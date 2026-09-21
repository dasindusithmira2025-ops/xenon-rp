'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@xenon/database';
import { deleteGalleryItem, upsertGalleryItem } from '@xenon/domain';
import { cuid, galleryItemInput } from '@xenon/validation';

import { type ActionResult, parseInput, runAction } from '~/server/action';
import { currentActor } from '~/server/context';

/** Gallery curation. Authorization and audit live in the content service. */

export async function upsertGalleryItemAction(
  raw: unknown,
  itemId?: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const input = parseInput(galleryItemInput, raw);
    const actor = await currentActor();

    await upsertGalleryItem(prisma, actor, input, itemId);
    revalidatePath('/control/gallery');
    revalidatePath('/gallery');
  });
}

export async function deleteGalleryItemAction(itemId: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = parseInput(cuid, itemId);
    const actor = await currentActor();

    await deleteGalleryItem(prisma, actor, id);
    revalidatePath('/control/gallery');
    revalidatePath('/gallery');
  });
}
