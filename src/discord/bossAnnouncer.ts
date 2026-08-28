/**
 * The Discord half of the boss scheduler — the concrete {@link BossAnnouncer}.
 *
 * Every discord.js call the boss feature makes at *scheduler* time lives here,
 * which is what keeps `bossScheduler.ts` a pure ordering of steps and
 * `bossEncounterService.ts` free of Discord types entirely.
 *
 * The permission set is checked rather than assumed, because the failure mode
 * of assuming is the worst one available: an encounter that opens, accepts
 * commitments for half an hour, and then cannot publish its results. The four
 * permissions checked are exactly the four an encounter needs —
 *
 *   ViewChannel        — to see the channel at all
 *   SendMessages       — to post the announcement
 *   EmbedLinks         — the announcement and results are embeds
 *   AttachFiles        — boss artwork rides as an attachment
 *
 * — plus ReadMessageHistory, which is what lets us *edit* our own message
 * after a restart, when it is no longer in the gateway's cache.
 *
 * Message components need no permission of their own; a bot that may send
 * messages may attach buttons to them. That is why "use components" appears in
 * the requirement list as satisfied by SendMessages rather than as a fifth
 * flag — there is no flag to check.
 */
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import type { BossEncounterRow, BossResolutionReason } from '../db/schema';
import type { BossEncounterService } from '../modules/bosses/bossEncounterService';
import type { BossAnnouncer } from '../modules/bosses/bossScheduler';
import {
  buildAnnouncement,
  buildCompletedAnnouncement,
  buildResults,
  commitRow,
  matchesEncounterMarker,
} from './bossPresenter';
import { resolveBossArtwork } from './bossArtwork';
import type { AppContext } from './types';

/** Permission → the operator-facing name used in the suspension message. */
const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'View Channel' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Send Messages' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Embed Links' },
  { flag: PermissionFlagsBits.AttachFiles, label: 'Attach Files' },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'Read Message History' },
] as const;

/** Discord codes meaning "the thing you are editing is gone". */
const GONE_CODES = new Set<number | string>([10003 /* Unknown Channel */, 10008 /* Unknown Message */]);

export function isGoneError(err: unknown): boolean {
  return err instanceof DiscordAPIError && GONE_CODES.has(err.code as number | string);
}

/**
 * Check one channel and report what is missing.
 *
 * `null` means the channel is gone, is not a guild text channel, or could not
 * be fetched — from the players' side those are one problem, and the scheduler
 * treats them identically.
 */
export async function verifyBossChannel(
  client: Client,
  channelId: string,
): Promise<{ missing: string[]; channel: GuildTextBasedChannel } | null> {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    if (isGoneError(err)) return null;
    throw err;
  }
  if (!channel || channel.type !== ChannelType.GuildText) return null;

  const me = channel.guild.members.me;
  // No cached member object means we cannot prove we may post. Treated as
  // unusable rather than assumed-fine: an optimistic guess here is what
  // produces an encounter nobody can see.
  if (!me) return null;
  const permissions = channel.permissionsFor(me);
  if (!permissions) return null;

  const missing = REQUIRED_PERMISSIONS.filter((p) => !permissions.has(p.flag)).map(
    (p) => p.label,
  );
  return { missing, channel: channel as GuildTextBasedChannel };
}

export interface BossAnnouncerDeps {
  ctx: AppContext;
  client: Client;
  encounters: BossEncounterService;
}

/**
 * How far back reconciliation looks for an orphaned results message.
 *
 * One Discord page. The window this has to cover is "messages posted since the
 * crash that lost the write", which in a dedicated boss channel is a handful
 * at most — encounters are ~40–65 minutes apart and nothing else posts there.
 * A deeper scan would trade a real per-tick cost against a case that cannot
 * arise: if a hundred messages have landed since, the results message is not
 * adjacent to its announcement any more and adopting it would be wrong.
 */
const RESULTS_SCAN_LIMIT = 100;

