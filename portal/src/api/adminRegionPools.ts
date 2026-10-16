/**
 * Portal admin API client for Region Pools: which Waifumon each region's hunt
 * can meet.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/regionPools.ts` (RP2B). The server owns
 * every rule and every number:
 *
 *   - **Drafts never reach hunts.** Save, discard, load-shipped and
 *     merge-shipped write the draft only; each names the `expectedDraftRevision`
 *     it edited and is refused with 409 `REGION_POOL_STALE` when someone else
 *     saved first.
 *   - **Publishing and rollback name a review.** `validate` (no entries) and
 *     `rollback-preview` return a `reviewHash` and the warning ids that must be
 *     acknowledged. Publish/rollback send them back unchanged; anything reviewed
 *     that changed since comes back as 409 `REGION_POOL_REVIEW_STALE`, and the
 *     Portal asks for a fresh review rather than retrying with the new hash.
 *   - **Odds come from `analysis`.** The Portal computes no probability.
 *
 * Deliberately separate from `adminDungeons.ts`: dungeon species pools are a
 * different model with different odds. Species thumbnails come from this
 * area's own `regions.read` artwork route, not the Dungeon one.
 */
import type { QueryClient } from '@tanstack/react-query';

import { apiClient, getData, postData, putData } from './client';

/** Hunted rarities in display order, then EX — which the hunt never rolls. */
export const REGION_POOL_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'] as const;
export const NOT_HUNTABLE_RARITY = 'EX';

/** The server's bounds (`regionPoolValidation.ts`), so a typo is caught before the round trip. */
export const REGION_POOL_MAX_ENTRIES = 500;
export const REGION_POOL_ENTRY_MAX_WEIGHT = 1_000_000;

export type RegionPoolIssueCode =
  | 'region_unknown'
  | 'entries_not_array'
  | 'entry_invalid'
  | 'too_many_entries'
  | 'species_unknown'
  | 'species_duplicate'
  | 'weight_invalid'
  | 'species_dungeon_exclusive'
  | 'region_exclusive_conflict'
  | 'pool_has_no_eligible_species'
  | 'species_disabled'
  | 'species_not_in_content'
  | 'species_not_huntable'
  | 'rarity_tier_empty'
  | 'region_not_released'
  | 'draft_unchanged'
  | 'revision_already_published'
  | 'draft_replaced_by_rollback';

export interface RegionPoolIssue {
  /** Stable: `code`, `code:species` or `code:rarity`. What an acknowledgement names. */
  id: string;
  code: RegionPoolIssueCode;
  severity: 'error' | 'warning';
  message: string;
  acknowledgementRequired: boolean;
  species?: string;
  rarity?: string;
  index?: number;
  /** Other regions involved (exclusive conflicts). */
  regions?: string[];
}

export interface RegionPoolEntry {
  species: string;
  weight: number;
}

export interface RegionPoolDiff {
  added: RegionPoolEntry[];
  removed: RegionPoolEntry[];
  reweighted: Array<{ species: string; from: number; to: number }>;
}

/** One pool entry with today's facts about her species. */
export interface RegionPoolEntryView extends RegionPoolEntry {
  name: string | null;
  rarity: string | null;
  enabled: boolean;
  inContent: boolean;
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  race: string | null;
  affinity: string | null;
  imagePath: string | null;
}

export interface RegionRef {
  id: string;
  name: string;
  /** The region file's `enabled` — owned by the region catalogue, not by this page. */
  released: boolean;
  isDefault: boolean;
}

export type RegionPoolRevisionSource = 'bootstrap' | 'editor' | 'rollback' | 'import';

export interface RegionPoolPublishedMeta {
  number: number;
  source: RegionPoolRevisionSource;
  rolledBackFrom: number | null;
  publishedAt: string;
  publishedBy: string | null;
  contentHash: string;
  entryCount: number;
}

export interface RegionPoolView {
  region: RegionRef;
  draft: {
    revision: number;
    hash: string;
    entries: RegionPoolEntryView[];
    updatedAt: string;
    updatedBy: string | null;
    unpublishedChanges: boolean;
  };
  published: (RegionPoolPublishedMeta & { entries: RegionPoolEntryView[] }) | null;
  /** Draft-level issues of the saved draft. */
  issues: RegionPoolIssue[];
}

