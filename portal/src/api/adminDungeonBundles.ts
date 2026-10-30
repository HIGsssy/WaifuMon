/**
 * Portal admin API client for Complete Dungeon Bundles (Content Portability
 * CP-4B). Maps 1:1 to `src/api/routes/v1/admin/dungeonBundles.ts`.
 *
 * Two formats, deliberately named apart in every screen:
 *
 *   - **Dungeon JSON** (`adminDungeons.ts`): the definition and its dependency
 *     evidence. Artwork, Scene Sprites, enemies' art and shared pools must
 *     already be on the destination.
 *   - **Complete Dungeon Bundle (ZIP)** (here): the same JSON plus the artwork
 *     bytes, enemies, Scene Sprites and shared pools it needs. Species, items,
 *     equipment, currencies, regions and legacy reward tables stay external
 *     prerequisites the review checks.
 */
import type { DungeonImportPlan, DungeonLootImportDecisions } from './adminDungeons';
import { postData, postDownload } from './client';

export type BundleReadiness = 'ready' | 'needs_enabling' | 'incomplete' | 'blocked';
export type BundleOutcome = 'create' | 'identical' | 'conflict';

export interface BundleIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface BundleDecisions {
  dungeon?: 'create' | 'replace' | 'unchanged';
  enemies?: Record<string, 'update' | 'keep'>;
  sceneSprites?: Record<string, 'update' | 'keep' | 'copy'>;
  sharedPools?: Record<string, 'update' | 'keep'>;
  lootTables?: DungeonLootImportDecisions;
  /** Repair mode: accept a draft that still lacks external prerequisites. */
  allowIncomplete?: boolean;
}

export interface BundleReference {
  dungeonKey: string;
  name: string;
  source: string;
}

export interface BundleSlotPlan {
  source: 'none' | 'managed' | 'shipped';
  destination: { kind: string; asset?: string; assetId?: string; path?: string };
  notes: string[];
}

export interface DungeonBundlePreview {
  bundle: {
    format: string;
    version: number;
    exportedAt: string;
    sourceEnvironment: string;
    origin: 'draft' | 'revision';
    draftRevision: number | null;
    publishedRevision: number | null;
    packageSchemaVersion: number;
    sceneSpriteEvidence: 'catalogue' | 'revision_snapshot' | null;
    bundleHash: string;
    warnings: { path: string; message: string }[];
  };
  dungeon: { key: string; name: string; decision: 'create' | 'replace' | 'unchanged'; plan: DungeonImportPlan };
  artwork: {
    dungeon: {
      usage: string[];
      source: 'managed' | 'shipped';
      path: string | null;
      asset: string;
      destination: 'shipped_file' | 'reuse' | 'create';
      rebound: boolean;
    }[];
    assets: {
      id: string;
      category: string;
      sha256: string;
      bytes: number;
      mimeType: string;
      width: number;
      height: number;
      name: string;
      action: 'reuse' | 'create' | 'not_needed';
      reuse: string[];
      usedBy: string[];
    }[];
  };
  sceneSprites: {
    key: string;
    name: string;
    outcome: BundleOutcome;
    changedFields: string[];
    archivedHere: boolean;
    references: BundleReference[];
    suggestedCopyKey: string;
    decision: 'update' | 'keep' | 'copy' | null;
    resultKey: string;
    asset: string;
    assetDestination: 'reuse' | 'create' | 'not_needed';
  }[];
  sharedPools: {
    key: string;
    name: string;
    outcome: BundleOutcome;
    changedFields: string[];
    enabledHere: boolean | null;
    enabledAfterImport: boolean;
    currentRevision: number | null;
    otherDungeons: BundleReference[];
    decision: 'update' | 'keep' | null;
    uses: 'bundled' | 'destination';
    species: { slug: string; status: 'available' | 'missing' | 'disabled' }[];
  }[];
  enemies: {
    key: string;
    name: string;
    outcome: 'create' | 'update' | 'conflict' | 'unchanged' | 'invalid';
    changedFields: string[];
    activation: { packageEnabled: boolean; enabled: boolean; reason: string } | null;
    references: { kind: string; key: string; name: string | null; usage: string }[];
    issues: { path: string; message: string }[];
    artwork: BundleSlotPlan;
    sprite: BundleSlotPlan;
    decision: 'update' | 'keep' | null;
  }[];
  prerequisites: {
    kind: 'species' | 'item' | 'equipment' | 'currency' | 'region' | 'reward_table';
    key: string;
    name: string;
    status: 'available' | 'missing' | 'disabled';
    notes: string[];
  }[];
  remainsDisabled: { kind: 'enemy' | 'shared_pool'; key: string; name: string; requiredForPublication: boolean }[];
  issues: BundleIssue[];
  decisionsRequired: string[];
  readiness: BundleReadiness;
  planHash: string;
}

