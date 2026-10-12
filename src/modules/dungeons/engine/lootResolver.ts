/**
 * Phase 2 loot resolution and analytical odds. Deliberately not wired to stepDungeon.
 * All dependencies are supplied by the caller; this module never grants rewards.
 */
import { z } from 'zod';
import { rollWeighted, type Rng } from '../../../shared/random';
import { equipmentSelectorKey, EQUIPMENT_REWARD_RARITIES } from '../../equipment/rewardSelector';
import {
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
} from '../../equipment/vocabulary';
import type {
  EquipmentRewardCandidate,
  EquipmentRewardPools,
} from '../../rewardTables/rewardTableCore';
import { DungeonIdSchema } from '../content/dungeonIdentifiers';
import {
  DungeonRewardBundleSchema,
  DungeonLootTableBodySchema,
  validateDungeonRewardBundleWork,
  type DungeonRewardBundle,
  type DungeonRewardGrant,
  type DungeonLootTableBodies,
  type DungeonLootPoolEntry,
  type DungeonLootTableBody,
} from '../content/dungeonRewards';
import { dungeonRngSource } from './seeds';

export const DUNGEON_LOOT_RESOLVER_VERSION = 1 as const;

/** A view of resolved dependencies, not a publication snapshot builder or storage format. */
export interface DungeonRewardResolverSnapshot {
  /** Caller-supplied provenance; this module does not build or verify a snapshot hash. */
  hash: string;
  tables: DungeonLootTableBodies;
  equipmentPools: EquipmentRewardPools;
}
export interface DungeonRewardActivityIdentity {
  roomId: string;
  actionId: string;
}

export type DungeonResolvedRewardGrant =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence'; amount: number }
  | { type: 'item'; item: string; quantity: number }
  | { type: 'equipment'; definitionKey: string; rollSeed: number }
  | { type: 'affection'; amount: number };

export interface DungeonRewardSource {
  dropId: string;
  source: 'guaranteed' | 'chance' | 'table';
  mode: 'guaranteed' | 'chance' | 'pool';
  tableKey?: string;
  tableReferenceId?: string;
  /** Draws and pool picks are zero-based ordinals, not authoring array positions. */
  tableDraw?: number;
  poolId?: string;
  poolName?: string;
  poolPick?: number;
}
export interface DungeonResolvedRewardLine extends DungeonRewardSource {
  entryId: string;
  hit: boolean;
  missReason?: 'chance_missed' | 'nothing';
  grant?: DungeonResolvedRewardGrant;
  rolls: {
    chance?: { value: number; chanceBasisPoints: number };
    pool?: { value: number; weight: number; totalWeight: number };
    quantity?: { min: number; max: number; value: number };
    equipment?: { selectorKey: string; candidateCount: number; index: number };
  };
}
export interface DungeonRewardPlanV2 {
  v: 2;
  resolverVersion: typeof DUNGEON_LOOT_RESOLVER_VERSION;
  snapshotHash: string;
  atRisk: { shards: number; waifubux: number };
  secured: {
    /** Base amounts, before any participating Buddy bonus. */
    essence: number;
    affection: number;
    items: { item: string; quantity: number }[];
    equipment: { dropId: string; definitionKey: string; rollSeed: number }[];
  };
  lines: DungeonResolvedRewardLine[];
}

export interface DungeonLootResolverIssue {
  code: string;
  path: string;
  message: string;
}
export class DungeonLootResolverError extends Error {
  override readonly name = 'DungeonLootResolverError';
  constructor(public readonly issues: readonly DungeonLootResolverIssue[]) {
    super(
      issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
    );
  }
}

export type DungeonAnalysedReward =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence' }
  | { type: 'item'; item: string }
  | { type: 'equipment'; definitionKey: string }
  | { type: 'affection' };
