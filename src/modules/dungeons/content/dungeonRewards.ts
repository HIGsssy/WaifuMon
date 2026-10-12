/** Dungeon-only authoring schemas and static work bounds. No rolling or catalogue I/O. */
import { z } from 'zod';
import { EquipmentRewardSelectorSchema } from '../../equipment/rewardSelector';
import { DungeonIdSchema, DungeonKeySchema } from './dungeonIdentifiers';
import { dungeonRewardActivities, type DungeonRewardSiteDefinition } from './dungeonRewardSites';

export const DUNGEON_REWARD_LIMITS = Object.freeze({
  guaranteedEntries: 12,
  chanceEntries: 12,
  tableReferences: 4,
  tableDraws: 10,
  chanceBasisPoints: 9999,
  itemQuantity: 999,
  atRiskCurrencyAmount: 1_000_000,
  essenceAmount: 100_000,
  affectionAmount: 500,
  equipmentPerActivity: 10,
  resolvedDrawsPerActivity: 200,
  affectionPerActivity: 1000,
  atRiskCurrencyPerDungeon: 2_000_000_000,
  tableChanceEntries: 20,
  pools: 6,
  poolDraws: 10,
  poolEntries: 40,
  weight: 1_000_000,
});
const L = DUNGEON_REWARD_LIMITS;

function range(max: number) {
  return z
    .object({ min: z.number().int().min(1).max(max), max: z.number().int().min(1).max(max) })
    .strict()
    .refine((r) => r.max >= r.min, { message: 'max must be at least min', path: ['max'] });
}

/** Inclusive, positive integer range. Individual grant types apply tighter bounds. */
export const DungeonQuantityRangeSchema = range(L.atRiskCurrencyAmount);
export type DungeonQuantityRange = z.infer<typeof DungeonQuantityRangeSchema>;
export const DungeonRewardGrantSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('currency'),
        /** Shards resolve to settings.progressionCurrency, never a hard-coded currency key. */
        currency: z.enum(['shards', 'waifubux', 'essence']),
        amount: DungeonQuantityRangeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('item'),
        item: z.string().trim().min(1).max(100),
        quantity: range(L.itemQuantity),
      })
      .strict(),
    z.object({ type: z.literal('equipment'), selector: EquipmentRewardSelectorSchema }).strict(),
    /** Awarded to the participating Buddy; there is no authored recipient. */
    z.object({ type: z.literal('affection'), amount: range(L.affectionAmount) }).strict(),
  ])
  .superRefine((grant, ctx) => {
    if (grant.type === 'currency' && grant.currency === 'essence') {
      for (const end of ['min', 'max'] as const) {
        if (grant.amount[end] > L.essenceAmount)
          ctx.addIssue({
            code: 'custom',
            path: ['amount', end],
            message: `Essence must be at most ${L.essenceAmount}`,
          });
      }
    }
  });
export type DungeonRewardGrant = z.infer<typeof DungeonRewardGrantSchema>;

export const DungeonGuaranteedEntrySchema = z
  .object({ id: DungeonIdSchema, grant: DungeonRewardGrantSchema })
  .strict();
export type DungeonGuaranteedEntry = z.infer<typeof DungeonGuaranteedEntrySchema>;
export const DungeonChanceEntrySchema = z
  .object({
    id: DungeonIdSchema,
    chanceBasisPoints: z.number().int().min(1).max(L.chanceBasisPoints),
    grant: DungeonRewardGrantSchema,
  })
  .strict();
export type DungeonChanceEntry = z.infer<typeof DungeonChanceEntrySchema>;
export const DungeonTableDrawSchema = z
  .object({
    id: DungeonIdSchema,
    table: DungeonKeySchema,
    draws: z.number().int().min(1).max(L.tableDraws),
  })
  .strict();
export type DungeonTableDraw = z.infer<typeof DungeonTableDrawSchema>;

