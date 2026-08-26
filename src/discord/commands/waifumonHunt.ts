/**
 * Encounter UI (Milestones 2A + 2B, ephemeral since the UX redesign).
 *
 * Flow:
 *   /wm hunt or menu:hunt → HuntService rolls → either a non-encounter reward
 *   embed or an encounter reveal with charm buttons, all private to the
 *   player. Clicking a charm calls CaptureService and repaints that same
 *   ephemeral with retry buttons or the final captured/escaped card.
 *
 * The only public writes left on this path are the SR+ rare-capture rich
 * embed (unchanged) and the Activity Feed narration, both of which happen
 * *after* the CaptureService transaction commits. If Discord returns a
 * permission error the DB result stays committed — captures are never eaten
 * by a failed send.
 */
import { eq } from 'drizzle-orm';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type InteractionEditReplyOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  species as speciesTable,
  type EncounterRow,
  type ItemRow,
  type SpeciesRow,
  type Rarity,
} from '../../db/schema';
import { rarityAtLeast, RARITY_RANK } from '../../modules/capture/captureMath';
import {
  affinityLabel,
  formatAffinityBonus,
  formatAffinityRead,
  normalizeAffinity,
  resolveBuddyAffinity,
} from '../../modules/capture/affinityMath';
import type {
  CaptureAttemptResult,
  CaptureOutcome,
  CaptureQuote,
} from '../../modules/capture/captureService';
import type { HuntResult } from '../../modules/hunt/huntService';
import {
  ActiveEncounterError,
  AppError,
  CaptureItemNotEligibleError,
  EncounterAlreadyResolvedError,
  EncounterExpiredError,
  EncounterNotFoundError,
  EncounterStaleError,
  HuntCooldownError,
  InsufficientEnergyError,
  InsufficientItemsError,
  ItemNotFoundError,
  ItemNotUsableError,
  NoCaptureItemSelectedError,
} from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { CARD_FILENAME, resolveAppearanceAssetOrPath } from '../assets/resolveAppearanceAsset';
import {
  renderEncounterDuplicateCardAttachment,
  renderOwnedCardAttachment,
} from '../assets/attachRenderedCard';
import { respondEphemeral, type SessionPayload } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import { captureDescriptors, huntDescriptors } from '../gameEventBuilders';
import { postAppearanceUnlockToasts } from '../appearanceToast';
import { withBackRow } from '../ui';
import { formatCaptureBonus, renderCaptureBonusLine } from './waifumon';
import { duplicatePromptComponents } from './waifumonCollection';

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

