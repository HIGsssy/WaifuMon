/**
 * Where enemies are used.
 *
 * One lookup for the whole game: the Enemy editor's Usage section, the usage
 * count in the list and the delete guard all read it. A system that names
 * enemies contributes an {@link EnemyReferenceSource}; the catalogue service
 * is handed the list and knows nothing about any of them.
 *
 * Two sources exist today:
 *
 *   - dungeon zones — the stored zone documents, both the procedural pools
 *     and the authored rooms (a zone keeps both whichever layout it uses);
 *   - Combat Trials — the shipped Trial definitions.
 */
import { asc } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { dungeonZones } from '../../db/schema';
import type { EnemyReference } from '../../shared/errors';

export type { EnemyReference };

/** A reference, tagged with the enemy it points at. */
export interface EnemyReferenceEntry extends EnemyReference {
  enemyKey: string;
}

/** Every place one system names an enemy. Reads inside the caller's transaction. */
export type EnemyReferenceSource = (tx: DbOrTx) => Promise<EnemyReferenceEntry[]>;

const ENEMY_POOLS = ['combat', 'elite', 'miniboss', 'boss'] as const;

/** The enemies one stored zone document names, de-duplicated per slot. */
export function zoneDocumentEnemyReferences(
  zoneKey: string,
  definition: unknown,
): EnemyReferenceEntry[] {
  const doc = (definition ?? {}) as {
    name?: unknown;
    pools?: Record<string, unknown>;
    authored?: { rooms?: unknown };
  };
  const name = typeof doc.name === 'string' ? doc.name : null;
  const out: EnemyReferenceEntry[] = [];
  const seen = new Set<string>();
  const add = (enemyKey: unknown, usage: string) => {
    if (typeof enemyKey !== 'string' || enemyKey === '') return;
    const id = `${enemyKey}\u0000${usage}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ enemyKey, kind: 'dungeon_zone', key: zoneKey, name, usage });
  };
  for (const pool of ENEMY_POOLS) {
    const entries = doc.pools?.[pool];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) add((entry as { enemyKey?: unknown } | null)?.enemyKey, `${pool} pool`);
  }
  const rooms = doc.authored?.rooms;
  if (Array.isArray(rooms)) {
    for (const raw of rooms) {
      const room = (raw ?? {}) as { id?: unknown; name?: unknown; type?: unknown; enemyKey?: unknown };
      const label = typeof room.name === 'string' && room.name.trim() !== '' ? room.name : String(room.id ?? '?');
      const type = typeof room.type === 'string' ? ` (${room.type})` : '';
      add(room.enemyKey, `room "${label}"${type}`);
    }
  }
  return out;
}

/** Zones are a handful of documents; scanning them tracks the shape better than a JSON path query. */
export const dungeonZoneEnemyReferences: EnemyReferenceSource = async (tx) => {
  const zones = await tx
    .select({ key: dungeonZones.zoneKey, definition: dungeonZones.definition })
    .from(dungeonZones)
    .orderBy(asc(dungeonZones.position), asc(dungeonZones.zoneKey));
  return zones.flatMap((zone) => zoneDocumentEnemyReferences(zone.key, zone.definition));
};

/** Combat Trials name one enemy each; they are shipped content, read from the live snapshot. */
export function combatTrialEnemyReferences(
  getTrials: () => readonly { key: string; name: string; enemyKey: string }[] | undefined,
): EnemyReferenceSource {
  return async () =>
    (getTrials() ?? []).map((trial) => ({
      enemyKey: trial.enemyKey,
      kind: 'combat_trial' as const,
      key: trial.key,
      name: trial.name,
      usage: 'primary enemy',
    }));
}

/** Run every source and group what they found by enemy. */
export async function collectEnemyReferences(
  tx: DbOrTx,
  sources: readonly EnemyReferenceSource[],
): Promise<Map<string, EnemyReference[]>> {
  const byEnemy = new Map<string, EnemyReference[]>();
  for (const source of sources) {
    for (const { enemyKey, ...reference } of await source(tx)) {
      const list = byEnemy.get(enemyKey);
      if (list) list.push(reference);
      else byEnemy.set(enemyKey, [reference]);
    }
  }
  return byEnemy;
}
