/**
 * Dungeon screens: the home (dungeons, or the active run), a dungeon's detail,
 * the run screen (what the latest step did, the pending action or the ways on,
 * and the end of the run) and the two confirmations. Pure builders from
 * `DungeonRunService` read models.
 *
 * Every number shown is copied from the service — the run's *snapshotted*
 * Buddy and stats, never the player's live ones. Combat events are formatted
 * with the Combat Trials summary; the full log is never dumped. Gear Score is
 * not a thing here: the player sees real ATK / DEF / HP and rooms cleared.
 *
 * The progression currency is always named from its configured metadata
 * (singular, plural, icon). No name is written in this file.
 *
 * Custom ids (`dg` scope):
 *
 *   dg|home                         dungeons, or the active run
 *   dg|zone|<dungeonKey>            dungeon detail (`zone`: older menu buttons still route)
 *   dg|start|<dungeonKey>           start a run
 *   dg|run|<runId>                  the run as it stands (Resume, back from a confirmation)
 *   dg|act|<runId>|<step>|<code>    the pending action: a = advance, d = decline
 *   dg|mv|<runId>|<step>|<connId>   take a connection
 *   dg|ev|<runId>|<step>|<choiceId> answer the offered event with one of its choices
 *   dg|ci|<runId>|<step>            choose the capture charm (select menu; the value is the item slug)
 *   dg|cap|<runId>|<step>           attempt a capture with the chosen charm
 *   dg|res|<runId>|<step>           carry out a direct rescue
 *   dg|cl|<runId>|<step>            leave the offered WaifuMon
 *   dg|cu|<runId>|<step>            move on from a WaifuMon who can no longer be had (never spends or grants)
 *   dg|pz|<runId>|<step>            open the answer form for the pending puzzle (changes nothing)
 *   dg|pza|<runId>|<step>           the answer form's submission (a modal; the answer travels as its field)
 *   dg|exq|<runId>                  extraction confirmation
 *   dg|ex|<runId>|<step>            extract
 *   dg|abq|<runId>                  abandon confirmation
 *   dg|ab|<runId>|<step>            abandon the confirmed step
 *
 * `<step>` is the run's step when the button was drawn. The service refuses an
 * input whose step is not the run's current one, so a stale or double-clicked
 * button changes nothing. Old step-less abandon buttons reopen confirmation.
 * A charm is never named in a button: Capture uses the selection stored on
 * the run, so a button cannot spend an item the player did not choose.
 * A puzzle's answers never appear in an id, a label or an embed: the screen
 * gets only the prompt and the attempt counts.
 */
import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  embedLength,
} from 'discord.js';
import { BASIS_POINTS, DUNGEON_PUZZLE_LIMITS, type DungeonActionType } from '../modules/dungeons/content/dungeonDefinition';
import type { DungeonDailyAllowance } from '../modules/dungeons/dungeonAllowanceService';
import { fighterModifiers, type DungeonFighter } from '../modules/dungeons/dungeonFighter';
import type {
  DungeonActionResult,
  DungeonCard,
  DungeonCurrencyView,
  DungeonDetailView,
  DungeonEncounterReceipt,
  DungeonEncounterResultView,
  DungeonHomeView,
  DungeonRunView,
  DungeonSecuredReward,
  DungeonSettlement,
} from '../modules/dungeons/dungeonRunService';
import type { DungeonEncounterUnavailableReason, DungeonRecentEntry, DungeonWaveResult } from '../modules/dungeons/engine/types';
import type { DungeonEncounterView } from '../modules/dungeons/engine/encounters';
import { settleCurrency } from '../modules/dungeons/engine/rewards';
import type { DungeonEventChoiceView, DungeonEventView } from '../modules/dungeons/engine/events';
import type { DungeonPuzzleView } from '../modules/dungeons/engine/puzzles';
import type { DungeonActionView, DungeonConnectionView } from '../modules/dungeons/engine/view';
import { formatCombatBonus, type CombatBonus } from '../modules/equipment/combatBonuses';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from '../modules/equipment/vocabulary';
import { formatProgressionAmount } from '../modules/progressionCurrency/progressionCurrencyService';
import { blockerLine, modifiersLine, summarizeCombatEvents, type TrialArt } from './combatTrialPresenter';
import type { SessionPayload } from './ephemeralSession';
import { formatChancePercent } from './rollFormat';
import { EMPTY_SLOT, SLOT_EMOJI, formatMultiplier } from './equipmentPresenter';
import { buildCustomId } from './types';

export const DUNGEON_TITLE = '⛏️ Delve';
export const DUNGEON_LABEL = 'Delve';
export const LOCKED_DUNGEONS = '🔒 Delves unlock once you have Equipment.';
export const NO_ZONES = 'There are no Delves available in this region.';
export const ZONE_UNAVAILABLE = 'That dungeon isn’t open right now.';
export const RUN_ACTIVE_NOTICE = 'You’re already in a dungeon — here’s your run.';
export const RUN_NOT_FOUND = 'That run could not be found.';
export const STALE_STEP_NOTICE = 'That button is from an earlier moment — here’s where you are.';
export const STALE_NOTICE = 'That path is no longer available — here’s where you are.';
export const LOCKED_NOTICE = 'That way is locked.';
export const RUN_OVER_NOTICE = 'That run is over — here’s how it ended.';
export const NOT_EXTRACTABLE_NOTICE = 'You can’t extract from here.';
export const CHOICE_UNAVAILABLE_NOTICE = 'That choice isn’t available right now — here’s where you are.';
export const CHOICE_REQUIRED_NOTICE = 'Pick one of the choices below.';
export const CAPTURE_ITEM_REQUIRED_NOTICE = 'Choose a capture charm first.';
export const CAPTURE_ITEM_UNAVAILABLE_NOTICE = 'That charm can’t be used on her right now. Nothing was spent — choose another.';
export const ENCOUNTER_NOT_OFFERED_NOTICE = 'She isn’t waiting for you any more — here’s where you are.';
export const ENCOUNTER_STILL_HERE_NOTICE = 'She’s still here after all — here’s what you can do.';
export const ANSWER_REQUIRED_NOTICE = 'This puzzle needs an answer — press Enter Answer.';
export const PUZZLE_SOLVED_DEFAULT = 'That’s right.';
export const PUZZLE_INCORRECT_DEFAULT = 'That isn’t right.';
export const PUZZLE_EXHAUSTED_DEFAULT = 'You’ve run out of attempts.';
/** Discord: a modal title and a text input label are at most 45 characters. */
export const PUZZLE_MODAL_TITLE = 'Enter Answer';
export const PUZZLE_INPUT_LABEL = 'Your answer';
/** The answer form's one text input. */
export const PUZZLE_ANSWER_FIELD = 'answer';
/** The promise an encounter screen makes about charms. The wording is deliberate: do not soften it. */
export const CHARM_SPENT_PER_ATTEMPT = 'Each attempt uses one charm, whether or not she is caught.';
export const NO_USABLE_CHARM = 'You have no capture charm that works on her here.';
/** The promise a screen makes about an item a choice spends. The wording is deliberate: do not soften it. */
export const CONSUMED_WHEN_SELECTED = 'Consumed when selected.';
export const CONSUMED_EVEN_IF_CHECK_FAILS = 'Consumed when selected, even if the check fails.';
export const DAILY_LIMIT_NOTICE = 'You’ve used all of today’s Delve runs.';
export const DELVE_CLOSED_NOTICE = 'Delve is closed to new runs right now.';
export const EQUIPMENT_NOTE =
  'Your Buddy and gear are locked in for the run. Changing either elsewhere won’t affect it.';

const COLOR = 0x7c3aed;
const COLOR_GOOD = 0x16a34a;
const COLOR_BAD = 0xdc2626;
const COLOR_NEUTRAL = 0x6b7280;

