/**
 * Converting a legacy Treasure (`reward`) into dungeon rewards (`rewards`),
 * design section 10.3. Pure: no catalogue I/O, no clock, no randomness.
 *
 * The authority for what a legacy treasure pays is the code that pays it,
 * `engine/rewards.ts` → `rollExpeditionTable`:
 *
 *   - Both `rewardTable` and `equipmentRewardTable` are rolled the same way and
 *     pay the table's WaifuBux, items and gear. Essence, player XP and WaifuMon
 *     XP on the table are never paid by a dungeon.
 *   - A table that is missing or disabled when the run starts pays nothing.
 *   - A disabled group, a group with no enabled entry, and a group with chance
 *     0 pay nothing. Disabled entries are left out and the rest keep their
 *     weights (the roller normalises by the remaining total).
 *   - Each of a group's `rolls` is independent: a gate at `chanceBasisPoints`,
 *     then one weighted pick over items and gear together.
 *   - A gear pick chooses uniformly among the selector's eligible definitions.
 *
 * Every probability is carried over in integers. A group with gate `p` (basis
 * points) and weights `w_i` becomes a pool whose shares are `w_i × p` plus a
 * Nothing share of `Σw × (10000 − p)`, divided by their greatest common
 * divisor, so `P(entry i) = p/10000 × w_i/Σw` exactly. A uniform amount drawn
 * from `0..max` is a pool of Nothing (1 share) and `1..max` (`max` shares).
 * Whatever cannot be represented exactly is a blocker, never an approximation.
 */
import { z } from 'zod';
import { ExpeditionRewardTableSchema, equipmentEntrySelector, type ExpeditionRewardTable } from '../content/schemas';
import { EquipmentRewardSelectorSchema } from '../equipment/rewardSelector';
import { BASIS_POINTS, type RewardSpec } from './content/dungeonDefinition';
import { DUNGEON_KEY_MAX_LENGTH } from './content/dungeonIdentifiers';
import {
  DUNGEON_REWARD_LIMITS,
  DungeonLootTableBodySchema,
  DungeonRewardBundleSchema,
  type DungeonLootPool,
  type DungeonLootPoolEntry,
  type DungeonLootTableBody,
  type DungeonRewardBundle,
  type DungeonRewardGrant,
} from './content/dungeonRewards';

const L = DUNGEON_REWARD_LIMITS;

export type TreasureConversionBlockerCode =
  | 'conversion_table_missing'
  | 'conversion_table_unreadable'
  | 'conversion_currency_min_zero'
  | 'conversion_amount_too_large'
  | 'conversion_quantity_too_large'
  | 'conversion_share_too_large'
  | 'conversion_too_many_groups'
  | 'conversion_too_many_entries'
  | 'conversion_selector_unsupported'
  | 'conversion_unrepresentable';
export interface TreasureConversionBlocker {
  code: TreasureConversionBlockerCode;
  /** The expedition reward table at fault; null when it is the treasure itself. */
  table: string | null;
  message: string;
}

/** Something the legacy treasure names that the converted rewards will not carry. */
export interface TreasureConversionOmission {
  table: string | null;
  reason: 'never_paid' | 'disabled' | 'cannot_drop';
  text: string;
}

