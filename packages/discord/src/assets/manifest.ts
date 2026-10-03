import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { DesiredAsset } from '../provisioning/types';

/**
 * The asset manifest: the curated list of what Xenon may upload.
 *
 * Files live under `assets/discord/`, the manifest under
 * `assets/discord/manifests/assets.json`. The manifest is reviewed in git like
 * code; runtime upload state (snowflake, last sync, failure) lives in the
 * managed resource registry, so the file never churns because Discord did.
 */

export const ASSET_DIRECTORIES = [
  'branding',
  'emojis',
  'stickers',
  'role-icons',
  'banners',
  'imports',
  'generated',
  'manifests',
] as const;

const entrySchema = z.object({
  key: z.string().regex(/^(emoji|sticker)\.[a-z0-9_]{2,32}$/),
  type: z.enum(['EMOJI', 'STICKER']),
  name: z.string().regex(/^[a-z0-9_]{2,32}$/),
  /** Relative to `assets/discord/`. */
  file: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  animated: z.boolean(),
  /** Lower uploads first when capacity is short. */
  priority: z.number().int().min(0).max(1000).default(100),
  /** Required assets are uploaded before anything optional. */
  required: z.boolean().default(false),
  /** Imported packs arrive disabled; an operator curates them in. */
  enabled: z.boolean().default(false),
  /** Set when the importer could not make the asset Discord-ready. */
  review: z.string().optional(),
  source: z.string().optional(),
  tags: z.string().optional(),
  description: z.string().max(100).optional(),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(entrySchema),
});

export type ManifestEntry = z.output<typeof entrySchema>;
export type AssetManifest = z.output<typeof manifestSchema>;

/**
 * `assets/discord` at the repository root, found by walking up to the pnpm
 * workspace file so the bot, the CLI and tests agree regardless of cwd.
 */
export function assetsRoot(start = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return join(current, 'assets', 'discord');
    const parent = dirname(current);
    if (parent === current) return join(resolve(start), 'assets', 'discord');
    current = parent;
  }
}

export function manifestPath(root = assetsRoot()): string {
  return join(root, 'manifests', 'assets.json');
}

/** Resolve a manifest file path, refusing anything that escapes the asset root. */
export function assetFile(root: string, file: string): string {
  const full = resolve(root, file);
  if (full !== root && !full.startsWith(root + sep))
    throw new Error(`Asset path escapes the asset directory: ${file}`);
  return full;
}

export async function readManifest(root = assetsRoot()): Promise<AssetManifest> {
  try {
    const raw = await readFile(manifestPath(root), 'utf8');
    return manifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, assets: [] };
    }
    throw error;
  }
}

/** Atomic write: a crash mid-write must not leave a half manifest. */
export async function writeManifest(manifest: AssetManifest, root = assetsRoot()): Promise<void> {
  const target = manifestPath(root);
  await mkdir(dirname(target), { recursive: true });
  const sorted = {
    ...manifest,
    assets: [...manifest.assets].sort((a, b) => a.key.localeCompare(b.key)),
  };
  await writeFile(`${target}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  await rename(`${target}.tmp`, target);
}

/** What the plan should upload: enabled, reviewed, and present on disk. */
export function desiredAssets(manifest: AssetManifest, root = assetsRoot()): DesiredAsset[] {
  return manifest.assets
    .filter(
      (entry) =>
        entry.enabled && entry.review === undefined && existsSync(assetFile(root, entry.file)),
    )
    .map((entry) => ({
      key: entry.key,
      type: entry.type,
      name: entry.name,
      file: entry.file,
      hash: entry.hash,
      animated: entry.animated,
      priority: entry.priority,
      required: entry.required,
      ...(entry.tags === undefined ? {} : { tags: entry.tags }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }));
}

export async function readAssetData(
  asset: Pick<DesiredAsset, 'file'>,
  root = assetsRoot(),
): Promise<Buffer> {
  return readFile(assetFile(root, asset.file));
}
