import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A deliberately small, hostile-input ZIP reader.
 *
 * Asset packs come from the internet by way of an operator's downloads folder,
 * so the archive is treated as an attack until proven otherwise. The reader
 * never writes anything: it returns entries as buffers, and the caller decides
 * the file name. That alone removes Zip Slip - an archive path is never used
 * as a filesystem path - but traversal and absolute names are still refused
 * outright, because an archive that contains them is not an innocent pack.
 *
 * Guards, in the order they fire:
 *  - archive size, entry count and ZIP64 (not needed for emoji packs);
 *  - traversal, absolute and drive-letter names, NUL bytes;
 *  - symlinks (Unix mode bits in the external attributes);
 *  - encryption and compression methods other than store/deflate;
 *  - declared per-entry and total uncompressed size, and compression ratio;
 *  - inflation capped at the declared size, then size and CRC-32 verified,
 *    so a header that lies about its size cannot become a decompression bomb.
 */

export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  /** Uncompressed / compressed. Real images compress poorly; bombs do not. */
  readonly maxRatio: number;
}

export const defaultZipLimits: ZipLimits = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 500,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 100,
};

export interface ZipEntry {
  /** Normalised forward-slash path inside the archive. Never a filesystem path. */
  readonly path: string;
  readonly data: Buffer;
}

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function safeArchivePath(raw: string): string {
  if (raw.includes('\0')) throw new UnsafeArchiveError(`Entry name contains a NUL byte`);
  const path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new UnsafeArchiveError(`Absolute path in archive: ${raw}`);
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new UnsafeArchiveError(`Path traversal in archive: ${raw}`);
  }
  return path;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new UnsafeArchiveError('Not a ZIP archive');
}

export function readZip(buffer: Buffer, limits: ZipLimits = defaultZipLimits): ZipEntry[] {
  if (buffer.length > limits.maxArchiveBytes) throw new UnsafeArchiveError('Archive is too large');
  if (buffer.length < 22) throw new UnsafeArchiveError('Not a ZIP archive');

  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new UnsafeArchiveError('ZIP64 archives are not supported');
  }
  if (count > limits.maxEntries)
    throw new UnsafeArchiveError(`Archive has more than ${String(limits.maxEntries)} entries`);
  if (directoryOffset + directorySize > eocd)
    throw new UnsafeArchiveError('Corrupt central directory');

  const entries: ZipEntry[] = [];
  let total = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new UnsafeArchiveError('Corrupt central directory entry');
    }
    const madeBy = buffer.readUInt16LE(cursor + 4) >> 8;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.toString(
      (flags & 0x800) !== 0 ? 'utf8' : 'latin1',
      cursor + 46,
      cursor + 46 + nameLength,
    );
    cursor += 46 + nameLength + extraLength + commentLength;

    const path = safeArchivePath(rawName);
    if (path.endsWith('/')) continue; // directory

    // Host 3 is Unix; its high 16 bits of external attributes are st_mode.
    if (madeBy === 3 && ((external >>> 16) & S_IFMT) === S_IFLNK) {
      throw new UnsafeArchiveError(`Symlink in archive: ${path}`);
    }
    if ((flags & 0x1) !== 0) throw new UnsafeArchiveError(`Encrypted entry: ${path}`);
    if (method !== 0 && method !== 8)
      throw new UnsafeArchiveError(`Unsupported compression in ${path}`);
    if (size > limits.maxEntryBytes)
      throw new UnsafeArchiveError(`${path} is too large when extracted`);
    if (compressedSize > 0 && size / compressedSize > limits.maxRatio) {
      throw new UnsafeArchiveError(`${path} has a suspicious compression ratio`);
    }
    total += size;
    if (total > limits.maxTotalBytes)
      throw new UnsafeArchiveError('Archive is too large when extracted');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new UnsafeArchiveError(`Corrupt local header for ${path}`);
    }
    const dataStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize)
      throw new UnsafeArchiveError(`Truncated data for ${path}`);

    let data: Buffer;
    try {
      // `maxOutputLength` stops inflation the moment it passes the declared
      // size; a lying header throws here instead of filling memory.
      data =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
    } catch {
      throw new UnsafeArchiveError(`${path} does not decompress to its declared size`);
    }
    if (data.length !== size)
      throw new UnsafeArchiveError(`${path} does not match its declared size`);
    if (crc32(data) !== crc) throw new UnsafeArchiveError(`${path} failed its checksum`);

    entries.push({ path, data });
  }

  return entries;
}