export type RegionPoolDriftStatus = 'clean' | 'drift' | 'none';

export interface RegionPoolListItem {
  region: RegionRef;
  hasPool: boolean;
  draftRevision: number | null;
  unpublishedChanges: boolean;
  published: RegionPoolPublishedMeta | null;
  /** Published species per rarity. */
  rarityCounts: Record<string, number>;
  driftStatus: RegionPoolDriftStatus;
}

export interface RegionPoolReview {
  /** `publish` or `rollback:<n>`. */
  purpose: string;
  draftRevision: number;
  issues: RegionPoolIssue[];
  requiredAcknowledgements: string[];
  reviewHash: string;
  canPublish: boolean;
  diffFromPublished: RegionPoolDiff;
}

export interface RegionPoolShipped {
  available: boolean;
  hash: string | null;
  entries: RegionPoolEntry[];
  /** Slugs the region file names that no species row matches. */
  skipped: string[];
  diffFromDraft: RegionPoolDiff;
  diffFromPublished: RegionPoolDiff;
  /** Shipped species the draft does not list. */
  mergeCandidates: RegionPoolEntry[];
  weightConflicts: Array<{ species: string; draft: number; shipped: number }>;
}

export interface RegionPoolDrift {
  status: RegionPoolDriftStatus;
  publishedRevision: number | null;
  species: Array<{
    species: string;
    kind: 'disabled' | 'enabled' | 'missing_from_content' | 'rarity_changed' | 'tags_changed';
    from?: string;
    to?: string;
    addedTags?: string[];
    removedTags?: string[];
  }>;
  exclusiveConflicts: Array<{ species: string; regions: string[] }>;
  emptyTiers: Array<{ rarity: string; causedByContent: boolean }>;
  shipped: { available: boolean; differs: boolean; diff: RegionPoolDiff | null };
}

export interface RegionPoolHistoryItem extends RegionPoolPublishedMeta {
  current: boolean;
}

export interface RegionPoolRevisionDetail extends RegionPoolHistoryItem {
  entries: RegionPoolEntryView[];
  speciesManifest: Array<{ species: string; rarity: string; enabled: boolean; tags: string[] }>;
}

export interface RegionPoolEvent {
  /** Opaque paging cursor. */
  cursor: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface RegionPoolSpecies {
  slug: string;
  name: string;
  rarity: string;
  enabled: boolean;
  inContent: boolean;
  /** False for EX: the hunt never rolls her rarity. */
  huntable: boolean;
  regionExclusive: boolean;
  /** Never selectable for a region pool. */
  dungeonExclusive: boolean;
  race: string;
  affinity: string;
  imagePath: string;
  /** Regions whose published pool lists her. */
  publishedIn: string[];
}

export const DISTRIBUTION_MODES = ['hunt', 'scripted_spawn', 'filtered_selector'] as const;
export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];
export type ResolvingTier = 'region' | 'default_region' | 'global' | 'dead' | 'filtered';

export interface DistributionResult {
  mode: DistributionMode;
  level: number;
  encounterShare: number | null;
  rarities: Array<{
    rarity: string;
    baseWeight: number;
    effectiveWeight: number;
    rollProbability: number;
    probability: number;
    tier: ResolvingTier;
    candidates: number;
    unsafe: boolean;
  }>;
  species: Array<{
    slug: string;
    name: string;
    rarity: string;
    tier: ResolvingTier;
    inPool: boolean;
    weight: number;
    effectiveWeight: number;
    shareOfRarity: number;
    perEncounter: number;
    perHunt: number | null;
  }>;
  excluded: Array<{ slug: string; reason: string }>;
  exhausted: { probability: number; fallback: string } | null;
  errorProbability: number;
  issues: Array<{
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    rarity?: string;
  }>;
}

export interface RegionPoolAnalysis {
  source: 'draft' | 'published';
  assumptions: string[];
  result: DistributionResult;
  comparison: {
    against: 'draft' | 'published';
    result: DistributionResult;
    diff: {
      species: Array<{ slug: string; before: number; after: number; delta: number }>;
      rarities: Array<{
        rarity: string;
        tierBefore: ResolvingTier | null;
        tierAfter: ResolvingTier | null;
      }>;
    };
  } | null;
}

