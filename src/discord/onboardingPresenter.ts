/**
 * Equipment onboarding screens and the read-only Equipment overview.
 *
 * Pure builders: a view model from `EquipmentOnboardingService` in, an
 * ephemeral payload out. Styled like a World Encounter (narration, the NPC's
 * line, an item card) without being one.
 *
 * Copy comes from `content/onboarding/equipment.json`; every number comes from
 * the `CombatStats` the service handed over. Nothing here multiplies SP — the
 * explanation's `SP × multiplier = value` lines show the calculation the
 * combat-stat service already made, using its own Current SP and result.
 *
 * Custom ids (`onb` scope, flow name first so a later flow can share it):
 *   onb|open|equipment             — menu Begin/Resume
 *   onb|adv|equipment|<fromStep>   — a step's button
 *   onb|done|equipment             — "Gear up" (the completion)
 *   onb|view|equipment             — menu Equipment, once unlocked (opens the
 *                                    management home, `waifumonEquipment.ts`)
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { EquipmentOnboardingContent, NpcContent } from '../modules/content/onboardingSchemas';
import type { CombatStats, CombatSlotItem } from '../modules/equipment/equipmentMath';
import type { EquipmentSlot } from '../modules/equipment/vocabulary';
import type {
  EquipmentOnboardingView,
  StarterItemView,
} from '../modules/onboarding/equipmentOnboardingService';
import type { OnboardingEquipResult } from '../modules/equipment/equipmentService';
import {
  EQUIPMENT_ONBOARDING_FLOW,
  STARTER_SLOTS,
  type EquipmentOnboardingStep,
} from '../modules/onboarding/vocabulary';
import { resolveArtworkAttachment } from './assets/resolveArtworkAttachment';
import { buildEquipmentHome, type BuddyArtwork } from './equipmentPresenter';
import type { SessionPayload } from './ephemeralSession';
import { buildCustomId, type AppContext } from './types';

/** Rust-orange: Patch's scrapyard. */
const ONBOARDING_COLOR = 0xb4643c;

export const SLOT_EMOJI: Readonly<Record<EquipmentSlot, string>> = { attack: '⚔️', defense: '🛡️', health: '❤️' };
export const SLOT_GEAR_LABEL: Readonly<Record<EquipmentSlot, string>> = {
  attack: 'Attack Gear',
  defense: 'Defense Gear',
  health: 'Health Gear',
};
const SLOT_STAT: Readonly<Record<EquipmentSlot, { key: 'attack' | 'defense' | 'maxHp'; label: string }>> = {
  attack: { key: 'attack', label: 'ATK' },
  defense: { key: 'defense', label: 'DEF' },
  health: { key: 'maxHp', label: 'HP' },
};

const UNAVAILABLE_FALLBACK = 'Equipment training isn’t available right now.';

/** `4500` → `×0.45`. */
export function formatMultiplier(bp: number): string {
  return `×${(bp / 10_000).toFixed(2)}`;
}

export function onboardingCustomId(action: 'open' | 'done' | 'view'): string;
export function onboardingCustomId(action: 'adv', fromStep: EquipmentOnboardingStep): string;
export function onboardingCustomId(action: 'open' | 'adv' | 'done' | 'view', fromStep?: EquipmentOnboardingStep): string {
  return fromStep
    ? buildCustomId('onb', action, EQUIPMENT_ONBOARDING_FLOW, fromStep)
    : buildCustomId('onb', action, EQUIPMENT_ONBOARDING_FLOW);
}

/** The explanation line for one slot, e.g. `280 × 0.45 = 126 ATK`. Null stat renders as `—`. */
export function explainLine(currentSp: number, item: CombatSlotItem, slot: EquipmentSlot, value: number | null): string {
  return `${currentSp} × ${(item.multiplierBp / 10_000).toFixed(2)} = ${value ?? '—'} ${SLOT_STAT[slot].label}`;
}

