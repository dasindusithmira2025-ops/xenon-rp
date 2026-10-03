import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import type { Metadata } from 'sharp';

/**
 * Image validation and normalisation for Discord assets.
 *
 * Nothing is trusted from the file: the extension must agree with the magic
 * bytes, sharp must decode it, and the output is re-encoded by us at Discord's
 * sizes. Animation is preserved when it survives within Discord's limits and
 * otherwise flagged for a human - never silently flattened into a still.
 */

export type ImageFormat = 'png' | 'gif' | 'jpeg' | 'webp';
export type AssetKind = 'EMOJI' | 'STICKER';

const EXTENSIONS: Record<string, ImageFormat> = {
  '.png': 'png',
  '.apng': 'png',
  '.gif': 'gif',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
};

/** Discord's documented limits for uploads. */
export const DISCORD_LIMITS = {
  emojiBytes: 256 * 1024,
  emojiSize: 128,
  stickerBytes: 512 * 1024,
  stickerSize: 320,
} as const;

export function sniff(data: Buffer): ImageFormat | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  const head = data.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * `Xenon Online!.png` → `xenon_online`. Discord emoji names are 2-32
 * characters of letters, digits and underscores.
 */
export function normaliseAssetName(fileName: string): string {
  const base =
    fileName
      .replace(/\.[^.]+$/, '')
      .split('/')
      .pop() ?? '';
  let name = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name.length < 2) name = `asset_${name}`.replace(/_$/, '_x');
  return name.slice(0, 32).replace(/_+$/, '');
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export type ScanOutcome =
  | {
      readonly ok: true;
      readonly kind: AssetKind;
      readonly name: string;
      readonly animated: boolean;
      readonly width: number;
      readonly height: number;
      readonly output: Buffer;
      readonly extension: 'png' | 'gif';
      readonly hash: string;
      readonly sourceHash: string;
      readonly preview: Buffer;
    }
  | {
      readonly ok: false;
      readonly name: string;
      readonly reason: string;
      readonly review: boolean;
    };

export async function scanImage(path: string, data: Buffer, kind: AssetKind): Promise<ScanOutcome> {
  const name = normaliseAssetName(path);
  const declared = EXTENSIONS[extname(path).toLowerCase()];
  if (declared === undefined)
    return {
      ok: false,
      name,
      reason: `Unsupported file type ${extname(path) || '(none)'}`,
      review: false,
    };

  const actual = sniff(data);
  if (actual === null) return { ok: false, name, reason: 'Not a recognised image', review: false };
  if (actual !== declared) {
    return {
      ok: false,
      name,
      reason: `Extension says ${declared} but the content is ${actual}`,
      review: false,
    };
  }

  let metadata: Metadata;
  let sharp: typeof import('sharp').default;
  try {
    ({ default: sharp } = await import('sharp'));
    metadata = await sharp(data, { animated: true, limitInputPixels: 4096 * 4096 }).metadata();
  } catch {
    return { ok: false, name, reason: 'Image is malformed or could not be decoded', review: false };
  }
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (width < 16 || height < 16)
    return { ok: false, name, reason: 'Image is smaller than 16×16', review: false };

  const animated = (metadata.pages ?? 1) > 1;
  const size = kind === 'EMOJI' ? DISCORD_LIMITS.emojiSize : DISCORD_LIMITS.stickerSize;
  const limit = kind === 'EMOJI' ? DISCORD_LIMITS.emojiBytes : DISCORD_LIMITS.stickerBytes;
  const fit = { fit: 'contain' as const, background: { r: 0, g: 0, b: 0, alpha: 0 } };

  if (animated && kind === 'STICKER') {
    return {
      ok: false,
      name,
      reason: 'Animated stickers need a hand-made APNG or Lottie; flagged for review',
      review: true,
    };
  }

  let output: Buffer;
  try {
    output = animated
      ? await sharp(data, { animated: true }).resize(size, size, fit).gif({ effort: 10 }).toBuffer()
      : await sharp(data)
          .resize(size, size, fit)
          .png({ compressionLevel: 9, palette: false })
          .toBuffer();
  } catch {
    return { ok: false, name, reason: 'Image could not be converted', review: true };
  }
  if (output.length > limit) {
    return {
      ok: false,
      name,
      reason: `Converted ${animated ? 'animation' : 'image'} is ${String(Math.ceil(output.length / 1024))} KB, over Discord's ${String(limit / 1024)} KB limit`,
      review: true,
    };
  }

  const preview = await sharp(output, { animated: false }).resize(64, 64, fit).png().toBuffer();

  return {
    ok: true,
    kind,
    name,
    animated,
    width,
    height,
    output,
    extension: animated ? 'gif' : 'png',
    hash: sha256(output),
    sourceHash: sha256(data),
    preview,
  };
}