export interface DungeonBundleImportResult {
  importId: number;
  requestId: string;
  replayed: boolean;
  dungeonKey: string;
  dungeonResult: 'created' | 'replaced' | 'unchanged';
  draftRevision: number;
  dungeonImportId: number;
  enabled: boolean;
  publishedRevision: number | null;
  readiness: BundleReadiness;
  enemies: { created: string[]; updated: string[]; skipped: string[]; unchanged: string[] };
  sceneSprites: { created: string[]; updated: string[]; copied: { from: string; to: string }[]; reused: string[]; kept: string[] };
  sharedPools: { created: string[]; updated: string[]; reused: string[]; kept: string[] };
  assets: { created: number; reused: number };
  createdLootTables: string[];
  remainsDisabled: DungeonBundlePreview['remainsDisabled'];
  issues: BundleIssue[];
}

/** The server's own limit is 64 MiB (`DUNGEON_BUNDLE_BODY_LIMIT_BYTES`); checked here only to fail fast. */
export const DUNGEON_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
/** Bundles carry images, so give them longer than an ordinary call. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000;
const ZIP_HEADERS = { 'Content-Type': 'application/zip' };

/** Decisions travel as base64url JSON in the query, so the ZIP stays the whole body. */
export function encodeBundleDecisions(decisions: BundleDecisions): string {
  const bytes = new TextEncoder().encode(JSON.stringify(decisions));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The dungeon, its artwork and transferable dependencies as a `.zip`.
 * Refusals (artwork that cannot travel, a missing sprite or pool) arrive as
 * `PortalApiError`s with `details.reason` and `details.issues`.
 */
export async function exportDungeonBundle(
  key: string,
  origin: 'draft' | 'published' | { revision: number },
): Promise<{ blob: Blob; filename: string }> {
  const body = origin === 'draft' ? {} : origin === 'published' ? { origin: 'published' } : { revision: origin.revision };
  const { blob, filename } = await postDownload(`/v1/admin/dungeons/definitions/${encodeURIComponent(key)}/export/bundle`, body, {
    timeout: BUNDLE_TIMEOUT_MS,
  });
  return { blob, filename: filename ?? `${key}.bundle.zip` };
}

/** Review an uploaded bundle against this server, optionally with a set of choices. Writes nothing. */
export function previewDungeonBundle(file: Blob, decisions: BundleDecisions = {}): Promise<DungeonBundlePreview> {
  return postData<DungeonBundlePreview>('/v1/admin/dungeons/import/bundle/preview', file, {
    headers: ZIP_HEADERS,
    timeout: BUNDLE_TIMEOUT_MS,
    params: { decisions: encodeBundleDecisions(decisions) },
  });
}

/**
 * Apply exactly the reviewed bundle. Reusing `requestId` for a retry returns
 * the first attempt's result instead of importing twice.
 */
export function applyDungeonBundle(
  file: Blob,
  request: { expectedPlanHash: string; requestId: string; decisions: BundleDecisions },
): Promise<DungeonBundleImportResult> {
  return postData<DungeonBundleImportResult>('/v1/admin/dungeons/import/bundle/apply', file, {
    headers: ZIP_HEADERS,
    timeout: BUNDLE_TIMEOUT_MS,
    params: { expectedPlanHash: request.expectedPlanHash, requestId: request.requestId, decisions: encodeBundleDecisions(request.decisions) },
  });
}
