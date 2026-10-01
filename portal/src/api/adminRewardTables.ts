/**
 * Portal admin API client for boss and expedition reward tables.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/rewardTables.ts`. A table travels as
 * the document the shipped JSON files hold (`bossRewards.json` /
 * `expeditionRewards.json`), so the editor round-trips fields it does not
 * render. Every write names the `revision` it edited; a save that lost a race
 * comes back as a 409 `REWARD_TABLE_STALE` rather than overwriting.
 */
import { deleteData, getData, postData, putData } from './client';

export type RewardTableKind = 'boss' | 'expedition';
export const REWARD_TABLE_KINDS: readonly RewardTableKind[] = ['boss', 'expedition'];

/** Where a table stands relative to Git. */
export type RewardTableOrigin = 'shipped' | 'edited' | 'custom';

export interface RewardTableIssue {
  /** `groups[2].equipment[0].definitionKeys[1]`, `buddyXp`, `enabled`… */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RewardTableReference {
  role: 'boss' | 'success' | 'bonus' | 'failure';
  key: string;
  name: string;
  enabled: boolean;
}

export interface RewardTableSummary {
  kind: RewardTableKind;
  id: string;
  enabled: boolean;
  version: string | null;
  revision: number;
  origin: RewardTableOrigin;
  /** Null when this build ships no table with this id. */
  matchesShipped: boolean | null;
  groupCount: number;
  itemRowCount: number;
  equipmentRowCount: number;
  references: RewardTableReference[];
  updatedAt: string;
  updatedBy: string | null;
}

// ── the document ────────────────────────────────────────────────────────────

export interface ItemRewardRowDoc {
  itemId: string;
  enabled?: boolean;
  weight: number;
  /** Required on boss rows; defaults to 1 on expedition rows. */
  quantity?: number;
  [extra: string]: unknown;
}

/** A gear row: a selector, a switch and a weight — never a multiplier or affix. */
export interface EquipmentRewardRowDoc {
  slot?: string;
  rarity?: string;
  definitionKeys?: string[];
  enabled?: boolean;
  weight: number;
  [extra: string]: unknown;
}

export interface RewardGroupDoc {
  id: string;
  enabled?: boolean;
  rolls?: number;
  chanceBasisPoints?: number;
  entries: ItemRewardRowDoc[];
  equipment?: EquipmentRewardRowDoc[];
  [extra: string]: unknown;
}

export interface AmountRange {
  min: number;
  max: number;
}

export interface RewardTableDoc {
  id: string;
  enabled?: boolean;
  version?: string;
  /** Boss tables. */
  buddyXp?: number;
  /** Expedition tables. */
  waifubux?: AmountRange;
  essence?: AmountRange;
  waifuXp?: number;
  playerXp?: number;
  groups: RewardGroupDoc[];
  [extra: string]: unknown;
}

export interface RewardTableDetail extends RewardTableSummary {
  table: RewardTableDoc;
  /** Problems with the stored table on this server now (e.g. a gear definition since disabled). */
  issues: RewardTableIssue[];
}

export interface RewardTableReferenceData {
  items: Array<{ slug: string; name: string; category: string }>;
  equipmentDefinitions: Array<{ key: string; name: string; slot: string; rarity: string; enabled: boolean }>;
}

export interface EquipmentCandidate {
  key: string;
  name: string;
  slot: string;
  rarity: string;
}

export interface EquipmentSelectorPreview {
  eligible: EquipmentCandidate[];
  issues: Array<{ path: string; message: string }>;
}

export interface RewardTableExport {
  kind: RewardTableKind;
  file: string;
  tables: RewardTableDoc[];
}

export interface RewardTableImportPlan {
  kind: RewardTableKind;
  entries: Array<{
    id: string;
    action: 'create' | 'update' | 'unchanged' | 'invalid';
    currentRevision: number | null;
    issues: RewardTableIssue[];
  }>;
  issues: RewardTableIssue[];
  canApply: boolean;
}

export const REWARD_TABLES_QUERY_KEY = ['admin', 'reward-tables'] as const;

const base = '/v1/admin/reward-tables';
const tableUrl = (kind: RewardTableKind, id: string) => `${base}/${kind}/${encodeURIComponent(id)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listRewardTables(
  kind?: RewardTableKind,
  signal?: AbortSignal,
): Promise<{ tables: RewardTableSummary[] }> {
  return getData(`${base}${kind ? `?kind=${kind}` : ''}`, opts(signal));
}

export function getRewardTable(kind: RewardTableKind, id: string, signal?: AbortSignal): Promise<RewardTableDetail> {
  return getData(tableUrl(kind, id), opts(signal));
}

export function getRewardTableReference(signal?: AbortSignal): Promise<RewardTableReferenceData> {
  return getData(`${base}/reference`, opts(signal));
}

export function validateRewardTable(
  kind: RewardTableKind,
  table: RewardTableDoc,
  id: string | undefined,
  signal?: AbortSignal,
): Promise<{ issues: RewardTableIssue[] }> {
  return postData(`${base}/${kind}/validate`, id ? { table, id } : { table }, opts(signal));
}

export function previewEquipmentSelectors(
  selectors: unknown[],
  signal?: AbortSignal,
): Promise<{ previews: EquipmentSelectorPreview[] }> {
  return postData(`${base}/equipment-preview`, { selectors }, opts(signal));
}

export function createRewardTable(kind: RewardTableKind, table: RewardTableDoc): Promise<RewardTableDetail> {
  return postData(`${base}/${kind}`, { table });
}

export function updateRewardTable(
  kind: RewardTableKind,
  id: string,
  table: RewardTableDoc,
  expectedRevision: number,
): Promise<RewardTableDetail> {
  return putData(tableUrl(kind, id), { table, expectedRevision });
}

export function resetRewardTable(
  kind: RewardTableKind,
  id: string,
  expectedRevision: number,
): Promise<RewardTableDetail> {
  return postData(`${tableUrl(kind, id)}/reset`, { expectedRevision });
}

export function deleteRewardTable(kind: RewardTableKind, id: string, expectedRevision: number): Promise<{ ok: boolean }> {
  return deleteData(`${tableUrl(kind, id)}?expectedRevision=${expectedRevision}`);
}

export function exportRewardTables(kind: RewardTableKind): Promise<RewardTableExport> {
  return getData(`${base}/${kind}/export`);
}

export function planRewardTableImport(kind: RewardTableKind, tables: unknown): Promise<RewardTableImportPlan> {
  return postData(`${base}/${kind}/import/plan`, { tables });
}

export function applyRewardTableImport(
  kind: RewardTableKind,
  tables: unknown,
  expectedRevisions: Record<string, number | null>,
): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
  return postData(`${base}/${kind}/import/apply`, { tables, expectedRevisions });
}
