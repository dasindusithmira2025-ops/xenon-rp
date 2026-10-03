import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateBrandEmojis } from './generate';
import { importAssetZip, scanManifest } from './import';
import { assetFile, desiredAssets, readManifest } from './manifest';
import { normaliseAssetName, scanImage, sniff } from './scan';
import { defaultZipLimits, readZip, UnsafeArchiveError } from './zip';
import { buildZip } from './zip-fixture';

const png = (colour: string, size = 64) =>
  sharp({ create: { width: size, height: size, channels: 4, background: colour } })
    .png()
    .toBuffer();

async function animatedGif(): Promise<Buffer> {
  const frames = await Promise.all(['#2AFD23', '#FF4D4D'].map((colour) => png(colour, 32)));
  return sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
}

describe('safe ZIP reader', () => {
  it('reads a well-formed pack', async () => {
    const zip = buildZip([{ name: 'pack/xenon-online.png', data: await png('#2AFD23') }]);
    expect(readZip(zip).map((entry) => entry.path)).toEqual(['pack/xenon-online.png']);
  });

  it.each([
    ['../escape.png', 'traversal'],
    ['pack/../../escape.png', 'traversal'],
    ['/etc/passwd', 'Absolute'],
    ['C:/Windows/evil.png', 'Absolute'],
    ['..\\windows\\evil.png', 'traversal'],
  ])('refuses %s', (name, reason) => {
    expect(() => readZip(buildZip([{ name, data: Buffer.from('x') }]))).toThrow(
      new RegExp(reason, 'i'),
    );
  });

  it('refuses symlinks', () => {
    expect(() =>
      readZip(
        buildZip([
          { name: 'link.png', data: Buffer.from('/etc/passwd'), symlink: true, deflate: false },
        ]),
      ),
    ).toThrow(/Symlink/);
  });

  it('refuses a decompression bomb by ratio before inflating it', () => {
    const bomb = buildZip([{ name: 'bomb.png', data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => readZip(bomb)).toThrow(/compression ratio/);
  });

  it('refuses a header that lies about its size', () => {
    const liar = buildZip([
      { name: 'liar.png', data: Buffer.alloc(200_000, 7), declaredSize: 5_000 },
    ]);
    expect(() => readZip(liar, { ...defaultZipLimits, maxRatio: 10_000 })).toThrow(
      UnsafeArchiveError,
    );
  });

  it('refuses oversized entries, too many entries and encryption', async () => {
    const data = await png('#000000');
    expect(() =>
      readZip(buildZip([{ name: 'a.png', data }]), { ...defaultZipLimits, maxEntryBytes: 10 }),
    ).toThrow(/too large/);
    expect(() =>
      readZip(buildZip(Array.from({ length: 4 }, (_, i) => ({ name: `${String(i)}.png`, data }))), {
        ...defaultZipLimits,
        maxEntries: 3,
      }),
    ).toThrow(/more than 3 entries/);
    expect(() => readZip(buildZip([{ name: 'secret.png', data, encrypted: true }]))).toThrow(
      /Encrypted/,
    );
  });

  it('refuses something that is not a ZIP at all', () => {
    expect(() => readZip(Buffer.from('definitely not a zip file, just text'))).toThrow(/Not a ZIP/);
  });
});

describe('image scanning', () => {
  it('normalises names to Discord emoji names', () => {
    expect(normaliseAssetName('pack/Xenon Online!.png')).toBe('xenon_online');
    expect(normaliseAssetName('xenon-online.png')).toBe('xenon_online');
    expect(normaliseAssetName('Café Noir.gif')).toBe('cafe_noir');
    expect(normaliseAssetName('x.png')).toMatch(/^[a-z0-9_]{2,32}$/);
    expect(normaliseAssetName(`${'a'.repeat(50)}.png`)).toHaveLength(32);
  });

  it('accepts and normalises a static image to 128px', async () => {
    const result = await scanImage('xenon.png', await png('#2AFD23', 300), 'EMOJI');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = await sharp(result.output).metadata();
    expect([meta.width, meta.height]).toEqual([128, 128]);
    expect(result.animated).toBe(false);
  });

  it('keeps animation for emoji and flags animated stickers for review', async () => {
    const gif = await animatedGif();
    expect(sniff(gif)).toBe('gif');
    const emoji = await scanImage('spin.gif', gif, 'EMOJI');
    expect(emoji.ok && emoji.animated).toBe(true);
    const sticker = await scanImage('spin.gif', gif, 'STICKER');
    expect(sticker).toMatchObject({ ok: false, review: true });
  });

  it('rejects spoofed, unsupported and malformed files', async () => {
    const image = await png('#2AFD23');
    expect(await scanImage('fake.gif', image, 'EMOJI')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Extension says gif') as string,
    });
    expect(await scanImage('notes.png', Buffer.from('hello'), 'EMOJI')).toMatchObject({
      ok: false,
      reason: 'Not a recognised image',
    });
    expect(await scanImage('icon.svg', Buffer.from('<svg/>'), 'EMOJI')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Unsupported') as string,
    });
    expect(await scanImage('broken.png', image.subarray(0, 40), 'EMOJI')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('malformed') as string,
    });
  });
});

