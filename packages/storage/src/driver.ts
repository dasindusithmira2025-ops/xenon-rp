/**
 * Object storage boundary.
 *
 * Everything that stores a file goes through this interface, so the R2 SDK
 * appears in exactly one file and a fresh clone with no cloud credentials still
 * runs uploads against the local filesystem. Swapping provider is a driver
 * change, not a sweep through the codebase.
 */

export interface StoredObject {
  /** Key within the bucket, or path under the local root. */
  readonly key: string;
  readonly sizeBytes: number;
  readonly checksum: string;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  /** Public objects are served straight from the CDN; private ones are signed. */
  readonly publicRead: boolean;
}

export interface ObjectStorageDriver {
  /** `R2` or `LOCAL`; recorded on the MediaAsset row so a later read knows where to look. */
  readonly kind: 'R2' | 'LOCAL';
  put(input: PutObjectInput): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  /** Stable URL for a public object. */
  publicUrl(key: string): string;
  /** Time-limited URL for a private object. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  read(key: string): Promise<Uint8Array | undefined>;
}

/** SHA-256 of the bytes, used to deduplicate and to detect tampering. */
export async function checksumOf(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build a storage key.
 *
 * Date-partitioned so a bucket listing stays navigable at scale, and suffixed
 * with a random token so two uploads of the same filename never collide and a
 * key can never be guessed from the original name.
 */
export function buildStorageKey(purpose: string, originalName: string): string {
  const now = new Date();
  const datePart = `${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const extension = /\.([a-zA-Z0-9]{1,8})$/.exec(originalName)?.[1]?.toLowerCase() ?? 'bin';
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 20);

  return `${purpose}/${datePart}/${token}.${extension}`;
}
