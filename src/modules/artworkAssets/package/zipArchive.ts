/**
 * A deliberately small ZIP reader and writer for content packages that carry
 * artwork (Content Portability CP-3; reusable by CP-4).
 *
 * Why not a library: an uploaded package is untrusted input, and every rule
 * that keeps it safe lives here, in one place, where it can be read and
 * tested — the reader refuses anything it does not need rather than trying to
 * understand it:
 *
 *   - one disk, no ZIP64, no encryption, no archive comment, no data before
 *     the first entry or after the central directory;
 *   - only STORE and DEFLATE;
 *   - entry names that are plain relative paths: no absolute path, drive
 *     letter, backslash, `.`/`..` segment, empty segment, control character,
 *     or non-ASCII name without the UTF-8 flag; no duplicate (case-insensitively);
 *   - regular files and directories only — a symlink (or anything else whose
 *     Unix mode is not a regular file) is refused;
 *   - every local header agrees with the central directory, and no two
 *     entries' bytes overlap (the overlapping-entry bomb);
 *   - the caller's limits on entry count, archive bytes, each entry's
 *     expanded size, total expanded size and compression ratio are checked
 *     against the declared sizes before anything is inflated, and the
 *     inflater itself is capped at the declared size; CRC-32 and the actual
 *     length are verified afterwards.
 *
 * Nothing is ever written to disk: entries come back as buffers, and the
 * caller decides what an entry name means. Pure apart from `node:zlib`.
 */
import zlib from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const EOCD_SIZE = 22;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 3 (sizes in a trailing data descriptor), bit 11 (UTF-8 names), bits 1–2 (deflate options). */
const ALLOWED_FLAGS = 0x0008 | 0x0800 | 0x0006;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
/** 1980-01-01 00:00 — a fixed timestamp, so the same content writes the same bytes. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
export const ZIP_ENTRY_NAME_MAX_LENGTH = 200;

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipArchiveError';
  }
}

export interface ZipReadLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
  /** Largest DEFLATE expansion accepted, as uncompressed ÷ compressed. */
  maxCompressionRatio: number;
  /** The most an entry may expand to, or null to refuse a name outright. */
  maxEntryBytes(name: string): number | null;
  /** Directory entries (`name/`) that may appear. Any other is refused. */
  allowDirectory?(name: string): boolean;
}

export interface ZipFileEntry {
  name: string;
  data: Buffer;
}

