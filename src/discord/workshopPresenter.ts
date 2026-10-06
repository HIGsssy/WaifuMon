/**
 * Patch's Workshop screens: home, dismantle (list → review → result) and
 * fabrication (recipe → slot → review → reveal). Pure builders from
 * `EquipmentWorkshopService` read models — every cost, yield, balance and
 * availability shown here came from the service. Nothing here decides a rule.
 *
 * Custom ids (`pw` scope):
 *
 *   pw|home                                  Workshop home
 *   pw|dis|<page>   pw|disp|…                dismantle list (and its pager)
 *   pw|dsel|<page>                           multi-select; values are instance ids
 *   pw|dcf|<nonce>|<total>|<ids>             confirm a reviewed dismantle
 *   pw|fab                                   recipe list
 *   pw|fr|<recipe>                           slot choice
 *   pw|fs|<recipe>|<slot>                    review the cost
 *   pw|fc|<recipe>|<slot>|<nonce>            confirm a fabrication
 *   pw|noop|…                                disabled labels
 *
 * `<ids>` is the reviewed selection in base 36, dot-separated; `<total>` is
 * the Components the player was shown. The nonce is minted per rendered
 * Confirm button and becomes the service's request key, so a double-click or
 * a Discord retry replays the one operation it made. A Discord dismantle
 * batch is one list page (≤ 10 copies) so the confirm id fits Discord's
 * 100-character limit; the service itself accepts larger explicit batches.
 *
 * Artwork: one optional large image (the Workshop's artwork, else Patch's
 * portrait — the handler resolves which) on the home, the dismantle review
 * and result, and the fabrication review and result. Never more than one
 * image per screen; the long lists stay text-only.
 */
import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { NpcContent } from '../modules/content/onboardingSchemas';
import type {
  DismantleBlocker,
  DismantleCandidate,
  DismantleOutcome,
  DismantlePreview,
  FabricationOutcome,
  WorkshopOverview,
  WorkshopRecipeView,
} from '../modules/equipment/equipmentWorkshopService';
import type { Page } from '../modules/equipment/gearBag';
import { isWorkshopSlotChoice, type WorkshopSlotChoice } from '../modules/equipment/vocabulary';
import type { SessionPayload } from './ephemeralSession';
import {
  SLOT_EMOJI,
  SLOT_NAME,
  SLOT_STAT_LABEL,
  combatBonusLines,
  eqId,
  formatMultiplier,
  indicators,
} from './equipmentPresenter';
import { buildCustomId } from './types';

const COLOR = 0x92400e;
const MAX_CUSTOM_ID = 100;

export const WORKSHOP_TITLE = "🔧 Patch's Workshop";
export const VISIT_PATCH_LABEL = 'Visit Patch';
export const COMPONENTS = 'Salvaged Components';
export const DISMANTLE_LABEL = 'Dismantle Equipment';
export const FABRICATE_LABEL = 'Fabricate Equipment';
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{6,16}$/;

const SLOT_CHOICE_NAME: Readonly<Record<WorkshopSlotChoice, string>> = {
  attack: 'Attack',
  defense: 'Defense',
  health: 'Health',
  any: 'Any / Surprise Me',
};
const SLOT_CHOICE_EMOJI: Readonly<Record<WorkshopSlotChoice, string>> = { ...SLOT_EMOJI, any: '🎲' };

const BLOCKER_TEXT: Readonly<Record<DismantleBlocker, string>> = {
  equipped: 'Equipped — unequip it first',
  favorite: 'Favourite — unfavourite it first',
  locked: 'Locked — unlock it first',
  unsupported_rarity: "Patch can't salvage this rarity yet",
};

// ── custom ids ────────────────────────────────────────────────────────────

const encodeIds = (ids: readonly number[]) => ids.map((id) => id.toString(36)).join('.');

/** Strict: anything malformed is null. */
export function decodeIds(raw: string | undefined): number[] | null {
  if (!raw || !/^[0-9a-z]{1,11}(?:\.[0-9a-z]{1,11}){0,49}$/.test(raw)) return null;
  const ids = raw.split('.').map((part) => parseInt(part, 36));
  return ids.every((id) => Number.isSafeInteger(id) && id > 0) ? ids : null;
}

