/**
 * Dev-only image transfer accounting.
 *
 * The Portal's worst performance problem is invisible from the network tab
 * without adding up rows by hand: source artwork averages 4.5 MB, artwork and
 * the API share one HTTP/1.1 origin in dev, and a page that pulls twenty of
 * them starves JSON of connections until requests time out. This watches
 * Resource Timing and says so, once, with the number.
 *
 * Deliberately narrow:
 *   - `portalEnv.isDev` guards installation, so the module tree-shakes out of a
 *     production build the same way the diagnostics page does
 *   - one warning per URL, so a grid does not produce twenty identical lines
 *   - a summary only when something actually crossed the threshold
 *
 * Resource Timing reports `encodedBodySize: 0` for a cross-origin response with
 * no Timing-Allow-Origin (Discord avatars), so those are skipped rather than
 * reported as free.
 */
import { portalEnv } from '@/lib/env';

/** Above this, a single image is worth naming. Renditions land far below it. */
const LARGE_IMAGE_BYTES = 400 * 1024;

const IMAGE_PATH = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i;

let totalBytes = 0;
let imageCount = 0;
let largeCount = 0;
const warned = new Set<string>();

function shortPath(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url;
  }
}

function observe(entries: PerformanceResourceTiming[]): void {
  for (const entry of entries) {
    const isImage = entry.initiatorType === 'img' || IMAGE_PATH.test(entry.name);
    if (!isImage) continue;

    // Cross-origin without Timing-Allow-Origin, or a cache hit that moved no
    // bytes. Neither is a transfer worth accounting for.
    const bytes = entry.encodedBodySize;
    if (bytes === 0) continue;

    totalBytes += bytes;
    imageCount += 1;

    if (bytes >= LARGE_IMAGE_BYTES) {
      largeCount += 1;
      const path = shortPath(entry.name);
      if (!warned.has(path)) {
        warned.add(path);
        console.warn(
          `[portal image] ${path} is ${(bytes / 1024 / 1024).toFixed(1)} MB — ` +
            'this is source artwork, not a rendition. Run `npm run assets:thumbs`, ' +
            'or pass <Artwork displayWidth> at this call site.',
        );
      }
    }
  }
}

/** Bytes seen so far this session — surfaced on the diagnostics page. */
export function imageTransferStats(): {
  images: number;
  totalBytes: number;
  largeImages: number;
} {
  return { images: imageCount, totalBytes, largeImages: largeCount };
}

/**
 * Installs the observer. Safe to call more than once; a no-op outside dev and
 * anywhere `PerformanceObserver` is missing (jsdom, older Safari).
 */
export function installImageInstrumentation(): void {
  if (!portalEnv.isDev) return;
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const observer = new PerformanceObserver((list) => {
      observe(list.getEntries() as PerformanceResourceTiming[]);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    /* Resource Timing unavailable — instrumentation is never load-bearing */
  }
}
