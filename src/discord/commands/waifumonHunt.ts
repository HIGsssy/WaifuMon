/**
 * Encounter UI (Milestones 2A + 2B).
 *
 * Ephemeral flow:
 *   /waifumon hunt or menu:hunt → HuntService rolls → either a non-encounter
 *   reward embed or an encounter reveal with charm buttons.
 *   Clicking a charm calls CaptureService, then paints the public capture
 *   message (created on first attempt, edited on later attempts) and the
 *   player's own ephemeral state (retry buttons, or the final captured/
 *   escaped/released card).
 *
 * Public/DB separation: capture state commits inside the CaptureService
 * transaction; the public post/edit and rare-announcement calls happen
 * afterwards. If Discord returns a permission error, the DB result stays
 * committed and the player is told ephemerally that the announce couldn't
 * fire — captures are never eaten by a failed send.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type InteractionEditReplyOptions,
} from 'discord.js';
import {
  captureAttempts,
  items as itemsTable,
  species as speciesTable,
  type CaptureAttemptRow,
  type EncounterRow,
  type ItemRow,
  type SpeciesRow,
  type Rarity,
} from '../../db/schema';
import { rarityAtLeast, RARITY_RANK } from '../../modules/capture/captureMath';
import type { CaptureAttemptResult, CaptureOutcome } from '../../modules/capture/captureService';
import { resolveAssetPath } from '../../modules/content/loader';
import type { ItemContent } from '../../modules/content/schemas';
import {
  ActiveEncounterError,
  AppError,
  EncounterAlreadyResolvedError,
  EncounterExpiredError,
  EncounterNotFoundError,
  HuntCooldownError,
  InsufficientEnergyError,
  InsufficientItemsError,
  ItemNotFoundError,
  ItemNotUsableError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondScreen, withBackRow } from '../ui';

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const CARD_FILENAME = 'card.png';

const RARITY_COLORS: Record<string, number> = {
  N: 0xb8b8b8,
  R: 0x6fb1ff,
  SR: 0xa66fff,
  SSR: 0xffc46f,
  UR: 0xff6fa5,
  LR: 0xff3d7f,
  EX: 0xffffff,
};

function rarityColor(rarity: string): number {
  return RARITY_COLORS[rarity] ?? 0xff6fa5;
}

/** Discord permits max 5 buttons per row; keep Mythic last. */
function orderCharmItems(items: readonly ItemContent[]): ItemContent[] {
  return items
    .filter((i) => i.enabled && i.category === 'capture')
    .slice()
    .sort((a, b) => {
      if (a.isGuaranteedCapture !== b.isGuaranteedCapture) {
        return a.isGuaranteedCapture ? 1 : -1;
      }
      const ap = a.buyPrice ?? Number.POSITIVE_INFINITY;
      const bp = b.buyPrice ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
      return a.slug.localeCompare(b.slug);
    })
    .slice(0, 5);
}

function encounterButtonRows(
  encounter: EncounterRow,
  charms: readonly ItemContent[],
  ownedBySlug: ReadonlyMap<string, number>,
): ActionRowBuilder<ButtonBuilder>[] {
  const charmButtons: ButtonBuilder[] = charms.map((item) => {
    const owned = ownedBySlug.get(item.slug) ?? 0;
    const label = item.isGuaranteedCapture
      ? `${item.name} ×${owned} — guaranteed`
      : `${item.name} ×${owned}`;
    const btn = new ButtonBuilder()
      .setCustomId(buildCustomId('enc', 'charm', String(encounter.id), item.slug))
      .setLabel(label)
      .setStyle(item.isGuaranteedCapture ? ButtonStyle.Danger : ButtonStyle.Primary)
      .setDisabled(owned <= 0);
    if (item.emoji) btn.setEmoji(item.emoji);
    return btn;
  });
  const letGo = new ButtonBuilder()
    .setCustomId(buildCustomId('enc', 'release', String(encounter.id)))
    .setLabel('Let Her Go')
    .setStyle(ButtonStyle.Secondary);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (charmButtons.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...charmButtons));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(letGo));
  return rows;
}

