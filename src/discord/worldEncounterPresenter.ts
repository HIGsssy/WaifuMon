/**
 * World encounter presenter — the one place that turns an
 * `EncounterActivation` into a Discord embed + button rows.
 *
 * Discord-independent code stops at the {@link WorldEncounterService};
 * anything that touches `EmbedBuilder`, attachments, or the `enc-world:*`
 * custom id scheme lives here so the engine has no opinion on presentation.
 *
 * Custom id scheme: `wm|v1|encw|<action>|<activeId>|<choiceId?>`
 *   • `encw:choose`  — a choice button
 *   • `encw:abandon` — future support; not wired today
 *
 * Attachment filename is derived from the encounter slug (kebab-safe) so the
 * embed's image ref is always predictable.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { resolveAssetPath } from '../modules/content/loader';
import { buildCustomId } from './types';
import type { AppContext } from './types';
import type { SessionPayload } from './ephemeralSession';
import type { ChoiceView, EncounterActivation, Resolution } from '../modules/worldEncounters/worldEncounterService';

/** Discord button rows cap at 5 buttons each. */
const BUTTONS_PER_ROW = 5;
/** Total encounter choices we render. Extra choices are truncated. */
const MAX_CHOICES = 10;

/** Sanitise the slug into a safe attachment filename. */
export function encounterArtworkFilename(slug: string): string {
  return `${slug.replace(/[^a-z0-9_]/g, '_')}.png`;
}

/**
 * Best-effort artwork resolution, mirroring {@link resolveBossArtwork}: the
 * relative path from the definition is confined to `ASSETS_DIR`, and a
 * missing file drops the attachment rather than failing the render.
 */
function resolveEncounterArtwork(
  ctx: AppContext,
  slug: string,
  relative: string | null,
): { file: AttachmentBuilder; url: string } | null {
  if (!relative) return null;
  try {
    const absolute = resolveAssetPath(ctx.config.assetsDir, relative);
    if (!fs.existsSync(absolute)) {
      ctx.logger.warn(
        { tag: 'world-encounter/artwork-missing', slug, artwork: relative },
        'world encounter artwork missing at post time — rendering text-only',
      );
      return null;
    }
    const filename = encounterArtworkFilename(slug);
    return {
      file: new AttachmentBuilder(absolute, { name: filename }),
      url: `attachment://${filename}`,
    };
  } catch (err) {
    ctx.logger.error(
      { tag: 'world-encounter/artwork-unsafe', slug, artwork: relative, err },
      'world encounter artwork path rejected — rendering text-only',
    );
    return null;
  }
}

const RARITY_COLOR: Record<string, number> = {
  common: 0x9ca3af,
  uncommon: 0x22c55e,
  rare: 0x3b82f6,
  mythic: 0xa855f7,
};

const TYPE_LABEL: Record<string, string> = {
  decision: 'Decision',
  skill_check: 'Skill Check',
  combat: 'Combat',
  vendor: 'Vendor',
  deity: 'Deity',
  discovery: 'Discovery',
};

/** Build the "encounter appears" screen. */
export function buildEncounterPresent(
  ctx: AppContext,
  activation: EncounterActivation,
): SessionPayload {
  const { encounter, buddy, buddyBonusPercent, choiceViews } = activation;
  const embed = new EmbedBuilder()
    .setTitle(`${TYPE_LABEL[encounter.type] ?? encounter.type} — ${encounter.name}`)
    .setColor(RARITY_COLOR[encounter.rarity] ?? 0x9ca3af)
    .setDescription(encounter.description || '*(no description)*');

  const buddyLine = buddy
    ? `**${buddy.speciesName}** · lvl ${buddy.level} · SP ${buddy.currentSp} · ${buddy.affinity}`
    : 'No buddy equipped — SP checks will fail more often.';
  const bonusLine =
    buddyBonusPercent > 0 ? `\nBuddy Bonus: +${buddyBonusPercent.toFixed(1)}%` : '';
  embed.addFields({ name: 'Buddy', value: buddyLine + bonusLine, inline: false });

  const artwork = resolveEncounterArtwork(ctx, encounter.slug, encounter.artworkPath);
  const files: AttachmentBuilder[] = [];
  if (artwork) {
    embed.setImage(artwork.url);
    files.push(artwork.file);
  }

  const rows = buildChoiceRows(activation.activeId, choiceViews);
  return { embeds: [embed], components: rows, files };
}

