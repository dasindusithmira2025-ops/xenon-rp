import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp, { type OutputInfo, type OverlayOptions } from 'sharp';

import { brand } from '@xenon/config';

/**
 * Original Xenon welcome card, rendered with sharp only.
 *
 * Text is drawn by Pango from the bundled OFL Rajdhani fonts so the card
 * looks identical on hosts without system fonts. Every user-controlled string
 * is clamped and XML-escaped before it reaches Pango markup or SVG. The only
 * remote input is the member's Discord avatar, fetched with size, host and
 * time limits by {@link fetchAvatar}.
 */

export const CARD_WIDTH = 1000;
export const CARD_HEIGHT = 360;
const AVATAR_SIZE = 216;
const AVATAR_LEFT = 72;
const AVATAR_TOP = (CARD_HEIGHT - AVATAR_SIZE) / 2;
const AVATAR_CENTER = { x: AVATAR_LEFT + AVATAR_SIZE / 2, y: AVATAR_TOP + AVATAR_SIZE / 2 };
const TEXT_LEFT = 350;
const TEXT_MAX_WIDTH = CARD_WIDTH - TEXT_LEFT - 60;
/** Longest visible name before it is truncated with an ellipsis. */
export const MAX_CARD_NAME = 24;
const MAX_AVATAR_BYTES = 1_048_576;
const AVATAR_TIMEOUT_MS = 4_000;
const AVATAR_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const GREEN = brand.green;
const WHITE = brand.palette.text;
const MUTED = brand.palette.textSecondary;
const DIM = brand.palette.textMuted;

export interface WelcomeCardInput {
  /** PNG/JPEG/WebP bytes of the member avatar, or null for the neutral Xenon avatar. */
  readonly avatar: Buffer | null;
  readonly name: string;
  /** null hides the member badge. */
  readonly memberCount: number | null;
}

/** Escapes every character that is significant in XML, SVG and Pango markup. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

/** Drops control/format characters, collapses whitespace and truncates by grapheme. */
export function clampText(value: string, max: number): string {
  const cleaned = value.normalize('NFC').replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim();
  const parts = graphemes(cleaned);
  return parts.length <= max ? cleaned : `${parts.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The bundled font covers Latin scripts. Display names in other scripts fall
 * back to the Discord username, which Discord restricts to `a-z0-9_.`.
 */
export function cardName(displayName: string, username: string): string {
  const preferred = clampText(displayName, MAX_CARD_NAME);
  const name = /^[\u0020-\u007E\u00A0-\u024F…]+$/u.test(preferred) ? preferred : clampText(username, MAX_CARD_NAME);
  return name.length > 0 ? name : 'New Member';
}

/** Downloads a Discord CDN avatar with host, size and time limits; null when unusable. */
export async function fetchAvatar(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !AVATAR_HOSTS.has(parsed.hostname)) return null;
  const response = await fetchImpl(parsed, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS), redirect: 'error' });
  if (!response.ok || response.body === null) return null;
  if (Number(response.headers.get('content-length') ?? 0) > MAX_AVATAR_BYTES) return null;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function findFontDirectory(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'assets', 'fonts');
    if (existsSync(join(candidate, 'Rajdhani-Bold.ttf'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const fontDirectory = findFontDirectory();

interface Segment {
  readonly text: string;
  readonly color: string;
}

interface Layer {
  readonly input: Buffer;
  readonly width: number;
  readonly height: number;
}

/** One line of text as a transparent PNG, scaled down when wider than `maxWidth`. */
async function textLayer(
  segments: readonly Segment[],
  options: { readonly weight: 'Bold' | 'SemiBold'; readonly size: number; readonly spacing?: number; readonly maxWidth: number },
): Promise<Layer> {
  let rendered: { data: Buffer; info: OutputInfo };
  if (fontDirectory !== null) {
    const spacing = Math.round((options.spacing ?? 0) * 1024);
    const markup = segments
      .map((segment) => `<span foreground="${segment.color}" letter_spacing="${String(spacing)}">${escapeXml(segment.text)}</span>`)
      .join('');
    rendered = await sharp({
      text: {
        text: markup,
        font: `Rajdhani ${options.weight} ${String(options.size)}`,
        fontfile: join(fontDirectory, `Rajdhani-${options.weight}.ttf`),
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
  } else {
    // System-font fallback when the bundled font is unavailable.
    const spans = segments.map((segment) => `<tspan fill="${segment.color}">${escapeXml(segment.text)}</tspan>`).join('');
    const width = Math.ceil(segments.reduce((sum, segment) => sum + graphemes(segment.text).length, 0) * options.size * 0.62) + 8;
    const height = Math.ceil(options.size * 1.35);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}"><text x="0" y="${String(Math.round(options.size * 1.02))}" font-family="Rajdhani, DejaVu Sans, Arial, sans-serif" font-weight="${options.weight === 'Bold' ? '700' : '600'}" font-size="${String(options.size)}" letter-spacing="${String(options.spacing ?? 0)}">${spans}</text></svg>`;
    rendered = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
  }
  const { data, info } = rendered;
  if (info.width <= options.maxWidth) return { input: data, width: info.width, height: info.height };
  const height = Math.max(1, Math.round((info.height * options.maxWidth) / info.width));
  return { input: await sharp(data).resize(options.maxWidth, height).png().toBuffer(), width: options.maxWidth, height };
}

