/**
 * /waifumon hunt and encounter-reveal UI (Milestone 2A). Everything is
 * ephemeral. Charm buttons show quantities but do not perform capture yet —
 * capture attempts land in the next milestone. Public capture theater and
 * rare announcements are also deferred.
 */
import { eq } from 'drizzle-orm';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import { species as speciesTable, type EncounterRow, type SpeciesRow } from '../../db/schema';
import { resolveAssetPath } from '../../modules/content/loader';
import type { ItemContent } from '../../modules/content/schemas';
import {
  ActiveEncounterError,
  EncounterNotFoundError,
  HuntCooldownError,
  InsufficientEnergyError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';

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

async function buildEncounterView(
  ctx: AppContext,
  prov: Provisioned,
  encounter: EncounterRow,
  species: SpeciesRow,
  energyRemaining?: number,
): Promise<InteractionReplyOptions> {
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
  try {
    const abs = resolveAssetPath(ctx.config.assetsDir, species.imagePath);
    files.push(new AttachmentBuilder(abs, { name: CARD_FILENAME }));
    embed.setImage(`attachment://${CARD_FILENAME}`);
  } catch (err) {
    ctx.logger.warn({ err, slug: species.slug }, 'failed to attach species card image');
  }

  return {
    embeds: [embed],
    components: encounterButtonRows(encounter, charms, ownedBySlug),
    files,
    ...EPHEMERAL,
  };
}

async function loadSpeciesById(ctx: AppContext, speciesId: number): Promise<SpeciesRow | null> {
  const [row] = await ctx.db
    .select()
    .from(speciesTable)
    .where(eq(speciesTable.id, speciesId))
    .limit(1);
  return row ?? null;
}

/** /waifumon hunt (and the menu Hunt button). */
export async function handleHunt(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.reply({ content: 'Hunts need a channel context.', ...EPHEMERAL });
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
      await interaction.reply(view);
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
    await interaction.reply({ embeds: [embed], ...EPHEMERAL });
  } catch (err) {
    if (err instanceof ActiveEncounterError) {
      const active = await ctx.services.hunt.getActiveEncounter(prov.playerId);
      if (active) {
        const species = await loadSpeciesById(ctx, active.speciesId);
        if (species) {
          const view = await buildEncounterView(ctx, prov, active, species);
          await interaction.reply(view);
          return;
        }
      }
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    if (err instanceof HuntCooldownError || err instanceof InsufficientEnergyError) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    throw err;
  }
}

/**
 * Encounter charm button (placeholder). Capture attempts land next milestone;
 * for now we just tell the player and leave the encounter untouched.
 */
export async function handleEncounterCharm(
  _ctx: AppContext,
  interaction: ButtonInteraction,
  _prov: Provisioned,
  _args: string[],
): Promise<void> {
  await interaction.reply({
    content: 'Capture attempts are coming in the next milestone~',
    ...EPHEMERAL,
  });
}

/** Let Her Go — resolves the active encounter (pre-attempt path only in 2A). */
export async function handleEncounterRelease(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  if (!Number.isInteger(encounterId)) {
    await interaction.reply({ content: 'That encounter is no longer active.', ...EPHEMERAL });
    return;
  }
  try {
    await ctx.services.hunt.letHerGo(prov.playerId, encounterId);
    await interaction.update({
      content: 'You let her slip back into the neon~',
      embeds: [],
      components: [],
      files: [],
    });
  } catch (err) {
    if (err instanceof EncounterNotFoundError) {
      await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
      return;
    }
    throw err;
  }
}