export const dgId = {
  home: () => buildCustomId('dg', 'home'),
  zone: (dungeonKey: string) => buildCustomId('dg', 'zone', dungeonKey),
  start: (dungeonKey: string) => buildCustomId('dg', 'start', dungeonKey),
  run: (runId: number) => buildCustomId('dg', 'run', String(runId)),
  /** `step` is the step the screen was drawn for; the service refuses any other. */
  advance: (runId: number, step: number) => buildCustomId('dg', 'act', String(runId), String(step), 'a'),
  decline: (runId: number, step: number) => buildCustomId('dg', 'act', String(runId), String(step), 'd'),
  move: (runId: number, step: number, connectionId: string) =>
    buildCustomId('dg', 'mv', String(runId), String(step), connectionId),
  /** Choice ids are at most 40 characters, so the id stays well under Discord's 100. */
  choose: (runId: number, step: number, choiceId: string) => buildCustomId('dg', 'ev', String(runId), String(step), choiceId),
  extractConfirm: (runId: number) => buildCustomId('dg', 'exq', String(runId)),
  extract: (runId: number, step: number) => buildCustomId('dg', 'ex', String(runId), String(step)),
  abandonConfirm: (runId: number) => buildCustomId('dg', 'abq', String(runId)),
  abandon: (runId: number, step?: number) => buildCustomId('dg', 'ab', String(runId), ...(step === undefined ? [] : [String(step)])),
  /** The charm select menu. The chosen item slug travels as the menu's value, never in an id. */
  charm: (runId: number, step: number) => buildCustomId('dg', 'ci', String(runId), String(step)),
  capture: (runId: number, step: number) => buildCustomId('dg', 'cap', String(runId), String(step)),
  rescue: (runId: number, step: number) => buildCustomId('dg', 'res', String(runId), String(step)),
  leaveEncounter: (runId: number, step: number) => buildCustomId('dg', 'cl', String(runId), String(step)),
  /** An encounter whose WaifuMon can no longer be had: resolves it as unavailable, never spends or grants. */
  encounterGone: (runId: number, step: number) => buildCustomId('dg', 'cu', String(runId), String(step)),
  keepDuplicate: (runId: number, step: number, waifuId: number) => buildCustomId('dg', 'dk', String(runId), String(step), String(waifuId)),
  convertDuplicate: (runId: number, step: number, waifuId: number) => buildCustomId('dg', 'dc', String(runId), String(step), String(waifuId)),
  /** Opens the answer form. Names only the run and the step: never anything about the answer. */
  puzzle: (runId: number, step: number) => buildCustomId('dg', 'pz', String(runId), String(step)),
  puzzleSubmit: (runId: number, step: number) => buildCustomId('dg', 'pza', String(runId), String(step)),
};

const ACTION_HEADING: Readonly<Record<DungeonActionType, string>> = {
  combat: 'Fight',
  boss: 'Boss',
  rest: 'Rest',
  gate: 'Barred way',
  set_flag: 'Something stirs',
  leave: 'Way on',
  reward: 'Cache',
  event: 'Event',
  wild_encounter: 'A wild WaifuMon',
  rescue: 'Rescue',
  text_puzzle: 'Puzzle',
};
const ACTION_EMOJI: Readonly<Record<DungeonActionType, string>> = {
  combat: '⚔️',
  boss: '👑',
  rest: '🔥',
  gate: '🚪',
  set_flag: '✨',
  leave: '🚪',
  reward: '🎁',
  event: '❔',
  wild_encounter: '🌸',
  rescue: '🔓',
  text_puzzle: '🧩',
};
/** The button that carries out a pending action, when its author wrote no label. */
const ACTION_BUTTON: Readonly<Record<DungeonActionType, string>> = {
  combat: 'Fight',
  boss: 'Fight',
  rest: 'Rest',
  gate: 'Try the way',
  set_flag: 'Continue',
  leave: 'Move on',
  reward: 'Open',
  // Never drawn: an event's buttons are its choices (`eventButtons`).
  event: 'Continue',
  // Never drawn: an offered encounter has its own controls (`encounterRows`).
  wild_encounter: 'Continue',
  rescue: 'Continue',
  // Never drawn: a puzzle's button is Enter Answer (`actionButtons`).
  text_puzzle: 'Enter Answer',
};

/** Discord: at most 25 options in a select menu. */
const MAX_SELECT_OPTIONS = 25;
/** Discord: five buttons to a row, five rows to a message. Three rows are the connections'. */
const BUTTONS_PER_ROW = 5;
const CONNECTION_ROWS = 3;
const MAX_CONNECTION_BUTTONS = BUTTONS_PER_ROW * CONNECTION_ROWS;
/** Wave results shown in full after a step that fought several. */
const MAX_WAVE_FIELDS = 3;
const EMBED_TOTAL_LIMIT = 6000;

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components);
}

function button(id: string, label: string, style: ButtonStyle, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(id).setLabel(truncate(label, 80)).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
}

function menuButton(): ButtonBuilder {
  return button(buildCustomId('menu', 'start'), 'Back to Waifumon', ButtonStyle.Secondary);
}

function homeButton(label = 'Delve'): ButtonBuilder {
  return button(dgId.home(), label, ButtonStyle.Secondary, '⛏️');
}

/** Repainting a capture result never moves the dungeon cursor. */
export function dungeonCaptureNavigation(view: DungeonRunView): ActionRowBuilder<ButtonBuilder>[] {
  return view.status === 'active'
    ? [row(button(dgId.run(view.id), 'Continue the Delve', ButtonStyle.Primary), homeButton('Delve menu'))]
    : [row(homeButton('Delve menu'))];
}

