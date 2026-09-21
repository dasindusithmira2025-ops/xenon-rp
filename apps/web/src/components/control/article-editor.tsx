'use client';

import { ChevronDown, ExternalLink, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Panel,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@xenon/ui';

import { deleteArticleAction, upsertArticleAction } from '~/app/(control)/control/actions';
import { text } from '~/lib/form';

export interface ArticleRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly body: string;
  readonly heroImageUrl: string | null;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly status: string;
  readonly isPinned: boolean;
  readonly publishedAt: string | null;
  readonly authorName: string | null;
  readonly updatedAt: string;
}

/** News CRUD, with the list and the editor on one screen. */
export function ArticleEditor({
  articles,
  canPublish,
}: {
  articles: readonly ArticleRecord[];
  canPublish: boolean;
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="x-eyebrow">Articles</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCreating((current) => !current);
          }}
        >
          <Plus /> New article
        </Button>
      </div>

      {creating ? (
        <ArticleForm
          article={null}
          canPublish={canPublish}
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : null}

      <Panel tone="flat" pad="none" className="divide-y divide-line">
        {articles.map((article) => (
          <div key={article.id}>
            <button
              type="button"
              onClick={() => {
                setExpanded((current) => (current === article.id ? null : article.id));
              }}
              aria-expanded={expanded === article.id}
              className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-elevated"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm text-ink">{article.title}</span>
                <span className="font-mono text-[0.625rem] text-ink-muted">
                  /{article.slug}
                  {article.authorName === null ? null : <> · {article.authorName}</>} · edited{' '}
                  {new Date(article.updatedAt).toLocaleDateString('en-GB')}
                </span>
              </span>

              {article.isPinned ? <Badge tone="success">Pinned</Badge> : null}
              <Badge tone={article.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                {article.status.toLowerCase()}
              </Badge>
              <ChevronDown
                className={`size-4 shrink-0 text-ink-muted transition-transform ${
                  expanded === article.id ? 'rotate-180' : ''
                }`}
                aria-hidden
              />
            </button>

            {expanded === article.id ? (
              <div className="border-t border-line p-5">
                <ArticleForm article={article} canPublish={canPublish} />
              </div>
            ) : null}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function ArticleForm({
  article,
  canPublish,
  onDone,
}: {
  article: ArticleRecord | null;
  canPublish: boolean;
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [pinned, setPinned] = React.useState(article?.isPinned ?? false);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  return (
    <>
      <Panel tone={article === null ? 'flat' : 'ghost'} pad={article === null ? 'lg' : 'none'}>
        <form
          className="flex flex-col gap-5"
          action={(form) => {
            setErrors({});
            startTransition(async () => {
              const result = await upsertArticleAction(
                {
                  slug: text(form, 'slug'),
                  title: text(form, 'title'),
                  excerpt: text(form, 'excerpt'),
                  body: text(form, 'body'),
                  heroImageUrl: text(form, 'heroImageUrl') || null,
                  category: text(form, 'category'),
                  tags: text(form, 'tags')
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
                  status: text(form, 'status'),
                  isPinned: pinned,
                  publishedAt: text(form, 'publishedAt') || null,
                },
                article?.id,
              );

              if (result.ok) {
                toast.success(article === null ? 'Article created' : 'Saved');
                onDone?.();
                router.refresh();
                return;
              }
              setErrors(result.fieldErrors ?? {});
              if (result.fieldErrors === undefined) toast.error('Could not save', result.message);
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Title" htmlFor="title" required error={errors.title}>
              <Input name="title" defaultValue={article?.title ?? ''} maxLength={140} />
            </Field>
            <Field label="Slug" htmlFor="slug" required error={errors.slug}>
              <Input name="slug" defaultValue={article?.slug ?? ''} maxLength={64} />
            </Field>
          </div>

          <Field
            label="Excerpt"
            htmlFor="excerpt"
            hint="Shown on the index and used as the social description."
            error={errors.excerpt}
          >
            <Textarea
              name="excerpt"
              defaultValue={article?.excerpt ?? ''}
              rows={2}
              maxLength={300}
            />
          </Field>

          <Field
            label="Body"
            htmlFor="body"
            required
            hint="HTML. Sanitised on save."
            error={errors.body}
          >
            <Textarea
              name="body"
              defaultValue={article?.body ?? ''}
              rows={12}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Category" htmlFor="category" error={errors.category}>
              <Input name="category" defaultValue={article?.category ?? ''} maxLength={40} />
            </Field>
            <Field label="Tags" htmlFor="tags" hint="Comma separated." error={errors.tags}>
              <Input name="tags" defaultValue={(article?.tags ?? []).join(', ')} />
            </Field>
            <Field label="Status" htmlFor="status">
              <Select name="status" defaultValue={article?.status ?? 'DRAFT'}>
                <option value="DRAFT">Draft</option>
                <option value="PUBLISHED" disabled={!canPublish}>
                  Published{canPublish ? '' : ' (needs content.publish)'}
                </option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
            <Field label="Publish date" htmlFor="publishedAt" error={errors.publishedAt}>
              <Input name="publishedAt" type="date" defaultValue={article?.publishedAt ?? ''} />
            </Field>
          </div>

          <div className="grid items-end gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Hero image URL" htmlFor="heroImageUrl" error={errors.heroImageUrl}>
              <Input name="heroImageUrl" defaultValue={article?.heroImageUrl ?? ''} />
            </Field>
            <label className="flex items-center gap-3 pb-2.5 text-sm text-ink-secondary">
              <Switch checked={pinned} onCheckedChange={setPinned} label="Pin this article" />
              Pin to the top
            </label>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {article === null ? null : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmDelete(true);
                    }}
                  >
                    <Trash2 /> Delete
                  </Button>
                  {article.status === 'PUBLISHED' ? (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/news/${article.slug}`} target="_blank">
                        <ExternalLink /> View
                      </Link>
                    </Button>
                  ) : null}
                </>
              )}
            </div>
            <Button type="submit" variant="accent" size="sm" loading={pending}>
              {article === null ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      </Panel>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this article?"
        description="It disappears from the public site immediately. Archiving keeps it out of the index without losing it."
        confirmLabel="Delete"
        tone="danger"
        loading={pending}
        onConfirm={() => {
          if (article === null) return;
          startTransition(async () => {
            const result = await deleteArticleAction(article.id);
            if (result.ok) {
              toast.success('Article deleted');
              setConfirmDelete(false);
              router.refresh();
              return;
            }
            toast.error('Could not delete', result.message);
          });
        }}
      />
    </>
  );
}