export interface ConvertedLegacyTable {
  body: DungeonLootTableBody | null;
  omitted: TreasureConversionOmission[];
  blockers: TreasureConversionBlocker[];
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const range = (r: { min: number; max: number }) => (r.min === r.max ? String(r.min) : `${r.min}–${r.max}`);

/**
 * One gated weighted pick as pool shares, exactly. `weights` are the enabled
 * entries' weights in order; the last element of the result is the Nothing
 * share, 0 when the gate always passes.
 */
export function scaleGatedWeights(weights: readonly number[], chanceBasisPoints: number): { shares: bigint[]; nothing: bigint } {
  const p = BigInt(chanceBasisPoints);
  const scaled = weights.map((w) => BigInt(w) * p);
  const nothing = weights.reduce((sum, w) => sum + BigInt(w), 0n) * (BigInt(BASIS_POINTS) - p);
  const divisor = [...scaled, nothing].reduce(gcd, 0n) || 1n;
  return { shares: scaled.map((s) => s / divisor), nothing: nothing / divisor };
}

/**
 * The dungeon loot table that pays what `table` pays in a dungeon today.
 * `table` is the parsed expedition table (defaults applied).
 */
export function convertExpeditionRewardTable(table: ExpeditionRewardTable): ConvertedLegacyTable {
  const omitted: TreasureConversionOmission[] = [];
  const blockers: TreasureConversionBlocker[] = [];
  const block = (code: TreasureConversionBlockerCode, message: string) => blockers.push({ code, table: table.id, message });
  const omit = (reason: TreasureConversionOmission['reason'], text: string) => omitted.push({ table: table.id, reason, text });
  const body: DungeonLootTableBody = { guaranteed: [], chances: [], pools: [] };

  if (table.essence && table.essence.max > 0) omit('never_paid', `${range(table.essence)} Essence`);
  if (table.playerXp > 0) omit('never_paid', `${table.playerXp} player XP`);
  if (table.waifuXp > 0) omit('never_paid', `${table.waifuXp} WaifuMon XP`);

  const bux = table.waifubux;
  if (bux && bux.max > 0) {
    if (bux.max > L.atRiskCurrencyAmount) {
      block('conversion_amount_too_large', `"${table.id}" pays up to ${bux.max} WaifuBux. Dungeon rewards allow at most ${L.atRiskCurrencyAmount} in one reward; lower it on the table first.`);
    } else if (bux.min >= 1) {
      body.guaranteed.push({ id: 'waifubux', grant: { type: 'currency', currency: 'waifubux', amount: { min: bux.min, max: bux.max } } });
    } else {
      // Uniform over 0..max: 0 once in (max + 1), otherwise uniform over 1..max.
      body.pools.push({
        id: 'waifubux',
        name: 'WaifuBux',
        draws: 1,
        entries: [
          { id: 'amount', weight: bux.max, grant: { type: 'currency', currency: 'waifubux', amount: { min: 1, max: bux.max } } },
          { id: 'none', weight: 1, nothing: true },
        ],
      });
    }
  }

  table.groups.forEach((group, g) => {
    if (!group.enabled) return omit('disabled', `Group "${group.id}" is switched off.`);
    const items = group.entries.filter((entry) => {
      if (!entry.enabled) omit('disabled', `${entry.quantity} × ${entry.itemId} in group "${group.id}" is switched off.`);
      return entry.enabled;
    });
    const gear = (group.equipment ?? []).filter((entry) => {
      if (!entry.enabled) omit('disabled', `A gear entry in group "${group.id}" is switched off.`);
      return entry.enabled;
    });
    if (items.length + gear.length === 0) return omit('cannot_drop', `Group "${group.id}" has no entry switched on, so it never drops anything.`);
    if (group.chanceBasisPoints === 0) return omit('cannot_drop', `Group "${group.id}" has a 0% chance, so it never drops anything.`);

    const grants: DungeonRewardGrant[] = [];
    for (const entry of items) {
      if (entry.quantity > L.itemQuantity) {
        block('conversion_quantity_too_large', `Group "${group.id}" gives ${entry.quantity} × ${entry.itemId}. Dungeon rewards allow at most ${L.itemQuantity} of an item in one reward.`);
      }
      grants.push({ type: 'item', item: entry.itemId, quantity: { min: entry.quantity, max: entry.quantity } });
    }
    for (const entry of gear) {
      const selector = EquipmentRewardSelectorSchema.safeParse(equipmentEntrySelector(entry));
      if (!selector.success) {
        block('conversion_selector_unsupported', `A gear entry in group "${group.id}" uses a gear choice dungeon rewards cannot hold: ${selector.error.issues[0]?.message ?? 'unknown problem'}.`);
        continue;
      }
      grants.push({ type: 'equipment', selector: selector.data });
    }
    // Items first, then gear: the order the legacy roller picks over.
    const weights = [...items.map((e) => e.weight), ...gear.map((e) => e.weight)];
    if (grants.length !== weights.length) return;
    const { shares, nothing } = scaleGatedWeights(weights, group.chanceBasisPoints);
    if ([...shares, nothing].some((share) => share > BigInt(L.weight))) {
      return block('conversion_share_too_large', `Group "${group.id}" cannot keep its exact odds: its ${group.chanceBasisPoints / 100}% chance and weights need a share above ${L.weight}. Simplify its weights or chance on the table first.`);
    }
    const entries: DungeonLootPoolEntry[] = grants.map((grant, i) => ({
      id: i < items.length ? `i${i + 1}` : `e${i - items.length + 1}`,
      weight: Number(shares[i]),
      grant,
    }));
    if (nothing > 0n) entries.push({ id: 'none', weight: Number(nothing), nothing: true });
    if (entries.length > L.poolEntries) {
      return block('conversion_too_many_entries', `Group "${group.id}" has ${entries.length} choices. A dungeon loot group holds at most ${L.poolEntries}.`);
    }
    // Rolls are independent, so more than one pool's worth splits without changing any odds.
    const parts = Math.ceil(group.rolls / L.poolDraws);
    for (let part = 0; part < parts; part++) {
      const draws = Math.min(L.poolDraws, group.rolls - part * L.poolDraws);
      const pool: DungeonLootPool = {
        id: parts === 1 ? `g${g + 1}` : `g${g + 1}-${part + 1}`,
        name: (parts === 1 ? group.id : `${group.id} (part ${part + 1} of ${parts})`).slice(0, 100),
        draws,
        entries: entries.map((entry) => ({ ...entry })),
      };
      body.pools.push(pool);
    }
  });

  if (body.pools.length > L.pools) {
    block('conversion_too_many_groups', `"${table.id}" needs ${body.pools.length} loot groups. A dungeon loot table holds at most ${L.pools}; switch off or merge groups on the table first.`);
  }
  if (blockers.length > 0) return { body: null, omitted, blockers };
  const parsed = DungeonLootTableBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    block('conversion_unrepresentable', `"${table.id}" cannot be held as a dungeon loot table: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown problem'}.`);
    return { body: null, omitted, blockers };
  }
  return { body: parsed.data, omitted, blockers };
}