/** The main menu's entry to dungeons. */
export function dungeonMenuButton(style: ButtonStyle = ButtonStyle.Secondary): ButtonBuilder {
  return button(dgId.home(), DUNGEON_LABEL, style, '⛏️');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function files(art: TrialArt): AttachmentBuilder[] {
  return [art.scene?.file, art.buddy?.file].filter((f): f is AttachmentBuilder => f != null);
}

function applyArt(embed: EmbedBuilder, art: TrialArt): void {
  if (art.scene) embed.setImage(art.scene.url);
  if (art.buddy) embed.setThumbnail(art.buddy.url);
}

// ── formatting ──────────────────────────────────────────────────────────────

/** `💠 12 Shards` from the configured metadata; a bare number when the dungeon's currency is gone. */
export function currencyAmount(currency: DungeonCurrencyView | null, amount: number): string {
  return currency ? formatProgressionAmount(currency, amount) : amount.toLocaleString('en-US');
}

function currencyName(currency: DungeonCurrencyView | null): string {
  return currency ? `${currency.icon ? `${currency.icon} ` : ''}${currency.pluralName}` : 'Progress';
}

function percent(basisPoints: number): string {
  return `${Number((basisPoints / (BASIS_POINTS / 100)).toFixed(2))}%`;
}

function phase2(view: DungeonRunView): boolean {
  return view.rewardFormat === 'v2' || view.settlement?.waifubux != null || view.core.unbankedWaifubux > 0 ||
    view.secured.some((r) => r.kind === 'essence' || r.kind === 'affection' || (r.kind === 'equipment' && r.dropId !== undefined));
}

function riskLines(view: DungeonRunView): string[] {
  const risk = view.atRisk ?? { shards: view.core.unbankedCurrency, waifubux: view.core.unbankedWaifubux ?? 0 };
  return [currencyAmount(view.currency, risk.shards), ...(phase2(view) ? [`${risk.waifubux.toLocaleString('en-US')} WaifuBux`] : [])];
}

function retentionLines(dungeon: DungeonCard): string[] {
  return [
    'Complete or extract: keep everything.',
    `Defeated: keep ${percent(dungeon.defeatRetentionBasisPoints)} of at-risk currency.`,
    `Abandon: keep ${percent(dungeon.abandonRetentionBasisPoints ?? dungeon.defeatRetentionBasisPoints)} of at-risk currency.`,
    ...(dungeon.rewardFormat === 'v2' ? [`${currencyName(dungeon.currency)} and dungeon-earned WaifuBux stay at risk until banked.`] : []),
  ];
}

/** Whole reward rows, with a count instead of a cut-off final item. */
function rewardList(lines: readonly string[], max = 900): string {
  const shown: string[] = [];
  for (const line of lines) {
    const omitted = lines.length - shown.length - 1;
    const suffix = omitted > 0 ? `\nand ${omitted} more rewards` : '';
    if ([...shown, line].join('\n').length + suffix.length > max) break;
    shown.push(line);
  }
  const omitted = lines.length - shown.length;
  if (omitted > 0) shown.push(`and ${omitted} more rewards`);
  return shown.join('\n') || 'Nothing yet.';
}

function itemLabel(slug: string, itemName: (slug: string) => string): string {
  const name = itemName(slug);
  return truncate(name && name !== slug ? name : 'Unknown item', 180);
}

function bonusNote(grant: { bonusPercent: number; bonus: string; baseAmount: number }): string {
  return grant.bonus === 'pinned' && grant.bonusPercent > 0
    ? ` (${grant.baseAmount} base, +${grant.bonusPercent}% Buddy bonus)` : '';
}

/** All values here are actual secured receipts, including pinned recipients. */
function keptLines(secured: readonly DungeonSecuredReward[], itemName: (slug: string) => string, detailed: boolean): string[] {
  const lines: string[] = [];
  const bux = secured.reduce((sum, s) => sum + (s.kind === 'waifubux' ? s.amount : 0), 0);
  if (bux > 0) lines.push(`${bux.toLocaleString('en-US')} WaifuBux`);
  const essence = secured.filter((s) => s.kind === 'essence');
  if (detailed) for (const grant of essence) lines.push(`+${grant.granted} Essence${bonusNote(grant)}`);
  else if (essence.length) lines.push(`${essence.reduce((sum, s) => sum + s.granted, 0)} Essence`);
  const affection = secured.filter((s) => s.kind === 'affection');
  if (detailed) for (const grant of affection) lines.push(`♥ +${grant.granted} Affection → **${truncate(grant.name, 120)}**${bonusNote(grant)}`);
  else {
    const recipients = new Map<number, { name: string; amount: number }>();
    for (const grant of affection) recipients.set(grant.waifuId, { name: grant.name, amount: (recipients.get(grant.waifuId)?.amount ?? 0) + grant.granted });
    for (const grant of recipients.values()) lines.push(`♥ ${grant.amount} Affection → ${truncate(grant.name, 120)}`);
  }
  const totals = new Map<string, number>();
  for (const s of secured) if (s.kind === 'item') totals.set(s.slug, (totals.get(s.slug) ?? 0) + s.quantity);
  for (const [slug, quantity] of totals) lines.push(`${detailed ? '+' : ''}${quantity} ${itemLabel(slug, itemName)}`);
  for (const gear of secured) if (gear.kind === 'equipment') {
    const slot = gear.slot[0]?.toUpperCase() + gear.slot.slice(1);
    const roll = detailed ? ` · ${slot} · ${formatMultiplier(gear.rolledMultiplierBp)}` : '';
    const bonuses = detailed ? ((gear.combatBonuses ?? []) as CombatBonus[]).map((b) => ` · ${formatCombatBonus(b)}`).join('') : '';
    lines.push(`${slotEmoji(gear.slot)} **${truncate(gear.displayName, 160)}** (${gear.rarity})${roll}${bonuses}`);
  }
  return lines;
}

function fighterBlock(fighter: DungeonFighter, currentHp: number, maxHp: number = fighter.maxHp): string {
  return [
    `HP **${currentHp} / ${maxHp}**`,
    `ATK ${fighter.attack} · DEF ${fighter.defense}`,
    // The snapshot taken at run start — not the player's live loadout.
    modifiersLine(fighterModifiers(fighter)),
  ]
    .filter((l): l is string => l != null)
    .join('\n');
}

function slotEmoji(slot: string): string {
  return SLOT_EMOJI[slot as EquipmentSlot] ?? '🎁';
}

/** What a step paid: the plan's unbanked currency, and what was handed over for good. */
export interface DungeonRewardSummary {
  currency: number;
  waifubux: number;
  items: readonly { slug: string; quantity: number }[];
  equipment: readonly { displayName: string; slot: string; rarity: string; combatBonuses?: unknown[] | undefined }[];
}

function hasRewards(rewards: DungeonRewardSummary): boolean {
  return rewards.currency > 0 || rewards.waifubux > 0 || rewards.items.length > 0 || rewards.equipment.length > 0;
}

/** What a step paid, one line each. Item names resolved by the caller. */
export function rewardLines(
  rewards: DungeonRewardSummary,
  currency: DungeonCurrencyView | null,
  itemName: (slug: string) => string,
): string[] {
  const lines: string[] = [];
  if (rewards.currency > 0) lines.push(`+${currencyAmount(currency, rewards.currency)} _(unbanked)_`);
  for (const gear of rewards.equipment) {
    const bonuses = ((gear.combatBonuses ?? []) as CombatBonus[]).map((b) => ` · ${formatCombatBonus(b)}`).join('');
    lines.push(`${slotEmoji(gear.slot)} **${gear.displayName}** (${gear.rarity})${bonuses} — secured`);
  }
  if (rewards.waifubux > 0) lines.push(`+${rewards.waifubux} WaifuBux`);
  for (const item of rewards.items) lines.push(`+${item.quantity} ${itemName(item.slug)}`);
  return lines;
}

/**
 * What the latest step paid: the unbanked currency its reward actions planned
 * (`recent`), and the gear, WaifuBux and items actually handed over
 * (`latestSecured`). Null when the step opened no reward.
 */
function latestRewards(view: DungeonRunView): DungeonRewardSummary | null {
  const planned = view.core.recent.filter((r): r is Extract<DungeonRecentEntry, { kind: 'reward' }> => r.kind === 'reward');
  if (planned.length === 0 && view.latestSecured.length === 0) return null;
  const summary = { currency: 0, waifubux: 0, items: [] as { slug: string; quantity: number }[], equipment: [] as DungeonRewardSummary['equipment'][number][] };
  if (view.latestAtRisk) summary.currency = view.latestAtRisk.shards;
  else for (const r of planned) if (!('v' in r.plan)) summary.currency += r.plan.currency;
  for (const s of view.latestSecured) {
    if (s.kind === 'equipment') summary.equipment.push(s);
    else if (s.kind === 'waifubux') summary.waifubux += s.amount;
    else if (s.kind === 'item') summary.items.push({ slug: s.slug, quantity: s.quantity });
  }
  return summary;
}

/** A short roll-up of everything the run has secured so far. */
export function securedSummary(secured: readonly DungeonSecuredReward[], itemName: (slug: string) => string): string {
  if (secured.length === 0) return 'Nothing yet.';
  if (secured.some((s) => s.kind === 'essence' || s.kind === 'affection' || (s.kind === 'equipment' && s.dropId !== undefined))) {
    return rewardList(keptLines(secured, itemName, false));
  }
  const lines: string[] = [];
  for (const s of secured) if (s.kind === 'equipment') lines.push(`${slotEmoji(s.slot)} ${s.displayName} (${s.rarity})`);
  const bux = secured.reduce((sum, s) => sum + (s.kind === 'waifubux' ? s.amount : 0), 0);
  if (bux > 0) lines.push(`${bux} WaifuBux`);
  const itemTotals = new Map<string, number>();
  for (const s of secured) if (s.kind === 'item') itemTotals.set(s.slug, (itemTotals.get(s.slug) ?? 0) + s.quantity);
  for (const [slug, quantity] of itemTotals) lines.push(`${quantity} ${itemLabel(slug, itemName)}`);
  return rewardList(lines);
}

/** `Daily Runs: **2 / 3** remaining`, from the configured limit — never a written number. */
export function dailyRunsLine(daily: DungeonDailyAllowance): string {
  return `Daily Runs: **${daily.remaining} / ${daily.limit}** remaining`;
}

/**
 * Why a new run cannot be started today, or null when one can. Says when the
 * allowance comes back; a limit of 0 is Delve being closed, which no reset fixes.
 */
export function dailyLimitLine(daily: DungeonDailyAllowance): string | null {
  if (daily.remaining > 0) return null;
  if (daily.limit <= 0) return DELVE_CLOSED_NOTICE;
  return `${DAILY_LIMIT_NOTICE} They come back <t:${Math.floor(daily.resetsAt.getTime() / 1000)}:R>.`;
}

// ── home ────────────────────────────────────────────────────────────────────

function roomName(view: DungeonRunView): string {
  return view.core.room.name || view.core.room.id;
}

function roomsLine(view: DungeonRunView): string {
  return `${view.core.roomsCompleted} / ${view.core.roomCount}`;
}

function roomCountText(dungeon: DungeonCard): string {
  return `**${dungeon.roomCount}** ${dungeon.roomCount === 1 ? 'room' : 'rooms'}`;
}

function dungeonField(dungeon: DungeonCard): { name: string; value: string } {
  const lines = [
    dungeon.description ? `_${truncate(dungeon.description, 300)}_` : null,
    `${roomCountText(dungeon)}${dungeon.hasBoss ? ' · ends in a boss' : ''}`,
    dungeon.currency
      ? `Pays: ${currencyName(dungeon.currency)} · you hold **${currencyAmount(dungeon.currency, dungeon.balance)}**`
      : null,
    ...retentionLines(dungeon),
  ].filter((l): l is string => l != null);
  return { name: truncate(dungeon.name, 256), value: lines.join('\n') };
}

export interface DungeonScreenOptions {
  itemName(slug: string): string;
  art?: TrialArt;
  status?: string | null;
  /**
   * The capture attempt or rescue this very press committed, from the
   * service's result. Present only on the screen painted for that press:
   * a resumed or repainted screen has none, and says only what the run stored.
   */
  encounterReceipts?: readonly DungeonEncounterReceipt[];
  /** Rows the caller adds above the navigation row, e.g. the duplicate-conversion prompt. */
  extraRows?: readonly ActionRowBuilder<ButtonBuilder>[];
}

/** The home: the active run when there is one, otherwise the dungeons open here. */
export function buildDungeonHome(view: DungeonHomeView, opts: DungeonScreenOptions): SessionPayload {
  const run = view.activeRun;
  if (run) {
    const embed = new EmbedBuilder()
      .setTitle(DUNGEON_TITLE)
      .setColor(COLOR)
      .setDescription(
        [
          dailyRunsLine(view.daily),
          '',
          `You have a run in progress in **${run.dungeon.name}**.`,
          // Resuming never needs an attempt: the run was paid for when it started.
          view.daily.remaining <= 0 ? 'Out of new runs for today — this one is still yours to finish.' : null,
        ]
          .filter((l): l is string => l != null)
          .join('\n'),
      )
      .addFields(
        { name: 'Where', value: truncate(`${roomName(run)} — ${roomsLine(run)} rooms cleared`, 1024), inline: true },
        { name: truncate(run.fighter.name, 200), value: fighterBlock(run.fighter, run.core.hp, run.core.maxHp), inline: true },
        { name: phase2(run) ? 'At Risk' : `Unbanked ${currencyName(run.currency)}`, value: phase2(run) ? riskLines(run).join('\n') : currencyAmount(run.currency, run.core.unbankedCurrency) },
        { name: phase2(run) ? 'Kept' : 'Secured', value: securedSummary(run.secured, opts.itemName) },
      );
    const art = opts.art ?? {};
    applyArt(embed, art);
    fitEmbed(embed);
    return {
      content: truncate(opts.status ?? '', 2000),
      embeds: [embed],
      components: [
        row(
          button(dgId.run(run.id), 'Resume', ButtonStyle.Primary, '▶️'),
          button(dgId.abandonConfirm(run.id), 'Abandon', ButtonStyle.Danger),
        ),
      ],
      files: files(art),
    };
  }

  const embed = new EmbedBuilder()
    .setTitle(DUNGEON_TITLE)
    .setColor(COLOR)
    .setDescription(
      [
        `Current location: **${view.region.name}**`,
        dailyRunsLine(view.daily),
        '',
        view.dungeons.length
          ? 'Take your Buddy into a dungeon. HP carries from fight to fight — push deeper for more, or get out while you can.'
          : NO_ZONES,
      ].join('\n'),
    );
  const shown = view.dungeons.slice(0, BUTTONS_PER_ROW);
  if (shown.length) embed.addFields({ name: 'Available Delves', value: `Open in ${view.region.name}:` });
  for (const dungeon of shown) embed.addFields(dungeonField(dungeon));
  applyArt(embed, opts.art ?? {});
  const blocked = blockerLine(view.blocker);
  if (blocked) embed.addFields({ name: '⚠️ Can’t start yet', value: blocked });
  const spent = dailyLimitLine(view.daily);
  if (spent) embed.addFields({ name: '⏳ No runs left today', value: spent });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (shown.length) components.push(row(...shown.map((d) => button(dgId.zone(d.key), d.name, ButtonStyle.Primary))));
  components.push(row(menuButton()));
  fitEmbed(embed);
  return { content: truncate(opts.status ?? '', 2000), embeds: [embed], components, files: files(opts.art ?? {}) };
}

// ── dungeon detail ──────────────────────────────────────────────────────────

export function buildDungeonDetail(view: DungeonDetailView, opts: DungeonScreenOptions): SessionPayload {
  const { dungeon, stats, blocker } = view;
  const embed = new EmbedBuilder().setTitle(truncate(dungeon.name, 256)).setColor(COLOR);
  if (dungeon.description) embed.setDescription(truncate(dungeon.description, 4096));

  if (stats.buddy) {
    const gear = EQUIPMENT_SLOTS.map((slot) => `${SLOT_EMOJI[slot]} ${stats.loadout.slots[slot]?.name ?? EMPTY_SLOT}`);
    embed.addFields({
      name: `Your Buddy — ${truncate(stats.buddy.name, 200)}`,
      value: [
        `Current SP **${stats.buddy.currentSp}**`,
        `ATK ${stats.stats.attack ?? EMPTY_SLOT} · DEF ${stats.stats.defense ?? EMPTY_SLOT} · HP ${stats.stats.maxHp ?? EMPTY_SLOT}`,
        modifiersLine(stats.combatModifiers),
        ...gear,
      ]
        .filter((l): l is string => l != null)
        .join('\n'),
      inline: true,
    });
  } else {
    embed.addFields({ name: 'Your Buddy', value: 'No active Buddy.', inline: true });
  }
  embed.addFields({
    name: 'The run',
    value: [
      `${roomCountText(dungeon)}${dungeon.hasBoss ? ', ending in a boss' : ''}`,
      'HP carries between fights.',
      dungeon.currency
        ? `${currencyName(dungeon.currency)} are banked when you extract or finish. If you fall, you keep ${percent(dungeon.defeatRetentionBasisPoints)}.`
        : null,
      dungeon.rewardFormat === 'v2' ? 'Items, equipment, Essence and affection are kept as soon as earned.' : 'Gear you find is yours at once.',
    ]
      .filter((l): l is string => l != null)
      .join('\n'),
    inline: true,
  });
  embed.addFields({ name: 'Currency risk', value: retentionLines(dungeon).join('\n') });
  if (dungeon.currency) embed.addFields({ name: 'You hold', value: currencyAmount(dungeon.currency, dungeon.balance) });
  embed.addFields({ name: 'Locked in', value: EQUIPMENT_NOTE });
  const blocked = blockerLine(blocker);
  if (blocked) embed.addFields({ name: '⚠️ Can’t start yet', value: blocked });
  // An active run is resumed, not started: the allowance only gates a new one.
  const spent = view.activeRunId == null ? dailyLimitLine(view.daily) : null;
  embed.addFields({
    name: spent ? '⏳ No runs left today' : 'Daily runs',
    value: spent ?? `${dailyRunsLine(view.daily)}\nStarting a run uses one. Shared across every dungeon.`,
  });

  const art: TrialArt = { scene: opts.art?.scene ?? null, buddy: stats.buddy ? (opts.art?.buddy ?? null) : null };
  applyArt(embed, art);

  const actions: ButtonBuilder[] = [];
  if (view.activeRunId != null) {
    actions.push(button(dgId.run(view.activeRunId), 'Resume Run', ButtonStyle.Primary, '▶️'));
  } else {
    actions.push(button(dgId.start(dungeon.key), 'Start Run', ButtonStyle.Success, '⛏️').setDisabled(blocker != null || spent != null));
    if (blocker === 'no_buddy') {
      actions.push(button(buildCustomId('menu', 'collection'), 'Open Collection', ButtonStyle.Primary, '🎒'));
    } else if (blocker === 'incomplete_loadout') {
      actions.push(button(buildCustomId('eq', 'home'), 'Equipment', ButtonStyle.Primary, '🔧'));
    }
  }
  fitEmbed(embed);
  return {
    content: truncate(opts.status ?? '', 2000),
    embeds: [embed],
    components: [row(...actions), row(homeButton('All Dungeons'), ...(view.activeRunId == null ? [menuButton()] : []))],
    files: files(art),
  };
}

// ── run screen ──────────────────────────────────────────────────────────────

type Field = { name: string; value: string; inline?: boolean };

const WAVE_WORD: Readonly<Record<DungeonWaveResult['result'], string>> = {
  player_victory: '🏆 Victory',
  enemy_victory: '💀 Defeat',
  draw: '⏱️ Stalemate',
};

function waveWord(wave: DungeonWaveResult): string {
  return WAVE_WORD[wave.result] ?? '⏱️ Stalemate';
}

function waveField(view: DungeonRunView, wave: DungeonWaveResult, waveCount: number): Field {
  const of = waveCount > 1 ? ` (wave ${wave.waveIndex + 1} of ${waveCount})` : '';
  return {
    name: truncate(`${waveWord(wave)} — ${wave.enemyName}${of}`, 256),
    value: truncate(
      [
        `Your HP: ${wave.hpBefore} → **${wave.hpAfter}** / ${view.core.maxHp}`,
        `${wave.enemyName}: ${wave.enemyHpAfter} / ${wave.enemyMaxHp}`,
        `Rounds: ${wave.rounds}`,
        wave.lifestealHealed ? `Lifesteal: +${wave.lifestealHealed} HP` : null,
      ]
        .filter((l): l is string => l != null)
        .join('\n'),
      1024,
    ),
  };
}

/**
 * What the latest step did. Fights, rests and rewards are fields; the small
 * things (a gate, a refusal, turning back, a room finished) are lines for the
 * description. Flags and plain movement are the author's plumbing and are not shown.
 */
function recentBlock(view: DungeonRunView, opts: DungeonScreenOptions): { lines: string[]; fields: Field[] } {
  const lines: string[] = [];
  const fields: Field[] = [];
  const { recent, room } = view.core;
  const nameOf = (roomId: string) => (roomId === room.id ? roomName(view) : roomId);

  const waves = recent.filter((r): r is Extract<DungeonRecentEntry, { kind: 'wave' }> => r.kind === 'wave');
  const earlier = waves.slice(0, Math.max(0, waves.length - MAX_WAVE_FIELDS));
  if (earlier.length > 0) {
    fields.push({
      name: `Earlier waves (${earlier.length})`,
      value: truncate(
        earlier
          .map(({ wave }) => `${waveWord(wave)} — ${wave.enemyName}: HP ${wave.hpBefore} → ${wave.hpAfter}, ${wave.rounds} rounds`)
          .join('\n'),
        1024,
      ),
    });
  }
  for (const { wave, waveCount } of waves.slice(earlier.length)) fields.push(waveField(view, wave, waveCount));
  // The events are the last wave's; the earlier waves have their numbers above.
  if (waves.length > 0 && view.combatEvents?.length) {
    fields.push({ name: 'Combat summary', value: truncate(summarizeCombatEvents(view.combatEvents).join('\n'), 1024) || '—' });
  }

  for (const entry of recent) {
    switch (entry.kind) {
      case 'rest':
        fields.push({
          name: '🔥 Rested',
          value: `HP ${entry.hpBefore} → **${entry.hpAfter}** / ${view.core.maxHp} (+${entry.hpAfter - entry.hpBefore})`,
        });
        break;
      case 'gate':
        lines.push(entry.passed ? '🚪 The way opens.' : `🔒 ${truncate(entry.blockedText || 'The way is barred.', 300)}`);
        break;
      case 'declined':
        lines.push('You pass it by.');
        break;
      case 'retreated':
        lines.push(`↩ You turn back to **${truncate(nameOf(entry.toRoomId), 100)}**.`);
        break;
      case 'room_completed':
        lines.push(`✅ **${truncate(nameOf(entry.roomId), 100)}** is cleared.`);
        break;
      case 'event_nothing':
        if (entry.text) lines.push(`_${truncate(entry.text, 200)}_`);
        break;
      case 'puzzle':
        fields.push(puzzleResultField(entry));
        break;
      case 'encounter': {
        const told = view.latestEncounters?.find((e) => e.roomId === entry.roomId && e.actionId === entry.actionId);
        // A pool that drew no one is the author's quiet line, as an empty event pool is.
        if (entry.outcome === 'nothing') {
          if (entry.text) lines.push(`_${truncate(entry.text, 200)}_`);
          break;
        }
        const receipt = opts.encounterReceipts?.find((r) => r.roomId === entry.roomId && r.actionId === entry.actionId);
        fields.push(encounterResultField(view, entry, told, receipt, opts.itemName));
        break;
      }
      case 'event': {
        const told = view.latestEvents?.find((e) => e.roomId === entry.roomId && e.actionId === entry.actionId);
        const label = truncate(told?.choiceLabel ?? 'Your choice', 60);
        if (entry.walkedAway) {
          lines.push(told?.text ? `_${truncate(told.text, 800)}_` : `You leave **${truncate(told?.eventTitle ?? 'it', 80)}** for now.`);
          break;
        }
        const result: string[] = [];
        if (entry.check) {
          result.push(`${entry.check.success ? '✅ **Success**' : '❌ **Failed**'} — ${percent(entry.check.chanceBasisPoints)} chance`);
        }
        if (told?.text) result.push(truncate(told.text, 800));
        for (const spent of entry.consumed) result.push(`Used ${spent.quantity}× ${itemLabel(spent.item, (slug) => view.eventItemNames?.[slug] ?? opts.itemName(slug))}`);
        if (entry.hpAfter !== entry.hpBefore) {
          const change = entry.hpAfter - entry.hpBefore;
          result.push(`HP ${entry.hpBefore} → **${entry.hpAfter}** / ${view.core.maxHp} (${change > 0 ? '+' : '−'}${Math.abs(change)})`);
        }
        fields.push({ name: truncate(`${EVENT_TONE_EMOJI[told?.tone ?? 'neutral']} ${told?.eventTitle ?? 'Event'} — ${label}`, 256), value: truncate(result.join('\n') || 'Done.', 1024) });
        break;
      }
      default:
        break;
    }
  }

  if (phase2(view)) {
    if (view.latestAtRisk) {
      const risk = view.latestAtRisk;
      if (risk.shards > 0 || risk.waifubux > 0) fields.push({ name: '🎁 At Risk earned', value: [
        risk.shards > 0 ? `+${currencyAmount(view.currency, risk.shards)}` : null,
        risk.waifubux > 0 ? `+${risk.waifubux.toLocaleString('en-US')} WaifuBux` : null,
        'Held in this run until banked.',
      ].filter((l): l is string => l !== null).join('\n') });
    }
    if (view.latestSecured.length) fields.push({ name: '🎁 Kept this step', value: rewardList(keptLines(view.latestSecured, opts.itemName, true)) });
    else if (view.latestAtRisk && view.latestAtRisk.shards === 0 && view.latestAtRisk.waifubux === 0) {
      fields.push({ name: '🎁 Rewards', value: 'No rewards this time.' });
    }
  } else {
    const rewards = latestRewards(view);
    if (rewards) {
      fields.push(
        hasRewards(rewards)
          ? { name: '🎁 Rewards', value: rewardList(rewardLines(rewards, view.currency, (slug) => itemLabel(slug, opts.itemName))) }
          : { name: '🎁 Cache', value: 'Empty.' },
      );
    }
  }
  // Preserve reward fields even when a valid step auto-follows many rests.
  const rewardFields = fields.filter((f) => f.name.startsWith('🎁'));
  const otherFields = fields.filter((f) => !f.name.startsWith('🎁'));
  const omitted = Math.max(0, otherFields.length - 8);
  if (omitted) lines.push(`and ${omitted} more activity results`);
  return { lines, fields: [...otherFields.slice(0, 8), ...rewardFields] };
}

// ── encounters ──────────────────────────────────────────────────────────────

/** The marks an encounter's fields start with; `fitEmbed` never shortens them. */
const ENCOUNTER_MARKS = ['🎯', '🔓', '💖', '😤', '💨', '👋', '🚫'] as const;

/** Why she cannot be had, in player words. Never the internal reason code. */
const UNAVAILABLE_REASON: Readonly<Record<DungeonEncounterUnavailableReason, string>> = {
  missing: 'She can’t be found any more.',
  disabled: 'She can’t be found any more.',
  not_permitted: 'She can’t be taken from this dungeon.',
  player_limit: 'You’ve already taken as many of her from this dungeon as you can.',
  direct_not_permitted: 'She can’t be rescued here.',
  direct_limit_missing: 'She can’t be rescued here.',
};

function unavailableReasonLine(reason: string | null | undefined): string {
  return (reason && UNAVAILABLE_REASON[reason as DungeonEncounterUnavailableReason]) || 'She can’t join you right now.';
}

function nameWithRarity(name: string, rarity: string | null | undefined): string {
  return rarity ? `${name} (${rarity})` : name;
}

/** A selected charm the player can still use, with the service's quote; null when there is none. */
function selectedCharm(encounter: DungeonEncounterView): DungeonEncounterView['items'][number] | null {
  return encounter.items.find((i) => i.item === encounter.selectedItem) ?? null;
}

function chanceText(charm: { guaranteed: boolean; chance: number }): string {
  return charm.guaranteed ? 'guaranteed capture' : `${formatChancePercent(charm.chance)} capture chance`;
}

/** The offered WaifuMon, for the description: who, how rare, and the author's introduction. */
function encounterBrief(action: DungeonActionView, encounter: DungeonEncounterView): string {
  const heading = `${ACTION_EMOJI[action.type]} **${truncate(action.label || ACTION_HEADING[action.type], 100)}**`;
  return [
    heading,
    `**${truncate(encounter.name, 100)}**${encounter.rarity ? ` · ${encounter.rarity}` : ''}`,
    encounter.intro ? truncate(encounter.intro, 600) : null,
  ].filter((l): l is string => l != null).join('\n');
}

/**
 * What the player can do about her, and at what cost. The cost line is a
 * field rather than prose so that a full embed shortens the room text first.
 */
function encounterFields(encounter: DungeonEncounterView, itemName: (slug: string) => string): Field[] {
  if (!encounter.available) {
    return [{ name: '🚫 She can’t join you', value: `${unavailableReasonLine(encounter.unavailableReason)}\nContinue to move on. Nothing will be spent.` }];
  }
  if (encounter.mode === 'direct') {
    return [{ name: '🔓 Rescue', value: 'No charm and no roll: free her and she joins your collection.' }];
  }
  const lines = [`Attempts left: **${encounter.attemptsLeft}**`];
  const chosen = selectedCharm(encounter);
  if (encounter.items.length === 0) {
    lines.push(
      NO_USABLE_CHARM,
      'A charm only works on the rarities it is made for, and this encounter may allow only some charms. You can get one elsewhere and come back — she will wait.',
    );
  } else if (chosen) {
    lines.push(`Charm: **${itemLabel(chosen.item, itemName)}** — **${chanceText(chosen)}**`);
  } else if (encounter.selectedItem) {
    lines.push('Your chosen charm can’t be used any more — choose another below.');
  } else {
    lines.push('Choose a charm below to see your chance, then Capture.');
  }
  lines.push(`**${CHARM_SPENT_PER_ATTEMPT}**`);
  return [{ name: '🎯 Capture', value: truncate(lines.join('\n'), 1024) }];
}

/** The charm menu, Capture and Leave — or the one control that applies. */
function encounterRows(view: DungeonRunView, action: DungeonActionView, encounter: DungeonEncounterView, itemName: (slug: string) => string): Row[] {
  const leave = button(dgId.leaveEncounter(view.id, view.step), 'Leave her', ButtonStyle.Secondary, '👋');
  if (!encounter.available) {
    // Never Capture or Rescue: should she be obtainable again by the press, it is refused and changes nothing.
    return [row(button(dgId.encounterGone(view.id, view.step), 'Continue', ButtonStyle.Primary))];
  }
  if (encounter.mode === 'direct') {
    return [row(button(dgId.rescue(view.id, view.step), action.label || 'Rescue her', ButtonStyle.Success, '🔓'), leave)];
  }
  if (encounter.items.length === 0) return [row(leave)];
  const chosen = selectedCharm(encounter);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(dgId.charm(view.id, view.step))
    .setPlaceholder('Choose a capture charm…')
    .addOptions(encounter.items.slice(0, MAX_SELECT_OPTIONS).map((charm) => ({
      label: truncate(`${itemLabel(charm.item, itemName)} ×${charm.owned}`, 100),
      value: charm.item,
      description: truncate(`${charm.guaranteed ? 'Guaranteed capture' : `Capture chance: ${formatChancePercent(charm.chance)}`} · used on Capture`, 100),
      default: charm.item === chosen?.item,
    })));
  const capture = button(
    dgId.capture(view.id, view.step),
    chosen ? `Capture — ${itemLabel(chosen.item, itemName)}` : 'Capture',
    ButtonStyle.Success,
    '🎯',
  ).setDisabled(chosen == null);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), row(capture, leave)];
}

