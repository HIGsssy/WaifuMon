/**
 * PlayChannelGuard — the single access-control choke point (plan §11).
 * Waifumon runs in guild channels only; if the guild configured an
 * allowed-channel list, the channel must also be on it. The guard runs before
 * every command and component handler, and before any service call — blocked
 * interactions consume nothing and write no rows.
 *
 * Channel-level NSFW gating is intentionally NOT enforced here: server
 * administrators decide, via Discord permissions and the optional per-guild
 * allowlist, where the bot may be used.
 */
import { type GuildBasedChannel, type Interaction } from 'discord.js';

export type DenyReason = 'dm' | 'not_allowed';

export type GuardDecision = { allow: true } | { allow: false; reason: DenyReason };

export interface GuardChannelInfo {
  /** False for DMs / non-guild contexts. */
  isGuildChannel: boolean;
  channelId: string | null;
  /** Parent channel id when the interaction is inside a thread. */
  parentChannelId: string | null;
}

/**
 * Pure decision function: guildConfig × channelInfo → allow | deny(reason).
 * Rules in order: (1) guild channel only, (2) on the allowlist when one is
 * configured (empty/unset list = any guild channel).
 *
 * `alwaysAllowedChannelIds` exempts a channel from rule **2 only** — today,
 * the guild's dedicated Boss Encounter channel. That channel is configured
 * through its own admin command and hosts buttons the bot itself posted;
 * requiring an admin to *also* add it to the play allowlist would turn a
 * working feature into a support ticket.
 *
 * It deliberately does not exempt rule 1: a DM is still a DM.
 */
export function decidePlayChannel(
  channel: GuardChannelInfo,
  allowedChannelIds: string[] | null | undefined,
  alwaysAllowedChannelIds: readonly (string | null | undefined)[] = [],
): GuardDecision {
  if (!channel.isGuildChannel || !channel.channelId) {
    return { allow: false, reason: 'dm' };
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
    return { isGuildChannel: false, channelId: null, parentChannelId: null };
  }
  const guildChannel = channel as GuildBasedChannel;
  return {
    isGuildChannel: true,
    channelId: guildChannel.id,
    parentChannelId: guildChannel.isThread() ? guildChannel.parentId : null,
  };
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
  return `Waifumon doesn't play in this channel~${hint}`;
}
