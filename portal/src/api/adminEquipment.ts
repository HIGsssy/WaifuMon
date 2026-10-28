/**
 * Portal admin API client for the Equipment Catalogue (Equipment 3.0, E3-D).
 *
 * Maps 1:1 to `src/api/routes/v1/admin/equipment.ts`. The server owns every
 * rule — the definition schema, key immutability, the slot and rarity locks,
 * roll-policy feasibility, and the Catalogue's own: new definitions start
 * disabled, an edit never changes the enabled state, and enabling gear that
 * joins automatic rewards needs an acknowledgement. This client only carries
 * requests and names the error codes the pages react to.
 *
 * Every write names the `revision` it edited; a save that lost a race comes
 * back as a 409 `EQUIPMENT_DEFINITION_STALE` rather than overwriting.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { ArtworkDirectory, ArtworkSearchResults } from './adminArtwork';
import { apiClient, getData, postData, putData } from './client';

const base = '/v1/admin/equipment';
export const EQUIPMENT_CATALOGUE_QUERY_KEY = ['admin', 'equipment'] as const;

export const EQUIPMENT_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'] as const;
export type EquipmentRarity = (typeof EQUIPMENT_RARITIES)[number];
/** The rarities whose roll policy (primary SP, bonus maximum) is authorable. */
export const HIGH_RARITIES: readonly EquipmentRarity[] = ['SSR', 'UR', 'LR'];
export const EQUIPMENT_SLOTS = ['attack', 'defense', 'health'] as const;
export type EquipmentSlotName = (typeof EQUIPMENT_SLOTS)[number];
export const SLOT_LABELS: Record<EquipmentSlotName, string> = {
  attack: 'Attack',
  defense: 'Defense',
  health: 'Health',
};
/** The server's bounds, so a typo is caught before the round trip. */
export const EQUIPMENT_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const EQUIPMENT_KEY_MAX_LENGTH = 64;
export const SAMPLE_ROLL_MAX = 20;

export interface EquipmentIssue {
  path: string;
  message: string;
}

/** Everything an author sets on a definition. `key` is fixed once created. */
export interface EquipmentDefinitionInput {
  key: string;
  name: string;
  description: string;
  slot: EquipmentSlotName;
  rarity: EquipmentRarity;
  multiplierMinBp: number;
  multiplierMaxBp: number;
  multiplierStepBp: number;
  primarySpEligible: boolean;
  /** 0–3, or null for the rarity's own ceiling. */
  maxAdditionalBonuses: number | null;
  /** Reserved; always empty. Round-tripped untouched. */
  secondaryEffects: unknown[];
  tags: string[];
  regionId: string | null;
  artworkPath: string | null;
  enabled: boolean;
  /** Unused by any shop yet; round-tripped untouched. */
  shopRegions: string[];
  buyPrice: number | null;
  priceCurrency: string;
}

export interface CatalogueDefinition extends EquipmentDefinitionInput {
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  ownedCount: number;
  instanceCount: number;
}

export interface BonusFamilyRange {
  stat: string;
  label: string;
  unit: 'percent' | 'sp';
  min: number;
  max: number;
  step: number;
}

interface MultiplierInfo {
  min: number;
  max: number;
  step: number;
  values: number;
}

export type RollAnalysis =
  | {
      mode: 'legacy';
      rarity: string;
      multiplier: MultiplierInfo;
      bonusChanceBp: number;
      bonusCount: number;
      families: BonusFamilyRange[];
      affixPool: string;
      enabledAffixes: number;
      issues: EquipmentIssue[];
    }
  | {
      mode: 'high';
      rarity: string;
      rulesRevision: number | null;
      configured: boolean;
      rollable: boolean;
      issues: EquipmentIssue[];
      multiplier: MultiplierInfo;
      primarySpEligible: boolean;
      maxAdditionalBonuses: number | null;
      counts: { count: number; probability: number }[];
      families: BonusFamilyRange[];
      primarySp: { probability: number; min: number; max: number; step: number } | null;
      affix:
        | { mode: 'none' }
        | { mode: 'library'; library: string; revision: number | null; candidates: number | null };
      spRange: { min: number; max: number };
    }
  | { mode: 'unsupported'; rarity: string; issues: EquipmentIssue[] };