function xpLines(receipt: DungeonEncounterReceipt | undefined): string[] {
  if (!receipt) return [];
  const lines: string[] = [];
  if (receipt.xpGranted > 0) lines.push(`+${receipt.xpGranted} XP${receipt.acquired?.isNewDex ? ' (incl. new dex)' : ''}`);
  for (const l of receipt.levelUps) lines.push(`⬆️ **Level ${l.toLevel}!**${l.rewardLabels.length ? ` — ${l.rewardLabels.join(', ')}` : ''}`);
  return lines;
}

/** The charm an attempt used and the chance it was quoted, from the committed receipt. */
function attemptLines(receipt: DungeonEncounterReceipt | undefined, itemName: (slug: string) => string): string[] {
  if (receipt?.type !== 'capture_attempt') return [];
  const lines = [`Used **${itemLabel(receipt.item, itemName)}** — ${receipt.guaranteed ? 'guaranteed capture' : `${formatChancePercent(receipt.chance)} chance`}.`];
  if (receipt.microdose) {
    const name = receipt.microdose.sourceItemSlug ? itemLabel(receipt.microdose.sourceItemSlug, itemName) : 'Capture boost';
    lines.push(receipt.microdose.chargesRemaining > 0
      ? `${name}: 1 charge used — **${receipt.microdose.chargesRemaining}** left.`
      : `${name}: last charge used — the effect has worn off.`);
  }
  return lines;
}

