/**
 * The dungeon definition — the authoritative gameplay content of one dungeon.
 *
 * Two layers, kept apart on purpose:
 *
 *   - the **map**: rooms and the directed connections between them. A graph,
 *     not a tree — it may branch, rejoin and cycle;
 *   - the **room sequence**: each room's ordered list of actions.
 *
 * Nothing here is a canvas node or an edge. Where a room is drawn lives in a
 * separate layout document (`dungeonLayout.ts`) the runtime never reads, so
 * moving a box is not a gameplay change.
 *
 * ## Identity
 *
 * Every id in a definition — dungeon key, room, action, connection, flag — is
 * a string the author chose, stable across saves, exports and imports.
 * Enemies, reward tables, regions and currencies are named by their own
 * stable keys. No numeric database id appears anywhere in a definition, which
 * is what lets one be carried between environments.
 *
 * ## Sequences are lists with forward routing
 *
 * An action hands over to the next one in the list unless it routes somewhere
 * else. Routing is per outcome and only ever forward (see `ActionDestination`
 * and `engine/routing.ts` for the precedence). That is deliberately not a
 * workflow language: no loops, no variables beyond flags, no parallelism.
 * Loops belong to the map, where connections may cycle.
 *
 * ## Extending
 *
 * `DungeonActionSchema` is a discriminated union on `type`. A later phase adds
 * an action by adding a member here, a handler in `engine/actions.ts` and a
 * rule in `validation/`. The types reserved for those phases are listed in
 * `RESERVED_ACTION_TYPES`; a definition that uses one is refused with a
 * dedicated issue code rather than a schema error.
 */
import { z } from 'zod';

export const BASIS_POINTS = 10_000;

export const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const DUNGEON_KEY_MAX_LENGTH = 64;
/** Rooms, actions, connections and flags. Short enough to ride in a Discord custom id. */
export const DUNGEON_ID_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
export const DUNGEON_ID_MAX_LENGTH = 40;

export const DUNGEON_MAX_ROOMS = 200;
export const DUNGEON_MAX_CONNECTIONS = 600;
export const DUNGEON_MAX_ACTIONS_PER_ROOM = 60;
/**
 * A ceiling on one combat action's waves that exists only to bound a stored
 * document — the engine itself has no wave limit. A room wanting more chains
 * combat actions.
 */
export const DUNGEON_MAX_WAVES_PER_ACTION = 100;
export const DUNGEON_MAX_POOL_ENTRIES = 50;
export const DUNGEON_MAX_FLAGS = 200;
export const DUNGEON_MAX_CONDITION_DEPTH = 6;

const dungeonKey = z
  .string()
  .max(DUNGEON_KEY_MAX_LENGTH)
  .regex(DUNGEON_KEY_PATTERN, 'must be lower_snake_case');
const id = z
  .string()
  .max(DUNGEON_ID_MAX_LENGTH)
  .regex(DUNGEON_ID_PATTERN, 'must be lower-case letters, digits, "_" or "-"');
const referenceKey = z.string().trim().min(1).max(100);
const basisPoints = z.number().int().min(0).max(BASIS_POINTS);
const shortText = (max: number) => z.string().trim().max(max);

// ── artwork ─────────────────────────────────────────────────────────────────

/**
 * A picture, named in a way that survives a move between environments: a file
 * shipped under `assets/`, or a managed upload by the sha256 of its bytes.
 * Never a managed asset's id, which is minted per environment.
 */
export const DungeonArtworkRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('shipped'),
      path: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path under assets/'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('managed'),
      category: z.string().trim().min(1).max(40),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lower-case sha256 hex digest'),
      /** The file name it was uploaded under. Informational. */
      name: shortText(200).optional(),
    })
    .strict(),
]);
export type DungeonArtworkRef = z.infer<typeof DungeonArtworkRefSchema>;

// ── flags and conditions ────────────────────────────────────────────────────

/**
 * Where a flag lives. `run` flags die with the run. `player` flags persist per
 * player and dungeon; they are declared here so content can be written against
 * them, but nothing sets one until the phase that adds their store.
 *
 * Both are namespaced by the dungeon. A future campaign namespace would be a
 * third scope value, not a change to these two.
 */
export const DUNGEON_FLAG_SCOPES = ['run', 'player'] as const;
export type DungeonFlagScope = (typeof DUNGEON_FLAG_SCOPES)[number];