export interface DungeonRewardProbability {
  reward: DungeonAnalysedReward;
  /** Unrounded fractions in [0,1]; consumers must not round tiny positive odds to 0%. */
  probability: number;
  expectedQuantity: number;
}
export interface DungeonRewardSourceAnalysis extends DungeonRewardSource {
  /** Same-reward alternatives within this one pick are merged before multiplying misses. */
  rewards: DungeonRewardProbability[];
  noRewardChance: number;
}
export interface DungeonRewardAnalysisEntry {
  reward: DungeonAnalysedReward;
  riskClass: 'at_risk' | 'secured';
  expectedQuantity: number;
  chanceAtLeastOnce: number;
  contributions: (DungeonRewardSource & { probability: number; expectedQuantity: number })[];
}
export interface DungeonRewardAnalysis {
  resolverVersion: typeof DUNGEON_LOOT_RESOLVER_VERSION;
  snapshotHash: string;
  /** Essence and affection figures exclude Buddy bonuses. */
  rewards: DungeonRewardAnalysisEntry[];
  expectedEquipmentPieces: number;
  chanceAnyEquipment: number;
  equipmentCandidateCount: number;
  noRewardChance: number;
  sources: DungeonRewardSourceAnalysis[];
}

type GrantSlot = DungeonRewardSource & {
  mode: 'guaranteed' | 'chance';
  entryId: string;
  grant: DungeonRewardGrant;
  chanceBasisPoints: number;
};
type PoolSlot = DungeonRewardSource & { mode: 'pool'; entries: DungeonLootPoolEntry[] };
type Slot = GrantSlot | PoolSlot;
interface Prepared {
  slots: Slot[];
  candidates: Map<string, EquipmentRewardCandidate[]>;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fail(code: string, path: string, message: string): never {
  throw new DungeonLootResolverError([{ code, path, message }]);
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, prefix: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DungeonLootResolverError(
      result.error.issues.map((issue) => ({
        code: 'reward_schema',
        path: [prefix, ...issue.path].join('.'),
        message: issue.message,
      })),
    );
  return result.data;
}

/** Copies and validates only dependencies that this bundle actually uses. */
function prepare(bundle: DungeonRewardBundle, snapshot: DungeonRewardResolverSnapshot): Prepared {
  parse(z.string().min(1), snapshot.hash, 'snapshot.hash');
  const parsed = parse(DungeonRewardBundleSchema, bundle, 'bundle');
  const tables = new Map<string, DungeonLootTableBody>();
  for (const ref of parsed.tables) {
    if (tables.has(ref.table)) continue;
    const table = snapshot.tables.get(ref.table);
    if (table)
      tables.set(ref.table, parse(DungeonLootTableBodySchema, table, `tables.${ref.table}`));
  }
  const work = validateDungeonRewardBundleWork(parsed, tables);
  if (!work.ok) throw new DungeonLootResolverError(work.issues);
  const slots: Slot[] = [];
  const grants = (
    content: Pick<DungeonRewardBundle, 'guaranteed' | 'chances'>,
    prefix: string[],
    table?: Omit<DungeonRewardSource, 'dropId' | 'source' | 'mode'>,
  ) => {
    for (const entry of content.guaranteed)
      slots.push({
        dropId: [...prefix, 'g', entry.id].join(':'),
        source: table ? 'table' : 'guaranteed',
        mode: 'guaranteed',
        ...table,
        entryId: entry.id,
        grant: entry.grant,
        chanceBasisPoints: 10_000,
      });
    for (const entry of content.chances)
      slots.push({
        dropId: [...prefix, 'c', entry.id].join(':'),
        source: table ? 'table' : 'chance',
        mode: 'chance',
        ...table,
        entryId: entry.id,
        grant: entry.grant,
        chanceBasisPoints: entry.chanceBasisPoints,
      });
  };
  grants(parsed, []);
  for (const ref of parsed.tables)
    for (let draw = 0; draw < ref.draws; draw++) {
      const table = tables.get(ref.table)!;
      const prefix = ['t', ref.id, String(draw)];
      const source = { tableKey: ref.table, tableReferenceId: ref.id, tableDraw: draw };
      grants(table, prefix, source);
      for (const pool of table.pools)
        for (let pick = 0; pick < pool.draws; pick++)
          slots.push({
            dropId: [...prefix, 'p', pool.id, String(pick)].join(':'),
            source: 'table',
            mode: 'pool',
            ...source,
            poolId: pool.id,
            poolName: pool.name,
            poolPick: pick,
            // Stable selection intervals: reordering authoring rows must not reroll a pick.
            entries: [...pool.entries].sort((a, b) => compare(a.id, b.id)),
          });
    }
  slots.sort((a, b) => compare(a.dropId, b.dropId));
  const candidates = new Map<string, EquipmentRewardCandidate[]>();
  const candidateSchema = z.object({
    key: z.string().max(EQUIPMENT_KEY_MAX_LENGTH).regex(EQUIPMENT_KEY_PATTERN),
    name: z.string(),
    slot: z.enum(EQUIPMENT_SLOTS),
    rarity: z.enum(EQUIPMENT_REWARD_RARITIES),
  });
  for (const slot of slots) {
    const rewards =
      slot.mode === 'pool'
        ? slot.entries.flatMap((entry) => ('grant' in entry ? [entry.grant] : []))
        : [slot.grant];
    for (const grant of rewards) {
      if (grant.type !== 'equipment') continue;
      const key = equipmentSelectorKey(grant.selector);
      if (candidates.has(key)) continue;
      const pool = Object.hasOwn(snapshot.equipmentPools, key)
        ? snapshot.equipmentPools[key]
        : undefined;
      if (!pool?.length)
        fail(
          'reward_equipment_unresolved',
          `equipmentPools.${key}`,
          'selector has no frozen candidates',
        );
      const copied = parse(z.array(candidateSchema).min(1), pool, `equipmentPools.${key}`).sort(
        (a, b) => compare(a.key, b.key),
      );
      const seen = new Set<string>();
      for (const candidate of copied) {
        if (seen.has(candidate.key))
          fail(
            'reward_equipment_invalid',
            `equipmentPools.${key}`,
            `duplicate candidate "${candidate.key}"`,
          );
        seen.add(candidate.key);
        if (
          (grant.selector.slot && candidate.slot !== grant.selector.slot) ||
          (grant.selector.rarity && candidate.rarity !== grant.selector.rarity) ||
          (grant.selector.definitionKeys && !grant.selector.definitionKeys.includes(candidate.key))
        ) {
          fail(
            'reward_equipment_invalid',
            `equipmentPools.${key}`,
            `candidate "${candidate.key}" contradicts its selector`,
          );
        }
      }
      candidates.set(key, copied);
    }
  }
  return { slots, candidates };
}

function sourceOf(slot: Slot): DungeonRewardSource {
  const {
    dropId,
    source,
    mode,
    tableKey,
    tableReferenceId,
    tableDraw,
    poolId,
    poolName,
    poolPick,
  } = slot;
  return {
    dropId,
    source,
    mode,
    ...(tableKey !== undefined
      ? { tableKey, tableReferenceId: tableReferenceId!, tableDraw: tableDraw! }
      : {}),
    ...(poolId !== undefined ? { poolId, poolName: poolName!, poolPick: poolPick! } : {}),
  };
}
function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0)
    fail('reward_unsafe_integer', '', 'reward arithmetic exceeds safe nonnegative integers');
  return result;
}