/** Why `name` is not a safe relative entry path, or null. Directory names end in `/`. */
export function unsafeEntryName(name: string): string | null {
  if (name.length === 0) return 'an entry has an empty name';
  if (name.length > ZIP_ENTRY_NAME_MAX_LENGTH) return `entry name is longer than ${ZIP_ENTRY_NAME_MAX_LENGTH} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return `entry "${printable(name)}" has a control character in its name`;
  if (name.includes('\\')) return `entry "${printable(name)}" uses a backslash separator`;
  if (name.startsWith('/')) return `entry "${printable(name)}" is an absolute path`;
  if (/^[A-Za-z]:/.test(name) || name.includes(':')) return `entry "${printable(name)}" names a drive or stream`;
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  for (const segment of segments) {
    if (segment === '') return `entry "${printable(name)}" has an empty path segment`;
    if (segment === '.' || segment === '..') return `entry "${printable(name)}" has a "${segment}" path segment`;
  }
  return null;
}

function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
}

/**
 * Read every file in `archive`, enforcing `limits`. Directory entries are
 * validated and dropped.
 *
 * @throws {ZipArchiveError} naming the first problem found.
 */
export function readZip(archive: Buffer, limits: ZipReadLimits): ZipFileEntry[] {
  if (!Buffer.isBuffer(archive) || archive.length < EOCD_SIZE) throw new ZipArchiveError('The file is not a ZIP archive.');
  if (archive.length > limits.maxArchiveBytes) {
    throw new ZipArchiveError(`The archive is ${archive.length} bytes; the limit is ${limits.maxArchiveBytes}.`);
  }

  // The end record has no comment, so it is exactly the last 22 bytes.
  const eocd = archive.length - EOCD_SIZE;
  if (archive.readUInt32LE(eocd) !== END_OF_CENTRAL_DIRECTORY) {
    throw new ZipArchiveError('The file is not a ZIP archive, or it carries an archive comment or trailing data.');
  }
  const disk = archive.readUInt16LE(eocd + 4);
  const cdDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const cdSize = archive.readUInt32LE(eocd + 12);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (commentLength !== 0) throw new ZipArchiveError('Archive comments are not accepted.');
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) throw new ZipArchiveError('Multi-part archives are not accepted.');
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipArchiveError('ZIP64 archives are not accepted.');
  if (entryCount > limits.maxEntries) throw new ZipArchiveError(`The archive has ${entryCount} entries; the limit is ${limits.maxEntries}.`);
  if (cdOffset + cdSize !== eocd) throw new ZipArchiveError('The archive has data after its central directory.');

  interface Central {
    name: string;
    method: number;
    crc: number;
    compressedSize: number;
    size: number;
    localOffset: number;
    directory: boolean;
    flags: number;
  }
  const centrals: Central[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  let at = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (at + 46 > eocd || archive.readUInt32LE(at) !== CENTRAL_HEADER) throw new ZipArchiveError('The central directory is malformed.');
    const madeBy = archive.readUInt16LE(at + 4);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const entryCommentLength = archive.readUInt16LE(at + 32);
    const diskStart = archive.readUInt16LE(at + 34);
    const externalAttributes = archive.readUInt32LE(at + 38);
    const localOffset = archive.readUInt32LE(at + 42);
    const end = at + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd) throw new ZipArchiveError('The central directory is malformed.');
    const rawName = archive.subarray(at + 46, at + 46 + nameLength);
    at = end;

    if (flags & FLAG_ENCRYPTED) throw new ZipArchiveError('Encrypted entries are not accepted.');
    if (flags & ~ALLOWED_FLAGS) throw new ZipArchiveError('An entry uses ZIP features that are not accepted.');
    if (diskStart !== 0) throw new ZipArchiveError('Multi-part archives are not accepted.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipArchiveError('ZIP64 entries are not accepted.');
    }
    const name = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
    const unsafe = unsafeEntryName(name);
    if (unsafe) throw new ZipArchiveError(unsafe);
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) throw new ZipArchiveError(`The archive lists "${printable(name)}" more than once.`);
    seen.add(folded);

    const directory = name.endsWith('/');
    if (madeBy >> 8 === UNIX_HOST) {
      const mode = (externalAttributes >>> 16) & S_IFMT;
      if (mode !== 0 && mode !== (directory ? S_IFDIR : S_IFREG)) {
        throw new ZipArchiveError(`Entry "${printable(name)}" is not a regular file (links are not accepted).`);
      }
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipArchiveError(`Entry "${printable(name)}" uses an unsupported compression method.`);
    }
    if (directory) {
      if (!limits.allowDirectory?.(name)) throw new ZipArchiveError(`Unexpected entry "${printable(name)}".`);
      if (size !== 0 || compressedSize !== 0) throw new ZipArchiveError(`Directory entry "${printable(name)}" has content.`);
    } else {
      const limit = limits.maxEntryBytes(name);
      if (limit === null) throw new ZipArchiveError(`Unexpected entry "${printable(name)}".`);
      if (size > limit) throw new ZipArchiveError(`Entry "${printable(name)}" expands to ${size} bytes; the limit is ${limit}.`);
      if (method === METHOD_STORE && compressedSize !== size) {
        throw new ZipArchiveError(`Entry "${printable(name)}" has inconsistent sizes.`);
      }
      if (method === METHOD_DEFLATE && size > 0 && (compressedSize === 0 || size / compressedSize > limits.maxCompressionRatio)) {
        throw new ZipArchiveError(`Entry "${printable(name)}" is compressed more than ${limits.maxCompressionRatio}:1.`);
      }
      expanded += size;
      if (expanded > limits.maxExpandedBytes) {
        throw new ZipArchiveError(`The archive expands to more than ${limits.maxExpandedBytes} bytes.`);
      }
    }
    centrals.push({ name, method, crc, compressedSize, size, localOffset, directory, flags });
  }
  if (at !== eocd) throw new ZipArchiveError('The central directory is malformed.');

  // Each entry's local header and data must sit before the central directory,
  // agree with it, and not overlap another entry — checked for every entry
  // before any is inflated.
  const located: { entry: Central; dataStart: number; dataEnd: number }[] = [];
  const spans: { start: number; end: number; name: string }[] = [];
  for (const entry of centrals) {
    const lh = entry.localOffset;
    if (lh + 30 > cdOffset || archive.readUInt32LE(lh) !== LOCAL_HEADER) {
      throw new ZipArchiveError(`Entry "${printable(entry.name)}" has no valid local header.`);
    }
    const localFlags = archive.readUInt16LE(lh + 6);
    const localMethod = archive.readUInt16LE(lh + 8);
    const nameLength = archive.readUInt16LE(lh + 26);
    const extraLength = archive.readUInt16LE(lh + 28);
    if (lh + 30 + nameLength > cdOffset) throw new ZipArchiveError(`Entry "${printable(entry.name)}" has no valid local header.`);
    const localName = decodeName(archive.subarray(lh + 30, lh + 30 + nameLength), (localFlags & FLAG_UTF8) !== 0);
    if (localName !== entry.name || localMethod !== entry.method || (localFlags & FLAG_ENCRYPTED)) {
      throw new ZipArchiveError(`Entry "${printable(entry.name)}" disagrees with the central directory.`);
    }
    const dataStart = lh + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    // A trailing data descriptor (bit 3) takes at least 12 bytes after the data.
    const spanEnd = dataEnd + (entry.flags & 0x0008 ? 12 : 0);
    if (spanEnd > cdOffset) throw new ZipArchiveError(`Entry "${printable(entry.name)}" runs past the end of the archive.`);
    spans.push({ start: lh, end: spanEnd, name: entry.name });
    located.push({ entry, dataStart, dataEnd });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) {
      throw new ZipArchiveError(`Entries "${printable(spans[i - 1]!.name)}" and "${printable(spans[i]!.name)}" overlap.`);
    }
  }

  const files: ZipFileEntry[] = [];
  for (const { entry, dataStart, dataEnd } of located) {
    if (entry.directory) continue;
    const stored = archive.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (entry.method === METHOD_STORE) {
      data = Buffer.from(stored);
    } else {
      try {
        data = zlib.inflateRawSync(stored, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        throw new ZipArchiveError(`Entry "${printable(entry.name)}" is corrupt or larger than declared.`);
      }
    }
    if (data.length !== entry.size) throw new ZipArchiveError(`Entry "${printable(entry.name)}" is not the size it declares.`);
    if ((zlib.crc32(data) >>> 0) !== entry.crc) throw new ZipArchiveError(`Entry "${printable(entry.name)}" fails its checksum.`);
    files.push({ name: entry.name, data });
  }
  return files;
}

function decodeName(raw: Buffer, utf8: boolean): string {
  if (!utf8) {
    // Without the UTF-8 flag a name is CP437; anything beyond ASCII is ambiguous.
    for (const byte of raw) if (byte >= 0x80) throw new ZipArchiveError('An entry name is not plain ASCII and not marked UTF-8.');
    return raw.toString('latin1');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ZipArchiveError('An entry name is not valid UTF-8.');
  }
}

export interface ZipWriteEntry {
  name: string;
  data: Buffer;
  /** DEFLATE it (text); images are already compressed and are stored. */
  compress?: boolean;
  /** Unix mode bits for the external attributes. Defaults to a regular 0644 file. */
  mode?: number;
}

/**
 * A ZIP of `entries`, in order, with fixed timestamps so the same content
 * always produces the same bytes. Names are written as given — the writer
 * only ever receives names its caller generated.
 */
export function writeZip(entries: readonly ZipWriteEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compress = entry.compress === true && entry.data.length > 0;
    const body = compress ? zlib.deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const crc = zlib.crc32(entry.data) >>> 0;
    const method = compress ? METHOD_DEFLATE : METHOD_STORE;
    const directory = entry.name.endsWith('/');
    const mode = entry.mode ?? (directory ? S_IFDIR | 0o755 : S_IFREG | 0o644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE((UNIX_HOST << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(EOCD_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