export const DungeonFlagDeclarationSchema = z
  .object({
    key: id,
    scope: z.enum(DUNGEON_FLAG_SCOPES).default('run'),
    description: shortText(300).default(''),
  })
  .strict();
export type DungeonFlagDeclaration = z.infer<typeof DungeonFlagDeclarationSchema>;

export type DungeonCondition =
  | { type: 'flag'; flag: string; scope: DungeonFlagScope; equals: boolean }
  | { type: 'room_completed'; roomId: string }
  | { type: 'all'; conditions: DungeonCondition[] }
  | { type: 'any'; conditions: DungeonCondition[] }
  | { type: 'not'; condition: DungeonCondition };

type DungeonConditionInput =
  | { type: 'flag'; flag: string; scope?: DungeonFlagScope | undefined; equals?: boolean | undefined }
  | { type: 'room_completed'; roomId: string }
  | { type: 'all'; conditions: DungeonConditionInput[] }
  | { type: 'any'; conditions: DungeonConditionInput[] }
  | { type: 'not'; condition: DungeonConditionInput };

/**
 * What a `when` or `requires` tests. A small closed vocabulary: Phase 3
 * replaces it with the shared rules module's condition union, of which every
 * member here is one.
 */
export const DungeonConditionSchema: z.ZodType<DungeonCondition, z.ZodTypeDef, DungeonConditionInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('flag'),
        flag: id,
        scope: z.enum(DUNGEON_FLAG_SCOPES).default('run'),
        equals: z.boolean().default(true),
      })
      .strict(),
    z.object({ type: z.literal('room_completed'), roomId: id }).strict(),
    z.object({ type: z.literal('all'), conditions: z.array(DungeonConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('any'), conditions: z.array(DungeonConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('not'), condition: DungeonConditionSchema }).strict(),
  ]),
);

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Where a room's sequence goes after an action.
 *
 *   next           the action after this one; the room completes after the last
 *   action         a named action later in this room (never earlier)
 *   room_complete  the room completes now, whatever follows
 *   leave          the room completes and the player goes through a connection
 *   retreat        the room is left *unfinished* and the player goes back to
 *                  the room they came from; its sequence resumes on return
 *   end_run        the run ends here
 */
export const ActionDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next') }).strict(),
  z.object({ type: z.literal('action'), actionId: id }).strict(),
  z.object({ type: z.literal('room_complete') }).strict(),
  z.object({ type: z.literal('leave'), connectionId: id }).strict(),
  z.object({ type: z.literal('retreat') }).strict(),
  z.object({ type: z.literal('end_run'), outcome: z.enum(['completed', 'defeated']) }).strict(),
]);
export type ActionDestination = z.infer<typeof ActionDestinationSchema>;

// ── actions ─────────────────────────────────────────────────────────────────

const actionBase = {
  id,
  /** What the player reads on the button or heading; a default is used when empty. */
  label: shortText(80).default(''),
  /** Skipped silently, leaving only a log entry, when this is false. */
  when: DungeonConditionSchema.optional(),
  /** The player is offered a way to decline. Declining reports the outcome `declined`. */
  optional: z.boolean().default(false),
  /** Where every outcome goes unless `outcomes` names it. Omitted: the action type's default. */
  next: ActionDestinationSchema.optional(),
  /** Per-outcome routing. Keys are the action type's outcomes (see `ACTION_OUTCOMES`). */
  outcomes: z.record(z.string().max(40), ActionDestinationSchema).default({}),
};

export const EnemyPoolEntrySchema = z.object({ key: referenceKey, weight: z.number().int().min(1).max(1_000_000) }).strict();

/** One wave's opponent: a named enemy, or a weighted draw made once per run. */
export const WaveEnemySchema = z.union([
  z.object({ key: referenceKey }).strict(),
  z.object({ pool: z.array(EnemyPoolEntrySchema).min(1).max(DUNGEON_MAX_POOL_ENTRIES) }).strict(),
]);
export type WaveEnemy = z.infer<typeof WaveEnemySchema>;

export const CombatWaveSchema = z.object({ enemy: WaveEnemySchema }).strict();
export type CombatWave = z.infer<typeof CombatWaveSchema>;

const combatFields = {
  ...actionBase,
  /** Fought in order, one enemy each, HP carried from one to the next. */
  waves: z.array(CombatWaveSchema).min(1).max(DUNGEON_MAX_WAVES_PER_ACTION),
  /**
   * `confirm`: the player presses a button before each wave after the first.
   * `auto`: the remaining waves are fought in the same step as the first.
   * Either way each wave is its own seeded fight and its own log entry.
   */
  advance: z.enum(['confirm', 'auto']).default('confirm'),
};