/** A source table as the catalogue holds it, or null when it does not exist. */
export interface LegacyTableSource {
  enabled: boolean;
  definition: unknown;
  contentHash: string;
}

/** A dungeon loot table already in the catalogue, as far as key choice needs it. */
export interface ExistingLootTable {
  origin: string;
  contentHash: string;
  archived: boolean;
}

export interface TreasureConversionTable {
  sourceTable: string;
  sourceContentHash: string;
  /** How many times the treasure rolls it: 2 when both legacy fields name the same table. */
  draws: number;
  /** `reuse`: an identical converted table is already in the catalogue. */
  action: 'create' | 'reuse';
  key: string;
  name: string;
  description: string;
  body: DungeonLootTableBody;
  contentHash: string;
}

export interface TreasureConversion {
  rewards: DungeonRewardBundle | null;
  tables: TreasureConversionTable[];
  omitted: TreasureConversionOmission[];
  blockers: TreasureConversionBlocker[];
}

/** `converted_<source id>`, as a dungeon loot table key. */
export function convertedTableKey(sourceId: string, attempt: number): string {
  const suffix = attempt === 0 ? '' : `_${attempt + 1}`;
  const slug = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
  return `converted_${slug}`.slice(0, DUNGEON_KEY_MAX_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
}

/**
 * The whole conversion of one legacy treasure against the catalogues as given.
 * An identical converted table is reused; any other holder of a key is left
 * alone and the next free key is taken, so nothing existing is ever replaced.
 */
export function convertLegacyTreasure(input: {
  reward: RewardSpec;
  sources: ReadonlyMap<string, LegacyTableSource | null>;
  lootTables: ReadonlyMap<string, ExistingLootTable>;
  hashBody: (body: DungeonLootTableBody) => string;
}): TreasureConversion {
  const { reward } = input;
  const omitted: TreasureConversionOmission[] = [];
  const blockers: TreasureConversionBlocker[] = [];
  const tables: TreasureConversionTable[] = [];
  const bundle: DungeonRewardBundle = { guaranteed: [], chances: [], tables: [] };

  // `rollRewardPlan`: nothing when max <= 0, otherwise uniform over min..max.
  if (reward.currency.max > 0) {
    if (reward.currency.min < 1) {
      blockers.push({ code: 'conversion_currency_min_zero', table: null, message: `This treasure pays ${range(reward.currency)} Baddie Shards, so it can pay none. A guaranteed dungeon reward pays at least 1: set the minimum to 1 or more, save, then convert.` });
    } else if (reward.currency.max > L.atRiskCurrencyAmount) {
      blockers.push({ code: 'conversion_amount_too_large', table: null, message: `This treasure pays up to ${reward.currency.max} Baddie Shards. Dungeon rewards allow at most ${L.atRiskCurrencyAmount} in one reward.` });
    } else {
      bundle.guaranteed.push({ id: 'g_shards', grant: { type: 'currency', currency: 'shards', amount: { min: reward.currency.min, max: reward.currency.max } } });
    }
  }

  const taken = new Set<string>();
  const referenced = [reward.rewardTable, reward.equipmentRewardTable].filter((id): id is string => id !== null);
  for (const id of [...new Set(referenced)]) {
    const draws = referenced.filter((other) => other === id).length;
    const source = input.sources.get(id) ?? null;
    if (!source) {
      blockers.push({ code: 'conversion_table_missing', table: id, message: `The reward table "${id}" no longer exists. Clear it from this treasure, save, then convert.` });
      continue;
    }
    if (!source.enabled) {
      omitted.push({ table: id, reason: 'disabled', text: `The reward table "${id}" is switched off, so this treasure gets nothing from it today.` });
      continue;
    }
    const parsed = ExpeditionRewardTableSchema.safeParse(source.definition);
    if (!parsed.success) {
      blockers.push({ code: 'conversion_table_unreadable', table: id, message: `The reward table "${id}" could not be read. Open it under Reward Tables, fix it and save it again.` });
      continue;
    }
    const converted = convertExpeditionRewardTable(parsed.data);
    omitted.push(...converted.omitted);
    blockers.push(...converted.blockers);
    if (!converted.body) continue;
    const contentHash = input.hashBody(converted.body);
    let attempt = 0;
    let key = convertedTableKey(id, attempt);
    let action: 'create' | 'reuse' = 'create';
    for (;;) {
      const existing = input.lootTables.get(key);
      if (!existing && !taken.has(key)) break;
      if (existing && !taken.has(key) && existing.origin === 'converted' && !existing.archived && existing.contentHash === contentHash) {
        action = 'reuse';
        break;
      }
      key = convertedTableKey(id, ++attempt);
    }
    taken.add(key);
    tables.push({
      sourceTable: id,
      sourceContentHash: source.contentHash,
      draws,
      action,
      key,
      name: `${id} (converted)`.slice(0, 100),
      description: `Converted from the expedition reward table "${id}" for dungeon use. It pays what that table paid in a dungeon when it was converted.`,
      body: converted.body,
      contentHash,
    });
    bundle.tables.push({ id: `t_${bundle.tables.length + 1}`, table: key, draws });
  }

  if (blockers.length > 0) return { rewards: null, tables: [], omitted, blockers };
  const parsed = DungeonRewardBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    blockers.push({ code: 'conversion_unrepresentable', table: null, message: `This treasure cannot be held as dungeon rewards: ${issue?.message ?? 'unknown problem'}.` });
    return { rewards: null, tables: [], omitted, blockers };
  }
  return { rewards: parsed.data, tables, omitted, blockers };
}

/** Narrowing for stored JSON whose shape is checked elsewhere. */
export const TreasureConversionTargetSchema = z.object({ roomId: z.string().min(1).max(64), actionId: z.string().min(1).max(64) }).strict();