/** One encounter result of the latest step. Only committed facts: the stored outcome, and this press's receipt when there is one. */
function encounterResultField(
  view: DungeonRunView,
  entry: Extract<DungeonRecentEntry, { kind: 'encounter' }>,
  told: DungeonEncounterResultView | undefined,
  receipt: DungeonEncounterReceipt | undefined,
  itemName: (slug: string) => string,
): Field {
  const acquired = receipt?.acquired ?? null;
  const name = truncate(acquired?.name ?? told?.name ?? 'The WaifuMon', 100);
  const rarity = acquired?.rarity ?? told?.rarity ?? null;
  const authored = entry.text ? truncate(entry.text, 400) : null;
  const collection = acquired
    ? [acquired.isNewDex ? '✨ New to your collection!' : acquired.isDuplicate ? 'You already have her — this one is a duplicate.' : null]
    : [];
  let heading: string;
  let body: (string | null)[];
  switch (entry.outcome) {
    case 'failure': {
      const left = view.core.action?.encounter?.attemptsLeft;
      heading = `😤 ${name} broke free`;
      body = [
        ...attemptLines(receipt, itemName),
        left === undefined ? 'She is still here.' : `She is still here — **${left}** attempt${left === 1 ? '' : 's'} left.`,
        ...xpLines(receipt),
      ];
      break;
    }
    case 'captured':
      heading = `💖 You captured ${nameWithRarity(name, rarity)}!`;
      body = [authored, ...attemptLines(receipt, itemName), ...collection, ...xpLines(receipt)];
      break;
    case 'rescued':
      heading = `🔓 You rescued ${nameWithRarity(name, rarity)}!`;
      body = [authored, ...attemptLines(receipt, itemName), ...collection, ...xpLines(receipt)];
      break;
    case 'escaped':
      heading = `💨 ${name} escaped`;
      body = [authored ?? 'She slipped away.', ...attemptLines(receipt, itemName), ...xpLines(receipt)];
      break;
    case 'left':
      heading = `👋 You left ${name}`;
      body = [authored ?? 'You move on without her.'];
      break;
    default:
      heading = `🚫 ${name} can’t join you`;
      body = [unavailableReasonLine(told?.unavailableReason), authored];
      break;
  }
  return {
    name: truncate(heading, 256),
    value: truncate(body.filter((l): l is string => l != null && l !== '').join('\n'), 1024) || '—',
  };
}