function backgroundSvg(): Buffer {
  const { x, y } = AVATAR_CENTER;
  const ring = AVATAR_SIZE / 2 + 7;
  const bracket = (cx: number, cy: number, dx: number, dy: number) =>
    `<path d="M ${String(cx)} ${String(cy + dy * 26)} L ${String(cx)} ${String(cy)} L ${String(cx + dx * 26)} ${String(cy)}" />`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020302"/>
      <stop offset="0.6" stop-color="#050906"/>
      <stop offset="1" stop-color="#0a160b"/>
    </linearGradient>
    <radialGradient id="avatarGlow" cx="${String(x / CARD_WIDTH)}" cy="0.5" r="0.42">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0.20"/>
      <stop offset="1" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cornerGlow" cx="1" cy="0" r="0.55">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${GREEN}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${GREEN}" stop-opacity="0"/>
    </linearGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}" fill="url(#bg)"/>
  <rect width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}" fill="url(#avatarGlow)"/>
  <rect width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}" fill="url(#cornerGlow)"/>
  <polygon points="590,0 660,0 470,360 400,360" fill="${GREEN}" opacity="0.035"/>
  <polygon points="690,0 706,0 516,360 500,360" fill="${GREEN}" opacity="0.06"/>
  <g stroke="${GREEN}" stroke-linecap="square" opacity="0.05" stroke-width="30">
    <line x1="790" y1="60" x2="960" y2="300"/>
    <line x1="960" y1="60" x2="790" y2="300"/>
  </g>
  <g stroke="${GREEN}" stroke-linecap="square" opacity="0.10" stroke-width="2">
    <line x1="842" y1="18" x2="908" y2="110"/>
    <line x1="908" y1="18" x2="842" y2="110"/>
  </g>
  <rect x="0" y="0" width="${String(CARD_WIDTH)}" height="3" fill="url(#edge)"/>
  <rect x="0" y="${String(CARD_HEIGHT - 3)}" width="${String(CARD_WIDTH)}" height="3" fill="url(#edge)"/>
  <rect x="12" y="12" width="${String(CARD_WIDTH - 24)}" height="${String(CARD_HEIGHT - 24)}" rx="16" fill="none" stroke="${GREEN}" stroke-opacity="0.16" stroke-width="1.5"/>
  <g fill="none" stroke="${GREEN}" stroke-width="3" opacity="0.75">
    ${bracket(24, 24, 1, 1)}
    ${bracket(CARD_WIDTH - 24, 24, -1, 1)}
    ${bracket(24, CARD_HEIGHT - 24, 1, -1)}
    ${bracket(CARD_WIDTH - 24, CARD_HEIGHT - 24, -1, -1)}
  </g>
  <circle cx="${String(x)}" cy="${String(y)}" r="${String(ring + 4)}" fill="none" stroke="${GREEN}" stroke-width="12" opacity="0.35" filter="url(#blur)"/>
  <circle cx="${String(x)}" cy="${String(y)}" r="${String(ring)}" fill="#050705" stroke="${GREEN}" stroke-width="5"/>
  <rect x="${String(TEXT_LEFT)}" y="196" width="76" height="4" rx="2" fill="${GREEN}"/>
</svg>`);
}

const AVATAR_MASK = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(AVATAR_SIZE)}" height="${String(AVATAR_SIZE)}"><circle cx="${String(AVATAR_SIZE / 2)}" cy="${String(AVATAR_SIZE / 2)}" r="${String(AVATAR_SIZE / 2)}" fill="#fff"/></svg>`,
);

