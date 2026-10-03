import { mkdir, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { brand } from '@xenon/config';

import { assetFile, assetsRoot, type ManifestEntry, readManifest, writeManifest } from './manifest';
import { sha256 } from './scan';

/**
 * Xenon's own emoji set, rendered from SVG.
 *
 * One visual language: flat glyphs on a transparent ground, a single weight of
 * stroke, Xenon green only where it means "good" or "Xenon". They are drawn at
 * 128px and read cleanly at the 22px Discord shows inline. Regenerating is
 * deterministic, so the manifest hash only moves when the drawing does.
 */

const GREEN = brand.green;
const AMBER = '#FFB020';
const RED = '#FF4D4D';
const GREY = '#686F68';
const CHROME = brand.palette.text;
const INK = brand.palette.surfaceElevated;

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">${body}</svg>`;
}

const dot = (colour: string) =>
  svg(
    `<circle cx="64" cy="64" r="46" fill="${colour}" fill-opacity="0.18"/><circle cx="64" cy="64" r="30" fill="${colour}"/>`,
  );

const badge = (colour: string, glyph: string) =>
  svg(
    `<circle cx="64" cy="64" r="54" fill="${colour}"/><g fill="none" stroke="${INK}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>`,
  );

const drawings: readonly {
  name: string;
  body: string;
  required: boolean;
  priority: number;
}[] = [
  { name: 'xenon_online', body: dot(GREEN), required: true, priority: 0 },
  { name: 'xenon_degraded', body: dot(AMBER), required: true, priority: 1 },
  { name: 'xenon_offline', body: dot(RED), required: true, priority: 2 },
  { name: 'xenon_idle', body: dot(GREY), required: true, priority: 3 },
  {
    name: 'xenon_mark',
    body: svg(
      `<rect x="8" y="8" width="112" height="112" rx="28" fill="${INK}"/>` +
        `<path d="M40 38 L88 90" stroke="${CHROME}" stroke-width="16" stroke-linecap="round"/>` +
        `<path d="M88 38 L40 90" stroke="${GREEN}" stroke-width="16" stroke-linecap="round"/>`,
    ),
    required: true,
    priority: 4,
  },
  {
    name: 'xenon_check',
    body: badge(GREEN, '<path d="M38 66 L56 84 L92 46"/>'),
    required: false,
    priority: 10,
  },
  {
    name: 'xenon_cross',
    body: badge(RED, '<path d="M44 44 L84 84 M84 44 L44 84"/>'),
    required: false,
    priority: 11,
  },
  {
    name: 'xenon_pending',
    body: badge(AMBER, '<path d="M64 36 L64 66 L84 78"/>'),
    required: false,
    priority: 12,
  },
  {
    name: 'xenon_alert',
    body: svg(
      `<path d="M64 12 L120 112 L8 112 Z" fill="${AMBER}" stroke="${AMBER}" stroke-width="8" stroke-linejoin="round"/>` +
        `<path d="M64 48 L64 78" stroke="${INK}" stroke-width="12" stroke-linecap="round"/><circle cx="64" cy="96" r="7" fill="${INK}"/>`,
    ),
    required: false,
    priority: 13,
  },
  {
    name: 'xenon_arrow',
    body: svg(
      `<path d="M24 64 L100 64 M72 36 L100 64 L72 92" fill="none" stroke="${CHROME}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
    required: false,
    priority: 14,
  },
];

export async function generateBrandEmojis(root = assetsRoot()): Promise<string[]> {
  await mkdir(assetFile(root, 'generated/emoji'), { recursive: true });
  const manifest = await readManifest(root);
  const byKey = new Map(manifest.assets.map((entry) => [entry.key, entry]));
  const written: string[] = [];

  for (const drawing of drawings) {
    const png = await sharp(Buffer.from(drawing.body)).png({ compressionLevel: 9 }).toBuffer();
    const file = `generated/emoji/${drawing.name}.png`;
    await writeFile(assetFile(root, file), png);

    const key = `emoji.${drawing.name}`;
    const previous = byKey.get(key);
    const entry: ManifestEntry = {
      key,
      type: 'EMOJI',
      name: drawing.name,
      file,
      hash: sha256(png),
      animated: false,
      priority: drawing.priority,
      required: drawing.required,
      // An operator who disabled a generated emoji keeps it disabled.
      enabled: previous?.enabled ?? true,
      source: 'xenon:generated',
    };
    byKey.set(key, entry);
    written.push(key);
  }

  await writeManifest({ version: 1, assets: [...byKey.values()] }, root);
  return written;
}
