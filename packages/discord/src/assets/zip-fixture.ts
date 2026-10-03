import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds ZIP archives for tests, including hostile ones: traversal names,
 * symlinks, lying size headers, encryption flags. Never used at runtime.
 */

export interface FixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
  readonly symlink?: boolean;
  readonly encrypted?: boolean;
  /** Override the declared uncompressed size, to model a lying header. */
  readonly declaredSize?: number;
}

export function buildZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.deflate === false ? entry.data : deflateRawSync(entry.data);
    const method = entry.deflate === false ? 0 : 8;
    const size = entry.declaredSize ?? entry.data.length;
    const flags = 0x800 | (entry.encrypted === true ? 0x1 : 0);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.symlink === true ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
