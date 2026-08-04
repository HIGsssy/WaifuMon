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
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type InteractionEditReplyOptions,
} from 'discord.js';
import {
  species as speciesTable,
  type EncounterRow,
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
import { respondEphemeral, type SessionPayload } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import { captureDescriptors, huntDescriptors } from '../gameEventBuilders';
import { withBackRow } from '../ui';
import { formatCaptureBonus, renderCaptureBonusLine } from './waifumon';
import { duplicatePromptComponents } from './waifumonCollection';

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

/** 0.525 → "52.5%" — used next to the buddy-bonus line on capture results. */
function formatChancePercent(chance: number): string {
  const pct = Math.round(chance * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
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
      const view = await buildEncounterView(
        ctx,
        prov,
        result.encounter,
        result.species,
        result.energyRemaining,
      );
      // Encounter reveal has its own actions (charms + Let Her Go); no Back.
      await respondEphemeral(interaction, view);
      await emitEvents(ctx, interaction, prov, events);
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

function findItemContent(ctx: AppContext, slug: string): ItemContent | undefined {
  return ctx.content.items.find((i) => i.slug === slug);
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
): InteractionEditReplyOptions {
  const { outcome, species, item, isDuplicate, attempt, attemptsRemaining, newWaifu } = result;
  const embed = new EmbedBuilder().setColor(rarityColor(species.rarity));
  const attachName = `attachment://${CARD_FILENAME}`;
  const card = attachCard(ctx, species);
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
  const base = buildEphemeralOutcomeMessage(ctx, result);
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
    await respondEphemeral(interaction, 'That button no longer works.');
    return;
  }

  await interaction.deferUpdate();

  let result: CaptureAttemptResult;
  try {
    result = await ctx.services.capture.attemptCapture(prov.playerId, encounterId, itemSlug);
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
    );
  }

  // Paint the outcome (success / escape / failure) into the player's ephemeral.
  const reply =
    result.outcome === 'failure'
      ? await buildFailureRetryReply(ctx, prov, result)
      : buildEphemeralOutcomeMessage(ctx, result);
  await respondEphemeral(interaction, reply as unknown as SessionPayload);

  // Post-commit narration. The rare-embed path above already ran; the
  // Activity Feed suppresses SR+ successes so there is exactly one public
  // announcement per rare catch.
  await emitEvents(ctx, interaction, prov, await captureDescriptors(ctx, prov, result));
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
  const view = await buildEncounterView(ctx, prov, active, speciesRow);
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
  if (err instanceof InsufficientItemsError) {
    return "You don't have any of that charm~ Try a different one.";
  }
  if (err instanceof ItemNotFoundError) return err.userMessage;
  if (err instanceof ItemNotUsableError) return err.userMessage;
  if (err instanceof AppError) return err.userMessage;
  throw err;
}