/**
 * Phase 1A's minimal reward: one existing global table (and, optionally, a
 * second one for gear) plus a range of the dungeon's progression currency.
 * Phase 2 replaces `reward` with the full bundle; this shape is a subset of it.
 */
export const RewardSpecSchema = z
  .object({
    /** An `expedition`-kind reward table id; WaifuBux, items and gear are paid from it. */
    rewardTable: referenceKey.nullable().default(null),
    equipmentRewardTable: referenceKey.nullable().default(null),
    /** Unbanked progression currency, drawn uniformly. */
    currency: z
      .object({ min: z.number().int().min(0).max(1_000_000), max: z.number().int().min(0).max(1_000_000) })
      .strict()
      .refine((r) => r.max >= r.min, 'max must be at least min')
      .default({ min: 0, max: 0 }),
  })
  .strict();
export type RewardSpec = z.infer<typeof RewardSpecSchema>;

export const DungeonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('combat'), ...combatFields }).strict(),
  z.object({ type: z.literal('boss'), ...combatFields }).strict(),
  z.object({ type: z.literal('rest'), ...actionBase, healBasisPoints: basisPoints.default(3000) }).strict(),
  z
    .object({
      type: z.literal('gate'),
      ...actionBase,
      requires: DungeonConditionSchema,
      /** Shown when the gate does not open. */
      blockedText: shortText(300).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_flag'),
      ...actionBase,
      flag: id,
      scope: z.enum(DUNGEON_FLAG_SCOPES).default('run'),
      value: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('leave'),
      ...actionBase,
      /** The connection to walk through. Omitted: the room simply completes here. */
      connectionId: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal('reward'), ...actionBase, reward: RewardSpecSchema }).strict(),
]);
export type DungeonAction = z.infer<typeof DungeonActionSchema>;
export type DungeonActionType = DungeonAction['type'];
export type CombatAction = Extract<DungeonAction, { type: 'combat' | 'boss' }>;

export const DUNGEON_ACTION_TYPES = ['combat', 'boss', 'rest', 'gate', 'set_flag', 'leave', 'reward'] as const satisfies readonly DungeonActionType[];

/**
 * Action types later phases add. Named now so a definition that uses one is
 * told which phase it belongs to instead of failing as an unknown shape, and
 * so nothing else claims the name.
 */
export const RESERVED_ACTION_TYPES = {
  event: 'Phase 3',
  choice: 'Phase 3',
  objective: 'Phase 3',
  random_outcome: 'a later phase',
  wild_encounter: 'Phase 4',
  rescue: 'Phase 4',
} as const;

/**
 * The outcomes each action type can report, i.e. the keys its `outcomes` may
 * route. `declined` is added for any action marked `optional`.
 */
export const ACTION_OUTCOMES: Readonly<Record<DungeonActionType, readonly string[]>> = {
  combat: ['victory', 'defeat'],
  boss: ['victory', 'defeat'],
  rest: ['done'],
  gate: ['passed', 'blocked'],
  set_flag: ['done'],
  leave: [],
  reward: ['claimed'],
};
export const DECLINED_OUTCOME = 'declined';

// ── map ─────────────────────────────────────────────────────────────────────

export const DUNGEON_ROOM_KINDS = ['room', 'exit'] as const;
export const DUNGEON_CONNECTION_KINDS = ['path', 'shortcut', 'secret'] as const;

export const DungeonRoomSchema = z
  .object({
    id,
    name: shortText(80).default(''),
    description: shortText(600).default(''),
    /** An `exit` room ends the run as completed when its sequence finishes. */
    kind: z.enum(DUNGEON_ROOM_KINDS).default('room'),
    /** Once this room is complete the player may leave the dungeon here, banking everything. */
    extraction: z.boolean().default(false),
    background: DungeonArtworkRefSchema.nullable().default(null),
    actions: z.array(DungeonActionSchema).max(DUNGEON_MAX_ACTIONS_PER_ROOM).default([]),
  })
  .strict();
export type DungeonRoom = z.infer<typeof DungeonRoomSchema>;

export const DungeonConnectionSchema = z
  .object({
    id,
    from: id,
    to: id,
    label: shortText(80).default(''),
    /** `secret`: not shown at all while locked. The others show as locked. */
    kind: z.enum(DUNGEON_CONNECTION_KINDS).default('path'),
    /** The path is locked while this is false. */
    requires: DungeonConditionSchema.optional(),
    lockedText: shortText(200).default(''),
  })
  .strict();
