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
import { SpritePlacementSchema } from '../artworkAssets/scenePlacement';
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

/**
 * How a zone's run graph comes to be.
 *
 *   - `procedural` — the seeded generator builds a fresh graph per run from
 *     `generation` and `pools`;
 *   - `authored` — an admin laid the rooms out by hand (`authored`), and every
 *     run walks that same graph.
 *
 * Either way a run starts from the same {@link DungeonGraph} shape, so nothing
 * after run start knows which one it was. A zone stored before the field
 * existed is procedural.
 */
export const DUNGEON_LAYOUT_MODES = ['procedural', 'authored'] as const;
export type DungeonLayoutMode = (typeof DUNGEON_LAYOUT_MODES)[number];

/** Sanity ceilings — a V1 dungeon is a short graph, not a map. */
export const DUNGEON_MAX_NODES = 40;
/** An authored layout is held to the same size as a generated one. */
export const DUNGEON_MAX_ROOMS = DUNGEON_MAX_NODES;
/** Ways on from one authored room — the choices a player is offered at once. */
export const DUNGEON_MAX_ROOM_EXITS = 3;
export const DUNGEON_MAX_BRANCHES = 4;
export const DUNGEON_MAX_BRANCH_LENGTH = 3;
export const DUNGEON_WEIGHT_MAX = 1_000_000;
export const DUNGEON_CURRENCY_MAX = 1_000_000;
export const BASIS_POINTS = 10_000;

/**
 * The asset folders the Admin artwork picker may browse for a zone. Zone art
 * lives under `dungeons/zones/` and `dungeons/backgrounds/`.
 */
export const DUNGEON_ARTWORK_ROOTS = ['dungeons'] as const;

/** A region id as the region catalogue writes it: kebab-case. */
export const DUNGEON_REGION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DUNGEON_MAX_REGIONS = 50;

/**
 * Zone artwork: the shared authored-artwork rules (relative, no traversal, a
 * supported image extension), plus one mistake worth naming — the value is
 * relative to the assets root, so it never starts with `assets/`.
 */
const zoneArtworkPath = relativeArtworkPath.refine((p) => !/^assets\//i.test(p), {
  message: 'is relative to the assets folder — drop the leading "assets/" (e.g. dungeons/zones/<key>.webp)',
});

/** A managed artwork asset id (`artwork_assets.id`). Existence is checked in `zoneValidation.ts`. */
const artworkAssetId = z
  .string()
  .uuid('must be a managed artwork asset id')
  .transform((v) => v.toLowerCase());

export const DUNGEON_MAX_BACKGROUNDS = 50;

/** The stable key of the currency dungeons pay unless a zone says otherwise. */
export const DEFAULT_PROGRESSION_CURRENCY_KEY = 'ascension_currency';

const key = z
  .string()
  .max(DUNGEON_KEY_MAX_LENGTH)
  .regex(DUNGEON_KEY_PATTERN, 'must be lower_snake_case');
const tags = z.array(key).max(20).default([]);
const weight = z.number().int().min(0).max(DUNGEON_WEIGHT_MAX);
/** Guaranteed-extraction depth windows a zone may declare. */
export const DUNGEON_MAX_EXTRACTION_WINDOWS = 5;

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

/**
 * One background a zone's nodes may be drawn against. Names exactly one
 * image: a managed asset (`assetId`, uploaded in the Portal) or shipped
 * artwork (`artworkPath`, under `assets/`). `weight` and the depth range work
 * as they do for a pool entry; which background a node gets is decided once,
 * when the run is generated (`dungeonScenes.ts`), never per render.
 */
export const DungeonBackgroundEntrySchema = z
  .object({
    /** Stable within the zone; recorded on every node that drew it. */
    id: key,
    enabled: z.boolean().default(true),
    weight,
    ...depthRangeShape,
    assetId: artworkAssetId.nullable().default(null),
    artworkPath: zoneArtworkPath.nullable().default(null),
  })
  .strict()
  .superRefine((entry, ctx) => {
    refineDepthRange(entry, ctx);
    if ((entry.assetId === null) === (entry.artworkPath === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'a background names exactly one image: a managed asset or a shipped artwork path',
      });
    }
  });
export type DungeonBackgroundEntry = z.infer<typeof DungeonBackgroundEntrySchema>;

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

/** Initial tuning: a rest restores 30% of max HP unless the zone says otherwise. */
export const DEFAULT_REST_HEAL_BASIS_POINTS = 3000;