// ── puzzles ─────────────────────────────────────────────────────────────────

function attemptsLeftLine(remaining: number): string {
  return `**${remaining}** ${remaining === 1 ? 'attempt' : 'attempts'} left.`;
}

/** What one submitted answer came to, in the author's words. Never the answer itself. */
function puzzleResultField(entry: Extract<DungeonRecentEntry, { kind: 'puzzle' }>): Field {
  switch (entry.result) {
    case 'solved':
      return { name: '✅ Solved', value: truncate(entry.text || PUZZLE_SOLVED_DEFAULT, 1024) };
    case 'exhausted':
      return { name: '🔒 Out of attempts', value: truncate(entry.text || PUZZLE_EXHAUSTED_DEFAULT, 1024) };
    case 'incorrect': {
      const lines = [entry.text || PUZZLE_INCORRECT_DEFAULT];
      if (entry.maxAttempts !== null) lines.push(attemptsLeftLine(Math.max(0, entry.maxAttempts - entry.attempts)));
      return { name: '❌ Incorrect', value: truncate(lines.join('\n'), 1024) };
    }
  }
}

function puzzleBrief(heading: string, puzzle: DungeonPuzzleView): string {
  return [
    heading,
    truncate(puzzle.prompt, 1500),
    puzzle.attemptsRemaining !== null ? attemptsLeftLine(puzzle.attemptsRemaining) : null,
  ]
    .filter((l): l is string => l != null && l !== '')
    .join('\n');
}

/** The answer form. One short text field; what was typed is checked on the server and nowhere else. */
export function buildPuzzleModal(runId: number, step: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(dgId.puzzleSubmit(runId, step))
    .setTitle(PUZZLE_MODAL_TITLE)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(PUZZLE_ANSWER_FIELD)
          .setLabel(PUZZLE_INPUT_LABEL)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(DUNGEON_PUZZLE_LIMITS.answerLength),
      ),
    );
}

function isFight(action: DungeonActionView): boolean {
  return action.type === 'combat' || action.type === 'boss';
}

/** What the pending action holds, before it is carried out. */
function actionBrief(action: DungeonActionView): string {
  const heading = `${ACTION_EMOJI[action.type]} **${truncate(action.label || ACTION_HEADING[action.type], 100)}**`;
  if (isFight(action)) {
    const wave = action.wave;
    if (!wave) return heading;
    return [
      heading,
      `**${wave.enemy.name}**`,
      `ATK ${wave.enemy.attack} · DEF ${wave.enemy.defense} · HP ${wave.enemy.hp}`,
      wave.count > 1 ? `Wave ${wave.index + 1} of ${wave.count}` : null,
    ]
      .filter((l): l is string => l != null)
      .join('\n');
  }
  if (action.puzzle) return puzzleBrief(heading, action.puzzle);
  switch (action.type) {
    case 'rest':
      return `${heading}\nA quiet corner. Resting restores **${percent(action.healBasisPoints ?? 0)}** of max HP.`;
    case 'reward':
      return `${heading}\nA sealed cache.`;
    case 'gate':
      return `${heading}\nThe way ahead is barred.`;
    default:
      return heading;
  }
}

const EVENT_TONE_EMOJI = { good: '✨', neutral: '❔', bad: '⚠️' } as const;