/** Build the resolution screen: the outcome of the choice the player picked. */
export function buildEncounterResolved(
  ctx: AppContext,
  activation: EncounterActivation,
  resolution: Resolution,
): SessionPayload {
  const { encounter } = activation;
  const embed = new EmbedBuilder()
    .setTitle(`${encounter.name}`)
    .setColor(RARITY_COLOR[encounter.rarity] ?? 0x9ca3af)
    .setDescription(encounter.description || '*(no description)*');

  const choiceLine = `**Chose:** ${resolution.choice.label}`;
  const outcomeLine =
    resolution.check.chance >= 1
      ? '**Outcome:** Auto-resolved'
      : `**Outcome:** ${resolution.check.success ? '✅ Success' : '❌ Failure'} (${(resolution.check.chance * 100).toFixed(1)}% chance)`;

  embed.addFields({ name: 'Result', value: `${choiceLine}\n${outcomeLine}`, inline: false });

  const effects = resolution.effectsApplied
    .map(formatAppliedEffect)
    .filter((s): s is string => s != null);
  if (effects.length > 0) {
    embed.addFields({ name: 'Effects', value: effects.join('\n'), inline: false });
  }

  if (resolution.followUps.length > 0) {
    const followLines = resolution.followUps.map(formatFollowUp);
    embed.addFields({ name: 'What follows', value: followLines.join('\n'), inline: false });
  }

  const artwork = resolveEncounterArtwork(ctx, encounter.slug, encounter.artworkPath);
  const files: AttachmentBuilder[] = [];
  if (artwork) {
    embed.setImage(artwork.url);
    files.push(artwork.file);
  }

  // Continue / Vendor row: when the resolution opened a chained encounter,
  // add the Continue button. When it opened a vendor, add an "Open shop"
  // button that repaints as the vendor UI on click. Both buttons carry only
  // the active row id; every state check is server-side.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const followRow = new ActionRowBuilder<ButtonBuilder>();
  if (resolution.continuationActiveId != null) {
    followRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('encw', 'continue', String(resolution.continuationActiveId)))
        .setLabel('Continue →')
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (resolution.vendorInstance) {
    followRow.addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildCustomId('encv', 'open', String(activation.activeId)),
        )
        .setLabel('🛒 Open shop')
        .setStyle(ButtonStyle.Success),
    );
  }
  if (followRow.components.length > 0) rows.push(followRow);

  return { embeds: [embed], components: rows, files };
}

function buildChoiceRows(
  activeId: number,
  views: ChoiceView[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const trimmed = views.slice(0, MAX_CHOICES);
  for (let i = 0; i < trimmed.length; i += BUTTONS_PER_ROW) {
    const chunk = trimmed.slice(i, i + BUTTONS_PER_ROW);
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const view of chunk) {
      const button = new ButtonBuilder()
        .setCustomId(buildCustomId('encw', 'choose', String(activeId), String(view.choice.id)))
        .setLabel(view.choice.label.slice(0, 80))
        .setStyle(view.available ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!view.available);
      if (view.choice.emoji) {
        try {
          button.setEmoji(view.choice.emoji);
        } catch {
          // Ignore invalid emoji; Discord rejects some raw strings.
        }
      }
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

function formatAppliedEffect(entry: {
  effect: import('../modules/worldEncounters/types').Effect;
  applied: boolean;
  amount?: number;
  reason?: string;
}): string | null {
  const e = entry.effect;
  const amount = entry.amount;
  switch (e.type) {
    case 'waifubux_gain':
      return `+${amount ?? e.amount} Waifubux`;
    case 'waifubux_loss':
    case 'waifubux_loss_percent':
      return amount && amount > 0 ? `−${amount} Waifubux` : null;
    case 'essence_gain':
      return `+${amount ?? e.amount} Essence`;
    case 'essence_loss':
      return amount && amount > 0 ? `−${amount} Essence` : null;
    case 'energy_gain':
      return `+${amount ?? e.amount} Energy`;
    case 'energy_loss':
      return amount && amount > 0 ? `−${amount} Energy` : null;
    case 'player_xp':
      return `+${amount ?? e.amount} Player XP`;
    case 'buddy_xp':
      return amount && amount > 0 ? `+${amount} Buddy XP` : null;
    case 'give_item':
      return `Received ${e.quantity} × ${e.slug}`;
    case 'consume_item':
      return entry.applied ? `Used ${e.quantity} × ${e.slug}` : null;
    case 'temp_buff':
      return `Blessing: ${e.key}`;
    case 'trigger_encounter':
    case 'trigger_waifumon_encounter':
    case 'open_vendor':
      return null; // rendered under "What follows"
  }
}

function formatFollowUp(f: { kind: string; payload: Record<string, unknown> }): string {
  switch (f.kind) {
    case 'trigger_encounter':
      return `Another encounter awaits: ${String(f.payload.encounterSlug ?? '')}`;
    case 'trigger_waifumon_encounter':
      return f.payload.speciesSlug
        ? `A wild ${String(f.payload.speciesSlug)} appears…`
        : 'A wild waifumon appears…';
    case 'open_vendor':
      return `A vendor opens their wares: ${String(f.payload.vendorKey ?? '')}`;
    default:
      return f.kind;
  }
}

// Silence unused-import warnings if resolveAssetPath is unused when TS
// tree-shakes the resolver — the import above is load-bearing at runtime.
void path;
