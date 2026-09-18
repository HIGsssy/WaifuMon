/**
 * The authoritative species artwork build: PNG masters → runtime WebP.
 *
 * Every derivative of a species image is produced here, and every one is
 * encoded **directly from the PNG master**:
 *
 * ```
 *                  ┌─ full    <slug>/<variant>.webp                 q90, native size
 *                  ├─ 256     .thumbnails/256/…/<variant>.webp      q80
 *   master PNG ────┼─ 512     .thumbnails/512/…/<variant>.webp      q80
 *                  └─ 1024    .thumbnails/1024/…/<variant>.webp     q80
 * ```
 *
 * Never `PNG → full WebP → thumbnails`: a thumbnail encoded from an already
 * lossy WebP pays for compression twice.
 *
 * ## What gets built
 *
 * Runtime artwork only — the stems the content model can reach
 * (`readRuntimeArtworkCatalog`), not every PNG that happens to sit under
 * `waifumon/`. Backups and working files there are reported as ignored.
 *
 * ## What decides a rebuild
 *
 * A manifest (`<assets>/.artwork-manifest.json`), not modification times. An
 * output is rebuilt when the master's SHA-256 changed, the output's encoder
 * settings (which include the sharp / libvips / libwebp versions) changed, the
 * output file is missing or not the size the manifest recorded, or the
 * manifest has no valid entry for it. A git checkout that touches every mtime
 * rebuilds nothing.
 *
 * ## Safety
 *
 * - Each output is encoded to a temporary file beside its destination and
 *   renamed into place only after the encode succeeded, so a crash or a failed
 *   encode never leaves a truncated runtime asset.
 * - The manifest records an output only after its rename succeeded, and is
 *   itself written the same way.
 * - When a master has *changed*, any output still on disk from the old master
 *   that this run does not successfully rebuild — because the encode failed,
 *   or because `--only` excluded it — is removed, so the runtime resolver
 *   falls back to the current PNG instead of serving artwork that no longer
 *   matches it.
 *
 * ## Activation
 *
 * The runtime resolver prefers `<variant>.webp` over `<variant>.png` the
 * moment the WebP exists. Building the `full` output for an asset therefore
 * *switches that asset's live source*. Thumbnails do not — which is why
 * `--only thumbnails` exists for the Portal's development workflow.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  defaultAssetId,
  resolveAppearances,
  type AppearanceSpecies,
} from '../modules/appearance/appearanceContent';
import { listSpeciesFiles, readExpansionPacks } from '../modules/content/loader';
import {
  DEFAULT_APPEARANCE_ID,
  SpeciesFileSchema,
  type SpeciesContent,
} from '../modules/content/schemas';
import { ContentValidationError } from '../shared/errors';
import {
  ARTWORK_RENDITION_WIDTHS,
  assetPathWithin,
  renditionRelativePath,
  type ArtworkRenditionWidth,
} from '../modules/assets/speciesArtworkFile';

// ── Settings ─────────────────────────────────────────────────────────────────

/** Encoder settings for the full-size runtime image. Native dimensions, never resized. */
export const FULL_WEBP_OPTIONS = { quality: 90, effort: 6, smartSubsample: true } as const;

/**
 * Encoder settings for display renditions — the values the Portal's former
 * `generate-thumbnails.mjs` used, so existing renditions and new ones look
 * alike.
 */
export const THUMBNAIL_WEBP_OPTIONS = { quality: 80 } as const;
export const THUMBNAIL_RESIZE_OPTIONS = { withoutEnlargement: true } as const;

/** The artwork kind this tool builds. Other asset directories are authored as-is. */
export const SPECIES_ARTWORK_ROOT = 'waifumon';

export const MANIFEST_FILE = '.artwork-manifest.json';
export const MANIFEST_VERSION = 1;

export type OutputKey = 'full' | `${ArtworkRenditionWidth}`;
export const OUTPUT_KEYS: readonly OutputKey[] = [
  'full',
  ...ARTWORK_RENDITION_WIDTHS.map((w) => `${w}` as OutputKey),
];
export const THUMBNAIL_KEYS: readonly OutputKey[] = OUTPUT_KEYS.filter((k) => k !== 'full');

/** Library versions that can change encoded bytes. Part of every settings hash. */
function encoderVersions(): Record<string, string> {
  const v = sharp.versions as Record<string, string | undefined>;
  return { sharp: v.sharp ?? 'unknown', vips: v.vips ?? 'unknown', webp: v.webp ?? 'unknown' };
}

