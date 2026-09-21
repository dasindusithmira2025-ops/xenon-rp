import { prisma } from '@xenon/database';
import { publishedGallery } from '@xenon/domain';
import { storageDriver } from '@xenon/storage';
import { Badge, EmptyState } from '@xenon/ui';
import { Reveal } from '@xenon/ui/motion';

import type { Metadata } from 'next';

import { MediaSlot } from '~/components/media/media-slot';
import { PageHeader, Section } from '~/components/site/section';

export const metadata: Metadata = {
  title: 'Gallery',
  description: 'Moments from the city, captured by the XenonRP community.',
  alternates: { canonical: '/gallery' },
};

export const revalidate = 300;

/**
 * /gallery
 *
 * A masonry-ish grid built from CSS columns rather than a layout library: the
 * images are a mix of aspect ratios, columns handle that natively, and a
 * dependency for a photo wall is not a trade worth making.
 *
 * Only public assets are resolved to a URL here. A gallery item pointing at a
 * private or missing asset renders the designed placeholder rather than a
 * broken image or, worse, a signed URL to something that was never meant to be
 * public.
 */
export default async function GalleryPage(): Promise<React.ReactElement> {
  const items = await publishedGallery(prisma, 60);

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: items.map((item) => item.mediaId) },
      visibility: 'PUBLIC',
      deletedAt: null,
    },
    select: { id: true, storageKey: true },
  });

  const driver = storageDriver();
  const urls = new Map(assets.map((asset) => [asset.id, driver.publicUrl(asset.storageKey)]));

  return (
    <>
      <PageHeader
        eyebrow="Gallery"
        title={
          <>
            Moments
            <br />
            from the city
          </>
        }
        lead="Photographs taken in Xenon by the people who were there."
      />

      <Section width="wide">
        {items.length === 0 ? (
          <EmptyState
            title="The gallery is empty"
            description="Staff curate the gallery from the control centre. Send your best shots to the community Discord and they may end up here."
          />
        ) : (
          <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
            {items.map((item, index) => (
              <Reveal
                key={item.id}
                delay={Math.min(index, 8) * 0.03}
                className="mb-4 break-inside-avoid"
              >
                <figure className="group overflow-hidden rounded-lg border border-line">
                  <MediaSlot
                    src={urls.get(item.mediaId) ?? null}
                    alt={item.caption ?? 'A moment in Xenon'}
                    slot={`gallery.${item.id}`}
                    seed={index}
                    // Varying the ratio keeps the columns from forming visible
                    // horizontal bands.
                    className={
                      index % 3 === 0
                        ? 'aspect-4/5'
                        : index % 3 === 1
                          ? 'aspect-square'
                          : 'aspect-4/3'
                    }
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  />

                  {item.caption === null && item.photographer === null ? null : (
                    <figcaption className="flex flex-col gap-1.5 bg-surface p-4">
                      {item.caption === null ? null : (
                        <p className="text-sm leading-snug text-ink-secondary">{item.caption}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {item.photographer === null ? null : (
                          <span className="x-eyebrow">{item.photographer}</span>
                        )}
                        {item.department === null ? null : (
                          <Badge tone="chrome">{item.department.name}</Badge>
                        )}
                      </div>
                    </figcaption>
                  )}
                </figure>
              </Reveal>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
