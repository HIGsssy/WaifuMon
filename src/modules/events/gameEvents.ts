/**
 * GameEventBus — the central seam every gameplay-significant moment flows
 * through (Gameplay UX Redesign, phase 1).
 *
 * Design rules:
 *   - Gameplay services stay Discord-agnostic. They either return the raw
 *     data a coordinator needs, or (where convenient) a
 *     `GameEventDescriptor[]`. The *coordinator* (a Discord handler) mints
 *     the full `GameEvent` and emits it **after** the owning transaction has
 *     committed.
 *   - Subscribers are strictly downstream. `emit()` isolates every handler in
 *     its own try/catch, so a broken subscriber can never silence another
 *     subscriber and can never fail a hunt, capture, economy, or progression
 *     write. `emit()` itself never rejects.
 *   - Every event carries `eventId` (UUID v4) + `occurredAt`. Nothing consumes
 *     them yet; they exist for future analytics, replay, duplicate
 *     suppression, and audit trails.
 *   - `visibility` is advisory metadata for subscribers (and later, admin
 *     filtering). Gameplay logic never branches on it.
 *   - `scope` splits the catalog in two: `player-visible` events are eligible
 *     for public narration; `internal` events are subscriber-only signals
 *     (Trainer Profile refreshes and friends) that must never reach the
 *     public Activity Feed regardless of their visibility.
 */
import { randomUUID } from 'node:crypto';
import type { AssetId, CosmeticRarity } from '../content/schemas';
import type { Rarity } from '../../db/schema';
import type { Logger } from '../../shared/logger';

/** How broadcast-worthy an event is. Advisory only. */
export type EventVisibility = 'minor' | 'normal' | 'major';

/** Whether an event may ever be narrated publicly. */
export type EventScope = 'player-visible' | 'internal';

/** Why a hunt session closed. */
export type HuntCompletionReason = 'care_mode' | 'explicit' | 'inactivity';

/** Why Care Mode ended. */
export type CareExitReason =
  /** Player pressed "Leave Care Mode". */
  | 'manual'
  /** Hunting always exits Care Mode. */
  | 'hunt'
  /** Claiming the daily always exits Care Mode. */
  | 'daily'
  /** Energy Drink (or any restore-energy consumable) exits Care Mode. */
  | 'item'
  /** The care target vanished (released underneath) — service self-healed. */
  | 'auto_stop';

/**
 * The event catalog, as a kind → payload map. Adding an event means adding
 * one entry here plus one entry in {@link EVENT_META} — the compiler then
 * forces every exhaustive consumer (the Activity Feed formatter) to handle it.
 */
