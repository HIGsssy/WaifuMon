/** Authoring previews only: no effects port, player identifiers or grant services. */
import { z } from 'zod';
import { DungeonKeySchema } from './content/dungeonIdentifiers';
import { DungeonDefinitionSchema, type DungeonDefinition } from './content/dungeonDefinition';
import {
  DungeonLootTableBodySchema, DungeonRewardBundleSchema, DungeonTableDrawSchema,
  calculateDungeonRewardBundleWork,
} from './content/dungeonRewards';
import { resolveDungeonRewardDependencies, type DungeonRewardSnapshot } from './content/dungeonRewardSnapshot';
import { validateDungeonRewards } from './validation/dungeonRewardValidation';
import { hasErrors, type DungeonIssue, type DungeonValidationContext } from './validation/dungeonValidation';
import {
  analyseRewardBundle, resolveRewardBundle, type DungeonRewardPlanV2,
  type DungeonRewardAnalysis, type DungeonAnalysedReward,
} from './engine/lootResolver';
import { rewardResolverSnapshot } from './engine/rewards';
import { deriveDungeonSeed, randomDungeonSeed } from './engine/seeds';

const required = z.unknown().refine((v) => v !== undefined, 'reward content is required');
export const DungeonPreviewTablesSchema = z.record(DungeonKeySchema, required).refine(
  (tables) => Object.keys(tables).length <= 100, 'At most 100 unsaved tables may be supplied',
);
export const DungeonTestRollRequestSchema = z.object({
  target: z.union([
    z.object({ bundle: required }).strict(),
    z.object({ tableBody: required, draws: DungeonTableDrawSchema.shape.draws.default(1) }).strict(),
  ]),
  tables: DungeonPreviewTablesSchema.optional(),
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
  simulate: z.number().int().min(0).max(10_000).default(0),
  /** Omit outside a containing dungeon; null explicitly tests an unset Shards configuration. */
  progressionCurrency: z.string().min(1).max(100).nullable().optional(),
}).strict();
export type DungeonTestRollRequest = z.infer<typeof DungeonTestRollRequestSchema>;
export const TEST_ROLL_ACTIVITY = { roomId: 'preview', actionId: 'reward' } as const;
/** Bounds CPU/allocations as well as the number of simulations. */
export const MAX_TEST_ROLL_RESOLVED_DRAWS = 1_000_000;
export interface DungeonRewardSimulation {
  kind: 'observed';
  runs: number;
  averages: { reward: DungeonAnalysedReward; riskClass: 'at_risk' | 'secured'; averageQuantity: number }[];
  nothingRate: number;
  nothingResults: number;
}
export interface DungeonTestRollResult {
  seed: number;
  roll: DungeonRewardPlanV2 | null;
  analysis: DungeonRewardAnalysis | null;
  issues: DungeonIssue[];
  simulation?: DungeonRewardSimulation;
  /** Display metadata, without generating equipment stats or applying Buddy bonuses. */
  items: DungeonRewardSnapshot['items'];
  equipmentPools: DungeonRewardSnapshot['equipmentPools'];
}

const shapeIssues = (error: z.ZodError, path: string): DungeonIssue[] => error.issues.map((i) => ({
  code: 'schema', severity: 'error', path: [path, ...i.path].join('.'), message: i.message,
}));

/** Request-only active rows override even missing/archived catalogue entries. Never saved. */
export function previewRewardContext(
  ctx: DungeonValidationContext, tables: Record<string, unknown> = {},
): { context: DungeonValidationContext; issues: DungeonIssue[] } {
  const lootTables = new Map(ctx.lootTables);
  const issues: DungeonIssue[] = [];
  for (const [key, raw] of Object.entries(tables)) {
    const parsed = DungeonLootTableBodySchema.safeParse(raw);
    if (!parsed.success) issues.push(...shapeIssues(parsed.error, `tables.${key}`));
    else lootTables.set(key, { name: lootTables.get(key)?.name ?? key, body: parsed.data, archivedAt: null, revision: 1 });
  }
  return { context: { ...ctx, lootTables }, issues };
}

/** Shared T6 builder; callers validate against this exact context first. */
export function buildPreviewRewardSnapshot(definition: DungeonDefinition, ctx: DungeonValidationContext) {
  return resolveDungeonRewardDependencies(definition, ctx).snapshot;
}