export const pwId = {
  home: () => buildCustomId('pw', 'home'),
  dismantle: (page = 0) => buildCustomId('pw', 'dis', String(page)),
  dismantlePage: (page: number) => buildCustomId('pw', 'disp', String(page)),
  dismantleSelect: (page: number) => buildCustomId('pw', 'dsel', String(page)),
  dismantleConfirm: (nonce: string, total: number, ids: readonly number[]) =>
    buildCustomId('pw', 'dcf', nonce, String(total), encodeIds(ids)),
  fabricate: () => buildCustomId('pw', 'fab'),
  recipe: (recipeKey: string) => buildCustomId('pw', 'fr', recipeKey),
  review: (recipeKey: string, slot: WorkshopSlotChoice) => buildCustomId('pw', 'fs', recipeKey, slot),
  fabricateConfirm: (recipeKey: string, slot: WorkshopSlotChoice, nonce: string) =>
    buildCustomId('pw', 'fc', recipeKey, slot, nonce),
  noop: (what: string) => buildCustomId('pw', 'noop', what),
} as const;

export function parseSlotChoice(raw: string | undefined): WorkshopSlotChoice | null {
  return isWorkshopSlotChoice(raw) ? raw : null;
}

// ── shared bits ───────────────────────────────────────────────────────────

/** `4250` → `4,250`. */
export function formatAmount(n: number): string {
  return n.toLocaleString('en-US');
}

function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components);
}

function selectRow(select: StringSelectMenuBuilder): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as unknown as ActionRowBuilder<ButtonBuilder>;
}

function button(customId: string, label: string, style = ButtonStyle.Secondary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

const workshopButton = (label = 'Workshop') => button(pwId.home(), label).setEmoji('🔧');
const equipmentButton = () => button(eqId.home(), 'Equipment').setEmoji('⚔️');

function baseEmbed(title: string, npc: NpcContent | null): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title).setColor(COLOR);
  const name = npc?.name ?? 'Patch';
  embed.setAuthor({ name: npc?.title ? `${name} · ${npc.title}` : name });
  return embed;
}

function balanceLine(b: { components: number; waifubux: number }): string {
  return `${COMPONENTS}: **${formatAmount(b.components)}**\nWaifuBux: **${formatAmount(b.waifubux)}**`;
}

/** The one picture a Workshop screen may carry, as `resolveArtworkAttachment` returns it. */
export interface WorkshopArt {
  file: AttachmentBuilder;
  /** `attachment://…` */
  url: string;
}

/** Set the screen's single large image, if any, and return the files to attach. */
function withArt(embed: EmbedBuilder, art: WorkshopArt | null | undefined): AttachmentBuilder[] {
  if (!art) return [];
  embed.setImage(art.url);
  return [art.file];
}

function withStatus(payload: SessionPayload, status: string | null | undefined): SessionPayload {
  return status ? { ...payload, content: status } : payload;
}

function pager(page: number, totalPages: number): ButtonBuilder[] {
  return [
    button(pwId.dismantlePage(Math.max(page - 1, 0)) + '|p', '◀ Prev').setDisabled(page <= 0),
    button(pwId.noop('page'), `Page ${page + 1} / ${totalPages}`).setDisabled(true),
    button(pwId.dismantlePage(Math.min(page + 1, totalPages - 1)) + '|n', 'Next ▶').setDisabled(page >= totalPages - 1),
  ];
}

// ── home ──────────────────────────────────────────────────────────────────

export function buildWorkshopHome(
  view: WorkshopOverview,
  npc: NpcContent | null,
  status?: string | null,
  art?: WorkshopArt | null,
): SessionPayload {
  const embed = baseEmbed(WORKSHOP_TITLE, npc)
    .setDescription(`**${npc?.name ?? 'Patch'}:** “Bring me what you don't need. I'll build you something you might.”`)
    .addFields({ name: 'Your balances', value: balanceLine(view.balances) });
  if (view.salvageYields.length > 0) {
    embed.addFields({
      name: 'Salvage value',
      value: view.salvageYields.map((y) => `${y.rarity} → ${y.components}`).join(' · '),
    });
  }
  const files = withArt(embed, art);
  return withStatus(
    {
      embeds: [embed],
      components: [
        row(
          button(pwId.dismantle(0), DISMANTLE_LABEL, ButtonStyle.Primary).setEmoji('🪛'),
          button(pwId.fabricate(), FABRICATE_LABEL, ButtonStyle.Primary).setEmoji('🛠️'),
          button(eqId.home(), 'Back'),
        ),
      ],
      files,
    },
    status,
  );
}

// ── dismantle ─────────────────────────────────────────────────────────────