function uniqueIds(
  lists: readonly (readonly { id: string }[])[],
  names: readonly string[],
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  lists.forEach((entries, list) =>
    entries.forEach((entry, index) => {
      if (seen.has(entry.id))
        ctx.addIssue({
          code: 'custom',
          path: [names[list]!, index, 'id'],
          message: `duplicate entry id "${entry.id}"`,
        });
      seen.add(entry.id);
    }),
  );
}

export const DungeonRewardBundleSchema = z
  .object({
    guaranteed: z.array(DungeonGuaranteedEntrySchema).max(L.guaranteedEntries),
    chances: z.array(DungeonChanceEntrySchema).max(L.chanceEntries),
    tables: z.array(DungeonTableDrawSchema).max(L.tableReferences),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    uniqueIds(
      [bundle.guaranteed, bundle.chances, bundle.tables],
      ['guaranteed', 'chances', 'tables'],
      ctx,
    );
    // Referenced bodies are checked by the pure interface below once available.
    for (const issue of activityWorkIssues(calculateDungeonRewardBundleWork(bundle).work)) {
      ctx.addIssue({ code: 'custom', path: [], message: issue.message });
    }
  });
export type DungeonRewardBundle = z.infer<typeof DungeonRewardBundleSchema>;

/** Strict alternatives enforce exactly one of a grant and explicit Nothing. */
export const DungeonLootPoolEntrySchema = z.union([
  z
    .object({
      id: DungeonIdSchema,
      weight: z.number().int().min(1).max(L.weight),
      grant: DungeonRewardGrantSchema,
    })
    .strict(),
  z
    .object({
      id: DungeonIdSchema,
      weight: z.number().int().min(1).max(L.weight),
      nothing: z.literal(true),
    })
    .strict(),
]);
export type DungeonLootPoolEntry = z.infer<typeof DungeonLootPoolEntrySchema>;
export const DungeonLootPoolSchema = z
  .object({
    id: DungeonIdSchema,
    name: z.string().trim().min(1).max(100),
    draws: z.number().int().min(1).max(L.poolDraws),
    entries: z.array(DungeonLootPoolEntrySchema).min(1).max(L.poolEntries),
  })
  .strict()
  .superRefine((pool, ctx) => uniqueIds([pool.entries], ['entries'], ctx));
export type DungeonLootPool = z.infer<typeof DungeonLootPoolSchema>;
export const DungeonLootTableBodySchema = z
  .object({
    guaranteed: z.array(DungeonGuaranteedEntrySchema).max(L.guaranteedEntries),
    chances: z.array(DungeonChanceEntrySchema).max(L.tableChanceEntries),
    pools: z.array(DungeonLootPoolSchema).max(L.pools),
  })
  .strict()
  .superRefine((body, ctx) => {
    uniqueIds([body.guaranteed, body.chances, body.pools], ['guaranteed', 'chances', 'pools'], ctx);
  });
export type DungeonLootTableBody = z.infer<typeof DungeonLootTableBodySchema>;
export type DungeonLootTableBodies = ReadonlyMap<string, DungeonLootTableBody>;

export interface DungeonRewardWork {
  /** One slot per guaranteed/chance entry or pool pick, including Nothing. Table wrappers add no slot. */
  resolvedDraws: number;
  equipmentInstances: number;
  affection: number;
  currencies: { shards: number; waifubux: number; essence: number };
}
export interface DungeonRewardWorkResult {
  /** A lower bound on worst-case work until every dependency is resolved. */
  work: DungeonRewardWork;
  unresolvedTables: string[];
}
export interface DungeonRewardWorkIssue {
  code:
    | 'reward_too_many_equipment'
    | 'reward_too_many_draws'
    | 'reward_affection_too_large'
    | 'reward_currency_too_large'
    | 'reward_table_unresolved';
  path: string;
  message: string;
}
export interface DungeonRewardWorkValidation extends DungeonRewardWorkResult {
  complete: boolean;
  ok: boolean;
  issues: DungeonRewardWorkIssue[];
}