export type DungeonConnection = z.infer<typeof DungeonConnectionSchema>;

export const DungeonSettingsSchema = z
  .object({
    /** The progression currency rewards pay and settlement banks; null pays none. */
    progressionCurrency: referenceKey.nullable().default(null),
    /** Share of the unbanked currency kept on defeat or abandon. */
    defeatCurrencyRetentionBasisPoints: basisPoints.default(0),
  })
  .strict();

export const DungeonDefinitionSchema = z
  .object({
    key: dungeonKey,
    name: z.string().trim().min(1).max(100),
    description: shortText(1000).default(''),
    /** Regions a run can be started from. An active run is playable anywhere. */
    availableRegions: z.array(referenceKey).max(100).default([]),
    entranceRoomId: id,
    artwork: DungeonArtworkRefSchema.nullable().default(null),
    /** The backdrop of any room that names none of its own. */
    background: DungeonArtworkRefSchema.nullable().default(null),
    settings: DungeonSettingsSchema.default({}),
    flags: z.array(DungeonFlagDeclarationSchema).max(DUNGEON_MAX_FLAGS).default([]),
    rooms: z.array(DungeonRoomSchema).min(1).max(DUNGEON_MAX_ROOMS),
    connections: z.array(DungeonConnectionSchema).max(DUNGEON_MAX_CONNECTIONS).default([]),
  })
  .strict();

export type DungeonDefinition = z.infer<typeof DungeonDefinitionSchema>;
export type DungeonDefinitionInput = z.input<typeof DungeonDefinitionSchema>;

// ── reads ───────────────────────────────────────────────────────────────────

export function isCombatAction(action: DungeonAction): action is CombatAction {
  return action.type === 'combat' || action.type === 'boss';
}

export function roomOf(definition: DungeonDefinition, roomId: string | null | undefined): DungeonRoom | null {
  if (roomId == null) return null;
  return definition.rooms.find((r) => r.id === roomId) ?? null;
}

export function connectionOf(
  definition: DungeonDefinition,
  connectionId: string | null | undefined,
): DungeonConnection | null {
  if (connectionId == null) return null;
  return definition.connections.find((c) => c.id === connectionId) ?? null;
}

/** A room's outgoing connections, in authored order. */
export function connectionsFrom(definition: DungeonDefinition, roomId: string): DungeonConnection[] {
  return definition.connections.filter((c) => c.from === roomId);
}

/** Every enemy key a wave may field, in authored order, without duplicates. */
export function waveEnemyKeys(wave: CombatWave): string[] {
  return 'key' in wave.enemy ? [wave.enemy.key] : [...new Set(wave.enemy.pool.map((e) => e.key))];
}

export interface DungeonDependencies {
  enemies: string[];
  /** `expedition`-kind reward table ids. */
  rewardTables: string[];
  regions: string[];
  currencies: string[];
  artwork: DungeonArtworkRef[];
}

/**
 * Everything a definition names that lives outside it. Computed from the
 * content — never declared by hand — so a package's manifest cannot understate
 * what its dungeon needs.
 */
export function dungeonDependencies(definition: DungeonDefinition): DungeonDependencies {
  const enemies = new Set<string>();
  const rewardTables = new Set<string>();
  const artwork = new Map<string, DungeonArtworkRef>();
  const art = (ref: DungeonArtworkRef | null) => {
    if (ref) artwork.set(ref.kind === 'shipped' ? `shipped:${ref.path}` : `managed:${ref.category}:${ref.contentHash}`, ref);
  };
  art(definition.artwork);
  art(definition.background);
  for (const room of definition.rooms) {
    art(room.background);
    for (const action of room.actions) {
      if (isCombatAction(action)) {
        for (const wave of action.waves) for (const key of waveEnemyKeys(wave)) enemies.add(key);
      } else if (action.type === 'reward') {
        if (action.reward.rewardTable) rewardTables.add(action.reward.rewardTable);
        if (action.reward.equipmentRewardTable) rewardTables.add(action.reward.equipmentRewardTable);
      }
    }
  }
  return {
    enemies: [...enemies].sort(),
    rewardTables: [...rewardTables].sort(),
    regions: [...new Set(definition.availableRegions)].sort(),
    currencies: definition.settings.progressionCurrency ? [definition.settings.progressionCurrency] : [],
    artwork: [...artwork.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref),
  };
}