/**
 * What a node of a given type *does* when it is resolved, per zone — the
 * tunable behaviour that is not a reward. One entry per node type that has
 * any; a new type with settings (a vendor's stock, a shrine's price) adds its
 * own key here.
 */
export const DungeonNodeSettingsSchema = z
  .object({
    rest: z
      .object({
        /** Share of the fighter's *max* HP a rest restores (3000 = 30%). Never above max HP. */
        healBasisPoints: basisPoints.default(DEFAULT_REST_HEAL_BASIS_POINTS),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});
export type DungeonNodeSettings = z.infer<typeof DungeonNodeSettingsSchema>;

const typeList = z.array(nodeType).min(1).max(DUNGEON_NODE_TYPES.length);

/**
 * Where and how often Rest nodes appear — the Rest half of "Rest & Recovery"
 * (how much one heals is `nodeSettings.rest`). Applied on top of the generic
 * `depthRanges`, `required` and `limits`: a rest must satisfy both. Every
 * default is "no rule", so a zone without this block generates exactly as it
 * did before it existed.
 *
 *   - `minNodes` — at least this many rests on the **main path**, where no
 *     route can skip them. `maxNodes` — at most this many in the whole run
 *     (null: no limit).
 *   - `minDepth` / `maxDepth` — the depths a rest may sit at.
 *   - `beforeBoss` — the node immediately before the final boss is always a
 *     rest. That depth is kept off every fork, so it is the one node every
 *     route to the boss passes through. It is an ordinary rest in every other
 *     respect: it counts toward `minNodes` and `maxNodes`, must lie inside the
 *     depth range, and offers extraction if rests do.
 *
 * Whether a rest is also an extraction point is not decided here — that is
 * `extraction.nodeTypes`. Rest and extraction are separate concepts.
 */
export const DungeonRestRulesSchema = z
  .object({
    minNodes: z.number().int().min(0).max(DUNGEON_MAX_NODES).default(0),
    maxNodes: z.number().int().min(0).max(DUNGEON_MAX_NODES).nullable().default(null),
    ...depthRangeShape,
    beforeBoss: z.boolean().default(false),
  })
  .strict()
  .superRefine((rest, ctx) => {
    refineDepthRange(rest, ctx);
    if (rest.maxNodes !== null && rest.minNodes > rest.maxNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minNodes'],
        message: `minNodes ${rest.minNodes} is above maxNodes ${rest.maxNodes}`,
      });
    }
  })
  .default({});
