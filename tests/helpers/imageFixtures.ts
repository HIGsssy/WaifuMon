/**
 * Small real images for artwork tests, generated with `sharp` so nothing
 * binary is committed. Every helper returns encoded bytes.
 */
import sharp from 'sharp';

export type ImageFormat = 'png' | 'webp' | 'jpeg';
type Rgba = { r: number; g: number; b: number; alpha?: number };

export const RED: Rgba = { r: 220, g: 30, b: 30 };
export const GREEN: Rgba = { r: 30, g: 200, b: 60 };
export const BLUE: Rgba = { r: 30, g: 60, b: 220 };

/** An opaque, single-colour image. */
export function solidImage(width: number, height: number, color: Rgba = BLUE, format: ImageFormat = 'png'): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: color } });
  return (format === 'png' ? image.png() : format === 'webp' ? image.webp({ lossless: true }) : image.jpeg({ quality: 95 })).toBuffer();
}

/** A fully opaque single-colour image **with an alpha channel** — a sprite with no transparent part. */
export function opaqueSprite(width: number, height: number, color: Rgba = RED, format: 'png' | 'webp' = 'png'): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } });
  return (format === 'png' ? image.png() : image.webp({ lossless: true })).toBuffer();
}

/**
 * A transparent canvas with an opaque block in its middle half — what a
 * cut-out enemy sprite looks like to the compositor.
 */
export async function transparentSprite(width: number, height: number, color: Rgba = RED, format: 'png' | 'webp' = 'png'): Promise<Buffer> {
  const block = await sharp({
    create: { width: Math.max(1, Math.floor(width / 2)), height: Math.max(1, Math.floor(height / 2)), channels: 4, background: { ...color, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const image = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
    { input: block, gravity: 'centre' },
  ]);
  return (format === 'png' ? image.png() : image.webp({ lossless: true })).toBuffer();
}

/**
 * A fully opaque sprite whose left half is one colour and right half another —
 * so a horizontal mirror is visible in the pixels.
 */
export async function twoToneSprite(width: number, height: number, left: Rgba, right: Rgba, format: 'png' | 'webp' = 'webp'): Promise<Buffer> {
  const half = Math.floor(width / 2);
  const side = (w: number, color: Rgba) =>
    sharp({ create: { width: w, height, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
  const image = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
    { input: await side(half, left), left: 0, top: 0 },
    { input: await side(width - half, right), left: half, top: 0 },
  ]);
  return (format === 'png' ? image.png() : image.webp({ lossless: true })).toBuffer();
}

/** The RGB of one pixel of an encoded image. */
export async function pixelAt(bytes: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** True when a pixel is within `tolerance` of a colour on every channel (WebP is lossy). */
export function isNear(pixel: readonly number[], color: Rgba, tolerance = 40): boolean {
  return (
    Math.abs(pixel[0]! - color.r) <= tolerance &&
    Math.abs(pixel[1]! - color.g) <= tolerance &&
    Math.abs(pixel[2]! - color.b) <= tolerance
  );
}