/** The selector filter the analysis accepts (`RandomSpeciesSelectionSchema` without `mode`). */
export interface RegionPoolSelectorFilter {
  poolScope?: 'region' | 'global';
  rarities?: string[];
  races?: string[];
  affinities?: string[];
}

export interface RegionPoolAnalysisRequest {
  source: 'draft' | 'published';
  mode: DistributionMode;
  level: number;
  buddySpecies?: string | null;
  ownedSpecies?: string[];
  filter?: RegionPoolSelectorFilter;
  compare?: boolean;
}

/** `details` of a 409 `REGION_POOL_STALE`. */
export interface RegionPoolStaleDetails {
  expectedDraftRevision?: number;
  currentDraftRevision?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

/** `details` of a 409 `REGION_POOL_REVIEW_STALE`. */
export interface RegionPoolReviewStaleDetails {
  issues?: RegionPoolIssue[];
  reviewHash?: string;
}

export interface RegionPoolReviewInput {
  expectedDraftRevision: number;
  reviewHash: string;
  acknowledgedWarnings: string[];
}

export const REGION_POOLS_QUERY_KEY = ['admin', 'region-pools'] as const;

export const regionPoolKeys = {
  list: () => [...REGION_POOLS_QUERY_KEY, 'list'] as const,
  species: () => [...REGION_POOLS_QUERY_KEY, 'species'] as const,
  region: (regionId: string) => [...REGION_POOLS_QUERY_KEY, 'region', regionId] as const,
  shipped: (regionId: string) => [...regionPoolKeys.region(regionId), 'shipped'] as const,
  drift: (regionId: string) => [...regionPoolKeys.region(regionId), 'drift'] as const,
  history: (regionId: string) => [...regionPoolKeys.region(regionId), 'history'] as const,
  revision: (regionId: string, n: number) =>
    [...regionPoolKeys.region(regionId), 'revision', n] as const,
  events: (regionId: string) => [...regionPoolKeys.region(regionId), 'events'] as const,
  analysis: (regionId: string, request: RegionPoolAnalysisRequest) =>
    [...regionPoolKeys.region(regionId), 'analysis', request] as const,
};

const base = '/v1/admin/region-pools';
const regionUrl = (regionId: string) => `${base}/${encodeURIComponent(regionId)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * Call after any write to a region. The list's badges, the picker's
 * "published in" and every derived view of that region are refreshed.
 */
export function invalidateRegionPoolQueries(queryClient: QueryClient, regionId?: string): void {
  void queryClient.invalidateQueries({ queryKey: regionPoolKeys.list() });
  void queryClient.invalidateQueries({ queryKey: regionPoolKeys.species() });
  if (regionId) void queryClient.invalidateQueries({ queryKey: regionPoolKeys.region(regionId) });
}

export function listRegionPools(signal?: AbortSignal): Promise<{ regions: RegionPoolListItem[] }> {
  return getData(base, opts(signal));
}

export function getRegionPoolSpecies(
  signal?: AbortSignal,
): Promise<{ species: RegionPoolSpecies[] }> {
  return getData(`${base}/species`, opts(signal));
}

/** A species' default artwork at thumbnail width. 404 when she has none; the thumbnail shows its placeholder. */
export async function regionSpeciesArtworkBlob(slug: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/species/artwork`, { params: { slug, width: 256 }, responseType: 'blob' });
  return response.data;
}

export function getRegionPool(regionId: string, signal?: AbortSignal): Promise<RegionPoolView> {
  return getData(regionUrl(regionId), opts(signal));
}

/** Refused with 400 `REGION_POOL_INVALID` (details.issues) or 409 `REGION_POOL_STALE`. */
export function saveRegionPoolDraft(
  regionId: string,
  entries: RegionPoolEntry[],
  expectedDraftRevision: number,
): Promise<RegionPoolView> {
  return putData(`${regionUrl(regionId)}/draft`, { entries, expectedDraftRevision });
}

