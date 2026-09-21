import { prisma } from '@xenon/database';
import { listGalleryForStaff } from '@xenon/domain';
import { storageStatus } from '@xenon/storage';
import { Badge, EmptyState, Panel } from '@xenon/ui';

import { ControlPage } from '~/components/control/control-page';
import { MediaUploader } from '~/components/control/media-uploader';
import { requireCapability } from '~/server/context';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Gallery' };

/**
 * /control/content/gallery
 *
 * Uploads go through the media pipeline, which validates the declared type
 * against the file's actual magic number before anything is stored. The
 * gallery is public, so a file that claims to be a PNG and is not must never
 * reach the bucket.
 */
export default async function ControlGalleryPage(): Promise<React.ReactElement> {
  await requireCapability('content.edit');

  const [items, departments] = await Promise.all([
    listGalleryForStaff(prisma),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
  ]);

  const storage = storageStatus();

  return (
    <ControlPage
      title="Gallery"
      lead="Community photography. Published items appear on the public gallery immediately."
      actions={
        <Badge tone={storage.configured ? 'success' : 'warning'}>
          {storage.configured ? 'R2 storage' : 'Local storage (development)'}
        </Badge>
      }
    >
      {storage.configured ? null : (
        <Panel tone="ghost" pad="md" className="border-warning/30 bg-warning/5">
          <p className="text-xs leading-relaxed text-warning">
            Object storage is not configured, so uploads are written to{' '}
            <code className="font-mono">.storage/</code> on this machine and will not survive a
            redeploy. Production refuses to start without the R2 credentials.
          </p>
        </Panel>
      )}

      <MediaUploader
        departments={departments}
        items={items.map((item) => ({
          id: item.id,
          mediaId: item.mediaId,
          caption: item.caption,
          photographer: item.photographer,
          event: item.event,
          tags: item.tags,
          status: item.status,
          sortOrder: item.sortOrder,
          departmentName: item.department?.name ?? null,
        }))}
      />

      {items.length === 0 ? (
        <EmptyState
          title="The gallery is empty"
          description="Upload a screenshot to start. Credit the photographer - it is the whole reason people send them in."
        />
      ) : null}
    </ControlPage>
  );
}
