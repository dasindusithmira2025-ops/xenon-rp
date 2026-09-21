import { join } from 'node:path';

import { hasObjectStorage, serverEnv } from '@xenon/config/server';
import { ConflictError, ForbiddenError, ValidationError } from '@xenon/core';
import type { Db, MediaAsset, MediaVisibility } from '@xenon/database';

import { buildStorageKey, type ObjectStorageDriver } from './driver';
import { LocalStorageDriver } from './local-driver';
import { R2StorageDriver } from './r2-driver';

/**
 * The media pipeline: validate, store, record.
 *
 * Access is decided from the `MediaAsset` row rather than from whether someone
 * holds the URL, so a leaked link to a private attachment is not an
 * authorization bypass.
 */

let driverInstance: ObjectStorageDriver | undefined;

/**
 * The configured driver.
 *
 * R2 when every credential is present, the filesystem otherwise. Production
 * cannot reach the filesystem branch: `@xenon/config` refuses to start without
 * the R2 variables when `NODE_ENV=production`.
 */
export function storageDriver(): ObjectStorageDriver {
  if (driverInstance !== undefined) return driverInstance;

  if (hasObjectStorage()) {
    driverInstance = new R2StorageDriver({
      accountId: serverEnv.R2_ACCOUNT_ID ?? '',
      accessKeyId: serverEnv.R2_ACCESS_KEY ?? '',
      secretAccessKey: serverEnv.R2_SECRET_KEY ?? '',
      bucket: serverEnv.R2_BUCKET ?? '',
      publicBaseUrl: serverEnv.R2_PUBLIC_URL ?? '',
    });
  } else {
    driverInstance = new LocalStorageDriver(join(process.cwd(), '.storage'));
  }

  return driverInstance;
}

/** Replace the driver. Tests use this; nothing else should. */
export function setStorageDriver(driver: ObjectStorageDriver | undefined): void {
  driverInstance = driver;
}

export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;

export const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain'] as const;

/** 8 MB. Generous for a screenshot, small enough that a bulk upload is noticed. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface UploadInput {
  readonly body: Uint8Array;
  readonly mimeType: string;
  readonly originalName: string;
  /** What the file is for, e.g. `application_answer`, `gallery`, `ticket`. */
  readonly purpose: string;
  readonly ownerId: string | null;
  readonly visibility: MediaVisibility;
  readonly allowedMimeTypes?: readonly string[];
  readonly maxBytes?: number;
}

/**
 * Sniff the real type from the leading bytes.
 *
 * The declared `Content-Type` is attacker-controlled, so an HTML payload can
 * arrive labelled `image/png`. Checking the magic number means what is stored
 * is what it claims to be, which is what keeps a "gallery image" from being
 * served back as a script.
 */
function sniffMimeType(body: Uint8Array): string | undefined {
  const starts = (...bytes: number[]): boolean => bytes.every((byte, i) => body[i] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x52, 0x49, 0x46, 0x46)) {
    // RIFF container: WEBP writes its format tag at offset 8.
    const tag = String.fromCharCode(...Array.from(body.slice(8, 12)));
    return tag === 'WEBP' ? 'image/webp' : undefined;
  }
  // AVIF and other ISO-BMFF files carry `ftyp` at offset 4.
  if (body[4] === 0x66 && body[5] === 0x74 && body[6] === 0x79 && body[7] === 0x70) {
    const brand = String.fromCharCode(...Array.from(body.slice(8, 12)));
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
  }
  return undefined;
}

/**
 * Validate and store one upload, recording a `MediaAsset` row.
 *
 * Validation order matters: size first (cheapest), then declared type against
 * the allow-list, then the sniffed type against the declared one.
 */
export async function storeUpload(db: Db, input: UploadInput): Promise<MediaAsset> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowed = input.allowedMimeTypes ?? IMAGE_MIME_TYPES;

  if (input.body.byteLength === 0) {
    throw new ValidationError({ file: ['That file is empty.'] });
  }
  if (input.body.byteLength > maxBytes) {
    const mb = Math.round((maxBytes / 1024 / 1024) * 10) / 10;
    throw new ValidationError({ file: [`Files must be ${String(mb)} MB or smaller.`] });
  }
  if (!allowed.includes(input.mimeType)) {
    throw new ValidationError({ file: [`That file type is not accepted here.`] });
  }

  const sniffed = sniffMimeType(input.body);
  const textLike = input.mimeType === 'text/plain';
  if (!textLike && sniffed !== input.mimeType) {
    throw new ValidationError({
      file: ['That file does not look like the type it claims to be.'],
    });
  }

  const key = buildStorageKey(input.purpose, input.originalName);
  const driver = storageDriver();
  const stored = await driver.put({
    key,
    body: input.body,
    contentType: input.mimeType,
    publicRead: input.visibility === 'PUBLIC',
  });

  return db.mediaAsset.create({
    data: {
      storageKey: stored.key,
      driver: driver.kind,
      mimeType: input.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      originalName: input.originalName.slice(0, 200),
      visibility: input.visibility,
      ownerId: input.ownerId,
      purpose: input.purpose,
    },
  });
}

export interface MediaViewer {
  readonly userId: string | null;
  readonly isStaff: boolean;
}

/**
 * Resolve a media id to a URL the viewer is allowed to use.
 *
 * Private assets return a short-lived signed URL rather than a permanent one,
 * so a URL copied out of a staff review screen stops working.
 */
export async function resolveMediaUrl(
  db: Db,
  mediaId: string,
  viewer: MediaViewer,
): Promise<string> {
  const missing = (detail: string): ConflictError =>
    new ConflictError(`Media asset ${detail}`, 'That attachment is no longer available.');

  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (asset === null) throw missing('not found');
  if (asset.deletedAt !== null) throw missing('deleted');

  const isOwner = viewer.userId !== null && asset.ownerId === viewer.userId;
  const permitted =
    asset.visibility === 'PUBLIC' ||
    (asset.visibility === 'STAFF_ONLY' && viewer.isStaff) ||
    (asset.visibility === 'PRIVATE' && (isOwner || viewer.isStaff));

  if (!permitted) {
    throw new ForbiddenError('media.view', viewer.userId);
  }

  const driver = storageDriver();
  return asset.visibility === 'PUBLIC'
    ? driver.publicUrl(asset.storageKey)
    : driver.signedUrl(asset.storageKey, 300);
}

/** Soft-delete an asset and remove the bytes. The row survives for audit. */
export async function deleteMedia(db: Db, mediaId: string): Promise<void> {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (asset === null) return;

  await storageDriver().delete(asset.storageKey);
  await db.mediaAsset.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
}

/** Which storage backend is live, for the health screen. */
export function storageStatus(): { driver: 'R2' | 'LOCAL'; configured: boolean } {
  return { driver: storageDriver().kind, configured: hasObjectStorage() };
}
