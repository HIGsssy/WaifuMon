#!/usr/bin/env node
/**
 * Generates the artwork renditions the Portal actually displays.
 *
 * ## Why
 *
 * Source art is ~1500×2100 PNG, averaging 4.5 MB — 216 MB across the set. A
 * collection grid draws 25 of those at roughly 256 CSS pixels wide. Shipping
 * the originals is not merely wasteful: in development the artwork and the
 * Platform API proxy share one HTTP/1.1 origin, so a handful of multi-megabyte
 * transfers occupy every socket the browser will open and JSON requests queue
 * behind them until they time out. Shrinking the images is what stops that.
 *
 * ## What it does
 *
 * Writes `<assets>/.thumbnails/<width>/<relative path>.webp` for each width in
 * `SIZES`. The dev server serves those at `/dev-assets/t/<width>/<path>` and
 * silently falls back to the original when a rendition is missing, so running
 * this is an optimisation and never a prerequisite.
 *
 * Generation happens **here, once** — never per request. Re-runs skip anything
 * whose source has not changed since the rendition was written, so the second
 * run is nearly free and a new species costs only its own three encodes.
 *
 * ## Usage
 *
 *   npm run assets:thumbs            # portal/, reads ../assets by default
 *   npm run assets:thumbs -- --force # re-encode everything
 *   npm run assets:thumbs -- --assets ../some/other/assets
 *
 * `sharp` is an optional devDependency: it carries prebuilt native binaries and
 * is not worth forcing on anyone who never runs this. If it is absent the
 * script says so and exits cleanly rather than failing a build.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Must match `IMAGE_SIZE_BUCKETS` in `src/images/types.ts`. */
const SIZES = [256, 512, 1024];

/**
 * WebP quality. 80 is the usual point where a photographic image stops looking
 * different and the file stops getting smaller in interesting ways.
 */
const QUALITY = 80;

const SOURCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const THUMBNAIL_DIR = '.thumbnails';

function parseArgs(argv) {
  const args = { force: false, assets: path.resolve(here, '..', '..', 'assets') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--assets' && argv[i + 1]) {
      args.assets = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

/** Every source image under `root`, as paths relative to it. */
function sourceImages(root, relative = '') {
  const found = [];
  let entries;
  try {
    entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    // Never treat generated output as a source, or a re-run would shrink the
    // shrunken and compound the loss every time.
    if (entry.name === THUMBNAIL_DIR) continue;

    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...sourceImages(root, next));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(next);
  }
  return found;
}

function isUpToDate(sourcePath, outputPath) {
  try {
    return statSync(outputPath).mtimeMs >= statSync(sourcePath).mtimeMs;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Loads `sharp`, or explains precisely what to run.
 *
 * This is reachable from the repository root via `npm run content:prepare`,
 * where the likeliest cause is that nobody has installed the Portal's
 * dependencies at all — `portal/` is a separate package with its own lockfile.
 * "sharp is not installed" would be true and useless in that case, so the two
 * situations are distinguished and each names the command that fixes it.
 *
 * Nothing is installed automatically. A content-preparation command that
 * mutates dependency trees behind the author's back is a worse problem than
 * the one it solves.
 */
async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    const portalRoot = path.resolve(here, '..');
    const hasNodeModules = statSync(path.join(portalRoot, 'node_modules'), {
      throwIfNoEntry: false,
    })?.isDirectory();

    console.error(
      hasNodeModules
        ? 'generate-thumbnails: `sharp` is not installed.\n\n' +
            `  npm install --prefix ${path.relative(process.cwd(), portalRoot) || '.'}\n\n` +
            'It is a devDependency of the Portal package and ships native binaries, so only\n' +
            'this script needs it. Until it is installed the Portal serves original artwork,\n' +
            'which works but is slow.'
        : 'generate-thumbnails: the Portal’s dependencies are not installed.\n\n' +
            `  npm install --prefix ${path.relative(process.cwd(), portalRoot) || '.'}\n\n` +
            'The Portal is a separate package with its own lockfile; installing at the\n' +
            'repository root does not install it.',
    );
    return null;
  }
}

async function main() {
  const { force, assets } = parseArgs(process.argv.slice(2));

  if (!statSync(assets, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`generate-thumbnails: no assets directory at ${assets}`);
    process.exit(1);
  }

  const sharp = await loadSharp();
  if (!sharp) process.exit(1);

  const sources = sourceImages(assets);
  if (sources.length === 0) {
    console.log(`generate-thumbnails: no images found under ${assets}`);
    return;
  }

  let written = 0;
  let skipped = 0;
  let sourceBytes = 0;
  let outputBytes = 0;

  for (const relative of sources) {
    const sourcePath = path.join(assets, relative);
    sourceBytes += statSync(sourcePath).size;

    for (const width of SIZES) {
      const outputPath = path.join(
        assets,
        THUMBNAIL_DIR,
        String(width),
        relative.replace(/\.[^./]+$/, '') + '.webp',
      );

      if (!force && isUpToDate(sourcePath, outputPath)) {
        outputBytes += statSync(outputPath).size;
        skipped += 1;
        continue;
      }

      const buffer = await sharp(sourcePath)
        // `withoutEnlargement` keeps a small source from being upscaled into a
        // file larger than the original — a rendition must never cost more.
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer();

      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, buffer);
      outputBytes += buffer.byteLength;
      written += 1;
    }
  }

  const perSource = outputBytes / sources.length;
  console.log(
    `generate-thumbnails: ${written} written, ${skipped} up to date ` +
      `(${sources.length} sources × ${SIZES.length} sizes)\n` +
      `  sources    ${formatBytes(sourceBytes)}\n` +
      `  renditions ${formatBytes(outputBytes)} (${formatBytes(perSource)} per source, all sizes)`,
  );
}

await main();
