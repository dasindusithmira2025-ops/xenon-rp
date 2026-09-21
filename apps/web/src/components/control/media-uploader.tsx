'use client';

import { ImagePlus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge, Button, Field, Input, Panel, Select, useToast } from '@xenon/ui';

import {
  deleteGalleryItemAction,
  upsertGalleryItemAction,
} from '~/app/(control)/control/gallery/actions';
import { number, text } from '~/lib/form';

export interface GalleryRecord {
  readonly id: string;
  readonly mediaId: string;
  readonly caption: string | null;
  readonly photographer: string | null;
  readonly event: string | null;
  readonly tags: readonly string[];
  readonly status: string;
  readonly sortOrder: number;
  readonly departmentName: string | null;
}

/**
 * Upload and curate gallery items.
 *
 * Upload happens first and returns a media id; the metadata form is filled in
 * afterwards. Splitting them means a slow upload does not hold a form open, and
 * a failed upload does not discard the caption somebody just typed.
 */
export function MediaUploader({
  items,
  departments,
}: {
  items: readonly GalleryRecord[];
  departments: readonly { id: string; name: string }[];
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [uploading, setUploading] = React.useState(false);
  const [mediaId, setMediaId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('purpose', 'gallery');

      const response = await fetch('/api/media/upload', { method: 'POST', body });
      const result = (await response.json()) as { ok: boolean; mediaId?: string; message?: string };

      if (!result.ok || result.mediaId === undefined) {
        toast.error('Upload refused', result.message ?? 'Try a different file.');
        return;
      }

      setMediaId(result.mediaId);
      toast.success('Uploaded', 'Now add a caption and publish it.');
    } catch {
      toast.error('Upload failed', 'Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel tone="raised" pad="lg" edgeLight className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="x-eyebrow">Add an image</p>
          <p className="text-xs text-ink-muted">
            PNG, JPEG, WebP, AVIF or GIF, up to 8 MB. The file is checked against its declared type
            before it is stored.
          </p>
        </div>

        <label className="flex cursor-pointer items-center justify-center gap-3 rounded-md border border-dashed border-line-strong px-6 py-8 text-sm text-ink-secondary transition-colors hover:border-xenon/40">
          <ImagePlus className="size-4" aria-hidden />
          {uploading ? 'Uploading…' : 'Choose a file'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
              event.target.value = '';
            }}
          />
        </label>

        {mediaId === null ? null : (
          <form
            className="flex flex-col gap-4 border-t border-line pt-5"
            action={(form) => {
              startTransition(async () => {
                const result = await upsertGalleryItemAction({
                  mediaId,
                  caption: text(form, 'caption'),
                  photographer: text(form, 'photographer'),
                  event: text(form, 'event'),
                  tags: text(form, 'tags')
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
                  departmentId: text(form, 'departmentId') || null,
                  status: text(form, 'status'),
                  sortOrder: number(form, 'sortOrder') ?? 0,
                });

                if (result.ok) {
                  toast.success('Added to the gallery');
                  setMediaId(null);
                  router.refresh();
                  return;
                }
                toast.error('Could not save', result.message);
              });
            }}
          >
            <Field label="Caption" htmlFor="caption">
              <Input name="caption" maxLength={200} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Photographer" htmlFor="photographer" hint="Credit the person.">
                <Input name="photographer" maxLength={60} />
              </Field>
              <Field label="Event" htmlFor="event">
                <Input name="event" maxLength={80} />
              </Field>
              <Field label="Tags" htmlFor="tags" hint="Comma separated.">
                <Input name="tags" />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Department" htmlFor="departmentId">
                <Select name="departmentId" defaultValue="">
                  <option value="">None</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Status" htmlFor="status">
                <Select name="status" defaultValue="PUBLISHED">
                  <option value="PUBLISHED">Published</option>
                  <option value="DRAFT">Draft</option>
                </Select>
              </Field>
              <Field label="Order" htmlFor="sortOrder">
                <Input name="sortOrder" type="number" min={0} defaultValue="0" />
              </Field>
            </div>

            <div className="flex justify-end">
              <Button type="submit" variant="accent" size="sm" loading={pending}>
                Add to gallery
              </Button>
            </div>
          </form>
        )}
      </Panel>

      {items.length === 0 ? null : (
        <Panel tone="flat" pad="none" className="divide-y divide-line">
          {items.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 p-4">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-ink">{item.caption ?? 'Untitled'}</span>
                <span className="font-mono text-[0.625rem] text-ink-muted">
                  {item.photographer ?? 'uncredited'}
                  {item.event === null ? null : <> · {item.event}</>}
                  {item.departmentName === null ? null : <> · {item.departmentName}</>}
                </span>
              </span>

              <Badge tone={item.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                {item.status.toLowerCase()}
              </Badge>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove from gallery"
                disabled={pending}
                onClick={() => {
                  startTransition(async () => {
                    const result = await deleteGalleryItemAction(item.id);
                    if (result.ok) {
                      toast.success('Removed');
                      router.refresh();
                      return;
                    }
                    toast.error('Could not remove', result.message);
                  });
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