/** Same inputs give the same plan. No effects, services, bonus application, or shared running RNG. */
export function resolveRewardBundle(
  bundle: DungeonRewardBundle,
  snapshot: DungeonRewardResolverSnapshot,
  runSeed: number,
  activity: DungeonRewardActivityIdentity,
): DungeonRewardPlanV2 {
  parse(z.number().int().min(0).max(0xffff_ffff), runSeed, 'runSeed');
  parse(DungeonIdSchema, activity.roomId, 'roomId');
  parse(DungeonIdSchema, activity.actionId, 'actionId');
  const prepared = prepare(bundle, snapshot);
  const rngSource = dungeonRngSource(runSeed);
  const plan: DungeonRewardPlanV2 = {
    v: 2,
    resolverVersion: DUNGEON_LOOT_RESOLVER_VERSION,
    snapshotHash: snapshot.hash,
    atRisk: { shards: 0, waifubux: 0 },
    secured: { essence: 0, affection: 0, items: [], equipment: [] },
    lines: [],
  };
  const items = new Map<string, number>();
  for (const slot of prepared.slots) {
    // IDs cannot contain colons; splitting the drop id exactly recovers the 5.3 stream path.
    const rng = rngSource.stream(
      'loot',
      activity.roomId,
      activity.actionId,
      ...slot.dropId.split(':'),
    );
    const line: DungeonResolvedRewardLine = {
      ...sourceOf(slot),
      entryId: '',
      hit: false,
      rolls: {},
    };
    plan.lines.push(line);
    let grant: DungeonRewardGrant;
    if (slot.mode === 'pool') {
      let value = 0;
      const traced: Rng = {
        next: () => (value = rng.next()),
        intInclusive: (min, max) => rng.intInclusive(min, max),
      };
      const entry = rollWeighted(
        slot.entries.map((entry) => ({ weight: entry.weight, value: entry })),
        traced,
      );
      line.entryId = entry.id;
      line.rolls.pool = {
        value,
        weight: entry.weight,
        totalWeight: slot.entries.reduce((total, entry) => safeAdd(total, entry.weight), 0),
      };
      if ('nothing' in entry) {
        line.missReason = 'nothing';
        continue;
      }
      grant = entry.grant;
    } else {
      line.entryId = slot.entryId;
      if (slot.mode === 'chance') {
        const value = rng.intInclusive(0, 9999);
        line.rolls.chance = { value, chanceBasisPoints: slot.chanceBasisPoints };
        if (value >= slot.chanceBasisPoints) {
          line.missReason = 'chance_missed';
          continue;
        }
      }
      grant = slot.grant;
    }
    line.hit = true;
    if (grant.type === 'equipment') {
      const selectorKey = equipmentSelectorKey(grant.selector);
      const candidates = prepared.candidates.get(selectorKey)!;
      const index = rng.intInclusive(0, candidates.length - 1);
      const definitionKey = candidates[index]!.key;
      const rollSeed = rngSource.seedOf(
        'loot',
        activity.roomId,
        activity.actionId,
        'gear',
        slot.dropId,
      );
      line.rolls.equipment = { selectorKey, candidateCount: candidates.length, index };
      line.grant = { type: 'equipment', definitionKey, rollSeed };
      plan.secured.equipment.push({ dropId: line.dropId, definitionKey, rollSeed });
    } else {
      const range = grant.type === 'item' ? grant.quantity : grant.amount;
      const quantity = rng.intInclusive(range.min, range.max);
      line.rolls.quantity = { ...range, value: quantity };
      if (grant.type === 'item') {
        line.grant = { type: 'item', item: grant.item, quantity };
        items.set(grant.item, safeAdd(items.get(grant.item) ?? 0, quantity));
      } else if (grant.type === 'affection') {
        line.grant = { type: 'affection', amount: quantity };
        plan.secured.affection = safeAdd(plan.secured.affection, quantity);
      } else {
        line.grant = { type: 'currency', currency: grant.currency, amount: quantity };
        if (grant.currency === 'essence')
          plan.secured.essence = safeAdd(plan.secured.essence, quantity);
        else plan.atRisk[grant.currency] = safeAdd(plan.atRisk[grant.currency], quantity);
      }
    }
  }
  plan.secured.items = [...items]
    .sort(([a], [b]) => compare(a, b))
    .map(([item, quantity]) => ({ item, quantity }));
  return plan;
}

