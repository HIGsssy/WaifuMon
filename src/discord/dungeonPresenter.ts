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
 *   dg|exq|<runId>                  extraction confirmation
 *   dg|ex|<runId>|<step>            extract
 *   dg|abq|<runId>                  abandon confirmation
 *   dg|ab|<runId>                   abandon
 *
 * `<step>` is the run's step when the button was drawn. The service refuses an
 * input whose step is not the run's current one, so a stale or double-clicked
 * button changes nothing. Abandoning carries no step: it is always allowed.
 */
import { ActionRowBuilder, type AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, embedLength } from 'discord.js';
import { BASIS_POINTS, type DungeonActionType } from '../modules/dungeons/content/dungeonDefinition';
import type { DungeonDailyAllowance } from '../modules/dungeons/dungeonAllowanceService';
import { fighterModifiers, type DungeonFighter } from '../modules/dungeons/dungeonFighter';
import type {
  DungeonActionResult,
  DungeonCard,
  DungeonCurrencyView,
  DungeonDetailView,
  DungeonHomeView,
  DungeonRunView,
  DungeonSecuredReward,
  DungeonSettlement,
} from '../modules/dungeons/dungeonRunService';
import type { DungeonRecentEntry, DungeonWaveResult } from '../modules/dungeons/engine/types';
import type { DungeonActionView, DungeonConnectionView } from '../modules/dungeons/engine/view';
import { formatCombatBonus, type CombatBonus } from '../modules/equipment/combatBonuses';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from '../modules/equipment/vocabulary';
import { formatProgressionAmount } from '../modules/progressionCurrency/progressionCurrencyService';
import { blockerLine, modifiersLine, summarizeCombatEvents, type TrialArt } from './combatTrialPresenter';
import type { SessionPayload } from './ephemeralSession';
import { EMPTY_SLOT, SLOT_EMOJI } from './equipmentPresenter';
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
  extractConfirm: (runId: number) => buildCustomId('dg', 'exq', String(runId)),
  extract: (runId: number, step: number) => buildCustomId('dg', 'ex', String(runId), String(step)),
  abandonConfirm: (runId: number) => buildCustomId('dg', 'abq', String(runId)),
  abandon: (runId: number) => buildCustomId('dg', 'ab', String(runId)),
};

const ACTION_HEADING: Readonly<Record<DungeonActionType, string>> = {
  combat: 'Fight',
  boss: 'Boss',
  rest: 'Rest',
  gate: 'Barred way',
  set_flag: 'Something stirs',
  leave: 'Way on',
  reward: 'Cache',
};
const ACTION_EMOJI: Readonly<Record<DungeonActionType, string>> = {
  combat: '⚔️',
  boss: '👑',
  rest: '🔥',
  gate: '🚪',
  set_flag: '✨',
  leave: '🚪',
  reward: '🎁',
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
};

/** Discord: five buttons to a row, five rows to a message. Three rows are the connections'. */
const BUTTONS_PER_ROW = 5;
const CONNECTION_ROWS = 3;
const MAX_CONNECTION_BUTTONS = BUTTONS_PER_ROW * CONNECTION_ROWS;
/** Wave results shown in full after a step that fought several. */
const MAX_WAVE_FIELDS = 3;
const EMBED_TOTAL_LIMIT = 6000;

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
  for (const r of planned) summary.currency += r.plan.currency;
  for (const s of view.latestSecured) {
    if (s.kind === 'equipment') summary.equipment.push(s);
    else if (s.kind === 'waifubux') summary.waifubux += s.amount;
    else summary.items.push({ slug: s.slug, quantity: s.quantity });
  }
  return summary;
}

/** A short roll-up of everything the run has secured so far. */
export function securedSummary(secured: readonly DungeonSecuredReward[], itemName: (slug: string) => string): string {
  if (secured.length === 0) return 'Nothing yet.';
  const lines: string[] = [];
  for (const s of secured) if (s.kind === 'equipment') lines.push(`${slotEmoji(s.slot)} ${s.displayName} (${s.rarity})`);
  const bux = secured.reduce((sum, s) => sum + (s.kind === 'waifubux' ? s.amount : 0), 0);
  if (bux > 0) lines.push(`${bux} WaifuBux`);
  const itemTotals = new Map<string, number>();
  for (const s of secured) if (s.kind === 'item') itemTotals.set(s.slug, (itemTotals.get(s.slug) ?? 0) + s.quantity);
  for (const [slug, quantity] of itemTotals) lines.push(`${quantity} ${itemName(slug)}`);
  return truncate(lines.join('\n'), 1024);
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
  ].filter((l): l is string => l != null);
  return { name: truncate(dungeon.name, 256), value: lines.join('\n') };
}