/** Why a choice cannot be picked, in the author's words when they wrote some. */
function unavailableLine(choice: DungeonEventChoiceView): string {
  if (choice.unavailableText) return truncate(choice.unavailableText, 120);
  switch (choice.unavailableReason) {
    case 'items':
      return 'You don’t have what this needs.';
    case 'no_way_back':
      return 'There is nowhere to go back to.';
    default:
      return 'Not available right now.';
  }
}

/** The offered event's title and narrative, for the description. */
function eventBrief(event: DungeonEventView): string {
  return `${ACTION_EMOJI.event} **${truncate(event.title, 80)}**\n${truncate(event.text, 1500)}`;
}

const CHOICE_OPEN = '▸';
const CHOICE_CLOSED = '🚫';

/**
 * One field per choice: what it needs, what it costs and what it risks. Fields
 * rather than description lines so that a long narrative is what gives way
 * when an embed is full (`fitEmbed`), never the statement that an item is spent.
 */
function eventChoiceFields(view: DungeonRunView, event: DungeonEventView, itemName: (slug: string) => string): Field[] {
  const named = (slug: string) => view.eventItemNames?.[slug] ?? itemName(slug);
  return event.choices.slice(0, BUTTONS_PER_ROW).map((choice) => {
    const notes: string[] = [];
    if (choice.description) notes.push(truncate(choice.description, 200));
    for (const item of choice.items) {
      notes.push(`Needs ${item.quantity}× ${itemLabel(item.item, named)} (you have ${item.owned}).`);
    }
    // Said in full wherever an item is spent: it goes when the button is pressed, before any roll.
    if (choice.consumesOnSelect) notes.push(`**${choice.check ? CONSUMED_EVEN_IF_CHECK_FAILS : CONSUMED_WHEN_SELECTED}**`);
    if (choice.check) notes.push(`Success chance: **${percent(choice.check.chanceBasisPoints)}**`);
    if (!choice.available) notes.push(`_${unavailableLine(choice)}_`);
    return {
      name: `${choice.available ? CHOICE_OPEN : CHOICE_CLOSED} ${truncate(choice.label, 60)}`,
      value: truncate(notes.join('\n'), 1024) || (choice.walksAway ? 'Step back for now.' : 'No requirements.'),
    };
  });
}

/** One button per choice, in authored order; an unavailable choice is shown and cannot be pressed. */
function eventButtons(view: DungeonRunView, event: DungeonEventView): ButtonBuilder[] {
  return event.choices.slice(0, BUTTONS_PER_ROW).map((choice) => {
    const label = choice.check ? `${truncate(choice.label, 60)} (${percent(choice.check.chanceBasisPoints)})` : choice.label;
    const style = choice.walksAway ? ButtonStyle.Secondary : ButtonStyle.Primary;
    const built = button(dgId.choose(view.id, view.step, choice.id), label, style, choice.available ? undefined : CHOICE_CLOSED);
    return choice.available ? built : built.setDisabled(true);
  });
}

function actionButtons(view: DungeonRunView, action: DungeonActionView): ButtonBuilder[] {
  if (action.event) return eventButtons(view, action.event);
  if (action.type === 'text_puzzle') {
    const buttons = [button(dgId.puzzle(view.id, view.step), PUZZLE_MODAL_TITLE, ButtonStyle.Primary, ACTION_EMOJI.text_puzzle)];
    if (action.optional) buttons.push(button(dgId.decline(view.id, view.step), 'Skip', ButtonStyle.Secondary));
    return buttons;
  }
  const fight = isFight(action);
  const fallback = fight && (action.wave?.index ?? 0) > 0 ? 'Next wave' : ACTION_BUTTON[action.type];
  const buttons = [
    button(
      dgId.advance(view.id, view.step),
      action.label || fallback,
      fight ? ButtonStyle.Danger : ButtonStyle.Primary,
      ACTION_EMOJI[action.type],
    ),
  ];
  if (action.optional) buttons.push(button(dgId.decline(view.id, view.step), 'Skip', ButtonStyle.Secondary));
  return buttons;
}

function connectionLabel(connection: DungeonConnectionView): string {
  return connection.label || `→ ${connection.toRoomName}`;
}