function rewardKey(reward: DungeonAnalysedReward): string {
  if (reward.type === 'currency') return `currency:${reward.currency}`;
  if (reward.type === 'item') return `item:${reward.item}`;
  if (reward.type === 'equipment') return `equipment:${reward.definitionKey}`;
  return 'affection';
}

/** Closed-form expectations and probabilities. Pools are alternatives within a pick, independent across picks. */
export function analyseRewardBundle(
  bundle: DungeonRewardBundle,
  snapshot: DungeonRewardResolverSnapshot,
): DungeonRewardAnalysis {
  const prepared = prepare(bundle, snapshot);
  const rewards = new Map<string, { entry: DungeonRewardAnalysisEntry; logMiss: number }>();
  const sources: DungeonRewardSourceAnalysis[] = [];
  let logNothing = 0;
  let logNoEquipment = 0;
  let expectedEquipmentPieces = 0;
  const equipmentKeys = new Set<string>();
  for (const slot of prepared.slots) {
    const totalWeight =
      slot.mode === 'pool'
        ? slot.entries.reduce((total, entry) => safeAdd(total, entry.weight), 0)
        : 0;
    const alternatives =
      slot.mode === 'pool'
        ? slot.entries.flatMap((entry) =>
            'grant' in entry
              ? [{ grant: entry.grant, probability: entry.weight / totalWeight }]
              : [],
          )
        : [{ grant: slot.grant, probability: slot.chanceBasisPoints / 10_000 }];
    const local = new Map<string, DungeonRewardProbability>();
    let anyReward = 0;
    let anyEquipment = 0;
    const add = (reward: DungeonAnalysedReward, probability: number, average: number) => {
      const key = rewardKey(reward);
      const old = local.get(key);
      if (old) {
        old.probability += probability;
        old.expectedQuantity += probability * average;
      } else local.set(key, { reward, probability, expectedQuantity: probability * average });
    };
    for (const { grant, probability } of alternatives) {
      anyReward += probability;
      if (grant.type === 'equipment') {
        anyEquipment += probability;
        const candidates = prepared.candidates.get(equipmentSelectorKey(grant.selector))!;
        for (const candidate of candidates) {
          equipmentKeys.add(candidate.key);
          add(
            { type: 'equipment', definitionKey: candidate.key },
            probability / candidates.length,
            1,
          );
        }
      } else {
        const range = grant.type === 'item' ? grant.quantity : grant.amount;
        const average = (range.min + range.max) / 2;
        if (grant.type === 'currency')
          add({ type: 'currency', currency: grant.currency }, probability, average);
        else if (grant.type === 'item')
          add({ type: 'item', item: grant.item }, probability, average);
        else add({ type: 'affection' }, probability, average);
      }
    }
    // Sum integer shares first so an all-grant or all-equipment pool has exactly 100% odds.
    if (slot.mode === 'pool') {
      anyReward =
        slot.entries.reduce(
          (total, entry) => ('grant' in entry ? safeAdd(total, entry.weight) : total),
          0,
        ) / totalWeight;
      anyEquipment =
        slot.entries.reduce(
          (total, entry) =>
            'grant' in entry && entry.grant.type === 'equipment'
              ? safeAdd(total, entry.weight)
              : total,
          0,
        ) / totalWeight;
    }
    logNothing += Math.log1p(-anyReward);
    logNoEquipment += Math.log1p(-anyEquipment);
    expectedEquipmentPieces += anyEquipment;
    const source = sourceOf(slot);
    const outcomes = [...local].sort(([a], [b]) => compare(a, b)).map(([, outcome]) => outcome);
    sources.push({ ...source, rewards: outcomes, noRewardChance: 1 - anyReward });
    for (const outcome of outcomes) {
      // Correct only accumulated floating-point error near 1, never round small positive odds away.
      outcome.probability = 1 - outcome.probability < Number.EPSILON * 40 ? 1 : outcome.probability;
      const key = rewardKey(outcome.reward);
      let total = rewards.get(key);
      if (!total) {
        total = {
          entry: {
            reward: outcome.reward,
            riskClass:
              outcome.reward.type === 'currency' && outcome.reward.currency !== 'essence'
                ? 'at_risk'
                : 'secured',
            expectedQuantity: 0,
            chanceAtLeastOnce: 0,
            contributions: [],
          },
          logMiss: 0,
        };
        rewards.set(key, total);
      }
      total.entry.expectedQuantity += outcome.expectedQuantity;
      total.logMiss += Math.log1p(-outcome.probability);
      total.entry.contributions.push({
        ...source,
        probability: outcome.probability,
        expectedQuantity: outcome.expectedQuantity,
      });
    }
  }
  return {
    resolverVersion: DUNGEON_LOOT_RESOLVER_VERSION,
    snapshotHash: snapshot.hash,
    rewards: [...rewards]
      .sort(([a], [b]) => compare(a, b))
      .map(([, total]) => ({ ...total.entry, chanceAtLeastOnce: -Math.expm1(total.logMiss) })),
    expectedEquipmentPieces,
    chanceAnyEquipment: -Math.expm1(logNoEquipment),
    equipmentCandidateCount: equipmentKeys.size,
    noRewardChance: Math.exp(logNothing),
    sources,
  };
}
