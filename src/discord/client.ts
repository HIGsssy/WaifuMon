import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createDispatcher } from './commandRegistry';
import type { AppContext } from './types';
import {
  handleDaily,
  handleInventory,
  handleMenu,
  handleProfile,
  handleShop,
  handleShopBuy,
} from './commands/waifumon';
import {
  handleAdminAllowChannelAdd,
  handleAdminAllowChannelList,
  handleAdminAllowChannelRemove,
  handleAdminSetAnnounceChannel,
} from './commands/waifumonAdmin';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { Provisioned } from './types';

/** Builds the Discord client with the interaction router wired up. */
export function createDiscordClient(ctx: AppContext): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const dispatch = createDispatcher({
    logger: ctx.logger,
    lookupAllowlist: (discordGuildId) =>
      ctx.services.guilds.getAllowedChannelIds(discordGuildId),
    provision: async (discordGuildId, discordUserId) => {
      const guild = await ctx.services.guilds.ensureGuild(discordGuildId);
      const player = await ctx.services.players.ensurePlayer(guild.id, discordUserId);
      return { guildDbId: guild.id, playerId: player.id };
    },
    commandHandlers: {
      'waifumon:menu': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleMenu(ctx, i, prov),
      'waifumon:profile': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleProfile(ctx, i, prov),
      'waifumon:daily': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleDaily(ctx, i, prov),
      'waifumon:inventory': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleInventory(ctx, i, prov),
      'waifumon:shop': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleShop(ctx, i, prov),
      'waifumon-admin:allow-channel:add': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelAdd(ctx, i),
      'waifumon-admin:allow-channel:remove': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelRemove(ctx, i),
      'waifumon-admin:allow-channel:list': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelList(ctx, i),
      'waifumon-admin:set-announce-channel': (i: ChatInputCommandInteraction) =>
        handleAdminSetAnnounceChannel(ctx, i),
    },
    componentHandlers: {
      'menu:daily': (i: ButtonInteraction, prov: Provisioned) => handleDaily(ctx, i, prov),
      'menu:shop': (i: ButtonInteraction, prov: Provisioned) => handleShop(ctx, i, prov),
      'menu:profile': (i: ButtonInteraction, prov: Provisioned) => handleProfile(ctx, i, prov),
      'menu:inventory': (i: ButtonInteraction, prov: Provisioned) =>
        handleInventory(ctx, i, prov),
      'shop:buy': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleShopBuy(ctx, i, prov, args[0] ?? ''),
    },
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void dispatch(interaction);
  });

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info({ user: c.user.tag }, 'Discord client ready');
  });

  return client;
}