function connectionButton(view: DungeonRunView, connection: DungeonConnectionView): ButtonBuilder {
  const id = dgId.move(view.id, view.step, connection.id);
  if (!connection.open) return button(id, connectionLabel(connection), ButtonStyle.Secondary, '🔒').setDisabled(true);
  // A way back to a room already finished reads differently from a way on.
  return connection.toRoomCompleted
    ? button(id, connectionLabel(connection), ButtonStyle.Secondary, '↩️')
    : button(id, connectionLabel(connection), ButtonStyle.Primary);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const OUTCOME_TITLE: Readonly<Record<DungeonSettlement['outcome'], string>> = {
  extracted: '🚪 Extracted',
  completed: '👑 Dungeon Complete',
  defeated: '💀 Defeated',
  abandoned: '🏳️ Run Abandoned',
};

/** How the run ended and what happened to the currency. */
export function settlementLines(view: DungeonRunView): string[] {
  const s = view.settlement;
  if (!s) return [];
  const lines = [`Rooms cleared: **${roomsLine(view)}**`, `HP: ${s.finalHp} / ${view.core.maxHp}`];
  if (s.cause === 'stalemate') lines.push('The fight ran out the clock — you were forced back.');
  if (s.waifubux) {
    lines.push(
      `${currencyName(view.currency)} — Earned: ${s.earned.toLocaleString('en-US')} · Banked: **${s.banked.toLocaleString('en-US')}** · Lost: ${s.lost.toLocaleString('en-US')}`,
      `WaifuBux — Earned: ${s.waifubux.earned.toLocaleString('en-US')} · Banked: **${s.waifubux.banked.toLocaleString('en-US')}** · Lost: ${s.waifubux.lost.toLocaleString('en-US')}`,
    );
    if (s.bankingSkipped) lines.push(`${currencyName(view.currency)} cannot be banked right now.`);
    return lines;
  }
  lines.push(`Earned: ${currencyAmount(view.currency, s.earned)}`);
  if (s.bankingSkipped) {
    lines.push(`Banked: nothing — ${currencyName(view.currency)} cannot be banked right now.`);
  } else if (s.retentionBasisPoints < BASIS_POINTS) {
    lines.push(`Kept (${percent(s.retentionBasisPoints)}): **${currencyAmount(view.currency, s.banked)}** · Lost: ${currencyAmount(view.currency, s.lost)}`);
  } else {
    lines.push(`Banked: **${currencyAmount(view.currency, s.banked)}**${s.earned === 0 ? '' : ' — all of it'}`);
  }
  if (s.balanceAfter != null) lines.push(`You now hold ${currencyAmount(view.currency, s.balanceAfter)}.`);
  return lines;
}

/** Keep currency/results intact; shorten narrative and secondary fields first. */
function fitEmbed(embed: EmbedBuilder): void {
  let over = embedLength(embed.data) - EMBED_TOTAL_LIMIT;
  if (over <= 0) return;
  const description = embed.data.description;
  if (description) embed.setDescription(truncate(description, Math.max(1, description.length - over)));
  over = embedLength(embed.data) - EMBED_TOTAL_LIMIT;
  const fields = embed.data.fields ?? [];
  const important = (name: string) => name.startsWith('🎁') || name.startsWith(CHOICE_OPEN) || name.startsWith(CHOICE_CLOSED) || ENCOUNTER_MARKS.some((mark) => name.startsWith(mark)) || ['At Risk', 'Result', 'Kept', 'Kept — yours to keep', 'Secured', 'Secured — yours to keep', 'Currency risk'].includes(name);
  for (const field of [...fields].reverse().filter((f) => !important(f.name))) {
    if (over <= 0) break;
    const length = Math.max(1, field.value.length - over);
    field.value = truncate(field.value, length);
    over = embedLength(embed.data) - EMBED_TOTAL_LIMIT;
  }
  embed.setFields(fields);
}

/**
 * The run screen. One builder for every state of a run: what the latest step
 * did, then the action waiting for the player, or the ways out of a finished
 * room, or how the run ended.
 */
export function buildRunScreen(view: DungeonRunView, opts: DungeonScreenOptions): SessionPayload {
  const { core } = view;
  const over = core.phase === 'ended';
  const outcome = view.settlement?.outcome ?? core.end?.outcome ?? (view.status === 'active' ? null : view.status);
  const embed = new EmbedBuilder()
    .setTitle(
      truncate(over && outcome ? `${OUTCOME_TITLE[outcome]} — ${view.dungeon.name}` : `${view.dungeon.name} — ${roomName(view)}`, 256),
    )
    .setColor(
      over
        ? view.status === 'defeated'
          ? COLOR_BAD
          : view.status === 'abandoned'
            ? COLOR_NEUTRAL
            : COLOR_GOOD
        : COLOR,
    );

  const latest = recentBlock(view, opts);
  const body: string[] = [...latest.lines];
  if (body.length) body.push('');
  const shown = core.connections;
  // Open ways get the buttons first: a locked one is disabled anyway, and is listed below.
  const ordered = [...shown.filter((c) => c.open), ...shown.filter((c) => !c.open)];
  const buttoned = ordered.slice(0, MAX_CONNECTION_BUTTONS);
  const overflow = ordered.slice(MAX_CONNECTION_BUTTONS);

  if (over) {
    body.push(`Your run ended in **${truncate(roomName(view), 200)}**.`);
  } else {
    if (core.room.description) body.push(`_${truncate(core.room.description, 1000)}_`, '');
    if (core.phase === 'action' && core.action) {
      body.push(core.action.event
        ? eventBrief(core.action.event)
        : core.action.encounter ? encounterBrief(core.action, core.action.encounter) : actionBrief(core.action));
    } else if (core.stuck) {
      body.push('⚠️ **There is no way forward from here.** Nothing is left to do in this room, no way out of it is open and you cannot extract — abandoning the run is all that is left.');
    } else if (shown.some((c) => c.open)) {
      body.push('**Where to?**');
    } else {
      body.push('No way on is open from here.');
    }
  }
  embed.setDescription(truncate(body.join('\n').trim() || '—', 4096));
  embed.addFields(...latest.fields);
  if (!over && core.action?.event) embed.addFields(...eventChoiceFields(view, core.action.event, opts.itemName));
  if (!over && core.action?.encounter) embed.addFields(...encounterFields(core.action.encounter, opts.itemName));

  embed.addFields({ name: truncate(view.fighter.name, 200), value: fighterBlock(view.fighter, core.hp, core.maxHp), inline: true });
  if (over) {
    embed.addFields(
      { name: 'Result', value: truncate(settlementLines(view).join('\n'), 1024) || '—' },
      { name: phase2(view) ? 'Kept — yours to keep' : 'Secured — yours to keep', value: securedSummary(view.secured, opts.itemName) },
    );
  } else {
    embed.addFields(
      { name: phase2(view) ? 'At Risk' : `Unbanked ${currencyName(view.currency)}`, value: phase2(view) ? riskLines(view).join('\n') : currencyAmount(view.currency, core.unbankedCurrency), inline: true },
      { name: phase2(view) ? 'Kept' : 'Secured', value: securedSummary(view.secured, opts.itemName), inline: true },
      { name: 'Rooms cleared', value: roomsLine(view), inline: true },
    );
    const locked = shown.filter((c) => !c.open);
    if (locked.length) {
      embed.addFields({
        name: '🔒 Locked',
        value: truncate(
          locked.map((c) => `**${truncate(connectionLabel(c), 80)}** — ${truncate(c.lockedText || 'Locked.', 200)}`).join('\n'),
          1024,
        ),
      });
    }
    const unbuttoned = overflow.filter((c) => c.open);
    if (unbuttoned.length) {
      embed.addFields({
        name: `More ways (${unbuttoned.length}) — too many to show as buttons`,
        value: truncate(unbuttoned.map((c) => truncate(connectionLabel(c), 80)).join('\n'), 1024),
      });
    }
    if (core.room.extraction) {
      embed.addFields({
        name: '🚪 Extraction point',
        value: core.canExtract
          ? `You can leave here and bank all ${riskLines(view).join(' and ')}.`
          : 'You can leave from here once this room is done.',
      });
    }
  }
  fitEmbed(embed);

  const art = opts.art ?? {};
  applyArt(embed, art);

  const components: Row[] = [];
  const acquired = opts.encounterReceipts?.some((r) => r.acquired && !(r.type === 'rescue_grant' && r.replayed));
  if (over) {
    components.push(...(opts.extraRows ?? []), row(homeButton('Delve Again'), menuButton()));
  } else {
    if (acquired) {
      components.push(...dungeonCaptureNavigation(view));
    } else if (core.phase === 'action' && core.action?.encounter) {
      components.push(...encounterRows(view, core.action, core.action.encounter, opts.itemName));
    } else if (core.phase === 'action' && core.action) {
      components.push(row(...actionButtons(view, core.action)));
    } else {
      for (const group of chunk(buttoned, BUTTONS_PER_ROW)) components.push(row(...group.map((c) => connectionButton(view, c))));
    }
    const last: ButtonBuilder[] = [];
    if (core.canExtract) last.push(button(dgId.extractConfirm(view.id), 'Extract', ButtonStyle.Success, '🚪'));
    last.push(button(dgId.abandonConfirm(view.id), 'Abandon', core.stuck ? ButtonStyle.Danger : ButtonStyle.Secondary));
    if (!acquired) last.push(homeButton('Delve menu'));
    components.push(...(opts.extraRows ?? []), row(...last));
  }
  return { content: truncate(opts.status ?? '', 2000), embeds: [embed], components, files: files(art) };
}

/** The status line for an action's result; null when it simply happened. */
export function actionNotice(result: Pick<DungeonActionResult, 'status' | 'refusal'>): string | null {
  if (result.status === 'applied') return null;
  switch (result.refusal) {
    case 'stale':
      return STALE_STEP_NOTICE;
    case 'run_over':
      return RUN_OVER_NOTICE;
    case 'locked':
      return LOCKED_NOTICE;
    case 'not_extractable':
      return NOT_EXTRACTABLE_NOTICE;
    case 'choice_unavailable':
      return CHOICE_UNAVAILABLE_NOTICE;
    case 'choice_required':
      return CHOICE_REQUIRED_NOTICE;
    case 'capture_item_required':
      return CAPTURE_ITEM_REQUIRED_NOTICE;
    case 'capture_item_unavailable':
      return CAPTURE_ITEM_UNAVAILABLE_NOTICE;
    case 'encounter_not_offered':
      return ENCOUNTER_NOT_OFFERED_NOTICE;
    case 'encounter_available':
      return ENCOUNTER_STILL_HERE_NOTICE;
    case 'answer_required':
      return ANSWER_REQUIRED_NOTICE;
    default:
      return STALE_NOTICE;
  }
}

// ── confirmations ───────────────────────────────────────────────────────────

/** The Extract button carries the step this confirmation was drawn for. */
export function buildExtractConfirm(view: DungeonRunView): SessionPayload {
  const embed = new EmbedBuilder()
    .setTitle(truncate(`🚪 Extract from ${view.dungeon.name}?`, 256))
    .setColor(COLOR_GOOD)
    .setDescription(
      [
        `You'll bank all **${riskLines(view).join(' and ')}** and the run ends here, in ${truncate(roomName(view), 200)} with ${roomsLine(view)} rooms cleared.`,
        'Everything you have secured is already yours.',
        'There is no coming back to this run.',
      ].join('\n'),
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      row(
        button(dgId.extract(view.id, view.step), 'Extract', ButtonStyle.Success, '🚪'),
        button(dgId.run(view.id), 'Keep Going', ButtonStyle.Secondary),
      ),
    ],
    files: [],
  };
}

export function buildAbandonConfirm(view: DungeonRunView): SessionPayload {
  const retention = view.abandonRetentionBasisPoints ?? view.defeatRetentionBasisPoints;
  const shards = view.atRisk?.shards ?? view.core.unbankedCurrency;
  const bux = view.atRisk?.waifubux ?? view.core.unbankedWaifubux ?? 0;
  const shardShare = settleCurrency(shards, retention);
  const buxShare = settleCurrency(bux, retention);
  const embed = new EmbedBuilder()
    .setTitle(truncate(`🏳️ Abandon ${view.dungeon.name}?`, 256))
    .setColor(COLOR_BAD)
    .setDescription(
      [
        phase2(view)
          ? `Abandon: keep ${percent(retention)} of at-risk currency.`
          : `Abandoning: you keep ${percent(retention)} of your **${currencyAmount(view.currency, shards)}** unbanked.`,
        `${currencyName(view.currency)} — At risk: ${shards.toLocaleString('en-US')} · Keep: **${shardShare.banked.toLocaleString('en-US')}** · Lose: ${shardShare.lost.toLocaleString('en-US')}`,
        phase2(view) ? `WaifuBux — At risk: ${bux.toLocaleString('en-US')} · Keep: **${buxShare.banked.toLocaleString('en-US')}** · Lose: ${buxShare.lost.toLocaleString('en-US')}` : null,
        'Previously secured equipment, items, Essence and affection remain yours.',
        view.core.canExtract ? 'You are on an extraction point — extracting banks all of it instead.' : null,
      ]
        .filter((l): l is string => l != null)
        .join('\n'),
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      row(
        button(dgId.abandon(view.id, view.step), 'Abandon Run', ButtonStyle.Danger),
        button(dgId.run(view.id), 'Back to Run', ButtonStyle.Secondary),
      ),
    ],
    files: [],
  };
}

export function lockedDungeonsView(): SessionPayload {
  return { content: LOCKED_DUNGEONS, embeds: [], components: [row(menuButton())], files: [] };
}
