/**
 * Portal Admin Gallery — the read-only species/appearance catalog behind the
 * `gallery.read` admin API.
 *
 * The gallery is a content QA surface, so it must be able to say three things
 * the runtime snapshot on its own cannot:
 *
 *   1. **What was authored.** Every species in a content file, including those
 *      in expansion packs that are switched off, and every appearance exactly
 *      as written — before the loader's asset pre-flight disabled a species or
 *      dropped an appearance.
 *   2. **What the runtime loaded.** Whether the species is in the gameplay
 *      snapshot, whether it is enabled there, and which of its appearances
 *      survived.
 *   3. **What artwork exists.** Resolved per `AssetId` through the shared
 *      species artwork locator — the same candidates, preference order and
 *      realpath containment every consumer uses. A symlink out of the assets
 *      root is `unsafe`, never available, and no file is ever read.
 *
 * Pure apart from existence checks on disk: no database, no Discord, no HTTP,
 * no Portal code. Nothing here is consulted by gameplay, and nothing here
 * derives a Zone — the API returns tags and the Portal's canonical zone
 * mapping (`portal/src/lib/zone.ts`) stays the only one.
 *
 * `species.imagePath` is deliberately absent from every shape below. Artwork
 * is described by `AssetId`, its derived storage stem and the detected format;
 * a client can never supply a path, and none is returned.
 */
import {
  resolveAppearances,
  type ResolvedAppearance,
} from '../appearance/appearanceContent';
import {
  inspectSpeciesArtwork,
  speciesArtworkRenditions,
  speciesArtworkStem,
  type ArtworkRenditionWidth,
  type SpeciesArtworkExtension,
} from '../assets/speciesArtworkFile';
import { resolveRace } from '../cards/race';
import type {
  AppearanceUnlock,
  AssetId,
  BuddyBonusContent,
  CosmeticRarity,
  LoadedContent,
  SpeciesArtworkDiagnostic,
  SpeciesArtworkDiagnosticCode,
  SpeciesCardMeta,
  SpeciesContent,
} from '../content/schemas';
import type { Affinity, ContentRating, Rarity } from '../../db/schema';

// ── Issues ───────────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable QA findings. The Portal owns the wording.
 *
 *   - `species_disabled_by_loader` — authored enabled, but the loader disabled
 *     the species because nothing her default look could fall back to exists;
 *   - `default_artwork_missing`    — the default (`owned`) appearance has no file;
 *   - `appearance_artwork_missing` — a non-default appearance has no file;
 *   - `artwork_unsafe`             — the only candidate file escapes the assets
 *                                    root through a symlink, so it is unavailable;
 *   - `appearance_not_in_runtime`  — authored, but absent from the loaded
 *                                    snapshot (the loader dropped it);
 *   - `artwork_png_only`           — available only as the PNG master, no WebP;
 *   - `renditions_missing`         — a pre-generated display size is missing
 *                                    (species detail only; see below).
 */
export const GALLERY_ISSUE_CODES = [
  'species_disabled_by_loader',
  'default_artwork_missing',
  'appearance_artwork_missing',
  'artwork_unsafe',
  'appearance_not_in_runtime',
  'artwork_png_only',
  'renditions_missing',
] as const;
export type GalleryIssueCode = (typeof GALLERY_ISSUE_CODES)[number];

export type GalleryIssueSeverity = 'error' | 'warning';

const ISSUE_SEVERITY: Readonly<Record<GalleryIssueCode, GalleryIssueSeverity>> = {
  species_disabled_by_loader: 'error',
  default_artwork_missing: 'error',
  appearance_artwork_missing: 'error',
  artwork_unsafe: 'error',
  appearance_not_in_runtime: 'warning',
  artwork_png_only: 'warning',
  renditions_missing: 'warning',
};

export interface GalleryIssue {
  code: GalleryIssueCode;
  severity: GalleryIssueSeverity;
  /** The appearance concerned; `null` for none in particular. */
  appearanceId: string | null;
}

