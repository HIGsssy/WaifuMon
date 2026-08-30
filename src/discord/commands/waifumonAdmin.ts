/**
 * /waifumon-admin (Milestone 1): allow-channel add|remove|list and
 * set-announce-channel (validates the target is a guild text channel). Guild
 * admins only — gated by default member permissions on the command definition.
 */
import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { AppContext } from '../types';

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export async function handleAdminAllowChannelAdd(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const list = await ctx.services.guilds.addAllowedChannel(interaction.guildId!, channel.id);
  await interaction.reply({
    content: `Added <#${channel.id}> to the play-channel allowlist (${list.length} channel${list.length === 1 ? '' : 's'}).`,
    ...EPHEMERAL,
  });
}

export async function handleAdminAllowChannelRemove(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const list = await ctx.services.guilds.removeAllowedChannel(interaction.guildId!, channel.id);
  const suffix =
    list.length === 0
      ? ' Allowlist is now empty — any guild channel works.'
      : ` (${list.length} remaining).`;
  await interaction.reply({
    content: `Removed <#${channel.id}> from the play-channel allowlist.${suffix}`,
    ...EPHEMERAL,
  });
}

export async function handleAdminAllowChannelList(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const list = await ctx.services.guilds.getAllowedChannelIds(interaction.guildId!);
  const content =
    !list || list.length === 0
      ? 'No allowlist configured — Waifumon plays in any guild channel.'
      : `Allowed play channels:\n${list.map((id) => `• <#${id}>`).join('\n')}`;
  await interaction.reply({ content, ...EPHEMERAL });
}

export async function handleAdminSetAnnounceChannel(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const resolved = await interaction.guild?.channels.fetch(channel.id);
  const isTextChannel = resolved != null && resolved.type === ChannelType.GuildText;
  if (!isTextChannel) {
    await interaction.reply({
      content: `<#${channel.id}> must be a text channel to receive announcements.`,
      ...EPHEMERAL,
    });
    return;
  }
  await ctx.services.guilds.setAnnounceChannel(interaction.guildId!, channel.id);
  await interaction.reply({
    content: `Rare-capture announcements will go to <#${channel.id}>.`,
    ...EPHEMERAL,
  });
}