function candidateLine(c: DismantleCandidate): string {
  const marks = indicators({ equipped: c.item.equipped, favorite: c.item.isFavorite, locked: c.item.isLocked });
  const def = c.item.definition;
  const head = `${SLOT_EMOJI[c.item.slot]} **${c.item.displayName}**${marks ? ` ${marks}` : ''}`;
  const bonuses = combatBonusLines(c.item.combatBonuses).map((line) => ` • ${line}`).join('');
  const facts = `${def.rarity} • ${SLOT_STAT_LABEL[c.item.slot]} ${formatMultiplier(c.item.rolledMultiplierBp)}${bonuses}`;
  return c.blockedBy
    ? `${head}\n${facts} • 🚫 ${BLOCKER_TEXT[c.blockedBy]}`
    : `${head}\n${facts} • +${c.components} ${COMPONENTS}`;
}

export function buildDismantleList(
  page: Page<DismantleCandidate>,
  npc: NpcContent | null,
  status?: string | null,
): SessionPayload {
  const embed = baseEmbed(`${WORKSHOP_TITLE} — Dismantle`, npc).setFooter({
    text: `Page ${page.page + 1} / ${page.totalPages} · ${page.totalItems} item${page.totalItems === 1 ? '' : 's'}`,
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (page.items.length === 0) {
    embed.setDescription('Your Gear Bag is empty — nothing to dismantle.');
  } else {
    embed.setDescription(
      'Pick the copies to break down. Equipped, favourite and locked gear is shown but can’t be picked — ' +
        'change it in your Gear Bag first.\n\n' +
        page.items.map(candidateLine).join('\n\n'),
    );
    const eligible = page.items.filter((c) => c.blockedBy == null);
    if (eligible.length > 0) {
      rows.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(pwId.dismantleSelect(page.page))
            .setPlaceholder('Choose copies to dismantle…')
            .setMinValues(1)
            .setMaxValues(eligible.length)
            .addOptions(
              eligible.map((c) => ({
                label: c.item.displayName.slice(0, 100),
                description: `${c.item.definition.rarity} • ${SLOT_NAME[c.item.slot]} • ${formatMultiplier(c.item.rolledMultiplierBp)} • +${c.components} ${COMPONENTS}`.slice(0, 100),
                value: String(c.item.id),
              })),
            ),
        ),
      );
    } else {
      embed.addFields({ name: 'Nothing to pick on this page', value: 'Every copy here is protected.' });
    }
  }
  if (page.totalPages > 1) rows.push(row(...pager(page.page, page.totalPages)));
  rows.push(row(workshopButton('Back')));
  return withStatus({ embeds: [embed], components: rows, files: [] }, status);
}

/**
 * The review before anything is destroyed. `nonce` is minted for this one
 * Confirm button. Returns a refusal screen (no Confirm) if the selection is
 * too large to fit a custom id — the list page already caps it, so only a
 * forged select reaches that.
 */
export function buildDismantleReview(
  preview: DismantlePreview,
  ids: readonly number[],
  page: number,
  nonce: string,
  npc: NpcContent | null,
  art?: WorkshopArt | null,
): SessionPayload {
  const pieces = `${preview.count} piece${preview.count === 1 ? '' : 's'}`;
  const embed = baseEmbed(`Dismantle ${pieces}?`, npc)
    .setDescription(
      [
        preview.byRarity.map((l) => `${l.count}× ${l.rarity}`).join('\n'),
        '',
        `**You receive:**\n${formatAmount(preview.totalComponents)} ${COMPONENTS}`,
        `${COMPONENTS} after: **${formatAmount(preview.componentsAfter)}**`,
        '',
        '⚠️ **This cannot be undone.**',
      ].join('\n'),
    )
    .addFields({
      name: 'Selected',
      value: preview.items
        .map(
          (i) =>
            `${SLOT_EMOJI[i.slot]} ${i.displayName} · ${i.rarity} · ${SLOT_STAT_LABEL[i.slot]} ${formatMultiplier(i.rolledMultiplierBp)}` +
            combatBonusLines(i.combatBonuses).map((line) => ` · ${line}`).join(''),
        )
        .join('\n')
        .slice(0, 1024),
    });
  const confirmId = pwId.dismantleConfirm(nonce, preview.totalComponents, ids);
  const cancel = button(pwId.dismantle(page), 'Cancel');
  const files = withArt(embed, art);
  if (confirmId.length > MAX_CUSTOM_ID) {
    return {
      content: 'That selection is too large for one confirmation — pick fewer copies.',
      embeds: [embed],
      components: [row(cancel)],
      files,
    };
  }
  return {
    embeds: [embed],
    components: [row(button(confirmId, 'Confirm', ButtonStyle.Danger), cancel)],
    files,
  };
}