/** 0.525 → "52.5%" — used next to the buddy-bonus line on capture results. */
function formatChancePercent(chance: number): string {
  const pct = Math.round(chance * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 0.21 → "21%", 0.525 → "52.5%". Shared by every chance line on this screen. */
function formatChance(chance: number): string {
  const pct = Math.round(chance * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * Encounter controls.
 *
 * Three states, one builder:
 *   - nothing selected  → Capture (disabled, and says why) · Use Item · Let Her Go
 *   - item selected     → Capture · Change Item · Let Her Go
 *   - nothing eligible  → Capture (disabled) · Use Item (disabled) · Let Her Go
 *
 * The Capture button embeds the encounter's current `attempt_count`. That is
 * the stale-interaction guard: the service refuses a commit whose expected
 * count no longer matches, so a double-clicked Capture resolves exactly one
 * attempt and consumes exactly one item.
 */
function encounterButtonRows(
  encounter: EncounterRow,
  selected: { item: ItemRow; quantity: number } | null,
  hasEligibleItems: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const captureBtn = new ButtonBuilder()
    .setCustomId(
      buildCustomId(
        'enc',
        'capture',
        String(encounter.id),
        String(encounter.attemptCount),
      ),
    )
    .setLabel(selected ? `Capture with ${selected.item.name}` : 'Capture')
    .setEmoji('💘')
    .setStyle(ButtonStyle.Success)
    .setDisabled(selected == null);

  const pickBtn = new ButtonBuilder()
    .setCustomId(buildCustomId('enc', 'pick', String(encounter.id)))
    .setLabel(selected ? 'Change Item' : 'Use Item')
    .setEmoji('🎒')
    .setStyle(selected ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(!hasEligibleItems);

  const letGo = new ButtonBuilder()
    .setCustomId(buildCustomId('enc', 'release', String(encounter.id)))
    .setLabel('Let Her Go')
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(captureBtn, pickBtn, letGo),
  ];
}

/**
 * The item selector: only capture items the player *owns* and that are
 * *eligible* against this encounter's rarity. Both filters come from the
 * capture service, so the menu can never offer something the authoritative
 * commit would then refuse.
 *
 * Each option carries the resulting chance, because that is the whole decision
 * the player is making — and the number is the service's, not this file's.
 */
function itemSelectRow(
  encounter: EncounterRow,
  options: ReadonlyArray<{ item: ItemRow; quantity: number; quote: CaptureQuote }>,
  selectedItemId: number | null,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('enc', 'pick_item', String(encounter.id)))
    .setPlaceholder('Choose a capture item…')
    .addOptions(
      // Discord caps a select at 25 options; the capture catalog is far
      // smaller, but the slice keeps a future content explosion safe.
      options.slice(0, 25).map((entry) => ({
        label: `${entry.item.name} ×${entry.quantity}`.slice(0, 100),
        value: entry.item.slug,
        description: (entry.quote.guaranteed
          ? 'Guaranteed capture'
          : `Capture chance: ${formatChance(entry.quote.chance)}`
        ).slice(0, 100),
        ...(entry.item.emoji ? { emoji: entry.item.emoji } : {}),
        default: entry.item.id === selectedItemId,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * Raw artwork for a species, as her default appearance.
 *
 * Used where there is no owned copy yet — the encounter reveal, and the escape
 * and resist outcomes. Goes through the appearance service and the shared
 * resolver like every other surface; it used to read `species.imagePath` off
 * the filesystem directly, which was a second artwork-resolution path that knew
 * nothing about appearances or their fallbacks.
 */
function attachSpeciesArtwork(ctx: AppContext, species: SpeciesRow): AttachmentBuilder | null {
  const appearance = ctx.services.appearance.currentAppearance(species, null);
  return resolveAppearanceAssetOrPath(ctx, appearance.assetId, species.imagePath);
}

type EncounterRowComponent =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

interface EncounterView {
  embeds: EmbedBuilder[];
  components: EncounterRowComponent[];
  files: AttachmentBuilder[];
}

interface EncounterViewOptions {
  energyRemaining?: number;
  /** Render the item selector open (the Use Item / Change Item click). */
  showSelector?: boolean;
  /** Status line above the fields, e.g. after a selection changed. */
  statusLine?: string;
}

async function buildEncounterView(
  ctx: AppContext,
  prov: Provisioned,
  encounter: EncounterRow,
  species: SpeciesRow,
  options: EncounterViewOptions = {},
): Promise<EncounterView> {
  const { energyRemaining, showSelector = false, statusLine } = options;
  // Eligible items and the selected-item quote both come from the capture
  // service, so this screen never does capture math of its own.
  const eligible = await ctx.services.capture.listEligibleCaptureItems(
    prov.playerId,
    encounter.id,
  );
  const selectedEntry =
    encounter.selectedItemId != null
      ? (eligible.find((e) => e.item.id === encounter.selectedItemId) ?? null)
      : null;

  // Affinity read (5D): only meaningful with an active buddy. Read-only here —
  // the authoritative resolution happens inside the capture transaction.
  const buddy = await ctx.services.collection.getBuddy(prov.playerId);
  const affinityRead = buddy
    ? formatAffinityRead(
        resolveBuddyAffinity(
          {
            buddyAffinity: buddy.species.affinity,
            buddyRarity: buddy.species.rarity as Rarity,
            encounterAffinity: species.affinity,
          },
          ctx.content.tables.buddyAffinity,
        ),
      )
    : null;

  const prompt = selectedEntry
    ? 'Capture, change your item, or Let Her Go.'
    : eligible.length > 0
      ? 'Pick an item to try with, or Let Her Go.'
      : 'You have nothing that works on her~ Let Her Go, or restock.';
  const footer =
    energyRemaining != null ? `${prompt} · Energy left: ${energyRemaining}` : prompt;

  const description = [statusLine, species.description || '_A mysterious presence…_']
    .filter(Boolean)
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(`✨ A wild ${species.name} appears!`)
    .setColor(rarityColor(species.rarity))
    .setDescription(description)
    .addFields(
      { name: 'Rarity', value: species.rarity, inline: true },
      { name: 'Archetype', value: species.archetype, inline: true },
      { name: 'Affinity', value: affinityLabel(species.affinity), inline: true },
      {
        name: 'Time',
        value: `Expires <t:${Math.floor(encounter.expiresAt.getTime() / 1000)}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: footer });
  if (affinityRead) {
    embed.addFields({ name: '🤝 Buddy', value: affinityRead, inline: false });
  }

  // Active consumable buff (Microdose): show the bonus and charges *before*
  // the player commits a charm, so the decision is informed.
  const captureBonus = await ctx.services.effects.getCaptureBonus(prov.playerId);
  if (captureBonus) {
    const meta = ctx.content.items.find((i) => i.slug === captureBonus.sourceItemSlug);
    const line = renderCaptureBonusLine(captureBonus, meta?.name, meta?.emoji ?? null);
    if (line) embed.addFields({ name: '⏳ Active Effect', value: line, inline: false });
  }

  // The chosen item and what it does to her odds — the "6% → 21%" line. Both
  // numbers come from one `CaptureQuote`, which is the same computation the
  // commit will run, so the screen can never promise odds the server won't use.
  if (selectedEntry) {
    const { quote } = selectedEntry;
    const value = quote.guaranteed
      ? 'Capture chance: **Guaranteed**'
      : `Capture chance: **${formatChance(quote.baselineChance)} → ${formatChance(quote.chance)}**`;
    embed.addFields({
      name: `${selectedEntry.item.emoji ?? '•'} ${selectedEntry.item.name} selected`,
      value: `${value}\nOwned: ×${selectedEntry.quantity} · consumed only when you capture.`,
      inline: false,
    });
  }

  const files: AttachmentBuilder[] = [];
  // Pre-catch duplicate warning: if the player already owns ≥1 active copy of
  // this species, reveal her card with the CAUGHT badge composited. Every
  // failure falls back to raw artwork, so the encounter never fails to reveal.
  const ownsAlready = await ctx.services.collection.hasActiveSpeciesCopy(
    prov.playerId,
    species.id,
  );
  const duplicateCard = ownsAlready
    ? await renderEncounterDuplicateCardAttachment(ctx, species)
    : null;
  if (duplicateCard) {
    files.push(duplicateCard.file);
    embed.setImage(duplicateCard.url);
  } else {
    const attach = attachSpeciesArtwork(ctx, species);
    if (attach) {
      files.push(attach);
      embed.setImage(`attachment://${CARD_FILENAME}`);
    }
  }
  const components: EncounterRowComponent[] = [];
  if (showSelector && eligible.length > 0) {
    components.push(itemSelectRow(encounter, eligible, encounter.selectedItemId));
  }
  components.push(
    ...encounterButtonRows(
      encounter,
      selectedEntry
        ? { item: selectedEntry.item, quantity: selectedEntry.quantity }
        : null,
      eligible.length > 0,
    ),
  );
  return { embeds: [embed], components, files };
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
    await respondEphemeral(interaction, 'Hunts need a channel context.');
    return;
  }
  try {
    const result = await ctx.services.hunt.hunt(prov.playerId, channelId);
    // Record hunt + any find/level-up into the daily summary board.
    const session = await ctx.services.session.ensureSession(
      prov.guildDbId,
      prov.playerId,
      channelId,
    );
    await ctx.services.session.recordEvent(session.id, { type: 'hunt' });
    for (const lu of result.levelUps) {
      await ctx.services.session.recordEvent(session.id, {
        type: 'levelup',
        toLevel: lu.toLevel,
      });
    }
    if (result.buddyAward && (result.buddyAward.xpGranted > 0 || result.buddyAward.affectionGranted > 0)) {
      await ctx.services.session.recordEvent(session.id, {
        type: 'buddy',
        xp: result.buddyAward.xpGranted,
        affection: result.buddyAward.affectionGranted,
      });
    }
    if (result.kind === 'rare_item_find') {
      await ctx.services.session.recordEvent(session.id, {
        type: 'find',
        find: { kind: 'item', label: `${result.item.name} ×${result.quantity}` },
      });
    } else if (result.kind === 'waifubux_find') {
      await ctx.services.session.recordEvent(session.id, {
        type: 'find',
        find: { kind: 'waifubux', label: `+${result.amount} WB` },
      });
    } else if (result.kind === 'essence_find') {
      await ctx.services.session.recordEvent(session.id, {
        type: 'find',
        find: { kind: 'essence', label: `+${result.amount} Essence` },
      });
    }

    // Post-commit narration. Built before painting (the tracker mutation is
    // cheap and synchronous) and emitted after, so a slow Activity Feed post
    // never delays the player's own screen.
    const events = await huntDescriptors(ctx, prov, result);

    if (result.kind === 'encounter') {
      const view = await buildEncounterView(ctx, prov, result.encounter, result.species, {
        energyRemaining: result.energyRemaining,
      });
      // Encounter reveal has its own actions (charms + Let Her Go); no Back.
      await respondEphemeral(interaction, view);
      await emitEvents(ctx, interaction, prov, events);
      await postBuddyAppearanceToasts(ctx, interaction, result, prov.playerId);
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
    if (result.levelUps.length) {
      const lu = result.levelUps
        .map((l) => `⬆️ **Level ${l.toLevel}!**${l.rewardLabels.length ? ` — ${l.rewardLabels.join(', ')}` : ''}`)
        .join('\n');
      embed.setDescription(`${embed.data.description ?? ''}\n\n${lu}`.trim());
    }
    embed.setFooter({ text: `Energy left: ${result.energyRemaining}` });
    await respondEphemeral(interaction, {
      embeds: [embed],
      components: withBackRow([huntAgainRow()]),
    });
    await emitEvents(ctx, interaction, prov, events);
  } catch (err) {
    if (err instanceof ActiveEncounterError) {
      const active = await ctx.services.hunt.getActiveEncounter(prov.playerId);
      if (active) {
        const species = await loadSpeciesById(ctx, active.speciesId);
        if (species) {
          const view = await buildEncounterView(ctx, prov, active, species);
          await respondEphemeral(interaction, view);
          return;
        }
      }
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    if (err instanceof HuntCooldownError || err instanceof InsufficientEnergyError) {
      await respondEphemeral(interaction, err.userMessage);
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

async function sendRareAnnouncement(
  ctx: AppContext,
  interaction: ButtonInteraction,
  species: SpeciesRow,
  userMention: string,
  isDuplicate: boolean,
  newWaifu: CaptureAttemptResult['newWaifu'],
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
  // The announcement follows a successful capture, so the copy exists and the
  // collectible card is the honest thing to show off. Falls back to artwork
  // when rendering is off or fails.
  const owned = newWaifu ? await renderOwnedCardAttachment(ctx, { waifu: newWaifu, species }) : null;
  const artwork = owned ? null : attachSpeciesArtwork(ctx, species);
  const card = owned?.file ?? artwork;
  const files = card ? [card] : [];
  if (card) embed.setImage(owned ? owned.url : `attachment://${CARD_FILENAME}`);

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

/**
 * Controls after a failed attempt. She is still there and the selection
 * survived, so "Try Again" is one click — and it carries the *new*
 * `attempt_count`, so the button that just fired is now stale and a
 * double-click cannot spend a second item.
 */
function retryButtonRows(
  encounter: EncounterRow,
  item: ItemRow,
  ownedRemaining: number,
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (ownedRemaining > 0) {
    const label = item.isGuaranteedCapture
      ? `Try Again — ${item.name} ×${ownedRemaining} (guaranteed)`
      : `Try Again — ${item.name} ×${ownedRemaining}`;
    const btn = new ButtonBuilder()
      .setCustomId(
        buildCustomId(
          'enc',
          'capture',
          String(encounter.id),
          String(encounter.attemptCount),
        ),
      )
      .setLabel(label)
      .setStyle(ButtonStyle.Success);
    if (item.emoji) btn.setEmoji(item.emoji);
    buttons.push(btn);
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(buildCustomId('enc', 'pick', String(encounter.id)))
      .setLabel('Change Item')
      .setEmoji('🎒')
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

/**
 * The capture outcome embed.
 *
 * A **successful** capture shows her rendered card at her fresh level and
 * default look. The CAUGHT emblem is a *pre-catch* duplicate warning drawn on
 * the encounter reveal, so it deliberately does not appear here — the catch
 * has already happened, and the warning has already served its purpose.
 * Escapes and resists keep the raw artwork — there is no copy to render a
 * card for.
 *
 * The card is best-effort. When rendering is switched off, or fails, this falls
 * back to the same artwork the failure paths use, and the player sees a capture
 * result either way.
 */
export async function buildEphemeralOutcomeMessage(
  ctx: AppContext,
  result: CaptureAttemptResult,
): Promise<InteractionEditReplyOptions> {
  const { outcome, species, item, isDuplicate, attempt, attemptsRemaining, newWaifu } = result;
  const embed = new EmbedBuilder().setColor(rarityColor(species.rarity));

  const owned =
    outcome === 'success' && newWaifu
      ? await renderOwnedCardAttachment(ctx, { waifu: newWaifu, species })
      : null;

  const artwork = owned ? null : attachSpeciesArtwork(ctx, species);
  const attachName = owned ? owned.url : `attachment://${CARD_FILENAME}`;
  const card = owned?.file ?? artwork;
  const files = card ? [card] : [];

  if (outcome === 'success') {
    const dupNote = isDuplicate
      ? "\n\n_You already have her! Choose to **Keep** her or **Convert** the copy to Essence._"
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
  // Buddy affinity (5D) — show what the buddy actually contributed to this
  // attempt's chance. Guaranteed captures bypass the formula, so no bonus line.
  if (result.affinity.buddyWaifuId != null && !attempt.guaranteed) {
    const { matchup, buddyAffinity, encounterAffinity, buddyAffinityModifier } = result.affinity;
    const detail =
      matchup === 'strong'
        ? `${formatAffinityBonus(buddyAffinityModifier)} — ${affinityLabel(buddyAffinity)} beats ${affinityLabel(encounterAffinity)}`
        : matchup === 'weak'
          ? 'unfavorable matchup — no bonus'
          : `${formatAffinityBonus(buddyAffinityModifier)} — no clear advantage`;
    embed.addFields({
      name: '🤝 Buddy Bonus',
      value: `${detail}\nCapture chance: **${formatChancePercent(result.affinity.finalChance)}**`,
      inline: false,
    });
  }
  // Consumable capture buff: report the bonus that was applied, the charge
  // just spent, and what's left (or that the buff has now ended).
  if (result.effect) {
    const { sourceItemSlug, captureBonusModifier, chargesRemaining, cleared } = result.effect;
    const meta = ctx.content.items.find((i) => i.slug === sourceItemSlug);
    const name = meta?.name ?? sourceItemSlug;
    const tail = cleared
      ? 'last charge spent — the effect has worn off.'
      : `**${chargesRemaining}** charge${chargesRemaining === 1 ? '' : 's'} left.`;
    embed.addFields({
      name: `${meta?.emoji ?? '💊'} ${name}`,
      value:
        `${formatCaptureBonus(captureBonusModifier)} capture chance applied · 1 charge used — ${tail}\n` +
        `Capture chance: **${formatChancePercent(result.affinity.finalChance)}**`,
      inline: false,
    });
  }
  if (result.xpGranted > 0 || result.levelUps.length > 0) {
    const xpLine = result.xpGranted > 0
      ? `+${result.xpGranted} XP${result.isNewDex ? ' (incl. new dex)' : ''}`
      : '';
    const luLine = result.levelUps
      .map((l) => `⬆️ **Level ${l.toLevel}!**${l.rewardLabels.length ? ` — ${l.rewardLabels.join(', ')}` : ''}`)
      .join('\n');
    const suffix = [xpLine, luLine].filter(Boolean).join('\n');
    embed.setDescription(`${embed.data.description ?? ''}\n\n${suffix}`.trim());
  }
  // Duplicate captures get an inline Keep / Convert-to-Essence row so the
  // player can resolve the dup right away without a second slash command.
  // (Timeout defaults to Keep — the row already exists in the DB.)
  if (outcome === 'success' && isDuplicate && newWaifu) {
    const essenceValue =
      (ctx.content.tables.duplicate.essenceByRarity as Record<string, number>)[species.rarity] ?? 0;
    return {
      embeds: [embed],
      components: [duplicatePromptComponents(newWaifu.id, essenceValue), ...withBackRow()],
      files,
    };
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
): Promise<InteractionEditReplyOptions> {
  const base = await buildEphemeralOutcomeMessage(ctx, result);
  const owned = await ctx.services.inventory.getQuantity(prov.playerId, result.item.id);
  return {
    ...base,
    components: retryButtonRows(result.encounter, result.item, owned),
  };
}

/**
 * Capture click — the authoritative commit.
 *
 * `args` is `[encounterId, expectedAttemptCount]`. The item is deliberately
 * *not* in the custom id: the service reads the encounter's own selection
 * under its row lock, so the button cannot assert an item the player never
 * chose. The attempt count is the stale-click guard.
 */
export async function handleEncounterCapture(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  const expectedAttemptCount = Number(args[1]);
  if (!Number.isInteger(encounterId) || !Number.isInteger(expectedAttemptCount)) {
    await respondEphemeral(interaction, 'That button no longer works.');
    return;
  }

  await interaction.deferUpdate();

  let result: CaptureAttemptResult;
  try {
    result = await ctx.services.capture.attemptCapture(prov.playerId, encounterId, null, {
      expectedAttemptCount,
    });
  } catch (err) {
    const message = translateCaptureError(err);
    // Non-fatal capture rejections (already resolved, expired, out of items)
    // answer ephemerally so the player's current screen stays put.
    await respondEphemeral(interaction, message);
    return;
  }

  // Record capture/escape into the session summary board. Level-ups too.
  const channelId = interaction.channelId;
  if (channelId) {
    const session = await ctx.services.session.ensureSession(
      prov.guildDbId,
      prov.playerId,
      channelId,
    );
    if (result.outcome === 'success') {
      await ctx.services.session.recordEvent(session.id, {
        type: 'capture',
        speciesName: result.species.name,
        rarity: result.species.rarity,
      });
    } else if (result.outcome === 'escape') {
      await ctx.services.session.recordEvent(session.id, {
        type: 'escape',
        speciesName: result.species.name,
      });
    }
    for (const lu of result.levelUps) {
      await ctx.services.session.recordEvent(session.id, {
        type: 'levelup',
        toLevel: lu.toLevel,
      });
    }
  }

  // Rare capture announcement (SR+): fire once on success only. This is the
  // *separate* public announcement — the only public write on this path — and still uses
  // the guild-configured announce channel with safe allowedMentions.
  if (result.outcome === 'success') {
    await sendRareAnnouncement(
      ctx,
      interaction,
      result.species,
      `<@${interaction.user.id}>`,
      result.isDuplicate,
      result.newWaifu,
    );
  }

  // Paint the outcome (success / escape / failure) into the player's ephemeral.
  const reply =
    result.outcome === 'failure'
      ? await buildFailureRetryReply(ctx, prov, result)
      : await buildEphemeralOutcomeMessage(ctx, result);
  await respondEphemeral(interaction, reply as unknown as SessionPayload);

  // Post-commit narration. The rare-embed path above already ran; the
  // Activity Feed suppresses SR+ successes so there is exactly one public
  // announcement per rare catch.
  await emitEvents(ctx, interaction, prov, await captureDescriptors(ctx, prov, result));

  // Cosmetics a brand-new copy already qualifies for. Normally empty (her
  // default look is acknowledged silently), so this is free on the common path.
  if (result.newAppearances.length > 0) {
    await postAppearanceUnlockToasts(
      ctx,
      interaction,
      result.newAppearances,
      result.species.name,
      prov.playerId,
    );
  }
}

/**
 * Buddy-earned cosmetics from one hunt. The buddy's display name is taken from
 * the award the hunt already returned, so no extra query is spent on a toast.
 */
async function postBuddyAppearanceToasts(
  ctx: AppContext,
  interaction: PlayerInteraction,
  result: HuntResult,
  playerId: number,
): Promise<void> {
  const award = result.buddyAward;
  if (!award || award.newAppearances.length === 0) return;
  const name = award.waifu.nickname?.trim() || 'Your buddy';
  await postAppearanceUnlockToasts(ctx, interaction, award.newAppearances, name, playerId);
}

/**
 * Use Item / Change Item — repaints the encounter with the selector open and
 * quantities refreshed. Selects nothing and consumes nothing.
 */
export async function handleEncounterPick(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  if (!Number.isInteger(encounterId)) {
    await respondEphemeral(interaction, 'That encounter is no longer active.');
    return;
  }
  const active = await ctx.services.hunt.getActiveEncounter(prov.playerId);
  if (!active || active.id !== encounterId) {
    await respondEphemeral(interaction, 'That encounter is no longer active.');
    return;
  }
  const speciesRow = await loadSpeciesById(ctx, active.speciesId);
  if (!speciesRow) {
    await respondEphemeral(interaction, 'That encounter is no longer active.');
    return;
  }
  const view = await buildEncounterView(ctx, prov, active, speciesRow, {
    showSelector: true,
  });
  await respondEphemeral(interaction, view);
}

/**
 * A capture item was chosen from the selector.
 *
 * Nothing is consumed — the selection is persisted on the encounter and the
 * screen repaints with the new odds and a Capture button. Changing the choice
 * (or walking away) costs the player nothing, which is the entire point of
 * separating selection from commitment.
 */
export async function handleEncounterPickItem(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  const itemSlug = interaction.values[0];
  if (!Number.isInteger(encounterId) || !itemSlug) {
    await respondEphemeral(interaction, 'That encounter is no longer active.');
    return;
  }

  let quote: CaptureQuote;
  try {
    quote = await ctx.services.capture.selectCaptureItem(
      prov.playerId,
      encounterId,
      itemSlug,
    );
  } catch (err) {
    await respondEphemeral(interaction, translateCaptureError(err));
    return;
  }

  const statusLine = quote.guaranteed
    ? `**${quote.item?.name ?? 'Item'} selected**\nCapture chance: **Guaranteed**`
    : `**${quote.item?.name ?? 'Item'} selected**\nCapture chance: ` +
      `**${formatChance(quote.baselineChance)} → ${formatChance(quote.chance)}**`;

  const view = await buildEncounterView(ctx, prov, quote.encounter, quote.species, {
    statusLine,
  });
  await respondEphemeral(interaction, view);
}

/** Let Her Go — pre or post-attempt. Session board is the sole surface. */
export async function handleEncounterRelease(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const encounterId = Number(args[0]);
  if (!Number.isInteger(encounterId)) {
    await respondEphemeral(interaction, 'That encounter is no longer active.');
    return;
  }
  try {
    await ctx.services.hunt.letHerGo(prov.playerId, encounterId);
  } catch (err) {
    if (err instanceof EncounterNotFoundError) {
      await respondEphemeral(interaction, err.userMessage);
      return;
    }
    throw err;
  }

  await respondEphemeral(interaction, {
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
  if (err instanceof EncounterStaleError) return err.userMessage;
  if (err instanceof NoCaptureItemSelectedError) return err.userMessage;
  if (err instanceof CaptureItemNotEligibleError) return err.userMessage;
  if (err instanceof InsufficientItemsError) {
    return "You don't have any of that~ Try a different one.";
  }
  if (err instanceof ItemNotFoundError) return err.userMessage;
  if (err instanceof ItemNotUsableError) return err.userMessage;
  if (err instanceof AppError) return err.userMessage;
  throw err;
}