function attachCard(ctx: AppContext, species: SpeciesRow): AttachmentBuilder | null {
  try {
    const abs = resolveAssetPath(ctx.config.assetsDir, species.imagePath);
    return new AttachmentBuilder(abs, { name: CARD_FILENAME });
  } catch (err) {
    ctx.logger.warn({ err, slug: species.slug }, 'failed to attach species card image');
    return null;
  }
}

interface EncounterView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
}

async function buildEncounterView(
  ctx: AppContext,
  prov: Provisioned,
  encounter: EncounterRow,
  species: SpeciesRow,
  energyRemaining?: number,
): Promise<EncounterView> {
  const charms = orderCharmItems(ctx.content.items);
  const inventory = await ctx.services.inventory.getInventory(prov.playerId);
  const ownedBySlug = new Map(inventory.map((e) => [e.item.slug, e.quantity]));

  const footer =
    energyRemaining != null
      ? `Pick a charm to try, or Let Her Go. · Energy left: ${energyRemaining}`
      : 'Pick a charm to try, or Let Her Go.';

  const embed = new EmbedBuilder()
    .setTitle(`✨ A wild ${species.name} appears!`)
    .setColor(rarityColor(species.rarity))
    .setDescription(species.description || '_A mysterious presence…_')
    .addFields(
      { name: 'Rarity', value: species.rarity, inline: true },
      { name: 'Archetype', value: species.archetype, inline: true },
      {
        name: 'Time',
        value: `Expires <t:${Math.floor(encounter.expiresAt.getTime() / 1000)}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: footer });

  const files: AttachmentBuilder[] = [];
  const attach = attachCard(ctx, species);
  if (attach) {
    files.push(attach);
    embed.setImage(`attachment://${CARD_FILENAME}`);
  }
  return { embeds: [embed], components: encounterButtonRows(encounter, charms, ownedBySlug), files };
}

async function loadSpeciesById(ctx: AppContext, speciesId: number): Promise<SpeciesRow | null> {
  const [row] = await ctx.db
    .select()
    .from(speciesTable)
    .where(eq(speciesTable.id, speciesId))
    .limit(1);
  return row ?? null;
}

async function loadAttemptsForEncounter(
  ctx: AppContext,
  encounterId: number,
): Promise<CaptureAttemptRow[]> {
  return ctx.db
    .select()
    .from(captureAttempts)
    .where(eq(captureAttempts.encounterId, encounterId))
    .orderBy(asc(captureAttempts.attemptNumber));
}

/** DB items keyed by id — used to render the attempt log. */
async function loadItemsByIds(
  ctx: AppContext,
  ids: readonly number[],
): Promise<Map<number, ItemRow>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const rows = await ctx.db.select().from(itemsTable).where(inArray(itemsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/** /waifumon hunt (and the menu Hunt button). */
export async function handleHunt(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const channelId = interaction.channelId;
  if (!channelId) {
    await respondScreen(interaction, {
      content: 'Hunts need a channel context.',
      components: withBackRow(),
    });
    return;
  }
  try {
    const result = await ctx.services.hunt.hunt(prov.playerId, channelId);
    if (result.kind === 'encounter') {
      const view = await buildEncounterView(
        ctx,
        prov,
        result.encounter,
        result.species,
        result.energyRemaining,
      );
      // Encounter reveal has its own actions (charms + Let Her Go); no Back.
      await respondScreen(interaction, view);
      return;
    }
    const embed = new EmbedBuilder().setColor(0xff6fa5);
    if (result.kind === 'item_find' || result.kind === 'rare_item_find') {
      const emoji = result.item.emoji ?? '•';
      embed
        .setTitle(result.kind === 'rare_item_find' ? '🌟 Rare Find!' : '🎒 Item Found')
        .setDescription(`${emoji} **${result.item.name}** ×${result.quantity}`);
    } else if (result.kind === 'waifubux_find') {
      embed
        .setTitle('💰 WaifuBux Found')
        .setDescription(`+**${result.amount}** WaifuBux (balance: ${result.balanceAfter})`);
    } else if (result.kind === 'essence_find') {
      embed
        .setTitle('✨ Essence Found')
        .setDescription(`+**${result.amount}** Essence (balance: ${result.balanceAfter})`);
    } else if (result.kind === 'flavor') {
      embed.setTitle('🍃 Nothing but wind…').setDescription(result.text);
    }
    embed.setFooter({ text: `Energy left: ${result.energyRemaining}` });
    await respondScreen(interaction, {
      embeds: [embed],
      components: withBackRow([huntAgainRow()]),
    });
  } catch (err) {
    if (err instanceof ActiveEncounterError) {
      const active = await ctx.services.hunt.getActiveEncounter(prov.playerId);
      if (active) {
        const species = await loadSpeciesById(ctx, active.speciesId);
        if (species) {
          const view = await buildEncounterView(ctx, prov, active, species);
          await respondScreen(interaction, view);
          return;
        }
      }
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    if (err instanceof HuntCooldownError || err instanceof InsufficientEnergyError) {
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    throw err;
  }
}

/** Small "Hunt again" pill for the non-encounter result screen. */
function huntAgainRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('menu', 'hunt'))
      .setLabel('Hunt again')
      .setEmoji('🏹')
      .setStyle(ButtonStyle.Primary),
  );
}

// ─────────────────────────────── capture flow ───────────────────────────────

function findItemContent(ctx: AppContext, slug: string): ItemContent | undefined {
  return ctx.content.items.find((i) => i.slug === slug);
}

function renderAttemptLog(
  attempts: readonly CaptureAttemptRow[],
  itemsById: ReadonlyMap<number, ItemRow>,
): string {
  if (attempts.length === 0) return '_No attempts yet._';
  return attempts
    .map((a) => {
      const item = itemsById.get(a.itemId);
      const emoji = item?.emoji ?? '•';
      const name = item?.name ?? `Item #${a.itemId}`;
      const verdict = a.success
        ? a.guaranteed
          ? 'captured (guaranteed)!'
          : 'captured!'
        : 'she resisted…';
      return `${a.attemptNumber}. ${emoji} ${name} — ${verdict}`;
    })
    .join('\n');
}

function buildPublicCaptureEmbed(
  species: SpeciesRow,
  userMention: string,
  logText: string,
  outcome: CaptureOutcome | 'released' | 'ongoing',
  cardAttached: boolean,
  attemptsRemaining: number,
  maxAttempts: number,
): EmbedBuilder {
  const status = (() => {
    switch (outcome) {
      case 'success':
        return `✨ ${userMention} **captured ${species.name}!**`;
      case 'escape':
        return `💨 After ${maxAttempts} attempts, **${species.name}** vanished into the night.`;
      case 'released':
        return `🍃 ${userMention} let ${species.name} go.`;
      case 'failure':
        return `😤 **${species.name}** resisted! ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining.`;
      case 'ongoing':
        return `🎯 ${userMention} is trying to capture **${species.name}**…`;
    }
  })();
  const embed = new EmbedBuilder()
    .setColor(rarityColor(species.rarity))
    .setTitle(`🎯 ${species.name} · ${species.rarity}`)
    .setDescription(status)
    .addFields({ name: 'Attempts', value: logText || '_No attempts yet._' });
  if (cardAttached) embed.setImage(`attachment://${CARD_FILENAME}`);
  return embed;
}

/**
 * First attempt: send a fresh public message and persist its id.
 * Later attempts: fetch the persisted message and edit it in place.
 */
async function paintPublicMessage(
  ctx: AppContext,
  channel: GuildTextBasedChannel,
  encounter: EncounterRow,
  publicPayload: BaseMessageOptions,
): Promise<{ posted: boolean; messageId: string | null; error?: unknown }> {
  try {
    if (!encounter.publicMessageId) {
      const msg = await channel.send(publicPayload);
      await ctx.services.capture.setPublicMessageId(encounter.id, msg.id);
      return { posted: true, messageId: msg.id };
    }
    await channel.messages.edit(encounter.publicMessageId, publicPayload);
    return { posted: true, messageId: encounter.publicMessageId };
  } catch (err) {
    ctx.logger.warn(
      { err, encounterId: encounter.id, channelId: channel.id },
      'failed to paint public capture message',
    );
    return { posted: false, messageId: encounter.publicMessageId, error: err };
  }
}

async function sendRareAnnouncement(
  ctx: AppContext,
  interaction: ButtonInteraction,
  species: SpeciesRow,
  userMention: string,
  isDuplicate: boolean,
): Promise<'skipped' | 'sent' | 'failed'> {
  const config = ctx.content.tables.capture;
  const rarity = species.rarity as Rarity;
  if (!rarityAtLeast(rarity, config.announceMinRarity)) return 'skipped';

  let hereThreshold: Rarity = config.hereMentionMinRarity;
  if (interaction.guildId) {
    const guild = await ctx.services.guilds.getByDiscordId(interaction.guildId);
    if (guild) {
      const gt = guild.hereThresholdRarity as Rarity;
      if (RARITY_RANK[gt] != null) hereThreshold = gt;
    }
  }
  const mentionHere = rarityAtLeast(rarity, hereThreshold);

  const embed = new EmbedBuilder()
    .setTitle(`🌟 ${species.name} captured! (${rarity})`)
    .setColor(rarityColor(rarity))
    .setDescription(
      `${userMention} just landed a **${rarity}** encounter${isDuplicate ? ' (duplicate)' : ''}!`,
    );
  const card = attachCard(ctx, species);
  const files = card ? [card] : [];
  if (card) embed.setImage(`attachment://${CARD_FILENAME}`);

  // Announce channel: guild-configured if set, otherwise the capture channel.
  let target: GuildTextBasedChannel | null = null;
  if (interaction.guildId) {
    const guild = await ctx.services.guilds.getByDiscordId(interaction.guildId);
    const channelId = guild?.announceChannelId ?? interaction.channelId;
    if (channelId) {
      try {
        const fetched = await interaction.client.channels.fetch(channelId);
        if (fetched && 'send' in fetched) target = fetched as GuildTextBasedChannel;
      } catch (err) {
        ctx.logger.warn({ err, channelId }, 'failed to fetch announce channel');
      }
    }
  }
  if (!target) return 'failed';

  try {
    await target.send({
      ...(mentionHere ? { content: '@here' } : {}),
      embeds: [embed],
      files,
      allowedMentions: mentionHere ? { parse: ['everyone'] } : { parse: [] },
    });
    return 'sent';
  } catch (err) {
    ctx.logger.warn({ err, rarity, speciesSlug: species.slug }, 'rare announcement failed');
    return 'failed';
  }
}

function retryButtonRows(
  encounter: EncounterRow,
  charmSlug: string,
  charm: ItemContent | undefined,
  ownedRemaining: number,
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (charm && ownedRemaining > 0) {
    const label = charm.isGuaranteedCapture
      ? `Try Again — ${charm.name} ×${ownedRemaining} (guaranteed)`
      : `Try Again — ${charm.name} ×${ownedRemaining}`;
    const btn = new ButtonBuilder()
      .setCustomId(buildCustomId('enc', 'charm', String(encounter.id), charmSlug))
      .setLabel(label)
      .setStyle(ButtonStyle.Primary);
    if (charm.emoji) btn.setEmoji(charm.emoji);
    buttons.push(btn);
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('enc', 'pick', String(encounter.id)))
      .setLabel('Use Different Charm')
      .setStyle(ButtonStyle.Secondary),
  );
  buttons.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('enc', 'release', String(encounter.id)))
      .setLabel('Let Her Go')
      .setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function buildEphemeralOutcomeMessage(
  ctx: AppContext,
  result: CaptureAttemptResult,
  publicOk: boolean,
): InteractionEditReplyOptions {
  const { outcome, species, item, isDuplicate, attempt, attemptsRemaining } = result;
  const embed = new EmbedBuilder().setColor(rarityColor(species.rarity));
  const attachName = `attachment://${CARD_FILENAME}`;
  const card = attachCard(ctx, species);
  const files = card ? [card] : [];

  if (outcome === 'success') {
    const dupNote = isDuplicate
      ? '\n\n_Duplicate — kept in your collection. (Convert-to-Essence prompt lands next milestone.)_'
      : '';
    embed
      .setTitle(`💖 You captured ${species.name}!`)
      .setDescription(
        `Used ${item.emoji ?? '•'} **${item.name}**${attempt.guaranteed ? ' (guaranteed)' : ''}.${dupNote}`,
      );
  } else if (outcome === 'escape') {
    embed
      .setTitle(`💨 ${species.name} escaped`)
      .setDescription(`After ${attempt.attemptNumber} attempts, she vanished into the night.`);
  } else {
    embed
      .setTitle(`😤 ${species.name} resisted`)
      .setDescription(
        `Attempt ${attempt.attemptNumber} — she wriggled free. **${attemptsRemaining}** attempt${attemptsRemaining === 1 ? '' : 's'} left.`,
      );
  }
  if (card) embed.setImage(attachName);
  if (!publicOk) {
    embed.setFooter({
      text: "Note: I couldn't post publicly in this channel — the capture is still saved.",
    });
  }
  // Final outcomes (success / escape) get a Back button so the player can
  // return to the main menu without a fresh /waifumon. Failure paths get
  // their own retry row (see buildFailureRetryReply).
  const components = outcome === 'failure' ? [] : withBackRow();
  return { embeds: [embed], components, files };
}

/** Full retry UI needs current inventory quantities; keep this local. */
async function buildFailureRetryReply(
  ctx: AppContext,
  prov: Provisioned,
  result: CaptureAttemptResult,
  publicOk: boolean,
): Promise<InteractionEditReplyOptions> {
  const base = buildEphemeralOutcomeMessage(ctx, result, publicOk);
  const owned = await ctx.services.inventory.getQuantity(prov.playerId, result.item.id);
  const charm = findItemContent(ctx, result.item.slug);
  return {
    ...base,
    components: retryButtonRows(result.encounter, result.item.slug, charm, owned),
  };
}

/** Charm click — real capture attempt. */
export async function handleEncounterCharm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  const itemSlug = args[1];
  if (!Number.isInteger(encounterId) || !itemSlug) {
    await interaction.reply({ content: 'That button no longer works.', ...EPHEMERAL });
    return;
  }

  await interaction.deferUpdate();

  let result: CaptureAttemptResult;
  try {
    result = await ctx.services.capture.attemptCapture(prov.playerId, encounterId, itemSlug);
  } catch (err) {
    const message = translateCaptureError(err);
    await interaction.editReply({
      content: message,
      embeds: [],
      components: withBackRow(),
      files: [],
    });
    return;
  }

  const channel = interaction.channel as GuildTextBasedChannel | null;
  const userMention = `<@${interaction.user.id}>`;
  let publicOk = false;

  if (channel && 'send' in channel) {
    // Refetch the encounter to pick up publicMessageId set by prior attempts.
    const attempts = await loadAttemptsForEncounter(ctx, encounterId);
    const itemsById = await loadItemsByIds(ctx, attempts.map((a) => a.itemId));
    const outcomeForPublic: CaptureOutcome | 'ongoing' =
      result.outcome === 'failure' && result.attemptsRemaining > 0 ? 'failure' : result.outcome;
    const embed = buildPublicCaptureEmbed(
      result.species,
      userMention,
      renderAttemptLog(attempts, itemsById),
      outcomeForPublic,
      Boolean(result.species.imagePath),
      result.attemptsRemaining,
      result.encounter.maxAttempts,
    );
    // Build a fresh attachment for each public paint (Discord uploads per send).
    const card = attachCard(ctx, result.species);
    const files = card ? [card] : [];
    const publicPayload: BaseMessageOptions = {
      embeds: [embed],
      files,
      allowedMentions: { parse: [] },
    };
    const paint = await paintPublicMessage(ctx, channel, result.encounter, publicPayload);
    publicOk = paint.posted;
  }

  // Rare capture announcement (SSR+): fire once on success only.
  if (result.outcome === 'success') {
    await sendRareAnnouncement(ctx, interaction, result.species, userMention, result.isDuplicate);
  }

  // Paint the player's own ephemeral state.
  const reply =
    result.outcome === 'failure'
      ? await buildFailureRetryReply(ctx, prov, result, publicOk)
      : buildEphemeralOutcomeMessage(ctx, result, publicOk);
  await interaction.editReply(reply);
}

