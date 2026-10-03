import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetFile,
  assetsRoot,
  type AssetManifest,
  type ManifestEntry,
  readManifest,
  writeManifest,
} from './manifest';
import { type AssetKind, scanImage, sha256 } from './scan';
import { defaultZipLimits, readZip, type ZipLimits } from './zip';

/**
 * Import a Discord asset pack.
 *
 * ZIP → sandbox → scan → normalise → curated folder → manifest. Raw archive
 * bytes are only ever written into a throwaway directory under the OS temp
 * folder, under names this code generates; what reaches the repository is our
 * own re-encoded output, named by our own normalisation.
 *
 * Imported assets are added disabled. A pack is a pile of candidates, and the
 * operator decides which are good enough to represent Xenon.
 */

export interface ImportReport {
  readonly pack: string;
  readonly added: readonly {
    readonly key: string;
    readonly file: string;
    readonly animated: boolean;
  }[];
  readonly duplicates: readonly { readonly path: string; readonly of: string }[];
  readonly renamed: readonly { readonly path: string; readonly name: string }[];
  readonly review: readonly { readonly path: string; readonly reason: string }[];
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

export interface ImportOptions {
  readonly root?: string;
  readonly limits?: ZipLimits;
  /** Enable imported assets immediately instead of leaving them for curation. */
  readonly enable?: boolean;
  /** Default priority for imported assets. */
  readonly priority?: number;
}

/** Sticker if the pack puts it in a `sticker(s)` folder; emoji otherwise. */
function kindFor(path: string): AssetKind {
  return /(^|\/)stickers?\//i.test(path) ? 'STICKER' : 'EMOJI';
}

function packName(zipPath: string): string {
  const base = zipPath.replace(/\\/g, '/').split('/').pop() ?? 'pack';
  return (
    base
      .replace(/\.zip$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pack'
  );
}

export async function importAssetZip(
  zipPath: string,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const root = options.root ?? assetsRoot();
  const limits = options.limits ?? defaultZipLimits;

  const info = await stat(zipPath);
  if (!info.isFile()) throw new Error('The import path is not a file');
  if (info.size > limits.maxArchiveBytes) throw new Error('Archive is too large');

  const entries = readZip(await readFile(zipPath), limits);
  const pack = packName(zipPath);
  const manifest = await readManifest(root);

  const sandbox = await mkdtemp(join(tmpdir(), 'xenon-assets-'));
  const added: { key: string; file: string; animated: boolean }[] = [];
  const duplicates: { path: string; of: string }[] = [];
  const renamed: { path: string; name: string }[] = [];
  const review: { path: string; reason: string }[] = [];
  const rejected: { path: string; reason: string }[] = [];

  const hashes = new Map(manifest.assets.map((entry) => [entry.hash, entry.key]));
  const names = new Set(manifest.assets.map((entry) => entry.key));
  const next: ManifestEntry[] = [...manifest.assets];

  try {
    for (const [index, entry] of entries.entries()) {
      // Hidden files and macOS resource forks are noise, not assets.
      if (
        entry.path.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX')
      )
        continue;

      const staged = join(sandbox, `entry-${String(index).padStart(4, '0')}.bin`);
      await writeFile(staged, entry.data);

      const kind = kindFor(entry.path);
      const scanned = await scanImage(entry.path, await readFile(staged), kind);
      if (!scanned.ok) {
        (scanned.review ? review : rejected).push({ path: entry.path, reason: scanned.reason });
        continue;
      }

      const existing = hashes.get(scanned.hash) ?? hashes.get(scanned.sourceHash);
      if (existing !== undefined) {
        duplicates.push({ path: entry.path, of: existing });
        continue;
      }

      const prefix = kind === 'EMOJI' ? 'emoji' : 'sticker';
      let name = scanned.name;
      for (let suffix = 2; names.has(`${prefix}.${name}`); suffix += 1) {
        name = `${scanned.name.slice(0, 29)}_${String(suffix)}`;
      }
      if (name !== scanned.name) renamed.push({ path: entry.path, name });

      const folder = `imports/${pack}`;
      const file = `${folder}/${name}.${scanned.extension}`;
      await mkdir(assetFile(root, folder), { recursive: true });
      await writeFile(assetFile(root, file), scanned.output);
      await mkdir(assetFile(root, `generated/previews/${pack}`), { recursive: true });
      await writeFile(assetFile(root, `generated/previews/${pack}/${name}.png`), scanned.preview);

      const key = `${prefix}.${name}`;
      names.add(key);
      hashes.set(scanned.hash, key);
      next.push({
        key,
        type: kind,
        name,
        file,
        hash: scanned.hash,
        animated: scanned.animated,
        priority: options.priority ?? 500,
        required: false,
        enabled: options.enable === true,
        source: `${pack}:${entry.path}`,
      });
      added.push({ key, file, animated: scanned.animated });
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }

  const updated: AssetManifest = { version: 1, assets: next };
  await writeManifest(updated, root);

  return { pack, added, duplicates, renamed, review, rejected };
}

/** Re-scan every manifest entry against the file on disk. */
export async function scanManifest(root = assetsRoot()): Promise<{
  readonly ok: readonly string[];
  readonly problems: readonly { readonly key: string; readonly problem: string }[];
}> {
  const manifest = await readManifest(root);
  const ok: string[] = [];
  const problems: { key: string; problem: string }[] = [];
  const seen = new Map<string, string>();

  for (const entry of manifest.assets) {
    let data: Buffer;
    try {
      data = await readFile(assetFile(root, entry.file));
    } catch {
      problems.push({ key: entry.key, problem: `Missing file ${entry.file}` });
      continue;
    }
    const scanned = await scanImage(entry.file, data, entry.type);
    if (!scanned.ok) {
      problems.push({ key: entry.key, problem: scanned.reason });
      continue;
    }
    // The manifest records the bytes on disk; re-encoding is not deterministic
    // enough to compare against, so the file itself is hashed.
    if (sha256(data) !== entry.hash) {
      problems.push({
        key: entry.key,
        problem: 'File changed since it was recorded; re-run the import or update the hash',
      });
      continue;
    }
    const duplicate = seen.get(entry.hash);
    if (duplicate !== undefined) {
      problems.push({ key: entry.key, problem: `Same image as ${duplicate}` });
      continue;
    }
    seen.set(entry.hash, entry.key);
    ok.push(entry.key);
  }
  return { ok, problems };
}
