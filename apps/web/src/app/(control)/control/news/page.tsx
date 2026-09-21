import { prisma } from '@xenon/database';
import { listArticlesForStaff } from '@xenon/domain';
import { Badge, Panel } from '@xenon/ui';

import { AnnouncementForm } from '~/components/control/announcement-form';
import { ArticleEditor } from '~/components/control/article-editor';
import { ControlPage } from '~/components/control/control-page';
import { currentActor, requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'News' };

/**
 * /control/content/news
 *
 * Publishing is a database write, never a deploy. Saving a draft needs
 * `content.edit`; putting something in front of the community needs
 * `content.publish`, which is a different decision and therefore a different
 * capability.
 */
export default async function ControlNewsPage(): Promise<React.ReactElement> {
  await requireCapability('content.edit');
  const actor = await currentActor();

  const [articles, guild] = await Promise.all([
    listArticlesForStaff(prisma),
    prisma.discordGuild.findFirst({ where: { isPrimary: true } }),
  ]);

  const canPublish = actor.permissions.has('content.publish');

  return (
    <ControlPage
      title="News"
      lead="Articles and announcements. Published articles appear on the public site straight away."
      actions={canPublish ? null : <Badge tone="neutral">You can draft but not publish</Badge>}
    >
      {canPublish ? (
        <AnnouncementForm
          defaultChannelId={guild?.announcementChannelId ?? null}
          discordConfigured={guild !== null}
        />
      ) : null}

      <ArticleEditor
        canPublish={canPublish}
        articles={articles.map((article) => ({
          id: article.id,
          slug: article.slug,
          title: article.title,
          excerpt: article.excerpt,
          body: article.body,
          heroImageUrl: article.heroImageUrl,
          category: article.category,
          tags: article.tags,
          status: article.status,
          isPinned: article.isPinned,
          publishedAt: article.publishedAt?.toISOString().slice(0, 10) ?? null,
          authorName: article.author?.displayName ?? null,
          updatedAt: article.updatedAt.toISOString(),
        }))}
      />

      <Panel tone="ghost" pad="md">
        <p className="text-[0.6875rem] leading-relaxed text-ink-muted">
          Bodies are HTML and are sanitised when saved: scripts, styles, iframes, event handlers and
          `javascript:` URLs are dropped rather than escaped, so a stored payload cannot be revived
          by a later change to how articles are rendered.
        </p>
      </Panel>
    </ControlPage>
  );
}
