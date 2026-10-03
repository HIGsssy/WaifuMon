/**
 * Dungeon zone definitions — the authored input of the dungeon generator.
 *
 * A zone is one document: display fields, generation rules, content pools and
 * reward settings. The same shape is the shipped file
 * (`content/dungeons/zones.json`), the `dungeon_zones.definition` column, what
 * the Admin editor round-trips, and what a run snapshots.
 *
 * Two layers of rule, on purpose:
 *
 *   - **weights** say what the generator prefers (`generation.nodeWeights`,
 *     every pool entry's `weight`);
 *   - **constraints** say what is legal (`depthRanges`, `required`, `limits`,
 *     `noConsecutive`, `maxConsecutiveSameEnemy`, `boss`, `extraction`, and
 *     every pool entry's depth range).
 *
 * A weight never overrides a constraint.
 *
 * This file is the *shape*: everything checkable from the document alone.
 * References into other content (enemies, events, reward tables, the
 * currency) and whether the rules can actually produce a run are checked by
 * `zoneValidation.ts`.
 *
 * Pure: no database, no logger.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import { canonicalJson } from '../rewardTables/rewardTableCore';

/** Relative to the content directory. */
export const DUNGEON_ZONE_FILE = 'dungeons/zones.json';
export const DUNGEON_ZONE_FILE_FORMAT = 'waifumon-dungeon-zones' as const;
export const DUNGEON_ZONE_FILE_VERSION = 1 as const;

export const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const DUNGEON_KEY_MAX_LENGTH = 64;

/**
 * Every node type the model knows. A new type (vendor, puzzle…) is a new entry
 * here plus whatever the generator must know about its structural role; the
 * stored documents and graphs carry the type as text, so no schema changes.
 */
export const DUNGEON_NODE_TYPES = [
  'combat',
  'elite',
  'event',
  'reward',
  'rest',
  'miniboss',
  'boss',
  'exit',
] as const;
export type DungeonNodeType = (typeof DUNGEON_NODE_TYPES)[number];

/**
 * Types the generator places by weight. `boss` is not one of them: a boss is
 * placed structurally, as the final node, when `generation.boss.required`.
 */
export const DUNGEON_WEIGHTED_NODE_TYPES = [
  'combat',
  'elite',
  'event',
  'reward',
  'rest',
  'miniboss',
  'exit',
] as const satisfies readonly DungeonNodeType[];
export type DungeonWeightedNodeType = (typeof DUNGEON_WEIGHTED_NODE_TYPES)[number];

/** Node types that fight an enemy, and so draw from the pool of the same name. */
export const DUNGEON_ENEMY_NODE_TYPES = ['combat', 'elite', 'miniboss', 'boss'] as const satisfies readonly DungeonNodeType[];
export type DungeonEnemyNodeType = (typeof DUNGEON_ENEMY_NODE_TYPES)[number];

export const DUNGEON_POOL_KEYS = ['combat', 'elite', 'miniboss', 'boss', 'event'] as const;
export type DungeonPoolKey = (typeof DUNGEON_POOL_KEYS)[number];

export function isEnemyNodeType(type: DungeonNodeType): type is DungeonEnemyNodeType {
  return (DUNGEON_ENEMY_NODE_TYPES as readonly string[]).includes(type);
}

/** The pool a node type draws its content from, or null when it has none. */
export function poolForNodeType(type: DungeonNodeType): DungeonPoolKey | null {
  if (isEnemyNodeType(type)) return type;
  return type === 'event' ? 'event' : null;
}

/** Sanity ceilings — a V1 dungeon is a short graph, not a map. */
export const DUNGEON_MAX_NODES = 40;
export const DUNGEON_MAX_BRANCHES = 4;
export const DUNGEON_MAX_BRANCH_LENGTH = 3;
export const DUNGEON_WEIGHT_MAX = 1_000_000;
export const DUNGEON_CURRENCY_MAX = 1_000_000;
export const BASIS_POINTS = 10_000;

/** The stable key of the currency dungeons pay unless a zone says otherwise. */
export const DEFAULT_PROGRESSION_CURRENCY_KEY = 'ascension_currency';

const key = z
  .string()
  .max(DUNGEON_KEY_MAX_LENGTH)
  .regex(DUNGEON_KEY_PATTERN, 'must be lower_snake_case');
const tags = z.array(key).max(20).default([]);
const weight = z.number().int().min(0).max(DUNGEON_WEIGHT_MAX);
const depth = z.number().int().min(1).max(DUNGEON_MAX_NODES);
const nodeType = z.enum(DUNGEON_NODE_TYPES);
const basisPoints = z.number().int().min(0).max(BASIS_POINTS);