/** Resets the saved draft to the published pool. */
export function discardRegionPoolDraft(
  regionId: string,
  expectedDraftRevision: number,
): Promise<RegionPoolView> {
  return postData(`${regionUrl(regionId)}/draft/discard`, { expectedDraftRevision });
}

export function getRegionPoolShipped(
  regionId: string,
  signal?: AbortSignal,
): Promise<RegionPoolShipped> {
  return getData(`${regionUrl(regionId)}/shipped`, opts(signal));
}

/** Replaces the draft with the region file's pool. Not published. */
export function loadShippedIntoDraft(
  regionId: string,
  expectedDraftRevision: number,
): Promise<RegionPoolView> {
  return postData(`${regionUrl(regionId)}/draft/load-shipped`, { expectedDraftRevision });
}

/** Appends shipped species the draft lacks (all, or the named ones). Keeps every existing entry and weight. */
export function mergeShippedIntoDraft(
  regionId: string,
  expectedDraftRevision: number,
  species?: string[],
): Promise<RegionPoolView> {
  return postData(`${regionUrl(regionId)}/draft/merge-shipped`, {
    expectedDraftRevision,
    ...(species ? { species } : {}),
  });
}

/** Dry run of an unsaved entry list: draft-level issues only. Writes nothing. */
export function validateRegionPoolEntries(
  regionId: string,
  entries: RegionPoolEntry[],
  signal?: AbortSignal,
): Promise<{ issues: RegionPoolIssue[] }> {
  return postData(`${regionUrl(regionId)}/validate`, { entries }, opts(signal));
}

/** The publish review of the saved draft: issues, acknowledgements and the reviewHash. */
export function reviewRegionPoolPublish(
  regionId: string,
  signal?: AbortSignal,
): Promise<RegionPoolReview> {
  return postData(`${regionUrl(regionId)}/validate`, {}, opts(signal));
}

/**
 * 409 `REGION_POOL_STALE` / `REGION_POOL_REVIEW_STALE`, 422
 * `REGION_POOL_PUBLISH_BLOCKED` / `REGION_POOL_ACKNOWLEDGEMENT_REQUIRED`.
 */
export function publishRegionPool(
  regionId: string,
  input: RegionPoolReviewInput,
): Promise<RegionPoolView> {
  return postData(`${regionUrl(regionId)}/publish`, input);
}

export function getRegionPoolHistory(
  regionId: string,
  signal?: AbortSignal,
): Promise<{ revisions: RegionPoolHistoryItem[] }> {
  return getData(`${regionUrl(regionId)}/revisions`, opts(signal));
}

export function getRegionPoolRevision(
  regionId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<RegionPoolRevisionDetail> {
  return getData(`${regionUrl(regionId)}/revisions/${revision}`, opts(signal));
}

export function previewRegionPoolRollback(
  regionId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<RegionPoolReview> {
  return getData(`${regionUrl(regionId)}/revisions/${revision}/rollback-preview`, opts(signal));
}

/** Publishes revision `revision`'s entries as a new revision and replaces the draft with them. */
export function rollbackRegionPool(
  regionId: string,
  input: RegionPoolReviewInput & { revision: number },
): Promise<RegionPoolView> {
  return postData(`${regionUrl(regionId)}/rollback`, input);
}

export function getRegionPoolEvents(
  regionId: string,
  page: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<{ events: RegionPoolEvent[] }> {
  return getData(`${regionUrl(regionId)}/events`, {
    params: {
      ...(page.limit ? { limit: page.limit } : {}),
      ...(page.before ? { before: page.before } : {}),
    },
    ...opts(signal),
  });
}

export function getRegionPoolDrift(
  regionId: string,
  signal?: AbortSignal,
): Promise<RegionPoolDrift> {
  return getData(`${regionUrl(regionId)}/drift`, opts(signal));
}

/** Exact odds, computed by the server. Writes nothing. */
export function analyseRegionPool(
  regionId: string,
  request: RegionPoolAnalysisRequest,
  signal?: AbortSignal,
): Promise<RegionPoolAnalysis> {
  return postData(`${regionUrl(regionId)}/analysis`, request, opts(signal));
}