const emptyWork = (): DungeonRewardWork => ({
  resolvedDraws: 0,
  equipmentInstances: 0,
  affection: 0,
  currencies: { shards: 0, waifubux: 0, essence: 0 },
});
function addWork(target: DungeonRewardWork, source: DungeonRewardWork, times = 1) {
  target.resolvedDraws += source.resolvedDraws * times;
  target.equipmentInstances += source.equipmentInstances * times;
  target.affection += source.affection * times;
  for (const currency of ['shards', 'waifubux', 'essence'] as const)
    target.currencies[currency] += source.currencies[currency] * times;
}
function grantWork(grant: DungeonRewardGrant): DungeonRewardWork {
  const work = emptyWork();
  work.resolvedDraws = 1;
  if (grant.type === 'equipment') work.equipmentInstances = 1;
  if (grant.type === 'affection') work.affection = grant.amount.max;
  if (grant.type === 'currency') work.currencies[grant.currency] = grant.amount.max;
  return work;
}

/** Inputs to calculators are parsed schema outputs; no random draws or mutation of inputs. */
export function calculateDungeonLootTableWork(body: DungeonLootTableBody): DungeonRewardWork {
  const work = emptyWork();
  for (const entry of [...body.guaranteed, ...body.chances]) addWork(work, grantWork(entry.grant));
  for (const pool of body.pools) {
    const largest = emptyWork();
    largest.resolvedDraws = 1;
    // Each bound has its own worst case; mutually exclusive metrics must not be summed within a pick.
    for (const entry of pool.entries) {
      if (!('grant' in entry)) continue;
      const candidate = grantWork(entry.grant);
      largest.equipmentInstances = Math.max(
        largest.equipmentInstances,
        candidate.equipmentInstances,
      );
      largest.affection = Math.max(largest.affection, candidate.affection);
      for (const currency of ['shards', 'waifubux', 'essence'] as const)
        largest.currencies[currency] = Math.max(
          largest.currencies[currency],
          candidate.currencies[currency],
        );
    }
    addWork(work, largest, pool.draws);
  }
  return work;
}

export function calculateDungeonRewardBundleWork(
  bundle: DungeonRewardBundle,
  tables: DungeonLootTableBodies = new Map(),
): DungeonRewardWorkResult {
  const work = emptyWork();
  const unresolved = new Set<string>();
  for (const entry of [...bundle.guaranteed, ...bundle.chances])
    addWork(work, grantWork(entry.grant));
  for (const ref of bundle.tables) {
    const body = tables.get(ref.table);
    if (!body) unresolved.add(ref.table);
    else addWork(work, calculateDungeonLootTableWork(body), ref.draws);
  }
  return { work, unresolvedTables: [...unresolved].sort() };
}

function activityWorkIssues(work: DungeonRewardWork): DungeonRewardWorkIssue[] {
  const issues: DungeonRewardWorkIssue[] = [];
  if (work.equipmentInstances > L.equipmentPerActivity)
    issues.push({
      code: 'reward_too_many_equipment',
      path: '',
      message: `worst-case equipment instances ${work.equipmentInstances} exceed ${L.equipmentPerActivity}`,
    });
  if (work.resolvedDraws > L.resolvedDrawsPerActivity)
    issues.push({
      code: 'reward_too_many_draws',
      path: '',
      message: `worst-case resolved draws ${work.resolvedDraws} exceed ${L.resolvedDrawsPerActivity}`,
    });
  if (work.affection > L.affectionPerActivity)
    issues.push({
      code: 'reward_affection_too_large',
      path: '',
      message: `worst-case affection ${work.affection} exceeds ${L.affectionPerActivity}`,
    });
  return issues;
}
function validated(
  result: DungeonRewardWorkResult,
  issues: DungeonRewardWorkIssue[],
): DungeonRewardWorkValidation {
  for (const table of result.unresolvedTables)
    issues.push({
      code: 'reward_table_unresolved',
      path: '',
      message: `loot table "${table}" has no supplied body; worst-case validation is incomplete`,
    });
  return {
    ...result,
    complete: result.unresolvedTables.length === 0,
    ok: issues.length === 0,
    issues,
  };
}