/** `minDepth`..`maxDepth` inclusive; a null `maxDepth` is open-ended. */
const depthRangeShape = {
  minDepth: depth.default(1),
  maxDepth: depth.nullable().default(null),
};

function refineDepthRange(
  range: { minDepth: number; maxDepth: number | null },
  ctx: z.RefinementCtx,
): void {
  if (range.maxDepth !== null && range.maxDepth < range.minDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxDepth'],
      message: `maxDepth ${range.maxDepth} is below minDepth ${range.minDepth}`,
    });
  }
}

const poolEntryShape = {
  /** Stable within its pool; recorded on every node drawn from the entry. */
  id: key,
  enabled: z.boolean().default(true),
  weight,
  ...depthRangeShape,
  /** Persisted for authoring and future filtering; the generator ignores them. */
  tags,
};

/** One enemy a pool may place. Names the enemy; never copies its stats. */
export const DungeonEnemyPoolEntrySchema = z
  .object({ ...poolEntryShape, enemyKey: key })
  .strict()
  .superRefine(refineDepthRange);
export type DungeonEnemyPoolEntry = z.infer<typeof DungeonEnemyPoolEntrySchema>;

export const DungeonEventPoolEntrySchema = z
  .object({ ...poolEntryShape, eventKey: key })
  .strict()
  .superRefine(refineDepthRange);
export type DungeonEventPoolEntry = z.infer<typeof DungeonEventPoolEntrySchema>;

export type DungeonPoolEntry = DungeonEnemyPoolEntry | DungeonEventPoolEntry;

const pool = <T extends z.ZodTypeAny>(entry: T) => z.array(entry).max(200).default([]);

export const DungeonPoolsSchema = z
  .object({
    combat: pool(DungeonEnemyPoolEntrySchema),
    elite: pool(DungeonEnemyPoolEntrySchema),
    miniboss: pool(DungeonEnemyPoolEntrySchema),
    boss: pool(DungeonEnemyPoolEntrySchema),
    event: pool(DungeonEventPoolEntrySchema),
  })
  .strict();
export type DungeonPools = z.infer<typeof DungeonPoolsSchema>;

const amountRange = z
  .object({
    min: z.number().int().min(0).max(DUNGEON_CURRENCY_MAX),
    max: z.number().int().min(0).max(DUNGEON_CURRENCY_MAX),
  })
  .strict()
  .refine((r) => r.max >= r.min, { message: 'max must be >= min', path: ['max'] });
const noCurrency = { min: 0, max: 0 };

/** A reward table id — an `expedition`-kind row in `reward_tables`. */
const rewardTableRef = z.string().min(1).max(128).nullable().default(null);

/**
 * A depth band: what nodes in a depth range pay.
 *
 * `nodeTypes` empty means every type. A node takes the first band that names
 * its type, else the first band that names none — so "elite" and "boss" bands
 * sit alongside the general depth tiers without ordering tricks.
 */
export const DungeonRewardBandSchema = z
  .object({
    id: key,
    enabled: z.boolean().default(true),
    ...depthRangeShape,
    nodeTypes: z.array(nodeType).max(DUNGEON_NODE_TYPES.length).default([]),
    /** Ordinary rewards: WaifuBux, items, and any gear the table carries. */
    rewardTable: rewardTableRef,
    /** A further table rolled for Equipment — the "stronger gear deeper" lever. */
    equipmentRewardTable: rewardTableRef,
    /** Unbanked progression currency added by a node in this band. */
    currency: amountRange.default(noCurrency),
  })
  .strict()
  .superRefine(refineDepthRange);
export type DungeonRewardBand = z.infer<typeof DungeonRewardBandSchema>;

/** A one-off payout: completing the run, or extracting from it. */
const bonusSchema = z
  .object({
    currency: amountRange.default(noCurrency),
    rewardTable: rewardTableRef,
  })
  .strict()
  .default({});

export const DungeonRewardsSchema = z
  .object({
    /** Stable key of the progression currency this zone pays. Never a display name. */
    currencyKey: key.default(DEFAULT_PROGRESSION_CURRENCY_KEY),
    /**
     * Share of the *unbanked* currency a player keeps on defeat, in basis
     * points (2500 = 25%). Extraction and completion bank all of it.
     */
    defeatCurrencyRetentionBasisPoints: basisPoints,
    bands: z.array(DungeonRewardBandSchema).max(50).default([]),
    completion: bonusSchema,
    extraction: bonusSchema,
  })
  .strict();
