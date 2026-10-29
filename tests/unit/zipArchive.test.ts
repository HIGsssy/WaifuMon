/**
 * The bounded ZIP reader/writer content packages use (CP-3). Every archive
 * here is untrusted input: each test builds one hostile shape and expects a
 * named refusal before anything is returned.
 */
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip, unsafeEntryName, writeZip, ZipArchiveError, type ZipReadLimits } from '../../src/modules/artworkAssets/package/zipArchive';

const LIMITS: ZipReadLimits = {
  maxArchiveBytes: 1024 * 1024,
  maxEntries: 10,
  maxExpandedBytes: 512 * 1024,
  maxCompressionRatio: 100,
  maxEntryBytes: (name) => (name === 'manifest.json' || name.startsWith('artwork/') ? 256 * 1024 : null),
  allowDirectory: (name) => name === 'artwork/',
};
const refuses = (archive: Buffer, pattern: RegExp, limits: ZipReadLimits = LIMITS) => {
  expect(() => readZip(archive, limits)).toThrow(ZipArchiveError);
  expect(() => readZip(archive, limits)).toThrow(pattern);
};
const file = (name: string, text = 'x', compress = false) => ({ name, data: Buffer.from(text), compress });

describe('round trip', () => {
  it('reads back what it wrote — stored and deflated, with the allowed directory — byte for byte and deterministically', () => {
    const image = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
    const entries = [file('manifest.json', JSON.stringify({ a: 'b'.repeat(500) }), true), { name: 'artwork/', data: Buffer.alloc(0) }, { name: 'artwork/asset-001.png', data: image }];
    const zip = writeZip(entries);
    expect(writeZip(entries).equals(zip)).toBe(true);
    const read = readZip(zip, LIMITS);
    expect(read.map((e) => e.name)).toEqual(['manifest.json', 'artwork/asset-001.png']);
    expect(read[1]!.data.equals(image)).toBe(true);
    expect(JSON.parse(read[0]!.data.toString()).a).toHaveLength(500);
  });
});

describe('entry names', () => {
  it.each([
    ['../escape.json', /"\.\." path segment/],
    ['artwork/../../etc/passwd', /"\.\." path segment/],
    ['/etc/passwd', /absolute path/],
    ['C:/windows/x.png', /drive/],
    ['artwork\\asset-001.png', /backslash/],
    ['artwork//asset.png', /empty path segment/],
    ['./manifest.json', /"\." path segment/],
    ['artwork/a\u0000.png', /control character/],
  ])('refuses %j', (name, pattern) => {
    expect(unsafeEntryName(name)).toMatch(pattern);
    refuses(writeZip([file(name)]), pattern);
  });

  it('refuses a duplicate name, exact or differing only in case', () => {
    refuses(writeZip([file('manifest.json'), file('manifest.json')]), /more than once/);
    refuses(writeZip([file('artwork/a.png'), file('artwork/A.png')]), /more than once/);
  });

  it('refuses an entry the caller does not expect, and an unexpected directory', () => {
    refuses(writeZip([file('manifest.json'), file('notes.txt')]), /Unexpected entry "notes.txt"/);
    refuses(writeZip([{ name: 'other/', data: Buffer.alloc(0) }]), /Unexpected entry "other\/"/);
  });

  it('refuses a non-ASCII name not flagged UTF-8', () => {
    const zip = writeZip([file('artwork/é.png')]);
    // Clear the UTF-8 flag in both headers.
    zip.writeUInt16LE(0, 6);
    const cd = zip.length - 22 - (46 + Buffer.byteLength('artwork/é.png'));
    zip.writeUInt16LE(0, cd + 8);
    refuses(zip, /not plain ASCII/);
  });
});