export interface GameEventPayloads {
  /** A hunt session opened (player expressed intent to hunt). */
  PLAYER_STARTED_HUNT: { location: string | null };
  /** A hunt session closed. */
  PLAYER_COMPLETED_HUNT: { location: string | null; reason: HuntCompletionReason };
  PLAYER_ENCOUNTER: { encounterId: number; speciesName: string; rarity: Rarity };
  PLAYER_CAPTURE_SUCCESS: {
    speciesName: string;
    rarity: Rarity;
    isDuplicate: boolean;
    waifuId: number | null;
  };
  /** The encounter ended without a capture (she got away for good). */
  PLAYER_CAPTURE_FAILED: { speciesName: string; rarity: Rarity; attempts: number };
  PLAYER_FOUND_ITEM: { itemSlug: string; itemName: string; quantity: number; rare: boolean };
  PLAYER_FOUND_WAIFUBUX: { amount: number; balanceAfter: number };
  PLAYER_FOUND_ESSENCE: { amount: number; balanceAfter: number };
  PLAYER_LEVEL_UP: { level: number; rewardLabels: readonly string[] };
  BUDDY_LEVEL_UP: { waifuId: number; buddyName: string; level: number };
  AFFECTION_MILESTONE: {
    waifuId: number;
    buddyName: string;
    affection: number;
    stage: string;
  };
  /**
   * A cosmetic appearance became available on one owned copy.
   *
   * This is the **shared progression-notification** shape, not an
   * appearance-specific bus: it carries a display name, an unlock requirement,
   * a rarity badge and an `assetId`, which is exactly what a future
   * `EVOLUTION_AVAILABLE`, `ACHIEVEMENT_UNLOCKED`, or `GIFT_AVAILABLE` toast
   * needs. Adding one of those is a new kind here plus a new case in the
   * feed's formatter — no new table, no new bus, no new renderer plumbing.
   *
   * `assetId` is embedded so the toast, the activity-feed line and any future
   * Portal notification can render the artwork without a second lookup — and
   * without ever seeing a path.
   */
  WAIFU_APPEARANCE_UNLOCKED: {
    waifuId: number;
    /** Nickname when set, species name otherwise. */
    waifuName: string;
    speciesSlug: string;
    appearanceId: string;
    appearanceName: string;
    assetId: AssetId;
    cosmeticRarity: CosmeticRarity;
    /** The requirement that was met, e.g. "Reach Level 20". */
    unlockLabel: string;
    /**
     * How the unlock came about. `'owned'` is a fresh-capture default look
     * (bookkeeping, not a rewarded alternate); `'level'` is the progression
     * milestone this event exists to celebrate; `'content_add'` is a live
     * backfill after new artwork ships.
     */
    source: import('../appearance/appearanceService').AppearanceUnlockSource;
  };
  /** The player pointed an owned copy at a different appearance. Cosmetic. */
  WAIFU_APPEARANCE_CHANGED: {
    waifuId: number;
    waifuName: string;
    appearanceId: string;
    appearanceName: string;
    assetId: AssetId;
  };
  /**
   * An owned copy has a gift waiting (Affection Gift System).
   *
   * Deliberately says *that* a gift exists and nothing about what it is: the
   * reveal belongs to the player accepting it, and this event is narrated in a
   * shared channel. Emitted after the daily-reset transaction commits.
   */
  WAIFU_GIFT_AVAILABLE: {
    waifuId: number;
    /** Nickname when set, species name otherwise. */
    waifuName: string;
    affection: number;
    /** Content tier that produced it — audit colour, not narration. */
    tier: string;
    /** True when the pity guarantee fired rather than the chance roll. */
    guaranteed: boolean;
  };
  /** A gift was accepted. The item is named — the surprise is already spent. */
  WAIFU_GIFT_CLAIMED: {
    waifuId: number;
    waifuName: string;
    itemSlug: string;
    itemName: string;
    quantity: number;
  };
  PLAYER_ENTERED_CARE: { waifuId: number; buddyName: string };
  PLAYER_LEFT_CARE: {
    waifuId: number | null;
    buddyName: string | null;
    reason: CareExitReason;
  };
  /**
   * The care target changed while Care Mode stayed active. Internal: the
   * Trainer Profile recreates its message at the channel bottom; there is no
   * public narration for it.
   */
  CARE_BUDDY_CHANGED: { waifuId: number; buddyName: string };
  /** Internal — drives Trainer Profile edits. Never narrated. */
  CARE_TICK_APPLIED: {
    waifuId: number | null;
    buddyName: string | null;
    ticksProcessed: number;
    energyGained: number;
    waifuXpGained: number;
    affectionGained: number;
  };
  /** Internal, reserved — passive energy regen outside Care Mode. */
  ENERGY_REGENERATED: { amount: number; energyAfter: number };
  /** Reserved for the awakening system. */
  AWAKENING: { waifuId: number; buddyName: string };
  COLLECTION_COMPLETED: { distinctSpecies: number; totalSpecies: number };
  /** Internal, reserved — player came back after a long absence. */
  PLAYER_RETURNED_FROM_INACTIVITY: { awayMinutes: number };
  /** Internal, reserved — explicit "repost my Trainer Profile" request. */
  TRAINER_PROFILE_REFRESH_REQUESTED: Record<string, never>;

  // ── Boss Encounters (Stage 1) ────────────────────────────────────────────
  //
  // All four are `internal`. The boss channel is a dedicated venue that already
  // narrates every one of these moments in full, and routing them to the
  // Waifumon Log as well would print the same battle twice — once as an event
  // and once as the announcement it is describing. They exist on the bus so
  // future subscribers (analytics, a Portal feed, an ops dashboard) have a
  // seam, not because anything narrates them today.

