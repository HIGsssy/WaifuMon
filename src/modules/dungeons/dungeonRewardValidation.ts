/** Publication-time validation of legacy dungeon reward dependencies. */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { equipmentDefinitions, items, rewardTables } from '../../db/schema';
import { DungeonInvalidError, type DungeonIssueDetail } from '../../shared/errors';
import { rewardTableSchema, validateRewardTable } from '../rewardTables/rewardTableCore';
import { dungeonDependencies, type DungeonDefinition } from './content/dungeonDefinition';

/**
 * Call after locking the dungeon row, inside publish/rollback's transaction.
 * Shared locks keep the validated dependencies stable until the pointer and
 * revision commit. Lock order: tables, items, then the equipment catalogue.
 *
 * Reuses the importer's shared table/selector validator. The importer checks
 * loaded item slugs and writes drafts; publication instead checks live, locked
 * inventory rows and adds the dungeon-only ownership-cap rule.
 * Disabled tables retain their existing no-payout/warning policy; item
 * references must still exist and be uncapped, just as item existence is
 * required by the shared validator even in disabled entries.
 */
export async function assertDungeonRewardDependencies(tx: DbOrTx, definition: DungeonDefinition): Promise<void> {
  const ids = dungeonDependencies(definition).rewardTables;
  if (!ids.length) return;
  const tables = await tx.select().from(rewardTables)
    .where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, ids)))
    .orderBy(asc(rewardTables.tableId)).for('share');
  const parsed = tables.map((row) => rewardTableSchema('expedition').safeParse(row.definition));
  const slugs = [...new Set(parsed.flatMap((result) => result.success ? result.data.groups.flatMap((g) => g.entries.map((e) => e.itemId)) : []))].sort();
  const itemRows = slugs.length ? await tx.select({ slug: items.slug, maxOwned: items.maxOwned }).from(items)
    .where(inArray(items.slug, slugs)).orderBy(asc(items.slug)).for('share') : [];
  const itemBySlug = new Map(itemRows.map((item) => [item.slug, item]));
  const itemSlugs = new Set(itemBySlug.keys());
  const needsGear = parsed.some((result) => result.success && result.data.groups.some((g) => (g.equipment?.length ?? 0) > 0));
  const gear = needsGear ? await tx.select({
    key: equipmentDefinitions.key, name: equipmentDefinitions.name, slot: equipmentDefinitions.slot,
    rarity: equipmentDefinitions.rarity, enabled: equipmentDefinitions.enabled,
  }).from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.key)).for('share') : [];
  const issues: DungeonIssueDetail[] = [];
  const message = (id: string, detail: string) => `dungeon "${definition.name}" (${definition.key}), reward table "${id}": ${detail}`;
  for (const id of ids) {
    const row = tables.find((table) => table.tableId === id);
    const path = `dependencies.rewardTables.${id}`;
    if (!row) {
      issues.push({ code: 'reward_table_missing', severity: 'error', path, message: message(id, 'not an expedition reward table on this server') });
      continue;
    }
    const validation = validateRewardTable('expedition', row.definition, {
      itemSlugs, definitions: gear, references: [],
    });
    issues.push(...validation.issues.map((issue) => ({
      ...issue, code: issue.path.endsWith('.itemId') ? 'item_missing' : 'reward_dependency_invalid',
      path: `${path}.${issue.path}`, message: message(id, issue.message),
    })));
    for (const [g, group] of (validation.table?.groups ?? []).entries()) {
      for (const [e, entry] of group.entries.entries()) {
        const item = itemBySlug.get(entry.itemId);
        if (item && item.maxOwned !== null) issues.push({
          code: 'reward_item_capped', severity: 'error', path: `${path}.groups[${g}].entries[${e}].itemId`,
          message: message(id, `item "${entry.itemId}" has maxOwned ${item.maxOwned}; capped inventory items cannot be dungeon rewards`),
        });
      }
    }
  }
  if (issues.some((issue) => issue.severity === 'error')) throw new DungeonInvalidError(issues);
}
