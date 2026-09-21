import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  checksumOf,
  type ObjectStorageDriver,
  type PutObjectInput,
  type StoredObject,
} from './driver';

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** Public base URL fronting the bucket, e.g. https://cdn.example.com */
  readonly publicBaseUrl: string;
}

/**
 * Cloudflare R2 driver.
 *
 * R2 speaks the S3 API, so the official client works with a custom endpoint and
 * the `auto` region. This is the only file in the repository that imports the
 * S3 SDK.
 */
export class R2StorageDriver implements ObjectStorageDriver {
  readonly kind = 'R2' as const;

  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const checksum = await checksumOf(input.body);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Object-level ACLs are not how R2 gates access; the bucket's public
        // binding does. Recorded as metadata so an audit can tell them apart.
        Metadata: { 'x-xenon-visibility': input.publicRead ? 'public' : 'private' },
      }),
    );

    return { key: input.key, sizeBytes: input.body.byteLength, checksum };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.config.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      return bytes;
    } catch {
      return undefined;
    }
  }
}
