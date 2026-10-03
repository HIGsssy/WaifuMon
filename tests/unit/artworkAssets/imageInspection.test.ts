/**
 * Upload validation: the type is read from the bytes, never from a name or a
 * declared content type, and anything that is not a bounded still PNG / WebP /
 * JPEG is refused with a reason.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ARTWORK_MAX_DIMENSION,
  ARTWORK_UPLOAD_MAX_BYTES,
  displayNameFromFilename,
  inspectImage,
  sanitizeOriginalFilename,
  sniffImageType,
} from '../../../src/modules/artworkAssets/imageInspection';
import { ArtworkUploadInvalidError } from '../../../src/shared/errors';
import { solidImage, transparentSprite } from '../../helpers/imageFixtures';

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Rewrite a PNG's IHDR width and height (and its CRC), leaving the pixel data alone. */
function declareDimensions(png: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

const refusal = async (bytes: Buffer) => {
  const err = await inspectImage(bytes).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ArtworkUploadInvalidError);
  return (err as ArtworkUploadInvalidError).reason;
};

describe('accepted formats', () => {
  it('describes a PNG, a WebP and a JPEG from their bytes', async () => {
    const png = await inspectImage(await solidImage(64, 32, undefined, 'png'));
    expect(png).toMatchObject({ mimeType: 'image/png', extension: 'png', width: 64, height: 32, hasAlpha: false });
    const webp = await inspectImage(await solidImage(40, 50, undefined, 'webp'));
    expect(webp).toMatchObject({ mimeType: 'image/webp', extension: 'webp', width: 40, height: 50 });
    const jpeg = await inspectImage(await solidImage(120, 80, undefined, 'jpeg'));
    expect(jpeg).toMatchObject({ mimeType: 'image/jpeg', extension: 'jpg', width: 120, height: 80, hasAlpha: false });
  });

  it('records size and a sha256 of the exact bytes', async () => {
    const bytes = await solidImage(16, 16);
    const a = await inspectImage(bytes);
    expect(a.fileSize).toBe(bytes.length);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await inspectImage(Buffer.from(bytes))).contentHash).toBe(a.contentHash);
    expect((await inspectImage(await solidImage(16, 17))).contentHash).not.toBe(a.contentHash);
  });

  it('recognises a transparent sprite, as PNG and as WebP', async () => {
    expect((await inspectImage(await transparentSprite(64, 64, undefined, 'png'))).hasAlpha).toBe(true);
    expect(await inspectImage(await transparentSprite(64, 64, undefined, 'webp'))).toMatchObject({
      mimeType: 'image/webp',
      hasAlpha: true,
    });
  });
});

describe('refused uploads', () => {
  it('refuses SVG, GIF, HTML, scripts and arbitrary binaries by signature', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).gif().toBuffer();
    for (const bytes of [
      svg,
      gif,
      Buffer.from('<!doctype html><html><body>hi</body></html>'),
      Buffer.from('#!/bin/sh\nrm -rf /\n'),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]), // ELF
      Buffer.from('PK\u0003\u0004 not an image'),
    ]) {
      expect(sniffImageType(bytes)).toBeNull();
      expect(await refusal(bytes)).toMatch(/Only PNG, WebP and JPEG/);
    }
  });

  it('refuses a file whose signature says image but whose body is not one', async () => {
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>'.repeat(20))]);
    expect(sniffImageType(fakePng)).toBe('image/png');
    expect(await refusal(fakePng)).toMatch(/could not be read|malformed|not the image type/);
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    expect(await refusal(fakeJpeg)).toMatch(/could not be read|malformed/);
  });

  it('refuses a truncated image', async () => {
    const png = await solidImage(400, 400, undefined, 'png');
    expect(await refusal(png.subarray(0, Math.floor(png.length / 2)))).toMatch(/could not be read|malformed/);
  });

  it('refuses an empty body and one over the size limit', async () => {
    expect(await refusal(Buffer.alloc(0))).toMatch(/empty/);
    const png = await solidImage(16, 16);
    const padded = Buffer.concat([png, Buffer.alloc(ARTWORK_UPLOAD_MAX_BYTES)]);
    expect(await refusal(padded)).toMatch(/too large/);
  });

  it('refuses absurd dimensions without decoding them', async () => {
    // A tiny file that declares a huge canvas: the classic decompression bomb.
    const wide = await solidImage(ARTWORK_MAX_DIMENSION + 1, 8, undefined, 'png');
    expect(wide.length).toBeLessThan(100_000);
    expect(await refusal(wide)).toMatch(/longest edge/);
    // A real 16×16 PNG whose header is rewritten to declare 60000×60000:
    // a few hundred bytes that would decode to gigabytes.
    const bomb = declareDimensions(await solidImage(16, 16, undefined, 'png'), 60_000, 60_000);
    expect(bomb.length).toBeLessThan(2000);
    expect(await refusal(bomb)).toMatch(/could not be read|longest edge/);
    expect(await refusal(await solidImage(4, 4))).toMatch(/too small/);
  });

  it('refuses an animated WebP', async () => {
    const frames = [await solidImage(16, 16, { r: 255, g: 0, b: 0 }), await solidImage(16, 16, { r: 0, g: 0, b: 255 })];
    const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    expect(await refusal(animated)).toMatch(/Animated/);
  });
});

describe('file names are labels, never paths', () => {
  it('keeps only a harmless base name', () => {
    expect(sanitizeOriginalFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeOriginalFilename('C:\\Users\\me\\..\\boss.png')).toBe('boss.png');
    expect(sanitizeOriginalFilename('/abs/path/sprite.webp')).toBe('sprite.webp');
    expect(sanitizeOriginalFilename('..')).toBe('upload');
    expect(sanitizeOriginalFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeOriginalFilename('a\u0000b\nc<>.png')).toBe('abc.png');
    expect(sanitizeOriginalFilename(undefined)).toBe('upload');
    expect(sanitizeOriginalFilename('x'.repeat(500)).length).toBe(120);
  });

  it('derives a display name from a file name', () => {
    expect(displayNameFromFilename('scrap_heap-night.webp')).toBe('scrap heap night');
    expect(displayNameFromFilename('.png')).toBe('Untitled');
  });
});