  /** A boss appeared and the scouting window opened. */
  BOSS_ENCOUNTER_STARTED: {
    encounterId: number;
    bossId: string;
    bossName: string;
    bossAffinity: string;
    region: string;
    deadlineAt: string;
  };
  /** A trainer confirmed a buddy. Carries no damage estimate — see below. */
  BOSS_BUDDY_COMMITTED: {
    encounterId: number;
    bossId: string;
    waifuId: number;
    waifuName: string;
    /**
     * Deliberately *not* the estimated damage range, the affinity bonus, or
     * the response bonus. Those are ephemeral-preview details: a public
     * subscriber that logged them would leak one player's private read on the
     * matchup into a shared channel.
     */
    level: number;
  };
  /** The window closed and results were computed. */
  BOSS_ENCOUNTER_RESOLVED: {
    encounterId: number;
    bossId: string;
    bossName: string;
    reason: string;
    participantCount: number;
    totalDamage: number;
    totalAttacks: number;
  };
  /** Payouts landed. Separate from RESOLVED so a retry is observable. */
  BOSS_REWARDS_APPLIED: {
    encounterId: number;
    participantCount: number;
    totalXp: number;
    totalItems: number;
  };
  /** Scheduling stopped for a guild and an operator has to intervene. */
  BOSS_SCHEDULING_SUSPENDED: {
    reason: string;
    channelId: string | null;
  };
}

export type GameEventKind = keyof GameEventPayloads;

export interface GameEventMeta {
  visibility: EventVisibility;
  scope: EventScope;
}

/**
 * Default visibility + scope per kind. A descriptor may override `visibility`
 * (SR+ captures are `major`, everything below is `normal`); `scope` is a
 * property of the kind itself and is never overridden.
 */
export const EVENT_META: Readonly<Record<GameEventKind, GameEventMeta>> = {
  PLAYER_STARTED_HUNT: { visibility: 'major', scope: 'player-visible' },
  PLAYER_COMPLETED_HUNT: { visibility: 'major', scope: 'player-visible' },
  PLAYER_ENCOUNTER: { visibility: 'normal', scope: 'player-visible' },
  PLAYER_CAPTURE_SUCCESS: { visibility: 'normal', scope: 'player-visible' },
  PLAYER_CAPTURE_FAILED: { visibility: 'minor', scope: 'player-visible' },
  PLAYER_FOUND_ITEM: { visibility: 'minor', scope: 'player-visible' },
  PLAYER_FOUND_WAIFUBUX: { visibility: 'minor', scope: 'player-visible' },
  PLAYER_FOUND_ESSENCE: { visibility: 'minor', scope: 'player-visible' },
  PLAYER_LEVEL_UP: { visibility: 'major', scope: 'player-visible' },
  BUDDY_LEVEL_UP: { visibility: 'normal', scope: 'player-visible' },
  AFFECTION_MILESTONE: { visibility: 'normal', scope: 'player-visible' },
  // Worth narrating: earning new artwork is a visible milestone. Merely
  // *changing* outfits is not — that is a wardrobe click, so it is internal
  // and only ever refreshes surfaces that already show the copy.
  WAIFU_APPEARANCE_UNLOCKED: { visibility: 'normal', scope: 'player-visible' },
  WAIFU_APPEARANCE_CHANGED: { visibility: 'minor', scope: 'internal' },
  // "She has something for you" is a relationship beat worth a log line; the
  // claim itself is a private moment and stays internal, so the feed does not
  // read out everyone's inventory.
  WAIFU_GIFT_AVAILABLE: { visibility: 'normal', scope: 'player-visible' },
  WAIFU_GIFT_CLAIMED: { visibility: 'minor', scope: 'internal' },
  PLAYER_ENTERED_CARE: { visibility: 'major', scope: 'player-visible' },
  PLAYER_LEFT_CARE: { visibility: 'normal', scope: 'player-visible' },
  AWAKENING: { visibility: 'major', scope: 'player-visible' },
  COLLECTION_COMPLETED: { visibility: 'major', scope: 'player-visible' },
  CARE_BUDDY_CHANGED: { visibility: 'minor', scope: 'internal' },
  CARE_TICK_APPLIED: { visibility: 'minor', scope: 'internal' },
  ENERGY_REGENERATED: { visibility: 'minor', scope: 'internal' },
  PLAYER_RETURNED_FROM_INACTIVITY: { visibility: 'minor', scope: 'internal' },
  TRAINER_PROFILE_REFRESH_REQUESTED: { visibility: 'minor', scope: 'internal' },
  // Internal for the reason given on the payload definitions: the boss channel
  // is these events' narration surface, and the Activity Feed must not echo it.
  BOSS_ENCOUNTER_STARTED: { visibility: 'major', scope: 'internal' },
  BOSS_BUDDY_COMMITTED: { visibility: 'normal', scope: 'internal' },
  BOSS_ENCOUNTER_RESOLVED: { visibility: 'major', scope: 'internal' },
  BOSS_REWARDS_APPLIED: { visibility: 'normal', scope: 'internal' },
  BOSS_SCHEDULING_SUSPENDED: { visibility: 'major', scope: 'internal' },
};