export const DISMANTLE_REPLAYED = 'Patch already took those — here’s what you got.';

export function buildDismantleResult(
  outcome: DismantleOutcome,
  npc: NpcContent | null,
  art?: WorkshopArt | null,
): SessionPayload {
  const pieces = `${outcome.count} piece${outcome.count === 1 ? '' : 's'}`;
  const embed = baseEmbed(`🪛 Dismantled ${pieces}`, npc)
    .setDescription(
      [
        outcome.byRarity.map((l) => `${l.count}× ${l.rarity}`).join('\n'),
        '',
        `**+${formatAmount(outcome.totalComponents)} ${COMPONENTS}**`,
      ].join('\n'),
    )
    .addFields({ name: 'Your balances', value: balanceLine(outcome.balances) });
  const files = withArt(embed, art);
  return withStatus(
    {
      embeds: [embed],
      components: [row(button(pwId.dismantle(0), 'Dismantle more'), workshopButton(), equipmentButton())],
      files,
    },
    outcome.replayed ? DISMANTLE_REPLAYED : null,
  );
}

// ── fabrication ───────────────────────────────────────────────────────────

function costLine(recipe: Pick<WorkshopRecipeView, 'componentCost' | 'waifubuxCost'>): string {
  return `${formatAmount(recipe.componentCost)} ${COMPONENTS} + ${formatAmount(recipe.waifubuxCost)} WaifuBux`;
}

function availabilityLine(recipe: WorkshopRecipeView): string {
  return recipe.slots
    .map((s) => `${SLOT_CHOICE_EMOJI[s.choice]} ${SLOT_CHOICE_NAME[s.choice].split(' ')[0]} ${s.available ? '✓' : '— none yet'}`)
    .join(' · ');
}

function shortfallLine(recipe: WorkshopRecipeView): string | null {
  if (recipe.affordable) return null;
  const parts = [
    recipe.shortfall.components > 0 ? `${formatAmount(recipe.shortfall.components)} more ${COMPONENTS}` : '',
    recipe.shortfall.waifubux > 0 ? `${formatAmount(recipe.shortfall.waifubux)} more WaifuBux` : '',
  ].filter(Boolean);
  return `Needs ${parts.join(' and ')}.`;
}

export function buildRecipeList(view: WorkshopOverview, npc: NpcContent | null, status?: string | null): SessionPayload {
  const embed = baseEmbed(`${WORKSHOP_TITLE} — Fabricate`, npc).addFields({
    name: 'Your balances',
    value: balanceLine(view.balances),
  });
  if (view.recipes.length === 0) {
    embed.setDescription('Patch isn’t taking orders right now.');
  } else {
    embed.setDescription(
      'Patch guarantees the **rarity** — not the roll. The piece, multiplier and affix are random.',
    );
    for (const r of view.recipes) {
      embed.addFields({
        name: `${r.name} — ${r.rarity} Equipment`,
        value: [costLine(r), availabilityLine(r), shortfallLine(r)].filter(Boolean).join('\n'),
      });
    }
  }
  const recipeButtons = view.recipes
    .slice(0, 5)
    .map((r) => button(pwId.recipe(r.key), r.name, ButtonStyle.Primary).setDisabled(!r.available));
  const rows = recipeButtons.length > 0 ? [row(...recipeButtons)] : [];
  rows.push(row(workshopButton('Back')));
  return withStatus({ embeds: [embed], components: rows, files: [] }, status);
}

export function buildSlotChoice(
  recipe: WorkshopRecipeView,
  balances: WorkshopOverview['balances'],
  npc: NpcContent | null,
  status?: string | null,
): SessionPayload {
  const embed = baseEmbed(`${recipe.name} — ${recipe.rarity} Equipment`, npc)
    .setDescription(
      [recipe.description ?? null, `**Cost:** ${costLine(recipe)}`, 'Choose the slot Patch should build for.']
        .filter(Boolean)
        .join('\n'),
    )
    .addFields({ name: 'Your balances', value: balanceLine(balances) });
  const unavailable = recipe.slots.filter((s) => !s.available);
  if (unavailable.length > 0) {
    embed.addFields({
      name: 'Not available yet',
      value: unavailable
        .map((s) => `${SLOT_CHOICE_NAME[s.choice]}: Patch has no ${recipe.rarity} blueprints for it.`)
        .join('\n'),
    });
  }
  const slotButtons = recipe.slots.map((s) =>
    button(
      pwId.review(recipe.key, s.choice),
      s.available ? SLOT_CHOICE_NAME[s.choice] : `${SLOT_CHOICE_NAME[s.choice].split(' ')[0]} — none yet`,
      ButtonStyle.Primary,
    )
      .setEmoji(SLOT_CHOICE_EMOJI[s.choice])
      .setDisabled(!s.available),
  );
  return withStatus(
    { embeds: [embed], components: [row(...slotButtons), row(button(pwId.fabricate(), 'Back'))], files: [] },
    status,
  );
}