export function createBossAnnouncer(deps: BossAnnouncerDeps): BossAnnouncer {
  const { ctx, client, encounters } = deps;

  /** A text channel we can post to and read history from, or null when gone. */
  async function fetchTextChannel(channelId: string) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel) || !('send' in channel)) return null;
      return channel as GuildTextBasedChannel;
    } catch (err) {
      if (isGoneError(err)) return null;
      throw err;
    }
  }

  /** The live announcement message, or null when it is gone. */
  async function fetchAnnouncement(encounter: BossEncounterRow) {
    if (!encounter.channelId || !encounter.messageId) return null;
    try {
      const channel = await fetchTextChannel(encounter.channelId);
      if (!channel) return null;
      return await channel.messages.fetch(encounter.messageId);
    } catch (err) {
      if (isGoneError(err)) return null;
      throw err;
    }
  }

  /**
   * Locate a results message this bot already sent for `encounterId`.
   *
   * The deterministic marker in the results footer is the whole mechanism:
   * Discord's send and our `UPDATE` cannot share a transaction, so the only
   * way to distinguish "never sent" from "sent, then crashed" is to go and
   * look. Matching is narrowed to our own messages and to the *results*
   * footer specifically, so the encounter's own announcement — which carries
   * the same marker — can never be mistaken for its results.
   */
  async function findResultsMessage(
    channel: GuildTextBasedChannel,
    encounterId: number,
  ): Promise<Message | null> {
    let recent;
    try {
      recent = await channel.messages.fetch({ limit: RESULTS_SCAN_LIMIT });
    } catch (err) {
      if (isGoneError(err)) return null;
      throw err;
    }
    for (const message of recent.values()) {
      if (message.author.id !== client.user?.id) continue;
      const footer = message.embeds[0]?.footer?.text;
      if (!matchesEncounterMarker(footer, encounterId)) continue;
      // The announcement carries the marker too. Titles are the discriminator
      // and they are built one place, in `bossPresenter`.
      if (!message.embeds[0]?.title?.startsWith('Boss Results —')) continue;
      return message;
    }
    return null;
  }

  return {
    async verifyChannel(channelId) {
      const verdict = await verifyBossChannel(client, channelId);
      return verdict === null ? null : { missing: verdict.missing };
    },

    async postAnnouncement(encounter, channelId) {
      const verdict = await verifyBossChannel(client, channelId);
      if (!verdict || verdict.missing.length > 0) {
        throw new Error(
          `boss channel ${channelId} unusable: ${verdict ? verdict.missing.join(', ') : 'channel missing'}`,
        );
      }
      const message = await verdict.channel.send(
        buildAnnouncement({
          encounter,
          boss: encounters.bossFor(encounter),
          config: ctx.content.tables.bossEncounters,
          participantCount: 0,
          now: new Date(),
          ...resolveBossArtwork(ctx, encounter),
        }),
      );
      return message.id;
    },

    async refreshAnnouncement(encounter) {
      const message = await fetchAnnouncement(encounter);
      // The message was deleted underneath us. Deliberately *not* re-posted
      // here: a scheduler that silently replaces a deleted announcement would
      // fight an admin who deleted it on purpose. `/waifumon-admin boss repair`
      // is the deliberate way back, and it repoints the same encounter.
      if (!message) {
        ctx.logger.warn(
          { tag: 'boss/announcement-gone', encounterId: encounter.id },
          'boss announcement message is gone — use `/waifumon-admin boss repair`',
        );
        return;
      }
      const participantCount = await encounters.countParticipants(encounter.id);
      await message.edit(
        buildAnnouncement({
          encounter,
          boss: encounters.bossFor(encounter),
          config: ctx.content.tables.bossEncounters,
          participantCount,
          now: new Date(),
          ...resolveBossArtwork(ctx, encounter),
        }),
      );
    },

    /**
     * Close an encounter out in Discord: edit the announcement into its
     * terminal form, then post the results **beneath** it as a second message.
     *
     * Two steps, each independently stamped in the database, so this whole
     * method is a resumable repair rather than a one-shot. Called on every
     * resolve and again on any later tick that finds work outstanding — it is
     * safe to call any number of times.
     *
     * Ordering is deliberate. The completion edit comes first because it is
     * the *reversible-looking* half: a reader who sees a still-open-looking
     * boss with results already below it would reasonably try to commit. The
     * reverse — an encounter that visibly ended a moment before its results
     * arrive — reads correctly at every instant.
     *
     * Duplicate results are prevented in three layers, weakest last:
     *
     *   1. `resultsMessageId` is set → nothing to do.
     *   2. `resultsPublishedAt` is set but the id is not (a pre-split
     *      encounter, or a crash between send and write) → the channel tail is
     *      scanned for the encounter's marker before anything is sent.
     *   3. Only then is a message sent, and its id is persisted immediately.
     */
    async publishResults(encounterId) {
      const encounter = await encounters.getEncounter(encounterId);
      if (!encounter) return;
      if (!encounter.channelId) {
        ctx.logger.error(
          { tag: 'boss/results-unpublished', encounterId },
          'boss results computed but the encounter never had a channel — rewards were still applied',
        );
        return;
      }

      // ── Step 1: the completion edit on the original message ──────────────
      if (!encounter.completionEditedAt) {
        const message = await fetchAnnouncement(encounter);
        if (message) {
          await message.edit(
            buildCompletedAnnouncement({
              encounter,
              reason: (encounter.resolutionReason ?? 'unchallenged') as BossResolutionReason,
              boss: encounters.bossFor(encounter),
              participantCount: encounter.participantCount,
              totalDamage: encounter.totalDamage,
              totalAttacks:
                encounter.participantCount *
                ctx.content.tables.bossEncounters.attacksPerParticipation,
              ...resolveBossArtwork(ctx, encounter),
            }),
          );
          await encounters.markCompletionEdited(encounterId, new Date());
        } else {
          // An admin deleted it. Stamped anyway: there is no message left to
          // repair, and leaving it unstamped would make every future tick
          // re-attempt a fetch that can only fail. The results still publish.
          ctx.logger.warn(
            { tag: 'boss/announcement-gone', encounterId },
            'boss announcement message is gone — completion edit skipped, results still publish',
          );
          await encounters.markCompletionEdited(encounterId, new Date());
        }
      }

      // ── Step 2: the separate results message ─────────────────────────────
      if (encounter.resultsMessageId) return;

      const channel = await fetchTextChannel(encounter.channelId);
      if (!channel) {
        ctx.logger.error(
          { tag: 'boss/results-unpublished', encounterId },
          'boss results computed but the boss channel is gone — rewards were still applied',
        );
        return;
      }

      // A results message may already exist that no row points at: this
      // process (or a previous one) sent it and died before the write landed.
      // Adopting it is what makes the send-then-persist gap safe.
      const orphan = await findResultsMessage(channel, encounterId);
      if (orphan) {
        ctx.logger.warn(
          { tag: 'boss/results-adopted', encounterId, messageId: orphan.id },
          'found an unrecorded boss results message and adopted it rather than posting a second',
        );
        await encounters.markResultsPublished(encounterId, orphan.id, null, new Date());
        return;
      }

      // Pre-split encounters were stamped by migration 0018 with no results
      // message id, because their results were published by overwriting the
      // announcement. Re-posting one now would append a stray result under an
      // announcement that no longer says what it was.
      if (encounter.resultsPublishedAt) return;

      const pageSize = ctx.content.tables.bossEncounters.resultsPageSize;
      const listing = await encounters.listParticipations(encounterId, { page: 1, pageSize });
      // The earliest commitment, not the top of the damage-sorted page.
      const firstOnScene = await encounters.getFirstOnScene(encounterId);

      const sent = await channel.send(
        buildResults({
          encounter,
          reason: (encounter.resolutionReason ?? 'unchallenged') as BossResolutionReason,
          boss: encounters.bossFor(encounter),
          entries: listing.entries,
          page: listing.page,
          totalPages: listing.totalPages,
          totalParticipants: listing.total,
          totalDamage: encounter.totalDamage,
          totalAttacks:
            encounter.participantCount *
            ctx.content.tables.bossEncounters.attacksPerParticipation,
          firstOnScene,
          ...resolveBossArtwork(ctx, encounter),
        }),
      );
      await encounters.markResultsPublished(encounterId, sent.id, listing.pageSize, new Date());
    },
  };
}

/** Re-exported so the admin repair command can rebuild a closed window's row. */
export { commitRow };