export type DungeonRestRules = z.infer<typeof DungeonRestRulesSchema>;

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
     *
     * `windows` says *where* guaranteed points go: each window holds one
     * main-path extraction node between its `minDepth` and `maxDepth`. A
     * `required` window must be placeable in every run (the shortest
     * included); an optional one is placed when the run is long enough to
     * have a free main-path slot there and skipped otherwise — "an early way
     * out always, a later one where the run has room". Windows count toward
     * `minPoints`. Without any, guaranteed points land at any depth from
     * `minDepth`.
     */
    extraction: z
      .object({
        minDepth: depth,
        nodeTypes: z.array(nodeType).max(DUNGEON_NODE_TYPES.length).default(['exit']),
        minPoints: z.number().int().min(0).max(DUNGEON_MAX_NODES).default(0),
        windows: z
          .array(
            z
              .object({ ...depthRangeShape, required: z.boolean().default(true) })
              .strict()
              .superRefine(refineDepthRange),
          )
          .max(DUNGEON_MAX_EXTRACTION_WINDOWS)
          .default([]),
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
    /**
     * A fixed opening: every run's first node is this type (its content still
     * comes from the type's pool). Null leaves the first node to the weights.
     * With `rest.beforeBoss` and `boss.required` this is the whole of the
     * "mandatory rooms" a procedural zone can pin: start, pre-boss, boss.
     */
    firstNodeType: z.enum(DUNGEON_WEIGHTED_NODE_TYPES).nullable().default(null),
    /** Rest placement: how many, at which depths, and whether one always precedes the boss. */
    rest: DungeonRestRulesSchema,
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

/**
 * What a zone with no generator settings gets: the smallest block that
 * parses. An authored zone never reads it; a procedural zone left on it has
 * empty pools and is refused by validation, not silently generated.
 */
const DEFAULT_GENERATION = {
  minNodes: 2,
  maxNodes: 2,
  extraction: { minDepth: 1 },
  nodeWeights: { combat: 1 },
} as const;

/** What one authored room pays, in place of the zone's reward bands. */
export const DungeonRoomRewardSchema = z
  .object({
    /** Ordinary rewards: WaifuBux, items, and any gear the table carries. */
    rewardTable: rewardTableRef,
    /** A further table rolled for Equipment. */
    equipmentRewardTable: rewardTableRef,
    /** Unbanked progression currency. */
    currency: amountRange.default(noCurrency),
  })
  .strict();
export type DungeonRoomReward = z.infer<typeof DungeonRoomRewardSchema>;

/** A room's own picture of its enemy, over the enemy's defaults. Each field alone: null inherits. */
export const DungeonRoomSceneSchema = z
  .object({
    spriteAssetId: artworkAssetId.nullable().default(null),
    artworkAssetId: artworkAssetId.nullable().default(null),
    spritePlacement: SpritePlacementSchema.nullable().default(null),
  })
  .strict();
export type DungeonRoomScene = z.infer<typeof DungeonRoomSceneSchema>;

/**
 * One room of an authored layout. It compiles to exactly one node of the run
 * graph (`authoredLayout.ts`), so a room *is* a node with its content chosen
 * by hand rather than drawn from a pool.
 *
 * Everything optional inherits: no `reward` pays the zone's reward band for
 * the room's type and depth, no `healBasisPoints` heals what the zone's rests
 * heal, no background uses the zone's default, no `scene` uses the enemy's
 * own artwork and placement. Fields that do not apply to the room's type are
 * ignored.
 */
export const DungeonAuthoredRoomSchema = z
  .object({
    /** Stable within the zone. Other rooms point at it; a run records it on the node. */
    id: key,
    /** What the author calls it. Shown to players on rooms that have no enemy or event to name. */
    name: z.string().trim().max(100).default(''),
    type: nodeType,
    /** Ids of the rooms this one leads to. Empty on the final room only. */
    next: z.array(key).max(DUNGEON_MAX_ROOM_EXITS).default([]),
    /** The enemy fought here — combat, elite, miniboss and boss rooms. */
    enemyKey: key.nullable().default(null),
    /** The event met here — event rooms. */
    eventKey: key.nullable().default(null),
    reward: DungeonRoomRewardSchema.nullable().default(null),
    /** Rest rooms: the share of max HP restored, overriding `nodeSettings.rest`. */
    healBasisPoints: basisPoints.nullable().default(null),
    /** Whether the player may leave from here once the room is done. An `exit` room always may. */
    extraction: z.boolean().default(false),
    /** The room's own background; managed asset first, then shipped path, then the zone's default. */
    backgroundAssetId: artworkAssetId.nullable().default(null),
    backgroundArtworkPath: zoneArtworkPath.nullable().default(null),
    scene: DungeonRoomSceneSchema.nullable().default(null),
    /** For authors only; never shown to a player. */
    notes: z.string().trim().max(500).default(''),
  })
  .strict();
export type DungeonAuthoredRoom = z.infer<typeof DungeonAuthoredRoomSchema>;

/**
 * A hand-built layout: the rooms and where a run begins. Whether the rooms
 * form a legal dungeon — one start, one final room, no loops, nothing
 * unreachable — is checked in `authoredLayout.ts`, so a half-built layout
 * still parses and can be saved on a disabled zone.
 */
export const DungeonAuthoredLayoutSchema = z
  .object({
    startRoomId: key.nullable().default(null),
    rooms: z.array(DungeonAuthoredRoomSchema).max(DUNGEON_MAX_ROOMS).default([]),
  })
  .strict()
  .default({});
export type DungeonAuthoredLayout = z.infer<typeof DungeonAuthoredLayoutSchema>;

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
    artworkPath: zoneArtworkPath.nullable().default(null),
    /** Conventionally `dungeons/backgrounds/<key>.webp`. */
    backgroundArtworkPath: zoneArtworkPath.nullable().default(null),
    /**
     * Managed (Portal-uploaded) overrides for the two paths above. Each wins
     * over its path while the asset is active; when it is unset, disabled or
     * deleted the shipped path shows instead.
     */
    artworkAssetId: artworkAssetId.nullable().default(null),
    backgroundAssetId: artworkAssetId.nullable().default(null),
    /**
     * Backgrounds a run's nodes are drawn against, chosen per node by weight
     * within its depth range when the run is generated. Empty means every
     * node uses the zone background.
     */
    backgrounds: z.array(DungeonBackgroundEntrySchema).max(DUNGEON_MAX_BACKGROUNDS).default([]),
    /**
     * The regions (stable ids, e.g. `flaccid-foothills`) a player must be
     * standing in to see the zone and **start** a run. Nothing else reads it:
     * an active run is playable wherever the player goes. An empty list is
     * "available nowhere" — there is no global option — and validation refuses
     * it on an enabled zone. Whether an id names a real region is checked
     * against the region catalogue in `zoneValidation.ts`.
     */
    availableRegions: z
      .array(z.string().min(1).max(64).regex(DUNGEON_REGION_ID_PATTERN, 'must be a region id like "waifu-valley"'))
      .max(DUNGEON_MAX_REGIONS)
      .default([]),
    tags,
    /** Where the run graph comes from. Chosen when the zone is created. */
    layoutMode: z.enum(DUNGEON_LAYOUT_MODES).default('procedural'),
    /** The generator's rules. Kept, unused, on an authored zone. */
    generation: DungeonGenerationSchema.default(DEFAULT_GENERATION),
    /** Per-node-type behaviour, e.g. how much a rest heals. */
    nodeSettings: DungeonNodeSettingsSchema,
    /** What the generator draws from. Kept, unused, on an authored zone. */
    pools: DungeonPoolsSchema.default({}),
    /** The hand-built rooms. Kept, unused, on a procedural zone. */
    authored: DungeonAuthoredLayoutSchema,
    rewards: DungeonRewardsSchema,
  })
  .strict()
  .superRefine((zone, ctx) => {
    duplicateIds(zone.authored.rooms, ['authored', 'rooms'], 'room', ctx);
    for (const poolKey of DUNGEON_POOL_KEYS) {
      duplicateIds(zone.pools[poolKey], ['pools', poolKey], 'pool entry', ctx);
    }
    duplicateIds(zone.rewards.bands, ['rewards', 'bands'], 'reward band', ctx);
    duplicateIds(zone.backgrounds, ['backgrounds'], 'background', ctx);
    zone.availableRegions.forEach((region, i) => {
      if (zone.availableRegions.indexOf(region) !== i) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['availableRegions', i],
          message: `duplicate region "${region}"`,
        });
      }
    });
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
  // Fields added after zones were first stored are left out of the hash while
  // they hold their default, so a zone that does not use them hashes exactly
  // as it did before they existed — a deploy does not make every stored row
  // look edited, or every shipped zone look changed.
  const { layoutMode, authored, generation, ...rest } = parsed;
  const { firstNodeType, ...gen } = generation;
  const hashed = {
    ...rest,
    generation: firstNodeType === null ? gen : generation,
    ...(layoutMode === 'procedural' ? {} : { layoutMode }),
    ...(authored.startRoomId === null && authored.rooms.length === 0 ? {} : { authored }),
  };
  return createHash('sha256').update(canonicalJson(hashed)).digest('hex');
}

