import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import {
  checksumOf,
  type ObjectStorageDriver,
  type PutObjectInput,
  type StoredObject,
} from './driver';

/**
 * Filesystem driver for development.
 *
 * Exists so a fresh clone can exercise the full upload path - validation,
 * MediaAsset rows, gallery rendering - without anyone provisioning a bucket.
 * Never used in production: `NODE_ENV=production` requires the R2 credentials,
 * enforced in `@xenon/config`.
 */
export class LocalStorageDriver implements ObjectStorageDriver {
  readonly kind = 'LOCAL' as const;

  constructor(
    private readonly root: string,
    /** Route that serves files back out, e.g. `/api/media`. */
    private readonly servePath = '/api/media',
  ) {}

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the root.
   *
   * Keys are generated internally today, but this driver is reachable from an
   * upload handler, and `../` in a key would otherwise be an arbitrary file
   * write.
   */
  private pathFor(key: string): string {
    const absolute = resolve(this.root, normalize(key));
    const rootWithSep = resolve(this.root) + sep;
    if (!absolute.startsWith(rootWithSep)) {
      throw new Error(`Refusing storage key outside the storage root: ${key}`);
    }
    return absolute;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.body);

    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      checksum: await checksumOf(input.body),
    };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  publicUrl(key: string): string {
    return `${this.servePath}/${key}`;
  }

  /** Local files have no signing story; the serve route authorises instead. */
  signedUrl(key: string): Promise<string> {
    return Promise.resolve(this.publicUrl(key));
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return undefined;
    }
  }

  /** Absolute path of the storage root, for the health screen. */
  get location(): string {
    return join(this.root);
  }
}