function quote(npc: NpcContent | null, line: string): string {
  return `**${npc?.name ?? 'Patch'}:** “${line}”`;
}

function speech(npc: NpcContent | null, step: { narration?: string | undefined; say?: string | undefined }): string {
  const parts: string[] = [];
  if (step.narration) parts.push(`_${step.narration}_`);
  if (step.say) parts.push(quote(npc, step.say));
  return parts.join('\n\n');
}

function backToMenuButton(label = 'Back to Waifumon'): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('menu', 'start'))
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

function primary(customId: string, label: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary);
}

interface Art {
  files: AttachmentBuilder[];
  image: string | null;
  thumbnail: string | null;
}

/** Step artwork as the image, NPC portrait as the thumbnail. Missing files degrade to text. */
function artwork(ctx: AppContext, stem: string, imagePath: string | null, npc: NpcContent | null): Art {
  const art: Art = { files: [], image: null, thumbnail: null };
  const image = resolveArtworkAttachment(ctx, {
    relativePath: imagePath,
    stem,
    logTag: 'equipment-onboarding',
    logFields: { stem },
  });
  if (image) {
    art.files.push(image.file);
    art.image = image.url;
  }
  const portrait = resolveArtworkAttachment(ctx, {
    relativePath: npc?.portraitPath ?? null,
    stem: `npc_${npc?.key ?? 'unknown'}`,
    logTag: 'npc-portrait',
    logFields: { npc: npc?.key ?? null },
  });
  if (portrait) {
    art.files.push(portrait.file);
    art.thumbnail = portrait.url;
  }
  return art;
}

function baseEmbed(title: string, npc: NpcContent | null, art: Art): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title).setColor(ONBOARDING_COLOR);
  if (npc) embed.setAuthor({ name: npc.title ? `${npc.name} · ${npc.title}` : npc.name });
  if (art.image) embed.setImage(art.image);
  if (art.thumbnail) embed.setThumbnail(art.thumbnail);
  return embed;
}

function itemCard(item: StarterItemView): { name: string; value: string } {
  const { definition, slot } = item;
  const lines = [`${SLOT_GEAR_LABEL[slot]} · ${formatMultiplier(definition.multiplierBp)}`];
  if (definition.description) lines.push(`*${definition.description}*`);
  return { name: `${SLOT_EMOJI[slot]} ${definition.name}`, value: lines.join('\n') };
}

/** Buddy, the three slots, and ATK/DEF/HP — shared by the completion screen and the overview. */
function addLoadoutFields(embed: EmbedBuilder, stats: CombatStats): void {
  embed.addFields({
    name: 'Buddy',
    value: stats.buddy
      ? `**${stats.buddy.name}** · Current SP **${stats.buddy.currentSp}**`
      : 'No Buddy — choose one from your Collection to see your stats.',
  });
  for (const slot of STARTER_SLOTS) {
    const item = stats.loadout.slots[slot];
    embed.addFields({
      name: `${SLOT_EMOJI[slot]} ${SLOT_GEAR_LABEL[slot]}`,
      value: item ? `${item.name} · ${formatMultiplier(item.multiplierBp)}` : 'Empty',
      inline: true,
    });
  }
  embed.addFields(
    { name: 'ATK', value: String(stats.stats.attack ?? '—'), inline: true },
    { name: 'DEF', value: String(stats.stats.defense ?? '—'), inline: true },
    { name: 'HP', value: String(stats.stats.maxHp ?? '—'), inline: true },
  );
}

/** "Kept your X" lines for slots the completion found already occupied. */
function keptLines(stats: CombatStats, report: OnboardingEquipResult | null): string[] {
  if (!report) return [];
  return report.kept.map(({ slot }) => {
    const name = stats.loadout.slots[slot]?.name ?? 'your gear';
    return `${SLOT_EMOJI[slot]} Kept your **${name}** — your ${SLOT_GEAR_LABEL[slot]} slot was already filled.`;
  });
}

