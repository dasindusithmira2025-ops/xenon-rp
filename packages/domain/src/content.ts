import { NotFoundError } from '@xenon/core';
import type { Article, Db, GalleryItem, Prisma } from '@xenon/database';
import { cacheDelete, cached, enqueueBestEffort } from '@xenon/jobs';
import { type Actor, requirePermission } from '@xenon/permissions';
import type { AnnouncementInput, ArticleInput } from '@xenon/validation';

import { recordAudit } from './audit';

/**
 * News, announcements and the gallery.
 *
 * Publishing is a database write, never a deploy. Bodies are stored as HTML
 * that was sanitised at parse time in `@xenon/validation`, so the rendering
 * path has nothing left to decide.
 */

const NEWS_CACHE_KEY = 'news:published';
const NEWS_CACHE_TTL = 120;

export interface PublicArticleSummary {
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly heroImageUrl: string | null;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly publishedAt: string | null;
  readonly isPinned: boolean;
  readonly authorName: string | null;
}

/** Published articles, newest first, pinned ones lifted to the top. */
export async function publishedArticles(
  db: Db,
  limit = 24,
): Promise<readonly PublicArticleSummary[]> {
  return cached(`${NEWS_CACHE_KEY}:${String(limit)}`, NEWS_CACHE_TTL, async () => {
    const rows = await db.article.findMany({
      where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } },
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
      take: limit,
      include: { author: { select: { displayName: true } } },
    });

    return rows.map((row): PublicArticleSummary => ({
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      heroImageUrl: row.heroImageUrl,
      category: row.category,
      tags: row.tags,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      isPinned: row.isPinned,
      authorName: row.author?.displayName ?? null,
    }));
  });
}

export async function publishedArticleBySlug(db: Db, slug: string) {
  return db.article.findFirst({
    where: { slug, status: 'PUBLISHED', publishedAt: { lte: new Date() } },
    include: { author: { select: { displayName: true, avatarUrl: true, publicId: true } } },
  });
}

export async function upsertArticle(
  db: Db,
  actor: Actor,
  input: ArticleInput,
  articleId?: string,
): Promise<Article> {
  // Saving a draft and putting it in front of the community are different acts
  // and need different capabilities.
  requirePermission(actor, input.status === 'PUBLISHED' ? 'content.publish' : 'content.edit');

  const data: Prisma.ArticleUncheckedCreateInput = {
    slug: input.slug,
    title: input.title,
    excerpt: input.excerpt ?? null,
    body: input.body,
    heroImageUrl: input.heroImageUrl ?? null,
    category: input.category ?? null,
    tags: input.tags,
    status: input.status,
    isPinned: input.isPinned,
    authorId: actor.userId,
    publishedAt:
      input.status === 'PUBLISHED'
        ? (input.publishedAt ?? new Date())
        : (input.publishedAt ?? null),
  };

  const article =
    articleId === undefined
      ? await db.article.create({ data })
      : await db.article.update({
          where: { id: articleId },
          // The original author is preserved on edit; the audit log records who
          // actually made the change.
          data: { ...data, authorId: undefined },
        });

  await recordAudit(db, actor, {
    action: articleId === undefined ? 'article.created' : 'article.updated',
    entityType: 'article',
    entityId: article.id,
    entityLabel: article.slug,
    after: { title: article.title, status: article.status },
  });

  await cacheDelete(`${NEWS_CACHE_KEY}:24`, `${NEWS_CACHE_KEY}:3`, `${NEWS_CACHE_KEY}:6`);
  return article;
}

export async function deleteArticle(db: Db, actor: Actor, articleId: string): Promise<void> {
  requirePermission(actor, 'content.publish');

  const article = await db.article.findUnique({ where: { id: articleId } });
  if (article === null) throw new NotFoundError('Article', articleId);

  await db.article.delete({ where: { id: articleId } });
  await recordAudit(db, actor, {
    action: 'article.deleted',
    entityType: 'article',
    entityId: articleId,
    entityLabel: article.slug,
    before: { title: article.title },
  });
  await cacheDelete(`${NEWS_CACHE_KEY}:24`, `${NEWS_CACHE_KEY}:3`, `${NEWS_CACHE_KEY}:6`);
}