describe('pack import', () => {
  let root: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'xenon-assets-root-'));
    work = await mkdtemp(join(tmpdir(), 'xenon-assets-work-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it('imports valid assets disabled, dedupes, renames collisions and reports the rest', async () => {
    const green = await png('#2AFD23');
    const zip = buildZip([
      { name: 'Xenon Pack/xenon-online.png', data: green },
      { name: 'Xenon Pack/copy-of-online.png', data: green },
      { name: 'Xenon Pack/other/xenon_online.png', data: await png('#FF4D4D') },
      { name: 'Xenon Pack/stickers/wave.gif', data: await animatedGif() },
      { name: 'Xenon Pack/readme.txt', data: Buffer.from('thanks') },
      { name: '__MACOSX/._xenon-online.png', data: Buffer.from('junk') },
    ]);
    const path = join(work, 'Xenon Pack.zip');
    await writeFile(path, zip);

    const report = await importAssetZip(path, { root });

    expect(report.pack).toBe('xenon-pack');
    expect(report.added.map((entry) => entry.key)).toEqual([
      'emoji.xenon_online',
      'emoji.xenon_online_2',
    ]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.renamed).toEqual([
      { path: 'Xenon Pack/other/xenon_online.png', name: 'xenon_online_2' },
    ]);
    expect(report.review.map((entry) => entry.path)).toEqual(['Xenon Pack/stickers/wave.gif']);
    expect(report.rejected.map((entry) => entry.path)).toEqual(['Xenon Pack/readme.txt']);

    const manifest = await readManifest(root);
    expect(manifest.assets.every((asset) => !asset.enabled)).toBe(true);
    expect(existsSync(assetFile(root, 'imports/xenon-pack/xenon_online.png'))).toBe(true);
    // Disabled assets are never planned for upload.
    expect(desiredAssets(manifest, root)).toEqual([]);
    expect((await scanManifest(root)).problems).toEqual([]);
  });

  it('writes nothing when the archive is hostile', async () => {
    const path = join(work, 'evil.zip');
    await writeFile(path, buildZip([{ name: '../../evil.png', data: await png('#000') }]));
    await expect(importAssetZip(path, { root })).rejects.toThrow(/traversal/);
    expect((await readManifest(root)).assets).toEqual([]);
  });

  it('refuses an asset path that escapes the asset directory', () => {
    expect(() => assetFile(root, '../outside.png')).toThrow(/escapes/);
  });
});

describe('Xenon emoji set', () => {
  it('renders the branded set deterministically and records it enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xenon-brand-'));
    try {
      const keys = await generateBrandEmojis(root);
      expect(keys).toEqual(
        expect.arrayContaining(['emoji.xenon_online', 'emoji.xenon_offline', 'emoji.xenon_mark']),
      );
      const first = await readFile(assetFile(root, 'generated/emoji/xenon_online.png'));
      await generateBrandEmojis(root);
      expect(await readFile(assetFile(root, 'generated/emoji/xenon_online.png'))).toEqual(first);

      const manifest = await readManifest(root);
      const required = manifest.assets.filter((asset) => asset.required).map((asset) => asset.key);
      expect(required).toEqual(
        expect.arrayContaining([
          'emoji.xenon_online',
          'emoji.xenon_degraded',
          'emoji.xenon_offline',
        ]),
      );
      expect(desiredAssets(manifest, root)).toHaveLength(keys.length);
      expect((await scanManifest(root)).problems).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
