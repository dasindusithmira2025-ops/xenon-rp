# Discord assets

Custom emoji and stickers live under `assets/discord/`:

```
assets/discord/
  branding/  emojis/  stickers/  role-icons/  banners/
  imports/<pack>/          normalised output of imported packs
  generated/emoji/         Xenon's own rendered set
  generated/previews/      64px previews of imports
  manifests/assets.json    the curated manifest (reviewed in git)
```

The manifest decides what may be uploaded. Upload state (snowflake, last sync)
lives in the managed resource registry, not in the file.

## Xenon's emoji set

`pnpm discord:assets:generate` renders `xenon_online`, `xenon_degraded`,
`xenon_offline`, `xenon_idle`, `xenon_mark` (required) and `xenon_check`,
`xenon_cross`, `xenon_pending`, `xenon_alert`, `xenon_arrow` from SVG. Output is
deterministic. Panels use them where uploaded and fall back to Unicode.

## Importing a pack

```powershell
pnpm discord:assets:import ./assets/discord/imports/xenon-pack.zip
pnpm discord:assets:import ./pack.zip --enable   # skip curation
```

Only import packs you have the right to use. Xenon never downloads packs.

The importer treats the archive as hostile:

- archive ≤ 64 MB, ≤ 500 entries, entry ≤ 8 MB, total ≤ 128 MB;
- refuses traversal (`../`), absolute and drive-letter paths, NUL bytes,
  symlinks, encryption, ZIP64 and compression other than store/deflate;
- refuses compression ratios above 100:1 before inflating, caps inflation at
  the declared size, then verifies size and CRC-32;
- never uses an archive path as a filesystem path — entries are staged in an
  OS temp sandbox under generated names and deleted afterwards;
- checks the extension against the magic bytes, decodes with sharp, rejects
  malformed images and images under 16×16;
- re-encodes: emoji 128×128 (≤ 256 KB), stickers 320×320 PNG (≤ 512 KB),
  transparency preserved. Animated emoji stay animated; if they do not fit, or
  are stickers, they are flagged for review rather than flattened;
- dedupes by content hash, renames name collisions (`xenon_online_2`).

Imported entries arrive with `"enabled": false`. Edit the manifest to enable
the good ones and set `priority` (lower uploads first) or `required`.

`pnpm discord:assets:scan` re-validates every manifest entry against disk.

## Uploading

Assets are part of the normal plan (phase `ASSETS`). Capacity is derived from
the guild's boost tier at runtime; required and higher-priority assets are
planned first and the rest are reported `CAPACITY_BLOCKED` — the provision does
not fail. `pnpm discord:assets:sync -- --confirm "PROVISION XENON"` uploads
assets only.

Unchanged assets are never re-uploaded. A managed emoji deleted in Discord is
`DRIFT` (repair re-uploads it). One replaced by a different emoji under the
same name is `MANUAL_REVIEW` — Discord cannot change an emoji's image, so a
replacement always has a new id. A same-named emoji Xenon does not own is a
`CONFLICT`, never overwritten.
