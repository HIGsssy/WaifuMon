/**
 * Where dungeon zones are read from, and how shipped zones reach the database.
 *
 * The same arrangement as reward tables (`rewardTableStore.ts`):
 * `content/dungeons/zones.json` holds the shipped defaults, the
 * `dungeon_zones` row is authoritative once it exists, and
 * {@link seedDungeonZones} runs at startup. Per shipped zone:
 *
 *   - no row → insert it;
 *   - row untouched since its last seed (`content_hash = seed_hash`) → update
 *     it to the shipped zone if that changed;
 *   - row edited by an admin (`content_hash ≠ seed_hash`) → leave it and
 *     report the divergence — unless the shipped zone now *equals* the row
 *     (the edit was exported and committed), in which case the row is adopted
 *     as shipped again.
 *
 * A zone that exists only in the database is never touched by the seed.
 *
 * Rows store the *parsed* definition — every default spelled out — so the
 * editor, an export and a run snapshot all see the same complete document.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { dungeonZones, type DungeonZoneRow } from '../../db/schema';
import { ContentValidationError } from '../../shared/errors';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import { REGIONS, regionLabel } from '../locations/regions';
import type { DungeonContentCatalogue } from './dungeonGenerator';
import type { DungeonEventDefinition } from './eventDefinitions';
import {
  DUNGEON_ZONE_FILE,
  DungeonZoneDefinitionSchema,
  DungeonZoneFileSchema,
  dungeonZoneHash,
  type DungeonZoneDefinition,
} from './zoneDefinition';

export const DUNGEON_SEED_ACTOR = 'seed';

/** One zone as shipped in Git. */
export interface ShippedDungeonZone {
  key: string;
  definition: DungeonZoneDefinition;
  hash: string;
}

/** Read the shipped zone file; a deployment without one ships no zones. */
export function loadShippedDungeonZones(contentDir: string): ShippedDungeonZone[] {
  const file = path.join(contentDir, ...DUNGEON_ZONE_FILE.split('/'));
  if (!fs.existsSync(file)) return [];
  const parsed = DungeonZoneFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new ContentValidationError(
      `${DUNGEON_ZONE_FILE}: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data.zones.map((definition) => ({
    key: definition.key,
    definition,
    hash: dungeonZoneHash(definition),
  }));
}

/** Parse a stored row. A row this build cannot read is loud, never coerced. */
export function parseDungeonZoneRow(row: Pick<DungeonZoneRow, 'zoneKey' | 'definition'>): DungeonZoneDefinition {
  const parsed = DungeonZoneDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) {
    throw new ContentValidationError(
      `dungeon zone "${row.zoneKey}" in the database does not parse: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** A region as dungeon authoring needs it. */
export interface DungeonRegionRef {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * The region catalogue zones may name: the loaded region content (core files
 * plus enabled expansion packs), in its authored order. A deployment that
 * ships no region files still has the closed set of region ids.
 */
export function dungeonRegionsFromContent(content: {
  regions?: readonly { id: string; name: string; enabled: boolean; order?: number }[] | undefined;
}): DungeonRegionRef[] {
  const regions = content.regions ?? [];
  if (regions.length === 0) return REGIONS.map((id) => ({ id, name: regionLabel(id), enabled: true }));
  return [...regions]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, name: r.name, enabled: r.enabled }));
}

export async function readDungeonZoneRow(tx: DbOrTx, key: string, lock = false): Promise<DungeonZoneRow | undefined> {
  const query = tx.select().from(dungeonZones).where(eq(dungeonZones.zoneKey, key));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** The generator's view of loaded content: what each enemy and event key names. */
export function dungeonCatalogueFromContent(content: {
  combatEnemies?: readonly CombatEnemyDefinition[] | undefined;
  dungeonEvents?: readonly DungeonEventDefinition[] | undefined;
}): DungeonContentCatalogue {
  const refs = (list: readonly { key: string; name: string; enabled: boolean }[] | undefined) =>
    new Map((list ?? []).map((c) => [c.key, { key: c.key, name: c.name, enabled: c.enabled }]));
  return { enemies: refs(content.combatEnemies), events: refs(content.dungeonEvents) };
}

export interface DungeonZoneDivergence {
  key: string;
  /** True when Git changed the zone since it was last seeded — that change was not applied. */
  shippedChanged: boolean;
  updatedBy: string | null;
  revision: number;
}

export interface DungeonZoneSeedResult {
  created: string[];
  updated: string[];
  /** Edited rows the shipped file has caught up with; now count as shipped again. */
  adopted: string[];
  diverged: DungeonZoneDivergence[];
  unchanged: number;
}

/**
 * Bring the database up to the shipped zones without overwriting an admin
 * edit. Idempotent; each zone is its own transaction with its row locked, so
 * a save racing the seed either lands first (and is then preserved) or waits.
 */
export async function seedDungeonZones(
  db: Db,
  shipped: readonly ShippedDungeonZone[],
): Promise<DungeonZoneSeedResult> {
  const result: DungeonZoneSeedResult = { created: [], updated: [], adopted: [], diverged: [], unchanged: 0 };
  for (const zone of shipped) {
    const values = {
      enabled: zone.definition.enabled,
      definition: zone.definition as unknown as Record<string, unknown>,
      contentHash: zone.hash,
      seedHash: zone.hash,
      position: zone.definition.order,
      updatedBy: DUNGEON_SEED_ACTOR,
    };
    await db.transaction(async (tx) => {
      const row = await readDungeonZoneRow(tx, zone.key, true);
      if (!row) {
        const inserted = await tx
          .insert(dungeonZones)
          .values({ zoneKey: zone.key, ...values })
          .onConflictDoNothing()
          .returning({ key: dungeonZones.zoneKey });
        if (inserted.length > 0) result.created.push(zone.key);
        else result.unchanged += 1;
        return;
      }
      if (row.contentHash === row.seedHash) {
        if (row.contentHash === zone.hash) {
          result.unchanged += 1;
          return;
        }
        await tx
          .update(dungeonZones)
          .set({ ...values, revision: sql`${dungeonZones.revision} + 1`, updatedAt: new Date() })
          .where(eq(dungeonZones.zoneKey, zone.key));
        result.updated.push(zone.key);
        return;
      }
      if (row.contentHash === zone.hash) {
        // The admin edit was promoted back into Git: the row is shipped again.
        // Nothing about the zone changes, so neither does its revision.
        await tx.update(dungeonZones).set({ seedHash: zone.hash }).where(eq(dungeonZones.zoneKey, zone.key));
        result.adopted.push(zone.key);
        return;
      }
      result.diverged.push({
        key: zone.key,
        shippedChanged: row.seedHash !== zone.hash,
        updatedBy: row.updatedBy,
        revision: row.revision,
      });
    });
  }
  return result;
}
