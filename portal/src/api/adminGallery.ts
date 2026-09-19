/**
 * Portal admin API client for the Waifumon Gallery.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/gallery.ts`, every route gated on
 * `gallery.read`. The Portal is a separate package and cannot import the
 * server's types, so the wire shapes are restated here — field for field with
 * the route's response schemas, which are what the server actually serializes.
 *
 * Artwork bytes are not fetched through this module: the gallery's `<img>`
 * elements address the secure artwork route through the image resolver
 * (`images/providers/adminGalleryApi.ts`), authenticated by the session cookie.
 */
import { getData } from './client';
import type { Affinity, ContentRating, CosmeticRarity, Rarity } from './types';

/**
 * Issue codes the server emits today. Typed open-ended on the wire: a newer
 * server may add codes, and an older Portal must render them rather than crash.
 */
export type KnownGalleryIssueCode =
  | 'species_disabled_by_loader'
  | 'default_artwork_missing'
  | 'appearance_artwork_missing'
  | 'artwork_unsafe'
  | 'appearance_not_in_runtime'
  | 'artwork_png_only'
  | 'renditions_missing';

// `string & {}` keeps editor completion for the known codes while accepting any string.
export type GalleryIssueCode = KnownGalleryIssueCode | (string & {});

export type KnownLoaderDiagnosticCode =
  | 'species_disabled_default_artwork_missing'
  | 'default_appearance_artwork_missing'
  | 'appearance_dropped_artwork_missing';

export type LoaderDiagnosticCode = KnownLoaderDiagnosticCode | (string & {});

export interface GalleryIssue {
  code: GalleryIssueCode;
  severity: 'error' | 'warning';
  /** The appearance concerned; `null` for the species as a whole. */
  appearanceId: string | null;
}

export type GalleryArtworkStatus = 'available' | 'missing' | 'unsafe';
export type GalleryArtworkFormat = 'webp' | 'png';

export interface GalleryAssetId {
  kind: 'waifumon';
  slug: string;
  variant: string;
}

export type GallerySpeciesSource =
  | { kind: 'core' }
  | { kind: 'expansion'; expansionId: string; expansionName: string; expansionEnabled: boolean };

export interface GallerySpeciesSummary {
  slug: string;
  name: string;
  rarity: Rarity;
  race: string;
  archetype: string;
  affinity: Affinity;
  contentRating: ContentRating;
  /** Raw tags. Zone is derived from these by `lib/zone.ts`, never by the server. */
  tags: string[];
  source: GallerySpeciesSource;
  /** `enabled` as written in the content file. */
  authoredEnabled: boolean;
  runtime: {
    /** In the gameplay snapshot at all. False for a species in a disabled pack. */
    loaded: boolean;
    /** Enabled in the gameplay snapshot; `null` when not loaded. */
    enabled: boolean | null;
    /** Authored enabled, loaded disabled: the loader found no default artwork. */
    disabledByLoader: boolean;
  };
  appearanceCounts: {
    authored: number;
    inRuntime: number | null;
    artworkAvailable: number;
  };
  primary: {
    appearanceId: string;
    assetId: GalleryAssetId;
    status: GalleryArtworkStatus;
    format: GalleryArtworkFormat | null;
  };
  issues: GalleryIssue[];
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
  issueCounts: Record<string, number>;
}

export interface GalleryCatalog {
  summary: GalleryCatalogSummary;
  species: GallerySpeciesSummary[];
}

export interface GalleryAppearance {
  id: string;
  name: string;
  description: string | null;
  flavorText: string | null;
  cosmeticRarity: CosmeticRarity;
  introducedVersion: string | null;
  contentRating: ContentRating;
  contentRatingSource: 'appearance' | 'species';
  sortOrder: number;
  tags: string[];
  unlock: { type: string; atLevel?: number };
  unlockLabel: string;
  isDefault: boolean;
  /** Synthesized `standard` entry for a species that authors no catalog. */
  implicit: boolean;
  assetId: GalleryAssetId;
  /** Present in the gameplay snapshot. */
  inRuntime: boolean;
  artwork: {
    status: GalleryArtworkStatus;
    format: GalleryArtworkFormat | null;
    storageStem: string;
    /** Width → pre-generated rendition present. Absent unless the file is available. */
    renditions?: Record<string, boolean>;
  };
  loaderDiagnostics: LoaderDiagnosticCode[];
  issues: GalleryIssue[];
}

export interface GalleryLoaderDiagnostic {
  code: LoaderDiagnosticCode;
  slug: string;
  appearanceId: string;
  assetId: GalleryAssetId;
}

export interface GalleryBuddyBonus {
  name?: string;
  flavorText?: string;
  effectId?: string;
  value?: number;
  target?: { type: string; value: string };
}

export interface GallerySpeciesDetail extends GallerySpeciesSummary {
  description: string;
  card: Record<string, unknown> | null;
  buddyBonus: GalleryBuddyBonus | null;
  baseCaptureRate: number | null;
  eventKey: string | null;
  perSpeciesWeight: number;
  appearances: GalleryAppearance[];
  loaderDiagnostics: GalleryLoaderDiagnostic[];
}

/** Every authored species, loaded or not — one request for the whole gallery. */
export function getAdminGalleryCatalog(signal?: AbortSignal): Promise<GalleryCatalog> {
  return getData<GalleryCatalog>('/v1/admin/gallery/species', signal ? { signal } : {});
}

/** One species with every authored appearance — one request per detail page. */
export function getAdminGallerySpecies(
  slug: string,
  signal?: AbortSignal,
): Promise<GallerySpeciesDetail> {
  return getData<GallerySpeciesDetail>(
    `/v1/admin/gallery/species/${encodeURIComponent(slug)}`,
    signal ? { signal } : {},
  );
}
