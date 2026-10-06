/**
 * Portal admin API client for the Enemy Catalogue.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/enemies.ts`. Combat enemies are shared
 * content: dungeons and Combat Trials reference them **by key**, and they are
 * authored here rather than inside either. Every write names the `revision`
 * it edited; a save that lost a race comes back as a 409 `ENEMY_STALE` rather
 * than overwriting.
 *
 * An enemy is disabled, not deleted: a disabled enemy keeps every reference
 * to it and is only withdrawn from new use. Delete exists for a mistake
 * nothing references, and is refused (`ENEMY_IN_USE`) otherwise.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { SpritePlacement } from './adminArtworkAssets';
import { DUNGEONS_QUERY_KEY } from './adminDungeons';
import { deleteData, getData, postData, putData } from './client';

export type EnemyOrigin = 'shipped' | 'edited' | 'custom';

/** The server's bounds, so a typo is caught before the round trip. */
export const ENEMY_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const ENEMY_KEY_MAX_LENGTH = 64;
export const ENEMY_NAME_MAX_LENGTH = 100;
export const ENEMY_DESCRIPTION_MAX_LENGTH = 500;
export const ENEMY_MAX_TAGS = 20;
export const ENEMY_STAT_MAX = 1_000_000;
export const ENEMY_STAT_MIN = { attack: 1, defense: 0, hp: 1 } as const;
export type EnemyStat = keyof typeof ENEMY_STAT_MIN;