/**
 * What a service (or a coordinator) produces before the envelope is minted:
 * a kind, its payload, and an optional visibility override.
 */
export type GameEventDescriptor = {
  [K in GameEventKind]: {
    kind: K;
    payload: GameEventPayloads[K];
    visibility?: EventVisibility;
  };
}[GameEventKind];

/** Who the event happened to — filled in by the coordinator. */
export interface GameEventSource {
  /** Discord guild snowflake (used to resolve the Waifumon Log channel). */
  guildId: string;
  /** Internal `guilds.id`. */
  guildDbId: number;
  /** Internal `players.id`. */
  playerId: number;
  /** Display name used in narration ("Whistler"). */
  playerName: string;
  /** `<@id>` mention, for subscribers that prefer pings. */
  playerMention: string;
  /** Channel the action happened in (not necessarily where it is narrated). */
  channelId: string | null;
}

/** A fully-formed event as it reaches subscribers. */
export type GameEvent = {
  [K in GameEventKind]: GameEventSource & {
    eventId: string;
    kind: K;
    payload: GameEventPayloads[K];
    visibility: EventVisibility;
    scope: EventScope;
    occurredAt: Date;
  };
}[GameEventKind];

/** Narrow a `GameEvent` to one kind (handy in subscribers and tests). */
export type GameEventOf<K extends GameEventKind> = Extract<GameEvent, { kind: K }>;

export type GameEventHandler = (event: GameEvent) => void | Promise<void>;

export interface GameEventBus {
  /**
   * Dispatch to every subscriber. Resolves once all subscribers have settled
   * and **never rejects** — a throwing (or rejecting) subscriber is logged
   * and skipped. Callers may `await` this for ordering (the Trainer Profile
   * relies on create-before-edit ordering) or fire-and-forget it.
   */
  emit(event: GameEvent): Promise<void>;
  subscribe(handler: GameEventHandler): void;
  unsubscribe(handler: GameEventHandler): void;
  /** Number of attached subscribers (diagnostics + tests). */
  readonly subscriberCount: number;
}

export interface GameEventBusDeps {
  logger: Logger;
}

/** Simple in-memory dispatcher. One process, no persistence, no ordering guarantees between subscribers. */
export function createGameEventBus(deps: GameEventBusDeps): GameEventBus {
  const handlers = new Set<GameEventHandler>();
  const { logger } = deps;

  return {
    get subscriberCount() {
      return handlers.size;
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
    async emit(event) {
      // Snapshot first so a subscriber that (un)subscribes during dispatch
      // can't mutate the set we're iterating.
      const snapshot = Array.from(handlers);
      await Promise.all(
        snapshot.map(async (handler) => {
          try {
            await handler(event);
          } catch (err) {
            logger.warn(
              { err, kind: event.kind, eventId: event.eventId },
              'game event subscriber threw — swallowed',
            );
          }
        }),
      );
    },
  };
}

/** Mint the full envelope around a descriptor. */
export function buildGameEvent(
  descriptor: GameEventDescriptor,
  source: GameEventSource,
  occurredAt: Date = new Date(),
): GameEvent {
  const meta = EVENT_META[descriptor.kind];
  return {
    ...source,
    eventId: randomUUID(),
    kind: descriptor.kind,
    payload: descriptor.payload,
    visibility: descriptor.visibility ?? meta.visibility,
    scope: meta.scope,
    occurredAt,
  } as GameEvent;
}

/**
 * Emit a batch of descriptors in order. Never throws — this is called from
 * post-commit hooks where the gameplay write has already succeeded and must
 * not be undone by a presentation-layer failure.
 */
export async function emitGameEvents(
  bus: GameEventBus,
  source: GameEventSource,
  descriptors: readonly GameEventDescriptor[],
  occurredAt: Date = new Date(),
): Promise<void> {
  for (const descriptor of descriptors) {
    await bus.emit(buildGameEvent(descriptor, source, occurredAt));
  }
}

/** Type-safe descriptor constructor — keeps call sites free of casts. */
export function gameEvent<K extends GameEventKind>(
  kind: K,
  payload: GameEventPayloads[K],
  visibility?: EventVisibility,
): GameEventDescriptor {
  return (visibility ? { kind, payload, visibility } : { kind, payload }) as GameEventDescriptor;
}
