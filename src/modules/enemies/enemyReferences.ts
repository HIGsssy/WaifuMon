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
 *   - dungeons — every stored dungeon document: each draft, and each
 *     published revision new runs start on. A wave may name one enemy or draw
 *     from a weighted pool; both count;
 *   - Combat Trials — the shipped Trial definitions.
 */
import type { DbOrTx } from '../../db/client';
import type { EnemyReference } from '../../shared/errors';
import { isCombatAction, type DungeonDefinition } from '../dungeons/content/dungeonDefinition';
import { readDungeonContentDocuments } from '../dungeons/dungeonContentService';

export type { EnemyReference };

/** A reference, tagged with the enemy it points at. */
export interface EnemyReferenceEntry extends EnemyReference {
  enemyKey: string;
}

/** Every place one system names an enemy. Reads inside the caller's transaction. */
export type EnemyReferenceSource = (tx: DbOrTx) => Promise<EnemyReferenceEntry[]>;

/** The enemies one dungeon document names, de-duplicated per place. */
export function dungeonDocumentEnemyReferences(
  dungeonKey: string,
  definition: DungeonDefinition,
  source: 'draft' | 'published',
): EnemyReferenceEntry[] {
  const out: EnemyReferenceEntry[] = [];
  const seen = new Set<string>();
  for (const room of definition.rooms) {
    for (const action of room.actions) {
      if (!isCombatAction(action)) continue;
      action.waves.forEach((wave, index) => {
        const pooled = 'pool' in wave.enemy;
        const keys = 'key' in wave.enemy ? [wave.enemy.key] : wave.enemy.pool.map((e) => e.key);
        const wavePart = action.waves.length > 1 ? `, wave ${index + 1}` : '';
        const usage = `${source}: room "${room.name || room.id}" ${action.type} "${action.id}"${wavePart}${pooled ? ' (pool)' : ''}`;
        for (const enemyKey of keys) {
          const id = `${enemyKey}\u0000${usage}`;
          if (seen.has(id)) continue;
          seen.add(id);
          // The kind is the one the Portal already knows as "a dungeon".
          out.push({ enemyKey, kind: 'dungeon_zone', key: dungeonKey, name: definition.name, usage });
        }
      });
    }
  }
  return out;
}

/** Dungeons are a handful of documents; scanning them tracks the shape better than a JSON path query. */
export const dungeonEnemyReferences: EnemyReferenceSource = async (tx) =>
  (await readDungeonContentDocuments(tx)).flatMap((doc) => dungeonDocumentEnemyReferences(doc.dungeonKey, doc.definition, doc.source));

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