export interface Availability {
  enabled: boolean;
  rollConfiguration: 'legacy' | 'published' | 'unconfigured' | 'invalid' | 'unsupported';
  rollable: boolean;
  rewardRarity: boolean;
  summary: string;
}

export interface CatalogueDetail {
  definition: CatalogueDefinition;
  locks: { slotLocked: boolean; rarityLocked: boolean; instanceCount: number };
  roll: RollAnalysis;
  availability: Availability;
}

export interface CataloguePage {
  definitions: CatalogueDefinition[];
  total: number;
  page: number;
  pageSize: number;
  counts: { total: number; enabled: number; disabled: number; byRarity: Record<string, number> };
}

export type CatalogueSort = 'key' | 'name' | 'rarity' | 'slot' | 'updated' | 'owned';
export interface CatalogueQuery {
  q?: string;
  rarity?: EquipmentRarity;
  slot?: EquipmentSlotName;
  status?: 'enabled' | 'disabled';
  sort?: CatalogueSort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface RewardImpactEntry {
  source:
    | 'boss_reward_table'
    | 'expedition_reward_table'
    | 'world_encounter'
    | 'workshop_recipe'
    | 'dungeon_loot_table';
  key: string;
  name: string;
  location: string;
  selector: string;
  when: 'immediately' | 'next_deploy' | 'next_publish';
}

export interface RewardImpact {
  rewardRarity: boolean;
  automatic: RewardImpactEntry[];
  deferred: RewardImpactEntry[];
}

export interface SampleRoll {
  displayName: string;
  rolledMultiplierBp: number;
  affixKey: string | null;
  combatBonuses: { stat: string; valueBp: number }[];
  primarySp: number;
  totalFlatSp: number;
}

export interface RollPreview {
  analysis: RollAnalysis;
  availability: Availability;
  samples: SampleRoll[] | null;
  seed: number | null;
  sampleError: string | null;
}

export interface EquipmentPackageFile {
  format: string;
  version: number;
  exportedAt: string | null;
  label: string | null;
  definitions: Record<string, unknown>[];
}

export interface ImportPlanEntry {
  key: string;
  action: 'create' | 'update' | 'unchanged';
  changedFields: string[];
}

export interface ImportStatusNote {
  key: string;
  packageEnabled: boolean;
  enabled: boolean;
  reason: 'new_definitions_start_disabled' | 'existing_status_kept';
}

export interface ImportPreview {
  entries: ImportPlanEntry[];
  issues: EquipmentIssue[];
  counts: { create: number; update: number; unchanged: number };
  ok: boolean;
  planHash: string;
  statusNotes: ImportStatusNote[];
  rewardImpact: { key: string; impact: RewardImpact }[];
}

export interface ImportResult {
  plan: Omit<ImportPreview, 'planHash' | 'statusNotes' | 'rewardImpact'>;
  logId: number;
  planHash: string;
  statusNotes: ImportStatusNote[];
}

export interface CatalogueHistory {
  events: {
    id: number;
    key: string;
    action: string;
    actor: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }[];
  imports: {
    id: number;
    actor: string | null;
    appliedAt: string;
    packageVersion: number;
    packageLabel: string | null;
    sourceFilename: string | null;
    created: number;
    updated: number;
    unchanged: number;
    definitionKeys: string[];
  }[];
}

/** `details` of a 409 `EQUIPMENT_DEFINITION_STALE`. */
export interface EquipmentStaleDetails {
  expectedRevision?: number;
  currentRevision?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listCatalogue(query: CatalogueQuery, signal?: AbortSignal): Promise<CataloguePage> {
  return getData<CataloguePage>(`${base}/definitions`, { params: query, ...signalOf(signal) });
}

export function getCatalogueDefinition(
  key: string,
  signal?: AbortSignal,
): Promise<CatalogueDetail> {
  return getData<CatalogueDetail>(
    `${base}/definitions/${encodeURIComponent(key)}`,
    signalOf(signal),
  );
}

export function validateCatalogueDefinition(
  definition: EquipmentDefinitionInput,
  opts: { creating: boolean; key?: string },
): Promise<{ issues: EquipmentIssue[] }> {
  return postData(`${base}/definitions/validate`, { definition, ...opts });
}

export function createCatalogueDefinition(
  definition: EquipmentDefinitionInput,
): Promise<CatalogueDetail> {
  return postData<CatalogueDetail>(`${base}/definitions`, { definition });
}

export function updateCatalogueDefinition(
  key: string,
  definition: EquipmentDefinitionInput,
  expectedRevision: number,
): Promise<CatalogueDetail> {
  return putData<CatalogueDetail>(`${base}/definitions/${encodeURIComponent(key)}`, {
    definition,
    expectedRevision,
  });
}

export function setCatalogueDefinitionEnabled(
  key: string,
  enabled: boolean,
  expectedRevision: number,
  acknowledgeRewardImpact = false,
): Promise<CatalogueDetail> {
  return putData<CatalogueDetail>(`${base}/definitions/${encodeURIComponent(key)}/enabled`, {
    enabled,
    expectedRevision,
    ...(acknowledgeRewardImpact ? { acknowledgeRewardImpact: true } : {}),
  });
}

export function duplicateCatalogueDefinition(
  key: string,
  body: { key: string; name?: string },
): Promise<CatalogueDetail> {
  return postData<CatalogueDetail>(
    `${base}/definitions/${encodeURIComponent(key)}/duplicate`,
    body,
  );
}

export function getRewardImpact(key: string, signal?: AbortSignal): Promise<RewardImpact> {
  return getData<RewardImpact>(
    `${base}/definitions/${encodeURIComponent(key)}/impact`,
    signalOf(signal),
  );
}

export function previewEquipmentRoll(
  target: { key: string } | { definition: EquipmentDefinitionInput },
  opts: { seed?: number; count?: number } = {},
): Promise<RollPreview> {
  return postData<RollPreview>(`${base}/roll-preview`, { ...target, ...opts });
}

export function exportCatalogue(
  opts: { keys?: string[]; query?: CatalogueQuery } = {},
): Promise<EquipmentPackageFile> {
  const params: Record<string, unknown> = { ...(opts.query ?? {}) };
  if (opts.keys && opts.keys.length > 0) params.keys = opts.keys.join(',');
  return getData<EquipmentPackageFile>(`${base}/export`, { params });
}

export function previewEquipmentImport(pkg: unknown): Promise<ImportPreview> {
  return postData<ImportPreview>(`${base}/import/preview`, { package: pkg });
}

export function applyEquipmentImport(
  pkg: unknown,
  expectedPlanHash: string,
  sourceFilename?: string,
): Promise<ImportResult> {
  return postData<ImportResult>(`${base}/import/apply`, {
    package: pkg,
    expectedPlanHash,
    ...(sourceFilename ? { sourceFilename } : {}),
  });
}

export function getCatalogueHistory(key?: string, signal?: AbortSignal): Promise<CatalogueHistory> {
  return getData<CatalogueHistory>(`${base}/history`, {
    params: key ? { key } : {},
    ...signalOf(signal),
  });
}

export async function equipmentArtworkBlob(path: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/artwork`, {
    params: { path },
    responseType: 'blob',
  });
  return response.data;
}

export function browseEquipmentArtwork(
  path: string | undefined,
  signal?: AbortSignal,
): Promise<ArtworkDirectory> {
  return getData<ArtworkDirectory>(`${base}/artwork/browse`, {
    params: path ? { path } : {},
    ...signalOf(signal),
  });
}

export function searchEquipmentArtwork(
  query: string,
  signal?: AbortSignal,
): Promise<ArtworkSearchResults> {
  return getData<ArtworkSearchResults>(`${base}/artwork/search`, {
    params: { q: query },
    ...signalOf(signal),
  });
}

export function invalidateCatalogueQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: EQUIPMENT_CATALOGUE_QUERY_KEY });
}

/** A basis-point multiplier as players read it: `12500` → `×1.25`. */
export function formatMultiplier(bp: number): string {
  return `×${(bp / 10_000).toFixed(2).replace(/\.?0+$/, '') || '0'}`;
}

/** A basis-point percentage: `525` → `5.25%`. */
export function formatPercentBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** A family's value in its own unit. */
export function formatFamilyValue(unit: 'percent' | 'sp', value: number): string {
  return unit === 'sp' ? `+${value} SP` : formatPercentBp(value);
}