export function buildFabricationReview(
  recipe: WorkshopRecipeView,
  slot: WorkshopSlotChoice,
  balances: WorkshopOverview['balances'],
  nonce: string,
  npc: NpcContent | null,
  status?: string | null,
  art?: WorkshopArt | null,
): SessionPayload {
  const choice = recipe.slots.find((s) => s.choice === slot);
  const after = {
    components: balances.components - recipe.componentCost,
    waifubux: balances.waifubux - recipe.waifubuxCost,
  };
  const embed = baseEmbed('Fabricate with Patch?', npc).setDescription(
    [
      `**${recipe.name}** · ${recipe.rarity} · ${SLOT_CHOICE_NAME[slot]}`,
      '',
      `**Cost:** ${costLine(recipe)}`,
      `**You have:** ${formatAmount(balances.components)} ${COMPONENTS} · ${formatAmount(balances.waifubux)} WaifuBux`,
      recipe.affordable
        ? `**After:** ${formatAmount(after.components)} ${COMPONENTS} · ${formatAmount(after.waifubux)} WaifuBux`
        : `🚫 ${shortfallLine(recipe)}`,
      '',
      'Guaranteed rarity, random piece and roll.',
    ].join('\n'),
  );
  const blocked = !recipe.affordable || !choice?.available;
  const confirmId = pwId.fabricateConfirm(recipe.key, slot, nonce);
  const confirm = button(
    confirmId.length <= MAX_CUSTOM_ID ? confirmId : pwId.noop('too-long'),
    'Confirm',
    ButtonStyle.Success,
  ).setDisabled(blocked || confirmId.length > MAX_CUSTOM_ID);
  const files = withArt(embed, art);
  return withStatus(
    { embeds: [embed], components: [row(confirm, button(pwId.recipe(recipe.key), 'Cancel'))], files },
    status,
  );
}

export const FABRICATION_REPLAYED = 'Patch already built this one — here it is.';

export function buildFabricationResult(
  outcome: FabricationOutcome,
  npc: NpcContent | null,
  againAvailable: boolean,
  art?: WorkshopArt | null,
): SessionPayload {
  const { item } = outcome;
  const embed = baseEmbed(`✨ ${item.displayName}`, npc)
    .setDescription(`**${npc?.name ?? 'Patch'}:** “Fresh off the bench. Try not to break it. Or do — I'll take it back.”`)
    .addFields(
      { name: 'Rarity', value: item.rarity, inline: true },
      { name: 'Slot', value: `${SLOT_EMOJI[item.slot]} ${SLOT_NAME[item.slot]}`, inline: true },
      { name: 'Multiplier', value: `${SLOT_STAT_LABEL[item.slot]} ${formatMultiplier(item.rolledMultiplierBp)}`, inline: true },
      { name: 'Affix', value: item.affixSuffix ?? 'None', inline: true },
      ...(item.combatBonuses.length > 0
        ? [{ name: 'Combat Bonuses', value: combatBonusLines(item.combatBonuses).join('\n'), inline: true }]
        : []),
      { name: 'Recipe', value: `${outcome.recipe.name} · ${SLOT_CHOICE_NAME[outcome.slotChoice]}`, inline: true },
      { name: 'Remaining', value: balanceLine(outcome.balances) },
    );
  const actions = [
    button(eqId.item(item.equipmentId, { kind: 'home' }), 'Inspect', ButtonStyle.Primary),
    button(pwId.review(outcome.recipe.key, outcome.slotChoice), 'Fabricate Again').setDisabled(!againAvailable),
    workshopButton(),
  ];
  const files = withArt(embed, art);
  return withStatus({ embeds: [embed], components: [row(...actions)], files }, outcome.replayed ? FABRICATION_REPLAYED : null);
}
