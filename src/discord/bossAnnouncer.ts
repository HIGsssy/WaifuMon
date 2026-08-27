/**
 * The Discord half of the boss scheduler — the concrete {@link BossAnnouncer}.
 *
 * Every discord.js call the boss feature makes at *scheduler* time lives here,
 * which is what keeps `bossScheduler.ts` a pure ordering of steps and
 * `bossEncounterService.ts` free of Discord types entirely.
 *
 * The permission set is checked rather than assumed, because the failure mode
 * of assuming is the worst one available: an encounter that opens, accepts
 * commitments for an hour, and then cannot publish its results. The four
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
} from 'discord.js';
import type { BossEncounterRow, BossResolutionReason } from '../db/schema';
import type { BossEncounterService } from '../modules/bosses/bossEncounterService';
import type { BossAnnouncer } from '../modules/bosses/bossScheduler';
import { buildAnnouncement, buildResults, commitRow } from './bossPresenter';
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

export function createBossAnnouncer(deps: BossAnnouncerDeps): BossAnnouncer {
  const { ctx, client, encounters } = deps;

  /** The live announcement message, or null when it is gone. */
  async function fetchAnnouncement(encounter: BossEncounterRow) {
    if (!encounter.channelId || !encounter.messageId) return null;
    try {
      const channel = await client.channels.fetch(encounter.channelId);
      if (!channel || !('messages' in channel)) return null;
      return await channel.messages.fetch(encounter.messageId);
    } catch (err) {
      if (isGoneError(err)) return null;
      throw err;
    }
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

    async publishResults(encounterId) {
      const encounter = await encounters.getEncounter(encounterId);
      if (!encounter) return;
      const listing = await encounters.listParticipations(encounterId, { page: 1 });
      // The earliest commitment, not the top of the damage-sorted page.
      const firstOnScene = await encounters.getFirstOnScene(encounterId);

      const payload = buildResults({
        encounter,
        reason: (encounter.resolutionReason ?? 'unchallenged') as BossResolutionReason,
        boss: encounters.bossFor(encounter),
        entries: listing.entries,
        page: listing.page,
        totalPages: listing.totalPages,
        totalParticipants: listing.total,
        totalDamage: encounter.totalDamage,
        totalAttacks: encounter.participantCount * ctx.content.tables.bossEncounters.attacksPerParticipation,
        firstOnScene,
        ...resolveBossArtwork(ctx, encounter),
      });

      const message = await fetchAnnouncement(encounter);
      if (!message) {
        // Rewards are already committed at this point, so a missing message is
        // a presentation loss and nothing more. Logged at error level because
        // the players lost their results readout, which an admin can restore.
        ctx.logger.error(
          { tag: 'boss/results-unpublished', encounterId },
          'boss results computed but the announcement message is gone — rewards were still applied',
        );
        return;
      }
      await message.edit(payload);
    },
  };
}

/** Re-exported so the admin repair command can rebuild a closed window's row. */
export { commitRow };