/** Use Different Charm — reopens the encounter reveal with fresh quantities. */
export async function handleEncounterPick(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  if (!Number.isInteger(encounterId)) {
    await respondScreen(interaction, {
      content: 'That encounter is no longer active.',
      components: withBackRow(),
    });
    return;
  }
  const active = await ctx.services.hunt.getActiveEncounter(prov.playerId);
  if (!active || active.id !== encounterId) {
    await respondScreen(interaction, {
      content: 'That encounter is no longer active.',
      components: withBackRow(),
    });
    return;
  }
  const speciesRow = await loadSpeciesById(ctx, active.speciesId);
  if (!speciesRow) {
    await respondScreen(interaction, {
      content: 'That encounter is no longer active.',
      components: withBackRow(),
    });
    return;
  }
  const view = await buildEncounterView(ctx, prov, active, speciesRow);
  await respondScreen(interaction, view);
}

/** Let Her Go — pre or post-attempt. Finalizes the public message if one exists. */
export async function handleEncounterRelease(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  if (!Number.isInteger(encounterId)) {
    await respondScreen(interaction, {
      content: 'That encounter is no longer active.',
      components: withBackRow(),
    });
    return;
  }
  let releasedRow: EncounterRow;
  try {
    releasedRow = await ctx.services.hunt.letHerGo(prov.playerId, encounterId);
  } catch (err) {
    if (err instanceof EncounterNotFoundError) {
      await respondScreen(interaction, {
        content: err.userMessage,
        components: withBackRow(),
      });
      return;
    }
    throw err;
  }

  // If attempts happened, edit the public message to a final released state.
  if (releasedRow.publicMessageId) {
    const channel = interaction.channel as GuildTextBasedChannel | null;
    if (channel && 'messages' in channel) {
      const speciesRow = await loadSpeciesById(ctx, releasedRow.speciesId);
      if (speciesRow) {
        const attempts = await loadAttemptsForEncounter(ctx, releasedRow.id);
        const itemsById = await loadItemsByIds(ctx, attempts.map((a) => a.itemId));
        const embed = buildPublicCaptureEmbed(
          speciesRow,
          `<@${interaction.user.id}>`,
          renderAttemptLog(attempts, itemsById),
          'released',
          Boolean(speciesRow.imagePath),
          0,
          releasedRow.maxAttempts,
        );
        const card = attachCard(ctx, speciesRow);
        const files = card ? [card] : [];
        try {
          await channel.messages.edit(releasedRow.publicMessageId, {
            embeds: [embed],
            files,
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          ctx.logger.warn(
            { err, encounterId: releasedRow.id },
            'failed to finalize released public message',
          );
        }
      }
    }
  }

  await interaction.update({
    content: 'You let her slip back into the neon~',
    embeds: [],
    components: withBackRow(),
    files: [],
  });
}

function translateCaptureError(err: unknown): string {
  if (err instanceof EncounterNotFoundError) return err.userMessage;
  if (err instanceof EncounterAlreadyResolvedError) return err.userMessage;
  if (err instanceof EncounterExpiredError) return err.userMessage;
  if (err instanceof InsufficientItemsError) {
    return "You don't have any of that charm~ Try a different one.";
  }
  if (err instanceof ItemNotFoundError) return err.userMessage;
  if (err instanceof ItemNotUsableError) return err.userMessage;
  if (err instanceof AppError) return err.userMessage;
  throw err;
}
