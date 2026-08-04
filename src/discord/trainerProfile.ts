/**
 * Trainer Profile — the player's public dashboard while in Care Mode
 * (Gameplay UX Redesign, phase 3).
 *
 * This is the *only* thing Waifumon posts to the play channel on a player's
 * behalf. Everything else is ephemeral (phase 2) or goes to the Waifumon Log
 * (phase 1). Its lifecycle is exactly three operations:
 *
 *   create — a fresh `channel.send`, so the message lands at the channel
 *            bottom. Used when entering Care Mode, when the care target
 *            changes, and (reserved) on inactivity return / explicit refresh.
 *            Any previous profile is deleted first so a player never has two.
 *   edit   — `channel.messages.edit` in place, keeping the message id and its
 *            position. Used for every value change: energy, affection, buddy
 *            level, player level, collection progress. Editing a bot-authored
 *            message has no token-expiry window, so a Care Mode session can
 *            run indefinitely without churn.
 *   remove — `channel.messages.delete` + clear the stored id. Used on every
 *            Care Mode exit: manual, hunt, daily claim, Energy Drink, or the
 *            service's own auto-stop when the target is released.
 *
 * It is a `GameEventBus` subscriber, not a direct writer: handlers emit and
 * this module reacts. Every Discord call is best-effort — a missing
 * permission or a hand-deleted message is logged and swallowed, never
 * propagated back toward a gameplay transaction.
 */
import { DiscordAPIError, EmbedBuilder, type BaseMessageOptions } from 'discord.js';
import { affinityLabel } from '../modules/capture/affinityMath';
import type { CareState } from '../modules/care/careService';
import type { DexStats } from '../modules/collection/collectionService';
import type { LevelProgress } from '../modules/progression/progressionMath';
import type { GameEvent, GameEventBus, GameEventHandler } from '../modules/events/gameEvents';
import type { PlayerCurrenciesRow, PlayerRow } from '../db/schema';
import type { Logger } from '../shared/logger';
import type { AppServices } from './types';

/** Discord "Unknown Message" — the profile was deleted out from under us. */
const UNKNOWN_MESSAGE = 10008;

function isUnknownMessage(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === UNKNOWN_MESSAGE;
}

/**
 * The subset of a Discord text channel the profile needs. Kept structural so
 * tests can pass a plain object and this module never imports a client.
 */
export interface ProfileChannel {
  id: string;
  send(payload: BaseMessageOptions): Promise<{ id: string }>;
  messages: {
    edit(messageId: string, payload: BaseMessageOptions): Promise<unknown>;
    delete(messageId: string): Promise<unknown>;
  };
}

/**
 * Dashboard slots that are designed into the layout now and wired to real
 * data later. Every slot is skipped when null, so adding one is a one-line
 * change at the call site with no layout churn here.
 */
export interface TrainerDashboard {
  /** Once the region system exists. */
  currentRegion?: string | null;
  /** Daily session summary — available today via `summary_json`. */
  todaysHunts?: number | null;
  todaysCaptures?: number | null;
  /** `xpIntoLevel` / `xpToNext` — data is ready, slot reserved. */
  nextLevelProgress?: LevelProgress | null;
  /** One-line summary from the quests module. */
  currentDailyObjective?: string | null;
}

export interface TrainerProfileInput {
  playerName: string;
  player: PlayerRow;
  currencies: Pick<PlayerCurrenciesRow, 'huntEnergy' | 'waifubux' | 'essence'>;
  careState: CareState;
  collectionProgress: DexStats;
  maxEnergy: number;
  prestigeTitle: string | null;
  dashboard?: TrainerDashboard;
}

