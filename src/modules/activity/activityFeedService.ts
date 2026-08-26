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
import type { AssetId } from '../content/schemas';
import type {
  EventVisibility,
  GameEvent,
  GameEventBus,
  GameEventHandler,
} from '../events/gameEvents';

/**
 * A raw appearance PNG the activity feed wants to attach to an announcement.
 */
export interface AppearanceArtworkAttachment {
  /** Absolute path to a PNG that exists at resolution time. */
  absolutePath: string;
  /** Filename the Discord attachment will carry (safe, no path). */
  filename: string;
}

/**
 * A rich embed to post alongside the plain-text line. Used today for
 * alternate-appearance unlock announcements, where the artwork itself is the
 * point — see the `WAIFU_APPEARANCE_UNLOCKED` branch below.
 */
export interface ActivityRichEmbed {
  title: string;
  description: string;
  image: AppearanceArtworkAttachment;
  /** Optional footer text; the poster is free to ignore. */
  footer?: string;
}

/**
 * What the feed hands the Discord side. A plain `text` is always valid on its
 * own; `richEmbed` when present is the alternate presentation the poster
 * SHOULD use (a text-only fallback is fine when the poster cannot).
 */
export interface ActivityPostRequest {
  text: string;
  visibility: EventVisibility;
  richEmbed?: ActivityRichEmbed;
}

/**
 * Discord side of the feed. `channelId` is the resolved Waifumon Log
 * channel; the poster decides how to render the request.
 */
export type PostFn = (channelId: string, request: ActivityPostRequest) => Promise<void>;

/** Resolves the Waifumon Log channel for a guild, or null when unconfigured. */
export type ResolveFeedChannelFn = (discordGuildId: string) => Promise<string | null>;

/**
 * Turns an appearance's abstract `AssetId` into the raw PNG on disk that the
 * announcement should attach. Returns `null` when the artwork is missing — the
 * feed then falls back to a text-only line rather than blocking the
 * announcement.
 *
 * Deliberately synchronous: resolution reads the filesystem via existing
 * shared helpers and never talks to the network.
 */
export type ResolveAppearanceArtworkFn = (
  assetId: AssetId,
) => AppearanceArtworkAttachment | null;

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
  /**
   * Optional. When present, alternate-appearance unlock announcements attach
   * the raw appearance PNG so other players see the artwork itself. Absent →
   * the announcement is text-only, exactly as before.
   */
  resolveAppearanceArtwork?: ResolveAppearanceArtworkFn | undefined;
}

/** The rarity at which the existing rich embed takes over from narration. */
const DEFAULT_RICH_EMBED_MIN_RARITY: Rarity = 'SR';

/**
 * Who to credit in a public appearance-unlock announcement.
 *
 * An unlock is a brag-worthy milestone posted in a shared channel, so it names
 * a specific person rather than "a trainer". The mention is preferred — it
 * resolves to the right member even when two players share a display name — and
 * the display name is the fallback for any envelope that lacks one.
 *
 * Scoped to the unlock renderers on purpose: every other line keeps narrating
 * with the plain display name, so the log does not turn into a wall of pings.
 */
function unlockActor(event: GameEvent): string {
  const mention = event.playerMention?.trim();
  if (mention) return mention;
  const name = event.playerName?.trim();
  return name && name.length > 0 ? name : 'A trainer';
}

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
    // Names who, never what — the item is revealed to the player on accept.
    case 'WAIFU_GIFT_AVAILABLE':
      return line(
        `🎁 ${event.payload.waifuName} has something for ${player}.`,
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
    // Cosmetic, and narrated as such — earning a new look is a milestone, so
    // the requirement that was met is named. This is the log-level renderer;
    // the message-level one is `appearanceUnlockedDescriptor` in the bot.
    case 'WAIFU_APPEARANCE_UNLOCKED':
      return line(
        `🎀 ${event.payload.waifuName} unlocked a new look for ${unlockActor(event)} — ` +
          `**${event.payload.appearanceName}** (${event.payload.unlockLabel}).`,
      );
    // Internal scope — filtered before we get here, listed for exhaustiveness.
    case 'WAIFU_APPEARANCE_CHANGED':
    case 'WAIFU_GIFT_CLAIMED':
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
  const { post, resolveChannel, logger, resolveAppearanceArtwork } = deps;
  const richEmbedMinRarity = deps.richEmbedMinRarity ?? DEFAULT_RICH_EMBED_MIN_RARITY;

  /** SR+ successes belong to the rich-embed path — never double-narrate them. */
  function suppressed(event: GameEvent): boolean {
    return (
      event.kind === 'PLAYER_CAPTURE_SUCCESS' &&
      rarityAtLeast(event.payload.rarity, richEmbedMinRarity)
    );
  }

  /**
   * Alternate-appearance unlocks are the one event today that carries artwork
   * with its narration. The default `'owned'` appearance is skipped — it is
   * every fresh capture's `standard` look, and painting it here would double
   * every catch as an "unlock" that no player earned.
   */
  function alternateAppearanceEmbed(event: GameEvent): ActivityRichEmbed | undefined {
    if (event.kind !== 'WAIFU_APPEARANCE_UNLOCKED') return undefined;
    if (event.payload.source === 'owned') return undefined;
    if (!resolveAppearanceArtwork) return undefined;
    let artwork: AppearanceArtworkAttachment | null;
    try {
      artwork = resolveAppearanceArtwork(event.payload.assetId);
    } catch (err) {
      logger.warn(
        { err, tag: 'activity-feed/artwork-resolve-failed', eventId: event.eventId },
        'appearance-unlock artwork resolution threw; posting text-only',
      );
      return undefined;
    }
    if (!artwork) return undefined;
    return {
      title: '🎀 New Appearance Unlocked!',
      description:
        `${unlockActor(event)}'s **${event.payload.waifuName}** unlocked ` +
        `**${event.payload.appearanceName}** — ${event.payload.unlockLabel}.\n\n` +
        `Keep leveling your Waifumon to discover new appearances.`,
      image: artwork,
      footer: 'Cosmetic only — nothing about her changes.',
    };
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
      const request: ActivityPostRequest = { text: line.text, visibility: line.visibility };
      const richEmbed = alternateAppearanceEmbed(event);
      if (richEmbed) request.richEmbed = richEmbed;
      await post(channelId, request);
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