/** Neutral Xenon avatar: dark disc with a green X, used when the real avatar is unavailable. */
function defaultAvatarSvg(): Buffer {
  const half = AVATAR_SIZE / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(AVATAR_SIZE)}" height="${String(AVATAR_SIZE)}">
  <defs><radialGradient id="g" cx="0.5" cy="0.4" r="0.7"><stop offset="0" stop-color="#132313"/><stop offset="1" stop-color="#050705"/></radialGradient></defs>
  <circle cx="${String(half)}" cy="${String(half)}" r="${String(half)}" fill="url(#g)"/>
  <g stroke="${GREEN}" stroke-width="14" stroke-linecap="square" opacity="0.85">
    <line x1="${String(half - 38)}" y1="${String(half - 44)}" x2="${String(half + 38)}" y2="${String(half + 44)}"/>
    <line x1="${String(half + 38)}" y1="${String(half - 44)}" x2="${String(half - 38)}" y2="${String(half + 44)}"/>
  </g>
</svg>`);
}

async function avatarLayer(avatar: Buffer | null): Promise<Buffer> {
  if (avatar !== null) {
    try {
      return await sharp(avatar, { limitInputPixels: 4096 * 4096, failOn: 'error' })
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
        .ensureAlpha()
        .composite([{ input: AVATAR_MASK, blend: 'dest-in' }])
        .png()
        .toBuffer();
    } catch {
      // Corrupt or unsupported image: fall through to the neutral avatar.
    }
  }
  return sharp(defaultAvatarSvg()).png().toBuffer();
}

/** Renders the 1000×360 `welcome.png`. Throws only if sharp itself fails. */
export async function renderWelcomeCard(input: WelcomeCardInput): Promise<Buffer> {
  const name = clampText(input.name, MAX_CARD_NAME) || 'New Member';
  const [avatar, eyebrow, title, tagline, member, badge] = await Promise.all([
    avatarLayer(input.avatar),
    textLayer([{ text: 'WELCOME TO', color: MUTED }], { weight: 'SemiBold', size: 26, spacing: 6, maxWidth: TEXT_MAX_WIDTH }),
    textLayer(
      [
        { text: 'XENON ', color: WHITE },
        { text: 'ROLEPLAY', color: GREEN },
      ],
      { weight: 'Bold', size: 66, spacing: 2, maxWidth: TEXT_MAX_WIDTH },
    ),
    textLayer([{ text: 'YOUR STORY. YOUR CITY. YOUR LEGACY.', color: DIM }], {
      weight: 'SemiBold',
      size: 19,
      spacing: 3,
      maxWidth: TEXT_MAX_WIDTH,
    }),
    textLayer([{ text: name, color: WHITE }], { weight: 'Bold', size: 42, maxWidth: TEXT_MAX_WIDTH }),
    input.memberCount === null
      ? null
      : textLayer([{ text: `MEMBER #${String(input.memberCount)}`, color: GREEN }], {
          weight: 'Bold',
          size: 22,
          spacing: 3,
          maxWidth: TEXT_MAX_WIDTH - 40,
        }),
  ]);

  const layers: OverlayOptions[] = [
    { input: avatar, left: AVATAR_LEFT, top: AVATAR_TOP },
    { input: eyebrow.input, left: TEXT_LEFT, top: 54 },
    { input: title.input, left: TEXT_LEFT - 2, top: 84 },
    { input: tagline.input, left: TEXT_LEFT, top: 160 },
    { input: member.input, left: TEXT_LEFT, top: 214 },
  ];
  if (badge !== null) {
    const pillWidth = badge.width + 36;
    const pillHeight = 40;
    const pill = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(pillWidth)}" height="${String(pillHeight)}"><rect x="1" y="1" width="${String(pillWidth - 2)}" height="${String(pillHeight - 2)}" rx="${String(pillHeight / 2 - 1)}" fill="${GREEN}" fill-opacity="0.10" stroke="${GREEN}" stroke-opacity="0.75" stroke-width="2"/></svg>`,
    );
    layers.push(
      { input: pill, left: TEXT_LEFT, top: 276 },
      { input: badge.input, left: TEXT_LEFT + 18, top: 276 + Math.round((pillHeight - badge.height) / 2) },
    );
  }
  return sharp(backgroundSvg()).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}
