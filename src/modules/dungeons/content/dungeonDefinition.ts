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
import { SceneSpriteInstanceSchema, SCENE_SPRITE_MAX_PLACEMENTS, sceneSpriteKeys } from '../sceneSprites/sceneSpriteDefinition';
import { equipmentSelectorKey, type EquipmentRewardSelector } from '../../equipment/rewardSelector';
import {
  DUNGEON_EVENT_LIMITS,
  DungeonEventPoolSchema,
  DungeonEventSchema,
  DungeonEventSourceSchema,
  type DungeonEvent,
  type DungeonEventPool,
} from './dungeonEvents';
import { DungeonIdSchema as id, DungeonKeySchema as dungeonKey } from './dungeonIdentifiers';
import {
  ActionDestinationSchema,
  DUNGEON_FLAG_SCOPES,
  DungeonArtworkRefSchema,
  DungeonConditionSchema,
  DungeonFlagDeclarationSchema,
  basisPoints,
  referenceKey,
  shortText,
  type DungeonArtworkRef,
} from './dungeonPrimitives';
import { dungeonRewardSites, reachableDungeonEvents } from './dungeonRewardSites';
import { DungeonRewardBundleSchema } from './dungeonRewards';

export { DUNGEON_KEY_PATTERN, DUNGEON_KEY_MAX_LENGTH, DUNGEON_ID_PATTERN, DUNGEON_ID_MAX_LENGTH } from './dungeonIdentifiers';
export {
  ActionDestinationSchema,
  BASIS_POINTS,
  DUNGEON_FLAG_SCOPES,
  DUNGEON_MAX_CONDITION_DEPTH,
  DungeonArtworkRefSchema,
  DungeonConditionSchema,
  DungeonFlagDeclarationSchema,
  type ActionDestination,
  type DungeonArtworkRef,
  type DungeonCondition,
  type DungeonFlagDeclaration,
  type DungeonFlagScope,
} from './dungeonPrimitives';
export * from './dungeonEvents';
export * from './dungeonRewardSites';

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

// ── actions ─────────────────────────────────────────────────────────────────

const actionBase = {
  sceneSprites: z.array(SceneSpriteInstanceSchema).max(SCENE_SPRITE_MAX_PLACEMENTS).optional(),
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
  /** Phase 2 authoring only; absence must not change legacy content hashes. */
  rewards: DungeonRewardBundleSchema.optional(),
};

/**
 * Phase 1A's minimal reward: one existing global table (and, optionally, a
 * second one for gear) plus a range of the dungeon's progression currency.
 * Kept for existing content. Phase 2 bundles use a separate optional `rewards` field.
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
  z.object({ type: z.literal('reward'), ...actionBase, reward: RewardSpecSchema.optional(), rewards: DungeonRewardBundleSchema.optional() }).strict(),
  /** Presents one event from the dungeon's library: a named one, or a draw from a pool. */
  z.object({ type: z.literal('event'), ...actionBase, source: DungeonEventSourceSchema }).strict(),
]).superRefine((action, ctx) => {
  if (action.type === 'reward' && (action.reward !== undefined) === (action.rewards !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['reward'], message: 'treasure must have exactly one of reward or rewards' });
  }
});
export type DungeonAction = z.infer<typeof DungeonActionSchema>;
export type DungeonActionType = DungeonAction['type'];
export type CombatAction = Extract<DungeonAction, { type: 'combat' | 'boss' }>;
export type EventAction = Extract<DungeonAction, { type: 'event' }>;

export const DUNGEON_ACTION_TYPES = ['combat', 'boss', 'rest', 'gate', 'set_flag', 'leave', 'reward', 'event'] as const satisfies readonly DungeonActionType[];

/**
 * Action types later phases add. Named now so a definition that uses one is
 * told which phase it belongs to instead of failing as an unknown shape, and
 * so nothing else claims the name.
 */