export function testRollDungeonRewards(input: DungeonTestRollRequest, ctx: DungeonValidationContext): DungeonTestRollResult {
  const seed = input.seed ?? randomDungeonSeed();
  const result: DungeonTestRollResult = { seed, roll: null, analysis: null, issues: [], items: {}, equipmentPools: {} };
  const overrides = previewRewardContext(ctx, input.tables);
  result.issues.push(...overrides.issues);
  let raw: unknown;
  if ('bundle' in input.target) raw = input.target.bundle;
  else {
    const table = DungeonLootTableBodySchema.safeParse(input.target.tableBody);
    if (!table.success) {
      result.issues.push(...shapeIssues(table.error, 'target.tableBody'));
      return result;
    }
    // This private table takes precedence over any request-supplied key of the same name.
    overrides.context.lootTables = new Map(overrides.context.lootTables).set('test_roll_table', {
      name: 'Test table', body: table.data, archivedAt: null,
    });
    raw = { guaranteed: [], chances: [], tables: [{ id: 'table', table: 'test_roll_table', draws: input.target.draws }] };
  }
  const bundle = DungeonRewardBundleSchema.safeParse(raw);
  if (!bundle.success) {
    result.issues.push(...shapeIssues(bundle.error, 'target.bundle'));
    return result;
  }
  // A one-activity container lets T5 and T6 share their existing dungeon dependency rules.
  const definition = DungeonDefinitionSchema.parse({
    key: 'test_roll', name: 'Test Roll', entranceRoomId: TEST_ROLL_ACTIVITY.roomId,
    settings: { progressionCurrency: input.progressionCurrency ?? null },
    rooms: [{ id: TEST_ROLL_ACTIVITY.roomId, name: 'Preview', kind: 'exit',
      actions: [{ id: TEST_ROLL_ACTIVITY.actionId, type: 'reward', rewards: bundle.data }] }],
  });
  result.issues.push(...validateDungeonRewards(definition, overrides.context, {
    checkShardsConfiguration: input.progressionCurrency !== undefined,
  }).issues);
  if (hasErrors(result.issues)) return result;
  const snapshot = buildPreviewRewardSnapshot(definition, overrides.context);
  if (!snapshot) return result; // Validation reports all incomplete dependencies above.
  const resolver = rewardResolverSnapshot(snapshot);
  const work = calculateDungeonRewardBundleWork(bundle.data, resolver.tables).work.resolvedDraws;
  if ((input.simulate + 1) * Math.max(1, work) > MAX_TEST_ROLL_RESOLVED_DRAWS) {
    result.issues.push({ code: 'reward_too_many_draws', severity: 'error', path: 'simulate',
      message: `Preview and simulation exceed ${MAX_TEST_ROLL_RESOLVED_DRAWS} resolved draws. Reduce the simulation count or reward draws.` });
    return result;
  }
  result.items = snapshot.items;
  result.equipmentPools = snapshot.equipmentPools;
  result.roll = resolveRewardBundle(bundle.data, resolver, seed, TEST_ROLL_ACTIVITY);
  result.analysis = analyseRewardBundle(bundle.data, resolver);
  if (input.simulate > 0) {
    const totals = result.analysis.rewards.map((entry) => ({ reward: entry.reward, riskClass: entry.riskClass, averageQuantity: 0 }));
    let nothing = 0;
    let nothingResults = 0;
    for (let index = 0; index < input.simulate; index++) {
      const plan = resolveRewardBundle(bundle.data, resolver,
        deriveDungeonSeed(seed, ['test-roll', 'simulation', index]), TEST_ROLL_ACTIVITY);
      if (plan.lines.every((line) => !line.hit)) nothing++;
      nothingResults += plan.lines.filter((line) => line.missReason === 'nothing').length;
      for (const total of totals) {
        const reward = total.reward;
        const quantity = reward.type === 'currency'
          ? reward.currency === 'essence' ? plan.secured.essence : plan.atRisk[reward.currency]
          : reward.type === 'affection' ? plan.secured.affection
          : reward.type === 'item' ? plan.secured.items.find((i) => i.item === reward.item)?.quantity ?? 0
          : plan.secured.equipment.filter((e) => e.definitionKey === reward.definitionKey).length;
        total.averageQuantity += quantity;
      }
    }
    for (const total of totals) total.averageQuantity /= input.simulate;
    result.simulation = { kind: 'observed', runs: input.simulate, averages: totals, nothingRate: nothing / input.simulate, nothingResults };
  }
  return result;
}
