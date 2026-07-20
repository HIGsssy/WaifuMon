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
  handleCareAutocomplete,
  handleCareChangeOpen,
  handleCareChangePick,
  handleCareCommand,
  handleCareLeave,
  handleCareStart,
  handleQuests,
  handleQuestsClaimAll,
} from './commands/waifumon';
import {
  handleEncounterCharm,
  handleEncounterPick,
  handleEncounterRelease,
  handleHunt,
} from './commands/waifumonHunt';
import {
  handleBuddyAutocomplete,
  handleBuddyCommand,
  handleCollection,
  handleCollectionList,
  handleCollectionPage,
  handleCollectionPick,
  handleCollectionPickId,
  handleDuplicateConvert,
  handleDuplicateKeep,
  handleInspectAutocomplete,
  handleInspectCommand,
  handleWaifuConvert,
  handleWaifuConvertConfirm,
  handleWaifuFavorite,
  handleWaifuInvest,
  handleWaifuNicknameOpen,
  handleWaifuNicknameSubmit,
  handleWaifuRelease,
  handleWaifuReleaseConfirm,
  handleWaifuSetBuddy,
} from './commands/waifumonCollection';
import {
  handleAdminAllowChannelAdd,
  handleAdminAllowChannelList,
  handleAdminAllowChannelRemove,
  handleAdminSetAnnounceChannel,
} from './commands/waifumonAdmin';
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
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
    lookupPlayerId: (discordGuildId, discordUserId) =>
      ctx.services.players.findPlayerId(discordGuildId, discordUserId),
    lookupSessionOwner: async (messageId) => {
      const session = await ctx.services.session.findByMessageId(messageId);
      if (!session) return null;
      const player = await ctx.services.players.getById(session.playerId);
      if (!player) return null;
      return {
        playerId: session.playerId,
        discordUserId: player.discordUserId,
        displayName: session.ownerDisplayName ?? null,
        expired: ctx.services.session.isExpired(session),
      };
    },
    commandHandlers: {
      'waifumon:menu': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleMenu(ctx, i, prov),
      'waifumon:hunt': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleHunt(ctx, i, prov),
      'waifumon:profile': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleProfile(ctx, i, prov),
      'waifumon:daily': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleDaily(ctx, i, prov),
      'waifumon:inventory': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleInventory(ctx, i, prov),
      'waifumon:shop': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleShop(ctx, i, prov),
      'waifumon:collection': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleCollection(ctx, i, prov),
      'waifumon:inspect': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleInspectCommand(ctx, i, prov),
      'waifumon:buddy': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleBuddyCommand(ctx, i, prov),
      'waifumon:care': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleCareCommand(ctx, i, prov),
      'waifumon:quests': (i: ChatInputCommandInteraction, prov: Provisioned) =>
        handleQuests(ctx, i, prov),
      'waifumon-admin:allow-channel:add': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelAdd(ctx, i),
      'waifumon-admin:allow-channel:remove': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelRemove(ctx, i),
      'waifumon-admin:allow-channel:list': (i: ChatInputCommandInteraction) =>
        handleAdminAllowChannelList(ctx, i),
      'waifumon-admin:set-announce-channel': (i: ChatInputCommandInteraction) =>
        handleAdminSetAnnounceChannel(ctx, i),
    },
    autocompleteHandlers: {
      'waifumon:inspect': (i: AutocompleteInteraction, playerId: number | null) =>
        handleInspectAutocomplete(ctx, i, playerId),
      'waifumon:buddy': (i: AutocompleteInteraction, playerId: number | null) =>
        handleBuddyAutocomplete(ctx, i, playerId),
      'waifumon:care': (i: AutocompleteInteraction, playerId: number | null) =>
        handleCareAutocomplete(ctx, i, playerId),
    },
    componentHandlers: {
      'menu:hunt': (i: ButtonInteraction, prov: Provisioned) => handleHunt(ctx, i, prov),
      'menu:daily': (i: ButtonInteraction, prov: Provisioned) => handleDaily(ctx, i, prov),
      'menu:shop': (i: ButtonInteraction, prov: Provisioned) => handleShop(ctx, i, prov),
      'menu:profile': (i: ButtonInteraction, prov: Provisioned) => handleProfile(ctx, i, prov),
      'menu:inventory': (i: ButtonInteraction, prov: Provisioned) =>
        handleInventory(ctx, i, prov),
      'menu:collection': (i: ButtonInteraction, prov: Provisioned) =>
        handleCollection(ctx, i, prov),
      'menu:quests': (i: ButtonInteraction, prov: Provisioned) => handleQuests(ctx, i, prov),
      'menu:back': (i: ButtonInteraction, prov: Provisioned) => handleMenu(ctx, i, prov),
      'shop:buy': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleShopBuy(ctx, i, prov, args[0] ?? ''),
      'quests:claim_all': (i: ButtonInteraction, prov: Provisioned) =>
        handleQuestsClaimAll(ctx, i, prov),
      'care:start': (i: ButtonInteraction, prov: Provisioned) =>
        handleCareStart(ctx, i, prov),
      'care:leave': (i: ButtonInteraction, prov: Provisioned) =>
        handleCareLeave(ctx, i, prov),
      'care:change_open': (i: ButtonInteraction, prov: Provisioned) =>
        handleCareChangeOpen(ctx, i, prov),
      'care:change_pick': (i: StringSelectMenuInteraction, prov: Provisioned) =>
        handleCareChangePick(ctx, i, prov),
      'enc:charm': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleEncounterCharm(ctx, i, prov, args),
      'enc:pick': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleEncounterPick(ctx, i, prov, args),
      'enc:release': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleEncounterRelease(ctx, i, prov, args),
      'col:page': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleCollectionPage(ctx, i, prov, args),
      'col:pick': (i: StringSelectMenuInteraction, prov: Provisioned) =>
        handleCollectionPick(ctx, i, prov),
      'col:list': (i: ButtonInteraction, prov: Provisioned) =>
        handleCollectionList(ctx, i, prov),
      'col:pick_id': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleCollectionPickId(ctx, i, prov, args),
      'waifu:fav': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuFavorite(ctx, i, prov, args),
      'waifu:release': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuRelease(ctx, i, prov, args),
      'waifu:release_confirm': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuReleaseConfirm(ctx, i, prov, args),
      'waifu:convert': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuConvert(ctx, i, prov, args),
      'waifu:convert_confirm': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuConvertConfirm(ctx, i, prov, args),
      'waifu:buddy': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuSetBuddy(ctx, i, prov, args),
      'waifu:invest': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuInvest(ctx, i, prov, args),
      'waifu:nick_open': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuNicknameOpen(ctx, i, prov, args),
      'waifu:nick_submit': (i: ModalSubmitInteraction, prov: Provisioned, args: string[]) =>
        handleWaifuNicknameSubmit(ctx, i, prov, args),
      'dup:keep': (i: ButtonInteraction, prov: Provisioned) =>
        handleDuplicateKeep(ctx, i, prov),
      'dup:convert': (i: ButtonInteraction, prov: Provisioned, args: string[]) =>
        handleDuplicateConvert(ctx, i, prov, args),
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
