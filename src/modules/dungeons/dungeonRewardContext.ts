/** Loads authoritative reward catalogues for pure authoring validation. No writes. */
import { asc, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import {
  dungeonLootTables,
  items,
  equipmentDefinitions,
  progressionCurrencies,
} from '../../db/schema';
import { eligibleRewardDefinitions } from '../equipment/rewardSelector';
import type { DungeonRewardSnapshot } from './content/dungeonRewardSnapshot';
import type { DungeonValidationContext } from './validation/dungeonValidation';

export async function loadDungeonRewardContext(
  tx: DbOrTx,
  options: { lootTableKeys?: readonly string[]; lock?: boolean } = {},
): Promise<DungeonValidationContext> {
  let lootQuery = tx
    .select()
    .from(dungeonLootTables)
    .where(
      options.lootTableKeys
        ? inArray(dungeonLootTables.tableKey, [...options.lootTableKeys])
        : undefined,
    )
    .orderBy(asc(dungeonLootTables.tableKey))
    .$dynamic();
  let itemQuery = tx
    .select({
      slug: items.slug,
      name: items.name,
      category: items.category,
      enabled: items.enabled,
      maxOwned: items.maxOwned,
    })
    .from(items)
    .orderBy(asc(items.slug))
    .$dynamic();
  let gearQuery = tx
    .select({
      key: equipmentDefinitions.key,
      name: equipmentDefinitions.name,
      slot: equipmentDefinitions.slot,
      rarity: equipmentDefinitions.rarity,
      enabled: equipmentDefinitions.enabled,
    })
    .from(equipmentDefinitions)
    .orderBy(asc(equipmentDefinitions.key))
    .$dynamic();
  let currencyQuery = tx
    .select({ key: progressionCurrencies.currencyKey, enabled: progressionCurrencies.enabled })
    .from(progressionCurrencies)
    .orderBy(asc(progressionCurrencies.currencyKey))
    .$dynamic();
  if (options.lock) {
    lootQuery = lootQuery.for('share');
    itemQuery = itemQuery.for('share');
    gearQuery = gearQuery.for('share');
    currencyQuery = currencyQuery.for('share');
  }
  // Sequential queries maintain the publication dependency lock order.
  const loot = await lootQuery;
  const inventory = await itemQuery;
  const gear = await gearQuery;
  const currencies = await currencyQuery;
  return {
    lootTables: new Map(
      loot.map((t) => [
        t.tableKey,
        { name: t.name, body: t.body, archivedAt: t.archivedAt, tier: t.tier, revision: t.revision },
      ]),
    ),
    items: new Map(inventory.map((i) => [i.slug, i])),
    currencies: new Map(currencies.map((c) => [c.key, { enabled: c.enabled }])),
    resolveEquipmentSelector: (selector) => eligibleRewardDefinitions(selector, gear),
  };
}

export interface DungeonRewardSnapshotLiveDependencies {
  items: ReadonlyMap<string, { name: string; maxOwned: number | null }>;
  equipmentKeys: ReadonlySet<string>;
}

/**
 * The live rows a pinned snapshot still needs to pay out: its items and its
 * equipment candidates' definitions. Loot tables are not read; the snapshot
 * carries their bodies. With `lock`, rows are held FOR SHARE in the
 * publication order (items, then equipment), each in key order.
 */
export async function loadSnapshotLiveDependencies(
  tx: DbOrTx,
  snapshot: Pick<DungeonRewardSnapshot, 'items' | 'equipmentPools'>,
  options: { lock?: boolean } = {},
): Promise<DungeonRewardSnapshotLiveDependencies> {
  const slugs = Object.keys(snapshot.items).sort();
  const keys = [
    ...new Set(Object.values(snapshot.equipmentPools).flatMap((pool) => pool.map((c) => c.key))),
  ].sort();
  let itemQuery = tx
    .select({ slug: items.slug, name: items.name, maxOwned: items.maxOwned })
    .from(items)
    .where(inArray(items.slug, slugs))
    .orderBy(asc(items.slug))
    .$dynamic();
  let gearQuery = tx
    .select({ key: equipmentDefinitions.key })
    .from(equipmentDefinitions)
    .where(inArray(equipmentDefinitions.key, keys))
    .orderBy(asc(equipmentDefinitions.key))
    .$dynamic();
  if (options.lock) {
    itemQuery = itemQuery.for('share');
    gearQuery = gearQuery.for('share');
  }
  const inventory = slugs.length ? await itemQuery : [];
  const gear = keys.length ? await gearQuery : [];
  return {
    items: new Map(inventory.map((i) => [i.slug, i])),
    equipmentKeys: new Set(gear.map((g) => g.key)),
  };
}
