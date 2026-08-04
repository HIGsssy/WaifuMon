/**
 * Activity Feed — the first `GameEventBus` subscriber.
 *
 * Turns gameplay events into one-line narration in the guild's "Waifumon
 * Log" channel (the existing `guilds.announce_channel_id`, reused). It reads
 * like a living world, not a debug log.
 *
 * Boundaries:
 *   - `formatActivityLine` is pure and exhaustive over the event catalog —
 *     that is where the canonical wording lives and what the unit tests pin.
 *   - Discord is injected as a `PostFn`, so this module never imports
 *     discord.js and tests inject a spy.
 *   - Internal-scope events never reach narration, whatever their visibility.
 *   - SR+ capture successes are suppressed: that path already posts the
 *     existing rich embed, and two announcements for one capture is noise.
 *   - Every failure is logged and swallowed. Nothing here may ever surface
 *     to a gameplay call site.
 */
import { rarityAtLeast } from '../capture/captureMath';
import type { Rarity } from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type {
  EventVisibility,
  GameEvent,
  GameEventBus,
  GameEventHandler,
} from '../events/gameEvents';

/**
 * Discord side of the feed. `channelId` is the resolved Waifumon Log
 * channel; `visibility` is passed through so a future implementation can
 * batch or drop `minor` lines without touching this service.
 */
export type PostFn = (
  channelId: string,
  text: string,
  visibility: EventVisibility,
) => Promise<void>;

/** Resolves the Waifumon Log channel for a guild, or null when unconfigured. */
export type ResolveFeedChannelFn = (discordGuildId: string) => Promise<string | null>;

export interface ActivityLine {
  text: string;
  visibility: EventVisibility;
}

export interface ActivityFeedService {
  /** Attach to the bus. Call once at bootstrap. */
  subscribe(bus: GameEventBus): void;
  /** Detach (tests, shutdown). */
  unsubscribe(bus: GameEventBus): void;
  /** Exposed for tests: handle one event directly. Never throws. */
  handle(event: GameEvent): Promise<void>;
}

export interface ActivityFeedDeps {
  post: PostFn;
  resolveChannel: ResolveFeedChannelFn;
  logger: Logger;
  /**
   * Capture rarities at or above this threshold are left to the existing
   * rich-embed announcement. Defaults to `content.tables.capture.announceMinRarity`.
   */
  richEmbedMinRarity: Rarity;
}

/** The rarity at which the existing rich embed takes over from narration. */
const DEFAULT_RICH_EMBED_MIN_RARITY: Rarity = 'SR';

/**
 * Canonical narration. Returns `null` for events that are deliberately not
 * narrated (internal scope is filtered before this is reached; reserved
 * kinds return null so adding a producer later is a one-line change here).
 */
export function formatActivityLine(event: GameEvent): ActivityLine | null {
  const player = event.playerName;
  const line = (text: string): ActivityLine => ({ text, visibility: event.visibility });

  switch (event.kind) {
    case 'PLAYER_STARTED_HUNT': {
      const { location } = event.payload;
      return line(
        location ? `🌿 ${player} ventured into ${location}.` : `🌿 ${player} started hunting.`,
      );
    }
    case 'PLAYER_COMPLETED_HUNT': {
      const { location } = event.payload;
      return line(
        location ? `🏕️ ${player} returned from ${location}.` : `🏕️ ${player} finished hunting.`,
      );
    }
    case 'PLAYER_ENCOUNTER':
      return line(
        `👀 ${player} spotted a ${event.payload.rarity} ${event.payload.speciesName}…`,
      );
    case 'PLAYER_CAPTURE_SUCCESS':
      return line(`💫 ${player} added ${event.payload.speciesName} to their collection.`);
    case 'PLAYER_CAPTURE_FAILED':
      return line(`🌫️ ${event.payload.speciesName} slipped away from ${player}.`);
    case 'PLAYER_FOUND_ITEM':
      return line(`🎁 ${player} pocketed ${event.payload.quantity} × ${event.payload.itemName}.`);
    case 'PLAYER_FOUND_WAIFUBUX':
      return line(`💰 ${player} came across ${event.payload.amount} WaifuBux.`);
    case 'PLAYER_FOUND_ESSENCE':
      return line(`✨ ${player} gathered ${event.payload.amount} Essence.`);
    case 'PLAYER_LEVEL_UP':
      return line(`⚡ ${player} reached level ${event.payload.level}.`);
    case 'BUDDY_LEVEL_UP':
      return line(`💖 ${event.payload.buddyName} grew stronger — now level ${event.payload.level}.`);
    case 'AFFECTION_MILESTONE':
      return line(
        `🌸 ${player} and ${event.payload.buddyName} grew closer (${event.payload.stage}).`,
      );
    case 'PLAYER_ENTERED_CARE':
      return line(`❤️ ${player} is spending time with ${event.payload.buddyName}.`);
    case 'PLAYER_LEFT_CARE': {
      const buddy = event.payload.buddyName;
      return line(
        buddy
          ? `🌸 ${player} finished spending time with ${buddy}.`
          : `🌸 ${player} finished spending time with their Waifumon.`,
      );
    }
    case 'AWAKENING':
      return line(`🌌 ${event.payload.buddyName} awakened for ${player}.`);
    case 'COLLECTION_COMPLETED':
      return line(`🌟 ${player} completed the collection.`);
    // Internal scope — filtered before we get here, listed for exhaustiveness.
    case 'CARE_BUDDY_CHANGED':
    case 'CARE_TICK_APPLIED':
    case 'ENERGY_REGENERATED':
    case 'PLAYER_RETURNED_FROM_INACTIVITY':
    case 'TRAINER_PROFILE_REFRESH_REQUESTED':
      return null;
    default: {
      // Exhaustiveness guard: adding a kind without wording is a compile error.
      const _never: never = event;
      void _never;
      return null;
    }
  }
}

export function createActivityFeedService(deps: ActivityFeedDeps): ActivityFeedService {
  const { post, resolveChannel, logger } = deps;
  const richEmbedMinRarity = deps.richEmbedMinRarity ?? DEFAULT_RICH_EMBED_MIN_RARITY;

  /** SR+ successes belong to the rich-embed path — never double-narrate them. */
  function suppressed(event: GameEvent): boolean {
    return (
      event.kind === 'PLAYER_CAPTURE_SUCCESS' &&
      rarityAtLeast(event.payload.rarity, richEmbedMinRarity)
    );
  }

  const handler: GameEventHandler = async (event) => {
    await handle(event);
  };

  async function handle(event: GameEvent): Promise<void> {
    try {
      if (event.scope !== 'player-visible') return;
      if (suppressed(event)) return;
      const line = formatActivityLine(event);
      if (!line) return;
      const channelId = await resolveChannel(event.guildId);
      // No Waifumon Log configured for this guild → stay silent. We
      // deliberately do NOT fall back to the play channel: the play channel
      // is reserved for Trainer Profiles.
      if (!channelId) return;
      await post(channelId, line.text, line.visibility);
    } catch (err) {
      logger.warn(
        { err, kind: event.kind, eventId: event.eventId },
        'activity feed failed to narrate event',
      );
    }
  }

  return {
    subscribe(bus) {
      bus.subscribe(handler);
    },
    unsubscribe(bus) {
      bus.unsubscribe(handler);
    },
    handle,
  };
}