export async function listArticlesForStaff(db: Db, query: { search?: string } = {}) {
  return db.article.findMany({
    where:
      query.search === undefined || query.search.length === 0
        ? {}
        : { title: { contains: query.search, mode: 'insensitive' } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { author: { select: { displayName: true } } },
  });
}

/**
 * Publish an announcement.
 *
 * The website copy is written immediately; Discord delivery is a queued job, so
 * a rate-limited or offline guild delays the crosspost rather than losing the
 * announcement.
 */
export async function createAnnouncement(
  db: Db,
  actor: Actor,
  input: AnnouncementInput,
): Promise<Article | null> {
  requirePermission(actor, 'content.publish');

  let article: Article | null = null;

  if (input.toWebsite) {
    const slug = `${input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)}-${Date.now().toString(36)}`;

    article = await db.article.create({
      data: {
        slug,
        title: input.title,
        excerpt: input.body.slice(0, 280),
        body: `<p>${input.body.replace(/\n/g, '</p><p>')}</p>`,
        category: 'Announcement',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        authorId: actor.userId,
      },
    });
  }

  await recordAudit(db, actor, {
    action: 'announcement.created',
    entityType: 'announcement',
    entityId: article?.id ?? 'discord-only',
    entityLabel: input.title,
    after: { toWebsite: input.toWebsite, toDiscord: input.toDiscord },
  });

  if (input.toDiscord && input.discordChannelId) {
    await enqueueBestEffort('discord.channel.post', {
      channelId: input.discordChannelId,
      kind: 'ANNOUNCEMENT',
      entityType: 'announcement',
      entityId: article?.id ?? input.title,
    });
  }

  await cacheDelete(`${NEWS_CACHE_KEY}:24`, `${NEWS_CACHE_KEY}:3`, `${NEWS_CACHE_KEY}:6`);
  return article;
}

// --- Gallery -----------------------------------------------------------------

export async function publishedGallery(db: Db, limit = 60) {
  return db.galleryItem.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    include: { department: { select: { slug: true, name: true } } },
  });
}

export async function upsertGalleryItem(
  db: Db,
  actor: Actor,
  input: {
    mediaId: string;
    caption?: string | undefined;
    photographer?: string | undefined;
    event?: string | undefined;
    tags: readonly string[];
    departmentId?: string | null | undefined;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    sortOrder: number;
  },
  itemId?: string,
): Promise<GalleryItem> {
  requirePermission(actor, input.status === 'PUBLISHED' ? 'content.publish' : 'content.edit');

  const data = {
    mediaId: input.mediaId,
    caption: input.caption ?? null,
    photographer: input.photographer ?? null,
    event: input.event ?? null,
    tags: [...input.tags],
    departmentId: input.departmentId ?? null,
    status: input.status,
    sortOrder: input.sortOrder,
    uploadedById: actor.userId,
  };

  const item =
    itemId === undefined
      ? await db.galleryItem.create({ data })
      : await db.galleryItem.update({
          where: { id: itemId },
          data: { ...data, uploadedById: undefined },
        });

  await recordAudit(db, actor, {
    action: itemId === undefined ? 'gallery.created' : 'gallery.updated',
    entityType: 'gallery_item',
    entityId: item.id,
    after: { status: item.status, caption: item.caption },
  });

  return item;
}

export async function deleteGalleryItem(db: Db, actor: Actor, itemId: string): Promise<void> {
  requirePermission(actor, 'content.publish');

  await db.galleryItem.delete({ where: { id: itemId } });
  await recordAudit(db, actor, {
    action: 'gallery.deleted',
    entityType: 'gallery_item',
    entityId: itemId,
  });
}

export async function listGalleryForStaff(db: Db) {
  return db.galleryItem.findMany({
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }],
    take: 200,
    include: { department: { select: { name: true } } },
  });
}