export const RESERVED_ACTION_TYPES = {
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
  /** `nothing`: a pool drew no event. A failed check is still `resolved`. */
  event: ['resolved', 'nothing'],
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
    sceneSprites: z.array(SceneSpriteInstanceSchema).max(SCENE_SPRITE_MAX_PLACEMENTS).optional(),
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
    /** Share of the unbanked currency kept on defeat; legacy abandonment uses this too. */
    defeatCurrencyRetentionBasisPoints: basisPoints.default(0),
    /** When absent, Phase 2 settlement will use the defeat rate. No new schema default. */
    abandonCurrencyRetentionBasisPoints: basisPoints.optional(),
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
    /** Phase 3 library. Absent, never defaulted: an event-free definition must hash as it always did. */
    events: z.array(DungeonEventSchema).max(DUNGEON_EVENT_LIMITS.events).optional(),
    eventPools: z.array(DungeonEventPoolSchema).max(DUNGEON_EVENT_LIMITS.pools).optional(),
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

export function eventOf(definition: Pick<DungeonDefinition, 'events'>, eventId: string | null | undefined): DungeonEvent | null {
  if (eventId == null) return null;
  return definition.events?.find((e) => e.id === eventId) ?? null;
}

export function eventPoolOf(definition: Pick<DungeonDefinition, 'eventPools'>, poolId: string | null | undefined): DungeonEventPool | null {
  if (poolId == null) return null;
  return definition.eventPools?.find((p) => p.id === poolId) ?? null;
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
  sceneSprites?: string[];
  enemies: string[];
  /** `expedition`-kind reward table ids. */
  rewardTables: string[];
  /** Phase 2 direct dependencies; referenced table bodies are resolved separately. */
  lootTables: string[];
  items: string[];
  equipmentSelectors: EquipmentRewardSelector[];
  regions: string[];
  currencies: string[];
  artwork: DungeonArtworkRef[];
}

/**
 * Everything a definition names that lives outside it. Computed from the
 * content — never declared by hand — so a package's manifest cannot understate
 * what its dungeon needs.
 */
export function dungeonDependencies(definition: DungeonDefinition, sceneSprites?: ReadonlyMap<string, { contentHash: string; artworkCategory: string; name: string }>): DungeonDependencies {
  const enemies = new Set<string>();
  const rewardTables = new Set<string>();
  const lootTables = new Set<string>();
  const items = new Set<string>();
  const equipmentSelectors = new Map<string, EquipmentRewardSelector>();
  const currencies = new Set<string>(definition.settings.progressionCurrency ? [definition.settings.progressionCurrency] : []);
  const artwork = new Map<string, DungeonArtworkRef>();
  const art = (ref: DungeonArtworkRef | null) => {
    if (ref) artwork.set(ref.kind === 'shipped' ? `shipped:${ref.path}` : `managed:${ref.category}:${ref.contentHash}`, ref);
  };
  for (const key of sceneSpriteKeys(definition)) {
    const sprite = sceneSprites?.get(key);
    if (sprite) art({ kind: 'managed', category: sprite.artworkCategory, contentHash: sprite.contentHash, name: sprite.name });
  }
  art(definition.artwork);
  art(definition.background);
  for (const room of definition.rooms) {
    art(room.background);
    for (const action of room.actions) {
      if (isCombatAction(action)) {
        for (const wave of action.waves) for (const key of waveEnemyKeys(wave)) enemies.add(key);
      } else if (action.type === 'reward' && action.reward) {
        if (action.reward.rewardTable) rewardTables.add(action.reward.rewardTable);
        if (action.reward.equipmentRewardTable) rewardTables.add(action.reward.equipmentRewardTable);
      }
    }
  }
  // Reward bundles wherever they sit: activities, then the outcomes of reachable events.
  for (const { bundle } of dungeonRewardSites(definition)) {
    for (const ref of bundle.tables) lootTables.add(ref.table);
    for (const { grant } of [...bundle.guaranteed, ...bundle.chances]) {
      if (grant.type === 'item') items.add(grant.item);
      if (grant.type === 'equipment') equipmentSelectors.set(equipmentSelectorKey(grant.selector), grant.selector);
      if (grant.type === 'currency' && grant.currency !== 'shards') currencies.add(grant.currency);
    }
  }
  const reachable = reachableDungeonEvents(definition);
  for (const event of definition.events ?? []) if (reachable.has(event.id)) art(event.artwork ?? null);
  return {
    ...(sceneSpriteKeys(definition).length ? { sceneSprites: sceneSpriteKeys(definition) } : {}),
    enemies: [...enemies].sort(),
    rewardTables: [...rewardTables].sort(),
    lootTables: [...lootTables].sort(),
    items: [...items].sort(),
    equipmentSelectors: [...equipmentSelectors.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, selector]) => selector),
    regions: [...new Set(definition.availableRegions)].sort(),
    currencies: [...currencies].sort(),
    artwork: [...artwork.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref),
  };
}