/** The encoder settings behind one output, exactly as they are applied. */
export function outputSettings(key: OutputKey): Record<string, unknown> {
  return key === 'full'
    ? { kind: 'full', webp: FULL_WEBP_OPTIONS }
    : { kind: 'rendition', width: Number(key), resize: THUMBNAIL_RESIZE_OPTIONS, webp: THUMBNAIL_WEBP_OPTIONS };
}

/** Hash of an output's settings plus encoder versions. A change rebuilds that output. */
export function outputSettingsHash(key: OutputKey): string {
  return sha256(JSON.stringify({ ...outputSettings(key), encoder: encoderVersions() })).slice(0, 16);
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface ManifestOutput {
  /** Relative to the assets root, forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  settingsHash: string;
}

export interface ManifestAsset {
  /** The master, relative to the assets root. */
  source: string;
  sourceSha256: string;
  sourceBytes: number;
  outputs: Partial<Record<OutputKey, ManifestOutput>>;
}

export interface ArtworkManifest {
  version: typeof MANIFEST_VERSION;
  generator: { tool: 'artwork-build'; encoder: Record<string, string> };
  settings: Record<OutputKey, { hash: string } & Record<string, unknown>>;
  /** Keyed by artwork stem: `waifumon/<slug>/<variant>`. */
  assets: Record<string, ManifestAsset>;
}

function emptyManifest(): ArtworkManifest {
  return {
    version: MANIFEST_VERSION,
    generator: { tool: 'artwork-build', encoder: encoderVersions() },
    settings: currentSettings(),
    assets: {},
  };
}

function currentSettings(): ArtworkManifest['settings'] {
  return Object.fromEntries(
    OUTPUT_KEYS.map((key) => [key, { hash: outputSettingsHash(key), ...outputSettings(key) }]),
  ) as ArtworkManifest['settings'];
}

/**
 * Reads the manifest. A missing, unreadable or wrong-version manifest is an
 * empty one — every output is then rebuilt — and says so via `warning`.
 */
export function readManifest(file: string): { manifest: ArtworkManifest; warning?: string } {
  if (!fs.existsSync(file)) return { manifest: emptyManifest() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ArtworkManifest>;
    if (parsed.version !== MANIFEST_VERSION || typeof parsed.assets !== 'object' || !parsed.assets) {
      return { manifest: emptyManifest(), warning: `ignoring ${file}: unrecognised version` };
    }
    return { manifest: { ...emptyManifest(), assets: parsed.assets } };
  } catch (err) {
    return {
      manifest: emptyManifest(),
      warning: `ignoring ${file}: ${(err as Error).message}`,
    };
  }
}

function writeManifest(file: string, manifest: ArtworkManifest): void {
  const sorted = Object.fromEntries(
    Object.entries(manifest.assets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  atomicWrite(file, `${JSON.stringify({ ...manifest, assets: sorted }, null, 2)}\n`);
}

// ── Runtime artwork catalog ──────────────────────────────────────────────────

/** What the catalog needs from a species: its appearances and legacy image. */
export type RuntimeArtworkSpecies = AppearanceSpecies & Pick<SpeciesContent, 'imagePath'>;

const SAFE_NAME = /^[a-z0-9_]+$/;
const LEGACY_SPECIES_IMAGE = /^waifumon\/([a-z0-9_]+)\/([a-z0-9_]+)\.png$/;

/**
 * The artwork stems (`waifumon/<slug>/<variant>`) the content model can ask
 * the runtime for — the set the build converts.
 *
 * Per species, exactly what the resolver's fallback chain can reach: every
 * appearance's `assetId`, the species' `standard`, and a legacy `imagePath`
 * that names a species master. Anything else under `waifumon/` — a
 * `standard_r1_backup.png`, a work-in-progress, art for a species no content
 * file defines yet — is not runtime artwork and is never built.
 */
export function runtimeArtworkStems(species: readonly RuntimeArtworkSpecies[]): Set<string> {
  const stems = new Set<string>();
  const add = (slug: string, variant: string): void => {
    if (SAFE_NAME.test(slug) && SAFE_NAME.test(variant)) {
      stems.add(`${SPECIES_ARTWORK_ROOT}/${slug}/${variant}`);
    }
  };
  for (const s of species) {
    for (const { assetId } of resolveAppearances(s)) {
      if (assetId.kind === SPECIES_ARTWORK_ROOT) add(assetId.slug, assetId.variant);
    }
    const standard = defaultAssetId(s.slug, DEFAULT_APPEARANCE_ID);
    add(standard.slug, standard.variant);
    const legacy = LEGACY_SPECIES_IMAGE.exec(s.imagePath);
    if (legacy) add(legacy[1]!, legacy[2]!);
  }
  return stems;
}

/**
 * The runtime artwork catalog of a content directory: core species plus the
 * species of **every** expansion pack, disabled ones included.
 *
 * A disabled pack's species are authored, schema-validated content that goes
 * live the moment `enabled` flips — the loader keeps reading them precisely so
 * re-enabling a pack is "never a leap into the dark". Their artwork is built
 * for the same reason, so enabling a pack needs no artwork step.
 */
export function readRuntimeArtworkCatalog(contentDir: string): Set<string> {
  const speciesDir = path.join(contentDir, 'species');
  if (!fs.existsSync(speciesDir)) {
    throw new ContentValidationError(`Species content directory missing: ${speciesDir}`);
  }
  const files = [
    ...listSpeciesFiles(speciesDir).map((f) => path.join(speciesDir, f)),
    ...readExpansionPacks(contentDir).sources.map((source) => source.absolutePath),
  ];
  return runtimeArtworkStems(files.flatMap(parseSpeciesFile));
}

function parseSpeciesFile(file: string): SpeciesContent[] {
  const parsed = SpeciesFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new ContentValidationError(`${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** A species master: `waifumon/<slug>/<variant>.png`. */
export interface ArtworkSource {
  /** `waifumon/<slug>/<variant>` — the manifest key and every output's stem. */
  stem: string;
  slug: string;
  variant: string;
  /** Relative to the assets root. */
  relativePath: string;
}

/**
 * The masters under `waifumon/` that are runtime artwork, sorted, plus every
 * other PNG found there (relative paths) as `ignored`. Only a
 * `<slug>/<variant>.png` whose stem is in `runtimeArtwork` is a source.
 */
export function discoverSources(
  assetsDir: string,
  runtimeArtwork: ReadonlySet<string>,
): { sources: ArtworkSource[]; ignored: string[] } {
  const root = path.join(assetsDir, SPECIES_ARTWORK_ROOT);
  const sources: ArtworkSource[] = [];
  const ignored: string[] = [];
  if (!fs.existsSync(root)) return { sources, ignored };
  for (const slug of fs.readdirSync(root).sort()) {
    const dir = path.join(root, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.png')) continue;
      const variant = file.slice(0, -'.png'.length);
      const stem = `${SPECIES_ARTWORK_ROOT}/${slug}/${variant}`;
      if (runtimeArtwork.has(stem)) sources.push({ stem, slug, variant, relativePath: `${stem}.png` });
      else ignored.push(`${SPECIES_ARTWORK_ROOT}/${slug}/${file}`);
    }
  }
  return { sources, ignored };
}

export type ArtworkSelection =
  | { all: true }
  | { species?: readonly string[]; assets?: readonly string[] };

/**
 * The masters a selection names. Every species or `slug/variant` asked for
 * must exist — a typo is reported, never silently built as nothing.
 */
export function selectSources(
  all: ArtworkSource[],
  selection: ArtworkSelection,
): { sources: ArtworkSource[]; unknown: string[] } {
  if ('all' in selection) return { sources: all, unknown: [] };
  const species = new Set(selection.species ?? []);
  const assets = new Set(selection.assets ?? []);
  const sources = all.filter(
    (s) => species.has(s.slug) || assets.has(`${s.slug}/${s.variant}`),
  );
  const unknown = [
    ...[...species].filter((slug) => !all.some((s) => s.slug === slug)),
    ...[...assets].filter((a) => !all.some((s) => `${s.slug}/${s.variant}` === a)),
  ];
  return { sources, unknown };
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface ArtworkBuildOptions {
  assetsDir: string;
  /**
   * The runtime artwork stems (`readRuntimeArtworkCatalog`). A PNG outside it
   * is never built, whatever it is named.
   */
  runtimeArtwork: ReadonlySet<string>;
  selection: ArtworkSelection;
  /** Outputs to produce. Default: all four. */
  outputs?: readonly OutputKey[];
  /** Rebuild every selected output regardless of the manifest. */
  force?: boolean;
  /** Plan only: read and hash sources, write nothing. */
  dryRun?: boolean;
  /** Assets encoded in parallel. */
  concurrency?: number;
  /** Receives one line per built / failed asset (the CLI's `--verbose`). */
  onAsset?: (line: string) => void;
}

export interface ArtworkFailure {
  asset: string;
  error: string;
}

export interface ArtworkBuildReport {
  dryRun: boolean;
  sourcesChecked: number;
  /** Assets with at least one output (re)built — or, in a dry run, that would be. */
  built: string[];
  skipped: number;
  failed: ArtworkFailure[];
  /** Selection entries that name no runtime-artwork master. */
  unknown: string[];
  /** PNGs under `waifumon/` that are not runtime artwork (backups, strays). */
  ignored: string[];
  /** Stale outputs removed after a failed rebuild of a changed master. */
  removedStale: string[];
  /** Bytes of every selected master. */
  sourceBytes: number;
  /** Current bytes of each output kind across the selection, after this run. */
  outputBytes: Partial<Record<OutputKey, number>>;
  manifestWarning?: string;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Why an output needs building, or `null` when the manifest says it is current. */
function staleReason(
  assetsDir: string,
  entry: ManifestAsset | undefined,
  sourceSha: string,
  key: OutputKey,
  expectedPath: string,
): string | null {
  if (!entry) return 'no manifest entry';
  if (entry.sourceSha256 !== sourceSha) return 'master changed';
  const out = entry.outputs[key];
  if (!out || out.path !== expectedPath) return 'not in manifest';
  if (out.settingsHash !== outputSettingsHash(key)) return 'settings changed';
  try {
    if (fs.statSync(path.join(assetsDir, out.path)).size !== out.bytes) return 'output modified';
  } catch {
    return 'output missing';
  }
  return null;
}

function outputRelativePath(source: ArtworkSource, key: OutputKey): string {
  return key === 'full' ? `${source.stem}.webp` : renditionRelativePath(source.stem, Number(key));
}

async function encode(master: Buffer, key: OutputKey): Promise<Buffer> {
  const pipeline = sharp(master);
  if (key !== 'full') pipeline.resize({ width: Number(key), ...THUMBNAIL_RESIZE_OPTIONS });
  return pipeline.webp(key === 'full' ? FULL_WEBP_OPTIONS : THUMBNAIL_WEBP_OPTIONS).toBuffer();
}

/** Encode → temp file beside the destination → rename. Never a partial file at `dest`. */
function atomicWrite(dest: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Builds the selected artwork. Never throws for a single asset: failures are
 * collected in the report, and the manifest records only what succeeded.
 */
export async function runArtworkBuild(options: ArtworkBuildOptions): Promise<ArtworkBuildReport> {
  const assetsDir = path.resolve(options.assetsDir);
  const outputs = options.outputs ?? OUTPUT_KEYS;
  const dryRun = options.dryRun ?? false;
  const manifestFile = path.join(assetsDir, MANIFEST_FILE);
  const { manifest, warning } = readManifest(manifestFile);

  const discovered = discoverSources(assetsDir, options.runtimeArtwork);
  const { sources, unknown } = selectSources(discovered.sources, options.selection);
  const report: ArtworkBuildReport = {
    dryRun,
    sourcesChecked: sources.length,
    built: [],
    skipped: 0,
    failed: [],
    unknown,
    ignored: discovered.ignored,
    removedStale: [],
    sourceBytes: 0,
    outputBytes: {},
    ...(warning === undefined ? {} : { manifestWarning: warning }),
  };

  const processOne = async (source: ArtworkSource): Promise<void> => {
    const sourcePath = assetPathWithin(assetsDir, source.relativePath);
    if (sourcePath === null) {
      report.failed.push({ asset: source.stem, error: 'path escapes the assets root' });
      return;
    }
    let master: Buffer;
    try {
      master = fs.readFileSync(sourcePath);
    } catch (err) {
      report.failed.push({ asset: source.stem, error: (err as Error).message });
      return;
    }
    report.sourceBytes += master.length;
    const sourceSha = sha256(master);
    const previous = manifest.assets[source.stem];
    const sameSource = previous?.sourceSha256 === sourceSha;

    // Outputs of the current master that are still valid carry over; anything
    // recorded against an older master is dropped from the entry.
    const entry: ManifestAsset = {
      source: source.relativePath,
      sourceSha256: sourceSha,
      sourceBytes: master.length,
      outputs: sameSource ? { ...previous.outputs } : {},
    };

    const todo = outputs.filter(
      (key) =>
        options.force === true ||
        staleReason(assetsDir, previous, sourceSha, key, outputRelativePath(source, key)) !== null,
    );

    if (todo.length === 0) {
      report.skipped += 1;
    } else if (dryRun) {
      report.built.push(source.stem);
      options.onAsset?.(`would build ${source.stem} [${todo.join(', ')}]`);
    } else {
      const errors: string[] = [];
      for (const key of todo) {
        const relative = outputRelativePath(source, key);
        const dest = path.join(assetsDir, relative);
        try {
          const bytes = await encode(master, key);
          const meta = await sharp(bytes).metadata();
          atomicWrite(dest, bytes);
          entry.outputs[key] = {
            path: relative,
            bytes: bytes.length,
            sha256: sha256(bytes),
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            settingsHash: outputSettingsHash(key),
          };
        } catch (err) {
          errors.push(`${key}: ${(err as Error).message}`);
          delete entry.outputs[key];
          // A file on disk that was built from an older master is now wrong,
          // and the runtime would prefer it over the current PNG. Remove it so
          // the resolver falls back to the master until a rebuild succeeds.
          if (!sameSource && fs.existsSync(dest)) {
            fs.rmSync(dest, { force: true });
            report.removedStale.push(relative);
          }
        }
      }
      // Outputs of an older master that this run did not rebuild (say, `full`
      // during `--only thumbnails`) no longer match the master either.
      if (previous && !sameSource) {
        for (const [key, out] of Object.entries(previous.outputs) as [OutputKey, ManifestOutput][]) {
          if (todo.includes(key) || entry.outputs[key]) continue;
          const stale = assetPathWithin(assetsDir, out.path);
          if (stale !== null && fs.existsSync(stale)) {
            fs.rmSync(stale, { force: true });
            report.removedStale.push(out.path);
          }
        }
      }
      if (errors.length > 0) {
        report.failed.push({ asset: source.stem, error: errors.join('; ') });
        options.onAsset?.(`FAILED ${source.stem}: ${errors.join('; ')}`);
      } else {
        report.built.push(source.stem);
        options.onAsset?.(`built ${source.stem} [${todo.join(', ')}]`);
      }
      manifest.assets[source.stem] = entry;
    }

    const current = dryRun ? previous : manifest.assets[source.stem];
    for (const key of outputs) {
      const out = current?.sourceSha256 === sourceSha ? current.outputs[key] : undefined;
      if (out) report.outputBytes[key] = (report.outputBytes[key] ?? 0) + out.bytes;
    }
  };

  const queue = [...sources];
  const workers = Math.max(1, options.concurrency ?? defaultConcurrency());
  try {
    await Promise.all(
      Array.from({ length: Math.min(workers, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await processOne(next);
      }),
    );
  } finally {
    // Whatever succeeded is recorded even if the run was interrupted by an
    // unexpected error, so the next run does not redo finished work.
    if (!dryRun && sources.length > 0) {
      manifest.generator = { tool: 'artwork-build', encoder: encoderVersions() };
      manifest.settings = currentSettings();
      writeManifest(manifestFile, manifest);
    }
  }

  report.built.sort();
  report.failed.sort((a, b) => (a.asset < b.asset ? -1 : 1));
  return report;
}

function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
}

// ── Report ───────────────────────────────────────────────────────────────────

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBuildReport(report: ArtworkBuildReport): string {
  const lines: string[] = [];
  if (report.manifestWarning) lines.push(`warning: ${report.manifestWarning}`);
  if (report.dryRun) lines.push('Dry run — nothing was written.');
  const verb = report.dryRun ? 'To build:  ' : 'Built:     ';
  lines.push(
    `Sources checked: ${report.sourcesChecked}`,
    `Ignored:         ${report.ignored.length} PNG(s) that are not runtime artwork`,
    `${verb}      ${report.built.length}`,
    `Skipped:         ${report.skipped}`,
    `Failed:          ${report.failed.length}`,
    `PNG source:      ${mb(report.sourceBytes)}`,
  );
  // A dry run can only report outputs that already exist, so it gives their
  // size but no reduction — that would compare every master to a subset.
  const full = report.outputBytes.full;
  if (full !== undefined) {
    lines.push(`${report.dryRun ? 'Existing WebP:  ' : 'Runtime WebP:   '} ${mb(full)}`);
    if (report.sourceBytes > 0 && !report.dryRun) {
      lines.push(`Reduction:       ${(100 * (1 - full / report.sourceBytes)).toFixed(1)}%`);
    }
  }
  const thumbs = THUMBNAIL_KEYS.filter((k) => report.outputBytes[k] !== undefined);
  if (thumbs.length > 0) {
    lines.push(
      `Thumbnails:      ${thumbs.map((k) => `${k}: ${mb(report.outputBytes[k]!)}`).join(', ')}`,
    );
  }
  for (const name of report.unknown) {
    lines.push(`unknown selection: ${name} (no runtime-artwork master PNG)`);
  }
  for (const f of report.failed) lines.push(`FAILED ${f.asset}: ${f.error}`);
  for (const r of report.removedStale) lines.push(`removed stale output: ${r}`);
  return lines.join('\n');
}