export interface EnemyIssue {
  /** `name`, `attack`, `tags[2]`, `artworkAssetId`, `key`… */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** One place an enemy is used, in one piece of authored content. */
export interface EnemyReference {
  /** `dungeon_zone`, `combat_trial`, or a kind a later system adds. */
  kind: string;
  /** That content's own key. */
  key: string;
  name: string | null;
  /** The slot inside it, in admin words: `combat pool`, `room "Gatehouse" (boss)`, `primary enemy`. */
  usage: string;
}

/** The artwork in effect: managed where set, shipped otherwise. */
export interface EnemyVisual {
  artworkAssetId: string | null;
  artworkPath: string | null;
  spriteAssetId: string | null;
  spriteArtworkPath: string | null;
  spritePlacement: SpritePlacement;
}

/** What a picker row needs — and all a picker gets. Also the Dungeon editor's reference rows. */
export interface EnemyRef {
  key: string;
  name: string;
  enabled: boolean;
  attack: number;
  defense: number;
  hp: number;
  tags: string[];
  visual: EnemyVisual;
}

export interface EnemySummary extends EnemyRef {
  description: string;
  /** Shipped artwork paths: the fallback when no managed artwork is set. */
  artworkPath: string | null;
  spriteArtworkPath: string | null;
  /** Managed artwork (uploaded through the Portal); local to this environment. */
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  /** The authored placement; null means the system default. */
  spritePlacement: SpritePlacement | null;
  revision: number;
  origin: EnemyOrigin;
  /** Null when this build ships no enemy with this key. */
  matchesShipped: boolean | null;
  /** How many places name this enemy. */
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/** An enemy as `content/combat/enemies.json` holds it. */
export interface EnemyDefinition {
  key: string;
  name: string;
  description: string;
  attack: number;
  defense: number;
  hp: number;
  artworkPath: string | null;
  spriteArtworkPath: string | null;
  spritePlacement: SpritePlacement | null;
  enabled: boolean;
  tags: string[];
}

export interface EnemyDetail extends EnemySummary {
  references: EnemyReference[];
  /** Problems with the stored enemy on this server now (e.g. disabled but still referenced). */
  issues: EnemyIssue[];
  /** This build's shipped enemy of the same key, to show what an edit changed. */
  shipped: EnemyDefinition | null;
}

/**
 * What an admin may set. The key is fixed at creation and travels beside it.
 * An artwork field left out is kept as it is; `null` clears a managed asset
 * back to the shipped fallback (or the placement back to the default).
 */
export interface EnemyInput {
  name: string;
  description?: string;
  enabled: boolean;
  attack: number;
  defense: number;
  hp: number;
  tags?: string[];
  artworkAssetId?: string | null;
  spriteAssetId?: string | null;
  spritePlacement?: SpritePlacement | null;
}

export interface EnemyExport {
  /** Where the document belongs in Git, relative to the content directory. */
  file: string;
  document: { format: string; version: number; enemies: EnemyDefinition[] };
  /** Managed artwork the document does NOT carry: uploads that exist in this environment only. */
  environmentLocal: {
    note: string;
    managedArtwork: Array<{
      key: string;
      artworkAssetId: string | null;
      spriteAssetId: string | null;
    }>;
  };
}

/** `details` of a 409 `ENEMY_STALE`. */
export interface EnemyStaleDetails {
  expectedRevision?: number;
  currentRevision?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

export const ENEMIES_QUERY_KEY = ['admin', 'enemies'] as const;

const base = '/v1/admin/enemies';
const enemyUrl = (key: string) => `${base}/${encodeURIComponent(key)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * Call after any enemy write. The Dungeon editor's pickers read enemies from
 * the dungeon reference data, so that is refreshed too — a new enemy is
 * pickable there straight away.
 */
export function invalidateEnemyQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ENEMIES_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: [...DUNGEONS_QUERY_KEY, 'reference'] });
}

export function listEnemies(signal?: AbortSignal): Promise<{ enemies: EnemySummary[] }> {
  return getData(base, opts(signal));
}

/** Picker rows for every enemy, disabled ones included. */
export function getEnemyReference(signal?: AbortSignal): Promise<{ enemies: EnemyRef[] }> {
  return getData(`${base}/reference`, opts(signal));
}

export function getEnemy(key: string, signal?: AbortSignal): Promise<EnemyDetail> {
  return getData(enemyUrl(key), opts(signal));
}

export function getEnemyReferences(
  key: string,
  signal?: AbortSignal,
): Promise<{ references: EnemyReference[] }> {
  return getData(`${enemyUrl(key)}/references`, opts(signal));
}

/** Dry run: every issue creating (`creating`) or saving this enemy would raise. Writes nothing. */
export function validateEnemy(
  key: string,
  enemy: EnemyInput,
  creating: boolean,
  signal?: AbortSignal,
): Promise<{ issues: EnemyIssue[] }> {
  return postData(`${base}/validate`, { key, enemy, creating }, opts(signal));
}

/** Refused with 400 `ENEMY_INVALID` (details.issues) or 409 `ENEMY_KEY_TAKEN`. */
export function createEnemy(key: string, enemy: EnemyInput): Promise<EnemyDetail> {
  return postData(base, { key, enemy });
}

export function updateEnemy(
  key: string,
  enemy: EnemyInput,
  expectedRevision: number,
): Promise<EnemyDetail> {
  return putData(enemyUrl(key), { enemy, expectedRevision });
}

export function setEnemyEnabled(
  key: string,
  enabled: boolean,
  expectedRevision: number,
): Promise<EnemyDetail> {
  return putData(`${enemyUrl(key)}/enabled`, { enabled, expectedRevision });
}

/** A copy under a new key. It starts disabled, whatever the source was. */
export function duplicateEnemy(
  sourceKey: string,
  input: { key: string; name?: string; copyArtwork?: boolean },
): Promise<EnemyDetail> {
  return postData(`${enemyUrl(sourceKey)}/duplicate`, input);
}

/** Refused with 409 `ENEMY_IN_USE` (details.references, details.shipped) while anything names it. */
export function deleteEnemy(key: string, expectedRevision: number): Promise<{ ok: boolean }> {
  return deleteData(enemyUrl(key), { params: { expectedRevision } });
}

export function exportEnemies(): Promise<EnemyExport> {
  return getData(`${base}/export`);
}