/** A zone's layout mode. Zones snapshotted before the field existed are procedural. */
export function layoutModeOf(zone: Pick<DungeonZoneDefinition, 'layoutMode'>): DungeonLayoutMode {
  return zone.layoutMode ?? 'procedural';
}

/** A zone's authored rooms; none on a zone snapshotted before they existed. */
export function authoredLayoutOf(zone: Pick<DungeonZoneDefinition, 'authored'>): DungeonAuthoredLayout {
  return zone.authored ?? { startRoomId: null, rooms: [] };
}

/** A zone's rest rules. Zones snapshotted before they existed have none. */
export function restRulesOf(gen: DungeonGeneration): DungeonRestRules {
  return gen.rest ?? { minNodes: 0, maxNodes: null, minDepth: 1, maxDepth: null, beforeBoss: false };
}

/**
 * Depths just before the final node that no fork may occupy: one when a rest
 * must precede the boss (so every route passes through it), otherwise none.
 */
export function reservedTailDepths(gen: DungeonGeneration): number {
  return restRulesOf(gen).beforeBoss && gen.boss.required ? 1 : 0;
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
  const reserved = reservedTailDepths(gen);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let total = gen.minNodes; total <= gen.maxNodes; total++) {
    for (let branches = minBranches; branches <= maxBranches; branches++) {
      for (let alternates = branches; alternates <= branches * maxLength; alternates++) {
        const depthCount = total - alternates;
        const interiorNeeded = alternates + Math.max(0, branches - 1);
        if (depthCount < 2 + reserved || depthCount - 2 - reserved < interiorNeeded) continue;
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

/** A zone's background pool. Zones snapshotted before it existed have none. */
export function backgroundsOf(zone: Pick<DungeonZoneDefinition, 'backgrounds'>): DungeonBackgroundEntry[] {
  return zone.backgrounds ?? [];
}
