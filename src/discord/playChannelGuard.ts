/**
 * PlayChannelGuard — the single compliance choke point (plan §11).
 * The whole game only functions in NSFW-marked guild channels; if the guild
 * configured an allowed-channel list, the channel must also be on it.
 * The guard runs before every command and component handler, and before any
 * service call — blocked interactions consume nothing and write no rows.
 */
import { ChannelType, type Interaction } from 'discord.js';

export type DenyReason = 'dm' | 'not_nsfw' | 'not_allowed';

export type GuardDecision = { allow: true } | { allow: false; reason: DenyReason };

export interface GuardChannelInfo {
  /** False for DMs / non-guild contexts. */
  isGuildChannel: boolean;
  /** Effective NSFW flag — threads inherit their parent's flag. */
  isNsfw: boolean;
  channelId: string | null;
  /** Parent channel id when the interaction is inside a thread. */
  parentChannelId: string | null;
}

/**
 * Pure decision function: guildConfig × channelInfo → allow | deny(reason).
 * Rules in order: (1) guild channel only, (2) NSFW-marked, (3) on the
 * allowlist when one is configured (empty/unset list = any NSFW channel).
 *
 * `alwaysAllowedChannelIds` exempts a channel from rule **3 only** — today,
 * the guild's dedicated Boss Encounter channel. That channel is configured
 * through its own admin command, is validated as NSFW at configuration time,
 * and hosts buttons the bot itself posted; requiring an admin to *also* add it
 * to the play allowlist would turn a working feature into a support ticket.
 *
 * It deliberately does not exempt rules 1 and 2: the compliance requirement is
 * the game's, not this feature's, so an NSFW-unmarked boss channel is still
 * refused — and refused with the same wording as anywhere else.
 */
export function decidePlayChannel(
  channel: GuardChannelInfo,
  allowedChannelIds: string[] | null | undefined,
  alwaysAllowedChannelIds: readonly (string | null | undefined)[] = [],
): GuardDecision {
  if (!channel.isGuildChannel || !channel.channelId) {
    return { allow: false, reason: 'dm' };
  }
  if (!channel.isNsfw) {
    return { allow: false, reason: 'not_nsfw' };
  }
  if (allowedChannelIds && allowedChannelIds.length > 0) {
    const exempt = new Set(alwaysAllowedChannelIds.filter((id): id is string => Boolean(id)));
    const onList =
      allowedChannelIds.includes(channel.channelId) ||
      exempt.has(channel.channelId) ||
      (channel.parentChannelId != null &&
        (allowedChannelIds.includes(channel.parentChannelId) ||
          exempt.has(channel.parentChannelId)));
    if (!onList) return { allow: false, reason: 'not_allowed' };
  }
  return { allow: true };
}

/** Extracts GuardChannelInfo from a live discord.js interaction. */
export function extractChannelInfo(interaction: Interaction): GuardChannelInfo {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    return { isGuildChannel: false, isNsfw: false, channelId: null, parentChannelId: null };
  }
  let isNsfw = false;
  let parentChannelId: string | null = null;
  if (channel.isThread()) {
    parentChannelId = channel.parentId;
    const parent = channel.parent;
    isNsfw = parent != null && 'nsfw' in parent ? Boolean(parent.nsfw) : false;
  } else if (channel.type === ChannelType.GuildText && 'nsfw' in channel) {
    isNsfw = Boolean(channel.nsfw);
  } else if ('nsfw' in channel) {
    isNsfw = Boolean((channel as { nsfw?: boolean }).nsfw);
  }
  return { isGuildChannel: true, isNsfw, channelId: channel.id, parentChannelId };
}

/** Friendly ephemeral copy for a blocked interaction. */
export function blockedMessage(
  reason: DenyReason,
  allowedChannelIds: string[] | null | undefined,
): string {
  if (reason === 'dm') {
    return 'Waifumon plays inside a server, not in DMs~';
  }
  const firstAllowed = allowedChannelIds?.[0];
  const hint = firstAllowed ? ` Head to <#${firstAllowed}>.` : '';
  if (reason === 'not_allowed') {
    return `Waifumon doesn't play in this channel~${hint}`;
  }
  return `Waifumon plays in NSFW-marked channels only~${hint}`;
}