export type DungeonRewards = z.infer<typeof DungeonRewardsSchema>;

const typeList = z.array(nodeType).min(1).max(DUNGEON_NODE_TYPES.length);

export const DungeonGenerationSchema = z
  .object({
    /** Total nodes in a run, branch alternates included. */
    minNodes: z.number().int().min(2).max(DUNGEON_MAX_NODES),
    maxNodes: z.number().int().min(2).max(DUNGEON_MAX_NODES),
    /**
     * Two-way forks off the main path that rejoin it. `minBranches` are always
     * placed; each further one up to `maxBranches` is rolled at
     * `chanceBasisPoints`. A fork runs `1..maxLength` nodes before rejoining.
     */
    branching: z
      .object({
        minBranches: z.number().int().min(0).max(DUNGEON_MAX_BRANCHES).default(0),
        maxBranches: z.number().int().min(0).max(DUNGEON_MAX_BRANCHES).default(0),
        chanceBasisPoints: basisPoints.default(0),
        maxLength: z.number().int().min(1).max(DUNGEON_MAX_BRANCH_LENGTH).default(1),
      })
      .strict()
      .default({}),
    /**
     * Where a player may leave with what they carry. A node offers extraction
     * when its depth is at least `minDepth` and its type is in `nodeTypes`;
     * the final node never does (finishing it is completion). An `exit` node
     * is itself only legal from `minDepth`. `minPoints` guarantees that many
     * extraction nodes on the main path — ones no route can skip.
     */
    extraction: z
      .object({
        minDepth: depth,
        nodeTypes: z.array(nodeType).max(DUNGEON_NODE_TYPES.length).default(['exit']),
        minPoints: z.number().int().min(0).max(DUNGEON_MAX_NODES).default(0),
      })
      .strict(),
    /** Preference among the types legal at a slot. Zero means "never by chance". */
    nodeWeights: z
      .object({
        combat: weight.default(0),
        elite: weight.default(0),
        event: weight.default(0),
        reward: weight.default(0),
        rest: weight.default(0),
        miniboss: weight.default(0),
        exit: weight.default(0),
      })
      .strict(),
    /**
     * `required: true` — the final node is the run's one boss, and no other
     * node is. `false` — no boss; the final node is an `exit`.
     */
    boss: z.object({ required: z.boolean().default(true) }).strict().default({}),
    /** The depths a type may appear at. A type with no entry may appear anywhere. */
    depthRanges: z
      .record(nodeType, z.object(depthRangeShape).strict().superRefine(refineDepthRange))
      .default({}),
    /**
     * "At least `min` nodes of these types", counted on the main path only —
     * a node on a fork can be walked around, so it guarantees nothing.
     */
    required: z
      .array(z.object({ types: typeList, min: z.number().int().min(1).max(DUNGEON_MAX_NODES) }).strict())
      .max(20)
      .default([]),
    /** "At most `max` nodes of these types", counted over the whole graph. */
    limits: z
      .array(z.object({ types: typeList, max: z.number().int().min(0).max(DUNGEON_MAX_NODES) }).strict())
      .max(20)
      .default([]),
    /** Types that may not follow themselves along an edge. */
    noConsecutive: z.array(nodeType).max(DUNGEON_NODE_TYPES.length).default([]),
    /**
     * The same enemy may be fought at most this many times in a row along any
     * route. A node with no enemy breaks the streak. Null for no limit.
     */
    maxConsecutiveSameEnemy: z.number().int().min(1).max(DUNGEON_MAX_NODES).nullable().default(null),
  })
  .strict()
  .superRefine((gen, ctx) => {
    if (gen.minNodes > gen.maxNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minNodes'],
        message: `minNodes ${gen.minNodes} is above maxNodes ${gen.maxNodes}`,
      });
    }
    if (gen.branching.minBranches > gen.branching.maxBranches) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branching', 'minBranches'],
        message: `minBranches ${gen.branching.minBranches} is above maxBranches ${gen.branching.maxBranches}`,
      });
    }
    if (DUNGEON_WEIGHTED_NODE_TYPES.every((t) => gen.nodeWeights[t] === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeWeights'],
        message: 'every node weight is zero — at least one node type needs a weight',
      });
    }
  });
export type DungeonGeneration = z.infer<typeof DungeonGenerationSchema>;

function duplicateIds(
  entries: readonly { id: string }[],
  path: (string | number)[],
  what: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, i) => {
    const first = seen.get(entry.id);
    if (first === undefined) seen.set(entry.id, i);
    else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i, 'id'],
        message: `duplicate ${what} id "${entry.id}" (also ${path.join('.')}[${first}])`,
      });
    }
  });
}