/** `90` → `01:30`. Used for the next-tick countdown. */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.round(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Nickname when set, species name otherwise. */
function careTargetLabel(care: CareState): string | null {
  const target = care.target;
  if (!target) return null;
  return target.waifu.nickname?.trim() || target.species.name;
}

/**
 * Pure view builder — no Discord calls, no DB. The profile is informational
 * only: it deliberately carries no components (spec §3).
 */
export function buildTrainerProfileView(
  input: TrainerProfileInput,
): { embeds: EmbedBuilder[] } {
  const { player, currencies, careState, collectionProgress, maxEnergy, prestigeTitle } = input;
  const dash = input.dashboard ?? {};

  const embed = new EmbedBuilder()
    .setTitle(`🌸 ${input.playerName}'s Trainer Profile`)
    .setColor(0xffb6d1)
    .setFooter({ text: `Trainer since ${player.createdAt.toDateString()}` });

  // ── Trainer ──
  const trainerLines = [
    `Level **${player.level}**${prestigeTitle ? ` — *${prestigeTitle}*` : ''}`,
    `⚡ Hunt Energy **${currencies.huntEnergy} / ${maxEnergy}**`,
  ];
  if (dash.nextLevelProgress && !dash.nextLevelProgress.atMaxLevel) {
    trainerLines.push(
      `${dash.nextLevelProgress.xpIntoLevel} / ${dash.nextLevelProgress.xpToNext} XP to Lv ${dash.nextLevelProgress.level + 1}`,
    );
  }
  if (dash.currentRegion) trainerLines.push(`🗺️ ${dash.currentRegion}`);
  embed.addFields({ name: '👤 Trainer', value: trainerLines.join('\n'), inline: true });

  // ── Buddy ──
  const target = careState.target;
  if (target) {
    const nick = target.waifu.nickname?.trim();
    const buddyLines = [
      nick ? `**${nick}** (${target.species.name})` : `**${target.species.name}**`,
      `${target.species.rarity} · Lv ${target.waifu.level}`,
      `${affinityLabel(target.species.affinity)} · 💗 ${target.waifu.affection} affection`,
    ];
    embed.addFields({ name: '⭐ Buddy', value: buddyLines.join('\n'), inline: true });
  }

  // ── Collection ──
  const { distinctSpecies, totalSpecies } = collectionProgress;
  const pct = totalSpecies > 0 ? Math.round((distinctSpecies / totalSpecies) * 100) : 0;
  embed.addFields({
    name: '🎒 Collection',
    value: `${distinctSpecies} / ${totalSpecies} unique species (${pct} %)`,
    inline: false,
  });

  // ── Activity ──
  const label = careTargetLabel(careState);
  const activityLines: string[] = [];
  if (label) activityLines.push(`Currently caring for **${label}**`);
  if (careState.nextTickAt) {
    activityLines.push(
      `Next tick in **${formatCountdown(careState.nextTickAt.getTime() - Date.now())}**`,
    );
  }
  activityLines.push(
    `Per tick: +${careState.energyPerTick} ⚡ · +${careState.waifuXpPerTick} XP · +${careState.affectionPerTick} affection`,
  );
  if (careState.currentEnergy >= careState.effectiveEnergyCap) {
    activityLines.push(
      `⚠️ Energy at the Care Mode cap (**${careState.effectiveEnergyCap}**) — training continues.`,
    );
  }
  if (dash.todaysHunts != null || dash.todaysCaptures != null) {
    activityLines.push(
      `Today: ${dash.todaysHunts ?? 0} hunts · ${dash.todaysCaptures ?? 0} caught`,
    );
  }
  if (dash.currentDailyObjective) activityLines.push(`📜 ${dash.currentDailyObjective}`);
  embed.addFields({ name: '💗 Activity', value: activityLines.join('\n'), inline: false });

  return { embeds: [embed] };
}

// ─────────────────────────────── lifecycle ───────────────────────────────

export interface TrainerProfileService {
  /** Attach to the bus. Call once at bootstrap. */
  subscribe(bus: GameEventBus): void;
  unsubscribe(bus: GameEventBus): void;
  /** Exposed for tests: handle one event directly. Never throws. */
  handle(event: GameEvent): Promise<void>;
  /** Post a fresh profile at the channel bottom, replacing any existing one. */
  create(event: GameEvent): Promise<void>;
  /** Update the stored profile in place; falls back to `create` on a 404. */
  edit(event: GameEvent): Promise<void>;
  /** Delete the stored profile and clear the pointer. */
  remove(event: GameEvent): Promise<void>;
}

/** Resolves the play channel an event happened in; null when unreachable. */
export type ResolveProfileChannelFn = (channelId: string) => Promise<ProfileChannel | null>;

export interface TrainerProfileDeps {
  services: Pick<AppServices, 'session' | 'players' | 'care' | 'collection' | 'progression'>;
  resolveChannel: ResolveProfileChannelFn;
  logger: Logger;
}

/** Events that (re)post the profile at the bottom of the channel. */
const CREATE_KINDS = new Set<GameEvent['kind']>([
  'PLAYER_ENTERED_CARE',
  'CARE_BUDDY_CHANGED',
  'PLAYER_RETURNED_FROM_INACTIVITY',
  'TRAINER_PROFILE_REFRESH_REQUESTED',
]);

/** Events that refresh the profile's contents without moving it. */
const EDIT_KINDS = new Set<GameEvent['kind']>([
  'CARE_TICK_APPLIED',
  'BUDDY_LEVEL_UP',
  'AFFECTION_MILESTONE',
  'PLAYER_LEVEL_UP',
  'COLLECTION_COMPLETED',
]);

/** Events that take the profile down. */
const REMOVE_KINDS = new Set<GameEvent['kind']>(['PLAYER_LEFT_CARE']);

export function createTrainerProfileService(
  deps: TrainerProfileDeps,
): TrainerProfileService {
  const { services, resolveChannel, logger } = deps;

  /** Everything the view needs, gathered fresh at paint time. */
  async function buildView(
    event: GameEvent,
  ): Promise<{ embeds: EmbedBuilder[]; careActive: boolean } | null> {
    const { player, currencies } = await services.players.getProfile(event.playerId);
    const [careState, collectionProgress] = await Promise.all([
      services.care.getState(event.playerId),
      services.collection.getDexStats(event.playerId),
    ]);
    const view = buildTrainerProfileView({
      playerName: event.playerName,
      player,
      currencies,
      careState,
      collectionProgress,
      maxEnergy: services.progression.computeMaxEnergy(player.level),
      prestigeTitle: services.progression.getPrestigeTitle(player.level),
    });
    return { ...view, careActive: careState.active };
  }

  /** Best-effort delete of whatever profile is currently stored. */
  async function deleteStored(
    channel: ProfileChannel,
    playerId: number,
    channelId: string,
  ): Promise<void> {
    const existing = await services.session.getProfileMessageId(playerId, channelId);
    if (!existing) return;
    try {
      await channel.messages.delete(existing);
    } catch (err) {
      // Already gone by hand — the pointer clear below is all that's left.
      if (!isUnknownMessage(err)) {
        logger.warn({ err, playerId, channelId }, 'trainer profile: delete failed');
      }
    }
  }

  async function create(event: GameEvent): Promise<void> {
    if (!event.channelId) return;
    const channel = await resolveChannel(event.channelId);
    if (!channel) return;
    const built = await buildView(event);
    if (!built) return;

    await deleteStored(channel, event.playerId, event.channelId);
    const sent = await channel.send({ embeds: built.embeds });
    await services.session.setProfileMessageId(
      event.guildDbId,
      event.playerId,
      event.channelId,
      sent.id,
    );
  }

  async function edit(event: GameEvent): Promise<void> {
    if (!event.channelId) return;
    const messageId = await services.session.getProfileMessageId(
      event.playerId,
      event.channelId,
    );
    // No profile posted (player isn't in Care Mode, or is in another channel):
    // an edit-triggering event outside Care Mode is a no-op, never a create.
    if (!messageId) return;
    const channel = await resolveChannel(event.channelId);
    if (!channel) return;
    const built = await buildView(event);
    if (!built) return;

    try {
      await channel.messages.edit(messageId, { embeds: built.embeds });
    } catch (err) {
      if (!isUnknownMessage(err)) throw err;
      // Someone deleted the profile by hand — repost it at the bottom.
      const sent = await channel.send({ embeds: built.embeds });
      await services.session.setProfileMessageId(
        event.guildDbId,
        event.playerId,
        event.channelId,
        sent.id,
      );
    }
  }

  async function remove(event: GameEvent): Promise<void> {
    if (!event.channelId) return;
    const messageId = await services.session.getProfileMessageId(
      event.playerId,
      event.channelId,
    );
    if (!messageId) return;
    const channel = await resolveChannel(event.channelId);
    if (channel) {
      try {
        await channel.messages.delete(messageId);
      } catch (err) {
        if (!isUnknownMessage(err)) {
          logger.warn({ err, playerId: event.playerId }, 'trainer profile: delete failed');
        }
      }
    }
    // Clear the pointer regardless — a profile we can't delete is still one we
    // must stop trying to edit.
    await services.session.setProfileMessageId(
      event.guildDbId,
      event.playerId,
      event.channelId,
      null,
    );
  }

  async function handle(event: GameEvent): Promise<void> {
    try {
      if (REMOVE_KINDS.has(event.kind)) {
        await remove(event);
        return;
      }
      if (CREATE_KINDS.has(event.kind)) {
        await create(event);
        return;
      }
      if (EDIT_KINDS.has(event.kind)) {
        await edit(event);
      }
    } catch (err) {
      logger.warn(
        { err, kind: event.kind, eventId: event.eventId },
        'trainer profile subscriber failed',
      );
    }
  }

  const handler: GameEventHandler = (event) => handle(event);

  return {
    subscribe(bus) {
      bus.subscribe(handler);
    },
    unsubscribe(bus) {
      bus.unsubscribe(handler);
    },
    handle,
    create,
    edit,
    remove,
  };
}
