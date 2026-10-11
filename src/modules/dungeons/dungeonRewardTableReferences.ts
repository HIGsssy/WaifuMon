/** Legacy expedition tables used by dungeon drafts and rollbackable revisions. */
import { asc, eq } from 'drizzle-orm';
import { dungeonDefinitions, dungeonRevisions } from '../../db/schema';
import type { RewardTableReferenceEntry, RewardTableReferenceSource } from '../rewardTables/rewardTableService';
import { DungeonDefinitionSchema, dungeonDependencies } from './content/dungeonDefinition';

/**
 * Keep every immutable revision: superseded content can be played by an
 * existing run or selected again through rollback. Only legacy reward-table
 * ids are reported; a future dungeon loot catalogue has its own references.
 * One entry per dungeon/table keeps the existing reference UI unambiguous.
 */
export const dungeonRewardTableReferences: RewardTableReferenceSource = async (tx) => {
  const [drafts, revisions] = await Promise.all([
    tx.select({ key: dungeonDefinitions.dungeonKey, enabled: dungeonDefinitions.enabled, definition: dungeonDefinitions.draft })
      .from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.dungeonKey)),
    tx.select({ key: dungeonDefinitions.dungeonKey, enabled: dungeonDefinitions.enabled, definition: dungeonRevisions.content })
      .from(dungeonRevisions).innerJoin(dungeonDefinitions, eq(dungeonDefinitions.dungeonKey, dungeonRevisions.dungeonKey))
      .orderBy(asc(dungeonDefinitions.dungeonKey), asc(dungeonRevisions.number)),
  ]);
  const names = new Map<string, string>();
  const references = new Map<string, RewardTableReferenceEntry>();
  for (const doc of [...drafts, ...revisions]) {
    const definition = DungeonDefinitionSchema.parse(doc.definition);
    // Prefer the current draft's name when a historical revision was renamed.
    if (!names.has(doc.key)) names.set(doc.key, definition.name);
    for (const tableId of dungeonDependencies(definition).rewardTables) {
      const key = `${doc.key}/${tableId}`;
      if (!references.has(key)) {
        references.set(key, {
          kind: 'expedition', tableId, role: 'dungeon', key: doc.key,
          name: names.get(doc.key)!, enabled: doc.enabled,
        });
      }
    }
  }
  return [...references.values()].sort((a, b) => a.key.localeCompare(b.key) || a.tableId.localeCompare(b.tableId));
};