export interface OnboardingPresenterContent {
  flow: EquipmentOnboardingContent;
  npc: NpcContent | null;
}

/** Build the payload for any onboarding view. */
export function buildOnboardingView(
  ctx: AppContext,
  view: EquipmentOnboardingView,
  content: OnboardingPresenterContent | null,
  homeArtwork?: BuddyArtwork | null,
): SessionPayload {
  // An unlocked player reopening the onboarding lands on Equipment management.
  if (view.kind === 'overview') return buildEquipmentHome(view.stats, null, homeArtwork);
  if (view.kind === 'unavailable' || !content) {
    return {
      content: content?.flow.unavailableText ?? UNAVAILABLE_FALLBACK,
      embeds: [],
      components: [row(backToMenuButton())],
      files: [],
    };
  }
  const { flow, npc } = content;
  const steps = flow.steps;

  switch (view.kind) {
    case 'intro': {
      const art = artwork(ctx, 'onboarding_intro', steps.intro.artworkPath, npc);
      const embed = baseEmbed(steps.intro.title, npc, art).setDescription(speech(npc, steps.intro));
      return {
        embeds: [embed],
        components: [row(primary(onboardingCustomId('adv', 'intro'), steps.intro.button), backToMenuButton('Later'))],
        files: art.files,
      };
    }
    case 'handover': {
      const step = steps[view.step];
      const art = artwork(ctx, `onboarding_${view.step}`, step.artworkPath ?? view.item.definition.artworkPath, npc);
      const embed = baseEmbed(step.title, npc, art)
        .setDescription(speech(npc, step))
        .addFields(itemCard(view.item));
      return {
        embeds: [embed],
        components: [row(primary(onboardingCustomId('adv', view.step), step.button), backToMenuButton('Later'))],
        files: art.files,
      };
    }
    case 'explain': {
      const step = steps.explain;
      const { stats } = view;
      const art = artwork(ctx, 'onboarding_explain', step.artworkPath, npc);
      const embed = baseEmbed(step.title, npc, art).setDescription(speech(npc, step));
      const buddy = stats.buddy!;
      embed.addFields({ name: buddy.name, value: `Current SP: **${buddy.currentSp}**` });
      for (const slot of STARTER_SLOTS) {
        const item = stats.loadout.slots[slot];
        if (!item) continue;
        embed.addFields({
          name: `${SLOT_EMOJI[slot]} ${item.name}`,
          value: explainLine(buddy.currentSp, item, slot, stats.stats[SLOT_STAT[slot].key]),
        });
      }
      if (step.sayAfter) embed.addFields({ name: '​', value: quote(npc, step.sayAfter) });
      return {
        embeds: [embed],
        components: [row(primary(onboardingCustomId('done'), step.button), backToMenuButton('Later'))],
        files: art.files,
      };
    }
    case 'needs_buddy': {
      const noBuddy = steps.explain.noBuddy;
      const art = artwork(ctx, 'onboarding_no_buddy', null, npc);
      const embed = baseEmbed(noBuddy.title, npc, art).setDescription(speech(npc, noBuddy));
      return {
        embeds: [embed],
        components: [
          row(
            new ButtonBuilder()
              .setCustomId(buildCustomId('menu', 'collection'))
              .setLabel('Open Collection')
              .setEmoji('🎒')
              .setStyle(ButtonStyle.Primary),
            backToMenuButton(),
          ),
        ],
        files: art.files,
      };
    }
    case 'complete': {
      const step = steps.complete;
      const art = artwork(ctx, 'onboarding_complete', step.artworkPath, npc);
      const description = [speech(npc, step), ...keptLines(view.stats, view.report)].join('\n\n');
      const embed = baseEmbed(step.title, npc, art).setDescription(description);
      addLoadoutFields(embed, view.stats);
      return {
        embeds: [embed],
        components: [row(backToMenuButton(step.button))],
        files: art.files,
      };
    }
  }
}