export interface DungeonScreenOptions {
  itemName(slug: string): string;
  art?: TrialArt;
  status?: string | null;
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
        { name: `Unbanked ${currencyName(run.currency)}`, value: currencyAmount(run.currency, run.core.unbankedCurrency) },
        { name: 'Secured', value: securedSummary(run.secured, opts.itemName) },
      );
    const art = opts.art ?? {};
    applyArt(embed, art);
    return {
      content: opts.status ?? '',
      embeds: [embed],
      components: [
        row(
          button(dgId.run(run.id), 'Resume', ButtonStyle.Primary, '▶️'),
          button(dgId.abandonConfirm(run.id), 'Abandon', ButtonStyle.Danger),
        ),
        row(menuButton()),
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
  return { content: opts.status ?? '', embeds: [embed], components, files: files(opts.art ?? {}) };
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
      'Gear you find is yours at once.',
    ]
      .filter((l): l is string => l != null)
      .join('\n'),
    inline: true,
  });
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
  return {
    content: opts.status ?? '',
    embeds: [embed],
    components: [row(...actions), row(homeButton('All Dungeons'), menuButton())],
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
      default:
        break;
    }
  }

  const rewards = latestRewards(view);
  if (rewards) {
    fields.push(
      hasRewards(rewards)
        ? { name: '🎁 Rewards', value: truncate(rewardLines(rewards, view.currency, opts.itemName).join('\n'), 1024) }
        : { name: '🎁 Cache', value: 'Empty.' },
    );
  }
  return { lines, fields };
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

function actionButtons(view: DungeonRunView, action: DungeonActionView): ButtonBuilder[] {
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

/** Discord refuses an embed over 6000 characters in all; the description gives way first. */
function fitEmbed(embed: EmbedBuilder): void {
  const over = embedLength(embed.data) - EMBED_TOTAL_LIMIT;
  const description = embed.data.description;
  if (over > 0 && description) embed.setDescription(truncate(description, Math.max(1, description.length - over)));
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
      body.push(actionBrief(core.action));
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

  embed.addFields({ name: truncate(view.fighter.name, 200), value: fighterBlock(view.fighter, core.hp, core.maxHp), inline: true });
  if (over) {
    embed.addFields(
      { name: 'Result', value: truncate(settlementLines(view).join('\n'), 1024) || '—' },
      { name: 'Secured — yours to keep', value: securedSummary(view.secured, opts.itemName) },
    );
  } else {
    embed.addFields(
      { name: `Unbanked ${currencyName(view.currency)}`, value: currencyAmount(view.currency, core.unbankedCurrency), inline: true },
      { name: 'Secured', value: securedSummary(view.secured, opts.itemName), inline: true },
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
          ? `You can leave here and bank all ${currencyAmount(view.currency, core.unbankedCurrency)}.`
          : 'You can leave from here once this room is done.',
      });
    }
  }
  fitEmbed(embed);

  const art = opts.art ?? {};
  applyArt(embed, art);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (over) {
    components.push(row(homeButton('Delve Again'), menuButton()));
  } else {
    if (core.phase === 'action' && core.action) {
      components.push(row(...actionButtons(view, core.action)));
    } else {
      for (const group of chunk(buttoned, BUTTONS_PER_ROW)) components.push(row(...group.map((c) => connectionButton(view, c))));
    }
    const last: ButtonBuilder[] = [];
    if (core.canExtract) last.push(button(dgId.extractConfirm(view.id), 'Extract', ButtonStyle.Success, '🚪'));
    last.push(button(dgId.abandonConfirm(view.id), 'Abandon', core.stuck ? ButtonStyle.Danger : ButtonStyle.Secondary), menuButton());
    components.push(row(...last));
  }
  return { content: opts.status ?? '', embeds: [embed], components, files: files(art) };
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
        `You'll bank all **${currencyAmount(view.currency, view.core.unbankedCurrency)}** and the run ends here, in ${truncate(roomName(view), 200)} with ${roomsLine(view)} rooms cleared.`,
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
  const embed = new EmbedBuilder()
    .setTitle(truncate(`🏳️ Abandon ${view.dungeon.name}?`, 256))
    .setColor(COLOR_BAD)
    .setDescription(
      [
        `Abandoning counts as a defeat: you keep ${percent(view.defeatRetentionBasisPoints)} of your **${currencyAmount(view.currency, view.core.unbankedCurrency)}** unbanked.`,
        'Everything you have secured is already yours.',
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
        button(dgId.abandon(view.id), 'Abandon Run', ButtonStyle.Danger),
        button(dgId.run(view.id), 'Back to Run', ButtonStyle.Secondary),
      ),
    ],
    files: [],
  };
}

export function lockedDungeonsView(): SessionPayload {
  return { content: LOCKED_DUNGEONS, embeds: [], components: [row(menuButton())], files: [] };
}