export const DungeonZoneDefinitionSchema = z
  .object({
    /** Stable for the life of the zone. Runs record it by value. */
    key,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(''),
    enabled: z.boolean(),
    /** List order, ascending. */
    order: z.number().int().min(0).max(100_000).default(0),
    /** Relative to the assets root, conventionally `dungeons/zones/<key>.webp`. */
    artworkPath: relativeArtworkPath.nullable().default(null),
    /** Conventionally `dungeons/backgrounds/<key>.webp`. */
    backgroundArtworkPath: relativeArtworkPath.nullable().default(null),
    tags,
    generation: DungeonGenerationSchema,
    pools: DungeonPoolsSchema,
    rewards: DungeonRewardsSchema,
  })
  .strict()
  .superRefine((zone, ctx) => {
    for (const poolKey of DUNGEON_POOL_KEYS) {
      duplicateIds(zone.pools[poolKey], ['pools', poolKey], 'pool entry', ctx);
    }
    duplicateIds(zone.rewards.bands, ['rewards', 'bands'], 'reward band', ctx);
  });

export type DungeonZoneDefinition = z.infer<typeof DungeonZoneDefinitionSchema>;
export type DungeonZoneDefinitionInput = z.input<typeof DungeonZoneDefinitionSchema>;

export const DungeonZoneFileSchema = z
  .object({
    format: z.literal(DUNGEON_ZONE_FILE_FORMAT),
    version: z.literal(DUNGEON_ZONE_FILE_VERSION),
    zones: z.array(DungeonZoneDefinitionSchema).max(500),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    file.zones.forEach((zone, i) => {
      const first = seen.get(zone.key);
      if (first === undefined) seen.set(zone.key, i);
      else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['zones', i, 'key'],
          message: `duplicate zone key "${zone.key}" (also zones[${first}])`,
        });
      }
    });
  });

/**
 * What a zone *means*, as a hash: parsed (so defaults are filled in), then
 * serialised with sorted keys and kept array order. Pool and band order is
 * significant — it changes deterministic draws — so reordering is a change.
 * Reformatting the file is not.
 *
 * @throws {z.ZodError} when the zone does not parse.
 */
export function dungeonZoneHash(zone: unknown): string {
  const parsed = DungeonZoneDefinitionSchema.parse(zone);
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

/** True when `depth` falls inside an inclusive, possibly open-ended range. */
export function depthInRange(
  depthValue: number,
  range: { minDepth: number; maxDepth: number | null } | undefined,
): boolean {
  if (!range) return true;
  return depthValue >= range.minDepth && (range.maxDepth === null || depthValue <= range.maxDepth);
}

/**
 * The band a node of `type` at `depthValue` pays from: the first enabled band
 * in range that names the type, else the first that names no type at all.
 */
export function rewardBandFor(
  bands: readonly DungeonRewardBand[],
  type: DungeonNodeType,
  depthValue: number,
): DungeonRewardBand | null {
  const inRange = bands.filter((b) => b.enabled && depthInRange(depthValue, b));
  return (
    inRange.find((b) => b.nodeTypes.includes(type)) ?? inRange.find((b) => b.nodeTypes.length === 0) ?? null
  );
}

/**
 * The shallowest and deepest final depth a run of this zone can have: total
 * nodes minus the nodes spent on fork alternates, over every fork layout that
 * fits. Forks sit strictly between the first and final depth with a rejoin
 * node between any two — the same rule the generator lays them out by — so a
 * run too short for its optional forks simply has fewer of them.
 */
export function possibleFinalDepths(gen: DungeonGeneration): { min: number; max: number } {
  const { minBranches, maxBranches, maxLength } = gen.branching;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let total = gen.minNodes; total <= gen.maxNodes; total++) {
    for (let branches = minBranches; branches <= maxBranches; branches++) {
      for (let alternates = branches; alternates <= branches * maxLength; alternates++) {
        const depthCount = total - alternates;
        const interiorNeeded = alternates + Math.max(0, branches - 1);
        if (depthCount < 2 || depthCount - 2 < interiorNeeded) continue;
        min = Math.min(min, depthCount);
        max = Math.max(max, depthCount);
      }
    }
  }
  // Nothing fits (required forks in a run too short for them): report the
  // unforked range so the callers' checks stay meaningful; the trial runs
  // surface the real problem.
  return max === 0 ? { min: gen.minNodes, max: gen.maxNodes } : { min, max };
}