/** Work validation only. Catalogue existence, archive status, item eligibility and selector candidates belong to T5. */
export function validateDungeonRewardBundleWork(
  bundle: DungeonRewardBundle,
  tables?: DungeonLootTableBodies,
): DungeonRewardWorkValidation {
  const result = calculateDungeonRewardBundleWork(bundle, tables);
  return validated(result, activityWorkIssues(result.work));
}

/** Structural input keeps this module independent of the definition schema that imports it. */
export interface DungeonRewardWorkDefinition {
  rooms: readonly {
    actions: readonly {
      type: string;
      rewards?: DungeonRewardBundle | undefined;
      reward?: { currency: { max: number } } | undefined;
      source?: DungeonRewardSiteDefinition['rooms'][number]['actions'][number]['source'];
    }[];
  }[];
  events?: DungeonRewardSiteDefinition['events'];
  eventPools?: DungeonRewardSiteDefinition['eventPools'];
}
/**
 * Each activity can claim once. Includes legacy unbanked Shards, but not legacy secured WaifuBux.
 * An event activity claims one outcome of one event it can present: every such
 * bundle is checked against the per-activity limits, and the dungeon totals
 * take the largest of them per measure.
 */
export function validateDungeonRewardWork(
  definition: DungeonRewardWorkDefinition,
  tables?: DungeonLootTableBodies,
): DungeonRewardWorkValidation {
  const work = emptyWork();
  const unresolved = new Set<string>();
  const issues: DungeonRewardWorkIssue[] = [];
  const reported = new Set<string>();
  // Only positions and bundles are read here, so the ids the traversal also reports may be absent.
  const activities = new Map(dungeonRewardActivities(definition as DungeonRewardSiteDefinition).map((a) => [a.path, a]));
  definition.rooms.forEach((room, ri) =>
    room.actions.forEach((action, ai) => {
      const activity = activities.get(`rooms[${ri}].actions[${ai}]`);
      if (activity) {
        const worst = emptyWork();
        for (const site of activity.sites) {
          const result = calculateDungeonRewardBundleWork(site.bundle, tables);
          worst.resolvedDraws = Math.max(worst.resolvedDraws, result.work.resolvedDraws);
          worst.equipmentInstances = Math.max(worst.equipmentInstances, result.work.equipmentInstances);
          worst.affection = Math.max(worst.affection, result.work.affection);
          for (const currency of ['shards', 'waifubux', 'essence'] as const)
            worst.currencies[currency] = Math.max(worst.currencies[currency], result.work.currencies[currency]);
          for (const key of result.unresolvedTables) unresolved.add(key);
          // An event shared by several rooms is one site: report it once.
          if (reported.has(site.path)) continue;
          reported.add(site.path);
          for (const issue of activityWorkIssues(result.work)) issues.push({ ...issue, path: site.path });
        }
        addWork(work, worst);
      } else if (action.type === 'reward' && action.reward)
        work.currencies.shards += action.reward.currency.max;
    }),
  );
  for (const currency of ['shards', 'waifubux'] as const) {
    if (work.currencies[currency] > L.atRiskCurrencyPerDungeon)
      issues.push({
        code: 'reward_currency_too_large',
        path: `currencies.${currency}`,
        message: `worst-case ${currency} total ${work.currencies[currency]} exceeds ${L.atRiskCurrencyPerDungeon}`,
      });
  }
  return validated({ work, unresolvedTables: [...unresolved].sort() }, issues);
}