function issue(code: GalleryIssueCode, appearanceId: string | null): GalleryIssue {
  return { code, severity: ISSUE_SEVERITY[code], appearanceId };
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export type GalleryArtworkStatus = 'available' | 'missing' | 'unsafe';

export interface GalleryArtwork {
  status: GalleryArtworkStatus;
  /** The stored format that resolved; `null` unless `available`. */
  format: SpeciesArtworkExtension | null;
  /**
   * `<kind>/<slug>/<variant>` — derived from the `AssetId`, no extension.
   * Display only; nothing accepts it back.
   */
  storageStem: string;
  /** Present on species detail only. */
  renditions?: Record<ArtworkRenditionWidth, boolean> | undefined;
}

/** Where a species was authored. Origin only — never where she can be found. */
export type GallerySpeciesSource =
  | { kind: 'core' }
  | { kind: 'expansion'; expansionId: string; expansionName: string; expansionEnabled: boolean };

export interface GallerySpeciesRuntime {
  /** In the gameplay snapshot at all. False for a species in a disabled pack. */
  loaded: boolean;
  /** Enabled in the gameplay snapshot; `null` when not loaded. */
  enabled: boolean | null;
  /** Authored enabled, loaded disabled: the loader found no default artwork. */
  disabledByLoader: boolean;
}

export interface GalleryAppearanceCounts {
  /** Every appearance the content defines (the implicit `standard` counts as one). */
  authored: number;
  /** Appearances present in the gameplay snapshot; `null` when not loaded. */
  inRuntime: number | null;
  /** Authored appearances whose artwork file is available. */
  artworkAvailable: number;
}

export interface GalleryPrimaryArtwork {
  appearanceId: string;
  assetId: AssetId;
  status: GalleryArtworkStatus;
  format: SpeciesArtworkExtension | null;
}

export interface GallerySpeciesSummary {
  slug: string;
  name: string;
  rarity: Rarity;
  race: string;
  archetype: string;
  affinity: Affinity;
  contentRating: ContentRating;
  /** Raw tags. The Portal derives Zone from these; the API never does. */
  tags: string[];
  source: GallerySpeciesSource;
  /** `enabled` as written in the content file. */
  authoredEnabled: boolean;
  runtime: GallerySpeciesRuntime;
  appearanceCounts: GalleryAppearanceCounts;
  primary: GalleryPrimaryArtwork;
  issues: GalleryIssue[];
}

export interface GalleryAppearance {
  id: string;
  name: string;
  description: string | null;
  flavorText: string | null;
  cosmeticRarity: CosmeticRarity;
  introducedVersion: string | null;
  /** Effective rating: the appearance's own, else the species'. */
  contentRating: ContentRating;
  /** Whether {@link contentRating} is the appearance's override or inherited. */
  contentRatingSource: 'appearance' | 'species';
  sortOrder: number;
  tags: string[];
  unlock: AppearanceUnlock;
  unlockLabel: string;
  /** The `owned` entry — what a freshly-captured copy wears. */
  isDefault: boolean;
  /** Synthesized `standard` entry for a species that authors no catalog. */
  implicit: boolean;
  /** Always revealed here — this is the admin surface. */
  assetId: AssetId;
  /** Present in the gameplay snapshot. False for every appearance of an unloaded species. */
  inRuntime: boolean;
  artwork: GalleryArtwork;
  /** What the loader's asset pre-flight recorded about this appearance. */
  loaderDiagnostics: SpeciesArtworkDiagnosticCode[];
  issues: GalleryIssue[];
}

export interface GallerySpeciesDetail extends GallerySpeciesSummary {
  description: string;
  card: SpeciesCardMeta | null;
  buddyBonus: BuddyBonusContent | null;
  baseCaptureRate: number | null;
  eventKey: string | null;
  perSpeciesWeight: number;
  /** Every *authored* appearance, in display order — not only the survivors. */
  appearances: GalleryAppearance[];
  /** Every loader pre-flight record for this species. */
  loaderDiagnostics: SpeciesArtworkDiagnostic[];
}

export interface GalleryCatalogSummary {
  authoredSpecies: number;
  runtimeLoadedSpecies: number;
  runtimeEnabledSpecies: number;
  loaderDisabledSpecies: number;
  unloadedSpecies: number;
  authoredAppearances: number;
  runtimeAppearances: number;
  artworkAvailableAppearances: number;
  speciesWithIssues: number;
  /** Every code, zero included, so a client never guesses at absence. */
  issueCounts: Record<GalleryIssueCode, number>;
}

export interface GalleryCatalog {
  summary: GalleryCatalogSummary;
  species: GallerySpeciesSummary[];
}

// ── Catalog entries ──────────────────────────────────────────────────────────

/** One species as the gallery sees it: authored content, plus the runtime copy if any. */
interface CatalogEntry {
  authored: SpeciesContent;
  runtime: SpeciesContent | null;
  expansionId: string | null;
}

/**
 * Every authored species, runtime-loaded first (in load order), then those of
 * disabled packs. Reads only the snapshot — nothing is re-parsed from disk, so
 * what the gallery calls "authored" is exactly what the running loader read.
 *
 * A snapshot with no `authoring` record (hand-built in tests, or produced
 * without `loadContent`) is read as authored == runtime.
 */
function catalogEntries(content: LoadedContent): CatalogEntry[] {
  const authoredBySlug = new Map(
    (content.authoring?.species ?? []).map((s) => [s.slug, s] as const),
  );
  const loaded = content.species.map<CatalogEntry>((runtime) => ({
    authored: authoredBySlug.get(runtime.slug) ?? runtime,
    runtime,
    expansionId: content.speciesOrigin[runtime.slug] ?? null,
  }));
  const unloaded = (content.authoring?.unloadedSpecies ?? []).map<CatalogEntry>((u) => ({
    authored: u.species,
    runtime: null,
    expansionId: u.expansionId,
  }));
  return [...loaded, ...unloaded];
}

function findEntry(content: LoadedContent, slug: string): CatalogEntry | null {
  return catalogEntries(content).find((e) => e.authored.slug === slug) ?? null;
}

function sourceOf(content: LoadedContent, expansionId: string | null): GallerySpeciesSource {
  if (expansionId === null) return { kind: 'core' };
  const pack = content.expansions.find((e) => e.id === expansionId);
  return {
    kind: 'expansion',
    expansionId,
    expansionName: pack?.name ?? expansionId,
    expansionEnabled: pack?.enabled ?? false,
  };
}

function inspectArtwork(
  assetsDir: string,
  assetId: AssetId,
  withRenditions: boolean,
): GalleryArtwork {
  const inspected = inspectSpeciesArtwork(assetsDir, assetId);
  const artwork: GalleryArtwork = {
    status: inspected.status,
    // Species artwork candidates are only ever `.webp` or `.png`.
    format:
      inspected.status === 'available'
        ? (inspected.file.extension as SpeciesArtworkExtension)
        : null,
    storageStem: speciesArtworkStem(assetId),
  };
  if (withRenditions && inspected.status === 'available') {
    artwork.renditions = speciesArtworkRenditions(assetsDir, assetId);
  }
  return artwork;
}

function appearanceIssues(
  appearance: Pick<GalleryAppearance, 'id' | 'isDefault' | 'inRuntime' | 'artwork'>,
  speciesLoaded: boolean,
): GalleryIssue[] {
  const out: GalleryIssue[] = [];
  const { status, format, renditions } = appearance.artwork;
  if (status === 'missing') {
    out.push(
      issue(appearance.isDefault ? 'default_artwork_missing' : 'appearance_artwork_missing', appearance.id),
    );
  } else if (status === 'unsafe') {
    out.push(issue('artwork_unsafe', appearance.id));
  } else if (format === 'png') {
    out.push(issue('artwork_png_only', appearance.id));
  }
  if (speciesLoaded && !appearance.inRuntime) {
    out.push(issue('appearance_not_in_runtime', appearance.id));
  }
  if (renditions && Object.values(renditions).some((present) => !present)) {
    out.push(issue('renditions_missing', appearance.id));
  }
  return out;
}

function buildAppearances(
  entry: CatalogEntry,
  assetsDir: string,
  diagnostics: readonly SpeciesArtworkDiagnostic[],
  withRenditions: boolean,
): GalleryAppearance[] {
  const { authored, runtime } = entry;
  const runtimeIds = new Set(runtime ? resolveAppearances(runtime).map((a) => a.id) : []);
  const authoredCatalog = authored.appearances ?? [];
  const implicit = authoredCatalog.length === 0;

  return resolveAppearances(authored).map((resolved: ResolvedAppearance) => {
    const own = authoredCatalog.find((a) => a.id === resolved.id);
    const base = {
      id: resolved.id,
      isDefault: resolved.unlock.type === 'owned',
      inRuntime: runtimeIds.has(resolved.id),
      artwork: inspectArtwork(assetsDir, resolved.assetId, withRenditions),
    };
    return {
      ...base,
      name: resolved.name,
      description: resolved.description,
      flavorText: resolved.flavorText,
      cosmeticRarity: resolved.cosmeticRarity,
      introducedVersion: resolved.introducedVersion,
      contentRating: resolved.contentRating,
      contentRatingSource: own?.contentRating !== undefined ? 'appearance' : 'species',
      sortOrder: resolved.sortOrder,
      tags: resolved.tags,
      unlock: resolved.unlock,
      unlockLabel: resolved.unlockLabel,
      implicit,
      assetId: resolved.assetId,
      loaderDiagnostics: diagnostics
        .filter((d) => d.appearanceId === resolved.id)
        .map((d) => d.code),
      issues: appearanceIssues(base, runtime !== null),
    };
  });
}

function buildSpecies(
  content: LoadedContent,
  entry: CatalogEntry,
  assetsDir: string,
  withRenditions: boolean,
): { summary: GallerySpeciesSummary; appearances: GalleryAppearance[]; diagnostics: SpeciesArtworkDiagnostic[] } {
  const { authored, runtime } = entry;
  const diagnostics = (content.authoring?.artworkDiagnostics ?? []).filter(
    (d) => d.slug === authored.slug,
  );
  const appearances = buildAppearances(entry, assetsDir, diagnostics, withRenditions);
  const disabledByLoader = diagnostics.some(
    (d) => d.code === 'species_disabled_default_artwork_missing',
  );

  const speciesIssues: GalleryIssue[] = disabledByLoader
    ? [
        issue(
          'species_disabled_by_loader',
          diagnostics.find((d) => d.code === 'species_disabled_default_artwork_missing')!
            .appearanceId,
        ),
      ]
    : [];

  // `resolveAppearances` always yields an `owned` entry (schema-enforced when
  // authored, synthesized when not), so the fallback to the first is defensive.
  const primary = appearances.find((a) => a.isDefault) ?? appearances[0]!;

  return {
    summary: {
      slug: authored.slug,
      name: authored.name,
      rarity: authored.rarity,
      race: resolveRace(authored),
      archetype: authored.archetype,
      affinity: authored.affinity,
      contentRating: authored.contentRating,
      tags: [...authored.tags],
      source: sourceOf(content, entry.expansionId),
      authoredEnabled: authored.enabled,
      runtime: {
        loaded: runtime !== null,
        enabled: runtime ? runtime.enabled : null,
        disabledByLoader,
      },
      appearanceCounts: {
        authored: appearances.length,
        inRuntime: runtime ? appearances.filter((a) => a.inRuntime).length : null,
        artworkAvailable: appearances.filter((a) => a.artwork.status === 'available').length,
      },
      primary: {
        appearanceId: primary.id,
        assetId: primary.assetId,
        status: primary.artwork.status,
        format: primary.artwork.format,
      },
      issues: [...speciesIssues, ...appearances.flatMap((a) => a.issues)],
    },
    appearances,
    diagnostics,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The whole catalog, one entry per authored species, ordered by name.
 *
 * Checks the existence of every authored appearance's artwork (a few `realpath`
 * and `stat` calls each — no reads, no scanning). Renditions are *not* checked
 * here; `renditions_missing` is therefore a species-detail finding only, and
 * the list's issue counts never include it.
 */
export function buildGalleryCatalog(content: LoadedContent, assetsDir: string): GalleryCatalog {
  const built = catalogEntries(content).map((entry) => buildSpecies(content, entry, assetsDir, false));
  const species = built
    .map((b) => b.summary)
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));

  const issueCounts = Object.fromEntries(GALLERY_ISSUE_CODES.map((c) => [c, 0])) as Record<
    GalleryIssueCode,
    number
  >;
  for (const s of species) for (const i of s.issues) issueCounts[i.code] += 1;

  const loaded = species.filter((s) => s.runtime.loaded);
  return {
    summary: {
      authoredSpecies: species.length,
      runtimeLoadedSpecies: loaded.length,
      runtimeEnabledSpecies: loaded.filter((s) => s.runtime.enabled === true).length,
      loaderDisabledSpecies: species.filter((s) => s.runtime.disabledByLoader).length,
      unloadedSpecies: species.length - loaded.length,
      authoredAppearances: species.reduce((n, s) => n + s.appearanceCounts.authored, 0),
      runtimeAppearances: loaded.reduce((n, s) => n + (s.appearanceCounts.inRuntime ?? 0), 0),
      artworkAvailableAppearances: species.reduce(
        (n, s) => n + s.appearanceCounts.artworkAvailable,
        0,
      ),
      speciesWithIssues: species.filter((s) => s.issues.length > 0).length,
      issueCounts,
    },
    species,
  };
}

