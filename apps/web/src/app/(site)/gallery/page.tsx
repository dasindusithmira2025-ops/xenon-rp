import { prisma } from '@xenon/database';
import { publishedGallery } from '@xenon/domain';
import { storageDriver } from '@xenon/storage';
import { EmptyState } from '@xenon/ui';

import type { Metadata } from 'next';

import { type GalleryEntry, GalleryGrid } from '~/components/gallery/gallery-grid';
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
 * The wall itself is `GalleryGrid`, which owns the layout and the lightbox.
 * This page's job is the query: work out which items exist and which of them
 * point at an asset the public is allowed to see.
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

  // Flattened here rather than in the client component: the grid should receive
  // exactly what it renders, not a domain record plus a lookup table it has to
  // join. It also keeps the Prisma shapes out of the client bundle.
  const entries: GalleryEntry[] = items.map((item) => ({
    id: item.id,
    url: urls.get(item.mediaId) ?? null,
    caption: item.caption,
    photographer: item.photographer,
    departmentName: item.department?.name ?? null,
  }));

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
        {entries.length === 0 ? (
          <EmptyState
            title="The gallery is empty"
            description="Staff curate the gallery from the control centre. Send your best shots to the community Discord and they may end up here."
          />
        ) : (
          <GalleryGrid items={entries} />
        )}
      </Section>
    </>
  );
}
