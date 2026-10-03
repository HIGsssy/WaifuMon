/**
 * "Is this upload an image we accept, and what is it?"
 *
 * Two independent checks, both on the bytes — the client's file name and
 * `Content-Type` are never consulted:
 *
 *   1. **Signature.** The leading bytes must be PNG, JPEG or WebP. Anything
 *      else (SVG, GIF, HTML, a script, an archive) is refused here, before a
 *      decoder sees it.
 *   2. **Decode.** `sharp` must read it as the *same* format, as a single
 *      still frame, within the dimension bounds. `limitInputPixels` makes the
 *      decoder itself refuse a decompression bomb, and the header-declared
 *      size is checked before any pixel is decoded.
 *
 * SVG is refused on purpose: an uploaded SVG is a document that can carry
 * script and external references. The scene compositor layers rasters and
 * never needs one.
 *
 * Pure apart from `sharp`: no database, no filesystem.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ArtworkAssetMimeType } from '../../db/schema';
import { ArtworkUploadInvalidError } from '../../shared/errors';

/** Largest accepted upload. Scene backgrounds at 2400×1350 WebP/PNG fit well inside it. */
export const ARTWORK_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** Longest accepted edge, and the most pixels a decoder may be asked to produce. */
export const ARTWORK_MAX_DIMENSION = 4096;
export const ARTWORK_MAX_PIXELS = ARTWORK_MAX_DIMENSION * ARTWORK_MAX_DIMENSION;
export const ARTWORK_MIN_DIMENSION = 8;

export const ARTWORK_MIME_EXTENSIONS: Readonly<Record<ArtworkAssetMimeType, string>> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export interface InspectedImage {
  mimeType: ArtworkAssetMimeType;
  /** The storage extension for `mimeType`, without the dot. */
  extension: string;
  width: number;
  height: number;
  /** True when the image has an alpha channel (a transparent sprite does). */
  hasAlpha: boolean;
  fileSize: number;
  /** sha256 of the bytes, hex. */
  contentHash: string;
}

/** The format the leading bytes declare, or null for anything not accepted. */
export function sniffImageType(bytes: Buffer): ArtworkAssetMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const SHARP_FORMATS: Readonly<Record<string, ArtworkAssetMimeType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Validate an upload and describe it.
 *
 * @throws {ArtworkUploadInvalidError} with a reason an admin can act on.
 */
export async function inspectImage(bytes: Buffer): Promise<InspectedImage> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new ArtworkUploadInvalidError('The upload is empty.');
  if (bytes.length > ARTWORK_UPLOAD_MAX_BYTES) {
    throw new ArtworkUploadInvalidError(
      `The file is too large — the limit is ${ARTWORK_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    );
  }
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    throw new ArtworkUploadInvalidError('Only PNG, WebP and JPEG images can be uploaded (SVG and GIF are not accepted).');
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw new ArtworkUploadInvalidError('The file could not be read as an image — it may be corrupt or too large.');
  }
  if (!meta.format || SHARP_FORMATS[meta.format] !== sniffed) {
    throw new ArtworkUploadInvalidError('The file is not the image type it claims to be.');
  }
  if ((meta.pages ?? 1) > 1) throw new ArtworkUploadInvalidError('Animated images are not supported.');
  const { width, height } = meta;
  if (!width || !height) throw new ArtworkUploadInvalidError('The image has no readable dimensions.');
  if (width > ARTWORK_MAX_DIMENSION || height > ARTWORK_MAX_DIMENSION) {
    throw new ArtworkUploadInvalidError(
      `The image is ${width}×${height} — the longest edge may be at most ${ARTWORK_MAX_DIMENSION}px.`,
    );
  }
  if (width < ARTWORK_MIN_DIMENSION || height < ARTWORK_MIN_DIMENSION) {
    throw new ArtworkUploadInvalidError(`The image is ${width}×${height} — too small to use.`);
  }
  // The header can lie about a truncated or malformed body; decode it once.
  try {
    await sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS, failOn: 'error' }).stats();
  } catch {
    throw new ArtworkUploadInvalidError('The image data is malformed and could not be decoded.');
  }

  return {
    mimeType: sniffed,
    extension: ARTWORK_MIME_EXTENSIONS[sniffed],
    width,
    height,
    hasAlpha: meta.hasAlpha === true,
    fileSize: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * The uploader's file name reduced to a harmless label: the base name only
 * (no directory, drive or traversal), control characters dropped, bounded.
 * Informational — the stored file's name is never derived from it.
 */
export function sanitizeOriginalFilename(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const base = text.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'upload';
}

/** A default display name from a file name: the stem, spaces for separators. */
export function displayNameFromFilename(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';
}