export type GalleryAppearanceLookup =
  | { status: 'found'; assetId: AssetId }
  | { status: 'species_not_found' }
  | { status: 'appearance_not_found' };

/**
 * The `AssetId` of one authored appearance, for serving its artwork.
 *
 * Resolved against the same authored catalog the gallery lists — runtime
 * species and disabled-pack species alike, and every authored appearance
 * whether or not the runtime kept it. The id comes from trusted content (the
 * authored `assetId`, or the species slug + appearance id), never from the
 * request. No filesystem access: existence is the caller's next step.
 */
export function findGalleryAppearance(
  content: LoadedContent,
  slug: string,
  appearanceId: string,
): GalleryAppearanceLookup {
  const entry = findEntry(content, slug);
  if (!entry) return { status: 'species_not_found' };
  const appearance = resolveAppearances(entry.authored).find((a) => a.id === appearanceId);
  if (!appearance) return { status: 'appearance_not_found' };
  return { status: 'found', assetId: appearance.assetId };
}

/**
 * One species with every authored appearance, including rendition presence.
 * `null` for a slug no content file defines — loaded or not.
 */
export function buildGallerySpeciesDetail(
  content: LoadedContent,
  assetsDir: string,
  slug: string,
): GallerySpeciesDetail | null {
  const entry = findEntry(content, slug);
  if (!entry) return null;
  const { summary, appearances, diagnostics } = buildSpecies(content, entry, assetsDir, true);
  const { authored } = entry;
  return {
    ...summary,
    description: authored.description,
    card: authored.card ?? null,
    buddyBonus: authored.buddyBonus ?? null,
    baseCaptureRate: authored.baseCaptureRate,
    eventKey: authored.eventKey,
    perSpeciesWeight: authored.perSpeciesWeight,
    appearances,
    loaderDiagnostics: diagnostics,
  };
}