describe('entry types', () => {
  it('refuses a symlink and any other non-regular file', () => {
    refuses(writeZip([{ name: 'artwork/link.png', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]), /links are not accepted/);
    refuses(writeZip([{ name: 'artwork/fifo.png', data: Buffer.from('x'), mode: 0o010644 }]), /not a regular file/);
  });

  it('refuses an encrypted entry and an unknown compression method', () => {
    const encrypted = writeZip([file('manifest.json')]);
    const cd = encrypted.length - 22 - (46 + 'manifest.json'.length);
    encrypted.writeUInt16LE(0x0801, cd + 8);
    refuses(encrypted, /Encrypted/);
    const bzip = writeZip([file('manifest.json')]);
    bzip.writeUInt16LE(12, 8);
    bzip.writeUInt16LE(12, bzip.length - 22 - (46 + 'manifest.json'.length) + 10);
    refuses(bzip, /unsupported compression method/);
  });
});

describe('sizes and bombs', () => {
  it('refuses an archive over the byte limit and one with too many entries', () => {
    refuses(writeZip([file('artwork/a.png', 'x'.repeat(2000))]), /limit is 1000/, { ...LIMITS, maxArchiveBytes: 1000 });
    refuses(writeZip(Array.from({ length: 11 }, (_, i) => file(`artwork/${i}.png`))), /11 entries; the limit is 10/);
  });

  it('refuses an entry larger than its own limit, and a total over the expanded limit, from the declared sizes', () => {
    refuses(writeZip([file('artwork/a.png', 'x'.repeat(300 * 1024))]), /limit is 262144/);
    refuses(
      writeZip([file('artwork/a.png', 'a'.repeat(200 * 1024)), file('artwork/b.png', 'b'.repeat(200 * 1024)), file('artwork/c.png', 'c'.repeat(200 * 1024))]),
      /expands to more than/,
    );
  });

  it('refuses a compression ratio past the limit (a deflate bomb)', () => {
    refuses(writeZip([file('artwork/zeros.png', '\0'.repeat(200 * 1024), true)]), /compressed more than 100:1/);
  });

  it('refuses an entry that inflates past the size it declares, and one whose checksum fails', () => {
    const real = zlib.deflateRawSync(Buffer.from('y'.repeat(5000)));
    const lie = writeZip([file('artwork/a.png', 'y'.repeat(100), true)]);
    // Splice in a body that inflates to 5000 bytes while the headers say 100.
    const name = 'artwork/a.png';
    const bodyStart = 30 + name.length;
    const oldBody = lie.readUInt32LE(18);
    const spliced = Buffer.concat([lie.subarray(0, bodyStart), real, lie.subarray(bodyStart + oldBody)]);
    for (const at of [18, spliced.length - 22 - (46 + name.length) + 20]) spliced.writeUInt32LE(real.length, at);
    spliced.writeUInt32LE(spliced.readUInt32LE(spliced.length - 6) + real.length - oldBody, spliced.length - 6);
    refuses(spliced, /corrupt or larger than declared|compressed more than/);

    const bad = writeZip([file('manifest.json', 'hello')]);
    bad.writeUInt32LE(0xdeadbeef, 14);
    bad.writeUInt32LE(0xdeadbeef, bad.length - 22 - (46 + 'manifest.json'.length) + 16);
    refuses(bad, /fails its checksum/);
  });

  it('refuses a central entry pointing at another entry\'s local header', () => {
    const zip = writeZip([file('artwork/a.png', 'a'.repeat(100)), file('artwork/b.png', 'b'.repeat(100))]);
    const cdB = zip.length - 22 - (46 + 'artwork/b.png'.length);
    zip.writeUInt32LE(0, cdB + 42); // b's local header offset → a's
    refuses(zip, /disagrees with the central directory/);
  });

  it('refuses an entry whose data swallows the next entry (overlapping-entry bomb), before inflating anything', () => {
    const name = 'artwork/a.png';
    const zip = writeZip([file(name, 'a'.repeat(100)), file('artwork/b.png', 'b'.repeat(100))]);
    const grown = 100 + 30 + 'artwork/b.png'.length + 100; // a now "contains" b's header and data
    const cdA = zip.length - 22 - 2 * 46 - name.length - 'artwork/b.png'.length;
    for (const at of [18, 22]) zip.writeUInt32LE(grown, at);
    for (const at of [cdA + 20, cdA + 24]) zip.writeUInt32LE(grown, at);
    refuses(zip, /overlap/);
  });
});

describe('structure', () => {
  it('refuses something that is not a ZIP, trailing data, an archive comment, and ZIP64 markers', () => {
    refuses(Buffer.from('definitely not a zip file at all, no'), /not a ZIP archive/);
    refuses(Buffer.concat([writeZip([file('manifest.json')]), Buffer.from('junk')]), /not a ZIP archive|trailing data/);
    const commented = writeZip([file('manifest.json')]);
    commented.writeUInt16LE(4, commented.length - 2);
    refuses(Buffer.concat([commented, Buffer.from('note')]), /not a ZIP archive|comment/);
    const zip64 = writeZip([file('manifest.json')]);
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    zip64.writeUInt16LE(0xffff, zip64.length - 14);
    refuses(zip64, /ZIP64/);
  });

  it('refuses a truncated archive', () => {
    const zip = writeZip([file('manifest.json', 'hello world')]);
    refuses(zip.subarray(10), /malformed|not a ZIP|local header|past the end|central directory/);
  });
});
