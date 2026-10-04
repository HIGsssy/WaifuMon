/**
 * Dungeon screens: the home (zones, or the active run), a zone's detail, the
 * run screen (the node the player is on, its result, the path ahead and the
 * end of the run) and the two confirmations. Pure builders from
 * `DungeonPlayService` read models.
 *
 * Every number shown is copied from the service — the run's *snapshotted*
 * Buddy and stats, never the player's live ones. Combat events are formatted
 * with the Combat Trials summary; the full log is never dumped. Gear Score is
 * not a thing here: the player sees real ATK / DEF / HP and depth.
 *
 * The progression currency is always named from its configured metadata
 * (singular, plural, icon). No name is written in this file.
 *
 * Custom ids (`dg` scope):
 *
 *   dg|home                      zones, or the active run
 *   dg|zone|<zoneKey>            zone detail
 *   dg|start|<zoneKey>           start a run
 *   dg|run|<runId>               the run as it stands (Resume)
 *   dg|enter|<runId>|<nodeId>    move onto an available node
 *   dg|go|<runId>|<nodeId>       resolve the node the player is on
 *   dg|exq|<runId>|<nodeId>      extraction confirmation
 *   dg|ex|<runId>|<nodeId>       extract
 *   dg|abq|<runId>               abandon confirmation
 *   dg|ab|<runId>                abandon
 *
 * Run and node ids are the idempotency keys: a second click of the same
 * button names the same transition, which the service replays.
 */
import { ActionRowBuilder, type AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { DungeonDailyAllowance } from '../modules/dungeons/dungeonAllowanceService';
import type {
  DungeonActionResult,
  DungeonCurrencyView,
  DungeonHomeView,
  DungeonNodeView,
  DungeonRunView,
  DungeonZoneCard,
  DungeonZoneDetailView,
} from '../modules/dungeons/dungeonPlayService';
import {
  hasRewards,
  type DungeonFighter,
  type DungeonRewards,
  type DungeonSecuredReward,
  type DungeonSettlement,
} from '../modules/dungeons/dungeonRunState';
import { BASIS_POINTS, type DungeonNodeType } from '../modules/dungeons/zoneDefinition';
import { EQUIPMENT_SLOTS } from '../modules/equipment/vocabulary';
import { formatProgressionAmount } from '../modules/progressionCurrency/progressionCurrencyService';
import { blockerLine, summarizeCombatEvents, type TrialArt } from './combatTrialPresenter';
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
export const REPLAYED_NOTICE = 'That was already resolved — here’s how it went.';
export const STALE_NOTICE = 'That path is no longer available — here’s where you are.';
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
  zone: (zoneKey: string) => buildCustomId('dg', 'zone', zoneKey),
  start: (zoneKey: string) => buildCustomId('dg', 'start', zoneKey),
  run: (runId: number) => buildCustomId('dg', 'run', String(runId)),
  enter: (runId: number, nodeId: string) => buildCustomId('dg', 'enter', String(runId), nodeId),
  resolve: (runId: number, nodeId: string) => buildCustomId('dg', 'go', String(runId), nodeId),
  extractConfirm: (runId: number, nodeId: string) => buildCustomId('dg', 'exq', String(runId), nodeId),
  extract: (runId: number, nodeId: string) => buildCustomId('dg', 'ex', String(runId), nodeId),
  abandonConfirm: (runId: number) => buildCustomId('dg', 'abq', String(runId)),
  abandon: (runId: number) => buildCustomId('dg', 'ab', String(runId)),
};

const NODE_LABEL: Readonly<Record<DungeonNodeType, string>> = {
  combat: 'Fight',
  elite: 'Elite',
  miniboss: 'Miniboss',
  boss: 'Boss',
  event: 'Event',
  reward: 'Cache',
  rest: 'Rest',
  exit: 'Exit',
};
const NODE_EMOJI: Readonly<Record<DungeonNodeType, string>> = {
  combat: '⚔️',
  elite: '💢',
  miniboss: '👹',
  boss: '👑',
  event: '❓',
  reward: '🎁',
  rest: '🔥',
  exit: '🚪',
};
/** The button that resolves a node the player is standing on. */
const RESOLVE_LABEL: Readonly<Record<DungeonNodeType, string>> = {
  combat: 'Fight',
  elite: 'Fight',
  miniboss: 'Fight',
  boss: 'Fight',
  event: 'Investigate',
  reward: 'Open',
  rest: 'Rest',
  exit: 'Step through',
};

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

/** `💠 12 Shards` from the configured metadata; a bare number when the zone's currency is gone. */
export function currencyAmount(currency: DungeonCurrencyView | null, amount: number): string {
  return currency ? formatProgressionAmount(currency, amount) : amount.toLocaleString('en-US');
}

function currencyName(currency: DungeonCurrencyView | null): string {
  return currency ? `${currency.icon ? `${currency.icon} ` : ''}${currency.pluralName}` : 'Progress';
}

function percent(basisPoints: number): string {
  return `${Number((basisPoints / (BASIS_POINTS / 100)).toFixed(2))}%`;
}

/**
 * `Fight — Alley Bruiser`, `Event — Flickering Terminal`, `Rest`. A room an
 * author named and that holds no enemy or event shows its name: `Rest — Repair Bay`.
 */
export function nodeTitle(node: DungeonNodeView): string {
  const what = node.enemy?.name ?? node.event?.name ?? node.label;
  return what ? `${NODE_LABEL[node.type]} — ${what}` : NODE_LABEL[node.type];
}

function depthRange(zone: DungeonZoneCard): string {
  return zone.minDepth === zone.maxDepth ? `${zone.minDepth}` : `${zone.minDepth}–${zone.maxDepth}`;
}

function fighterBlock(fighter: DungeonFighter, currentHp: number): string {
  return [
    `HP **${currentHp} / ${fighter.maxHp}**`,
    `ATK ${fighter.attack} · DEF ${fighter.defense}`,
  ].join('\n');
}

/** What a node or bonus paid, one line each. Item names resolved by the caller. */
export function rewardLines(
  rewards: DungeonRewards,
  currency: DungeonCurrencyView | null,
  itemName: (slug: string) => string,
): string[] {
  const lines: string[] = [];
  if (rewards.currency > 0) lines.push(`+${currencyAmount(currency, rewards.currency)} _(unbanked)_`);
  for (const gear of rewards.equipment) lines.push(`${SLOT_EMOJI[gear.slot]} **${gear.displayName}** (${gear.rarity}) — secured`);
  if (rewards.waifubux > 0) lines.push(`+${rewards.waifubux} WaifuBux`);
  for (const item of rewards.items) lines.push(`+${item.quantity} ${itemName(item.slug)}`);
  return lines;
}

/** A short roll-up of everything the run has secured so far. */
export function securedSummary(secured: readonly DungeonSecuredReward[], itemName: (slug: string) => string): string {
  if (secured.length === 0) return 'Nothing yet.';
  const lines: string[] = [];
  for (const s of secured) if (s.kind === 'equipment') lines.push(`${SLOT_EMOJI[s.slot]} ${s.displayName} (${s.rarity})`);
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

function zoneField(zone: DungeonZoneCard): { name: string; value: string } {
  const lines = [
    zone.description ? `_${truncate(zone.description, 300)}_` : null,
    `Depth: **${depthRange(zone)}** nodes${zone.hasBoss ? ' · ends in a boss' : ''}`,
    zone.currency ? `Pays: ${currencyName(zone.currency)} · you hold **${currencyAmount(zone.currency, zone.balance)}**` : null,
  ].filter((l): l is string => l != null);
  return { name: truncate(zone.name, 256), value: lines.join('\n') };
}

export interface DungeonScreenOptions {
  itemName(slug: string): string;
  art?: TrialArt;
  status?: string | null;
}

/** The home: the active run when there is one, otherwise the open zones. */
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
          `You have a run in progress in **${run.zone.name}**.`,
          // Resuming never needs an attempt: the run was paid for when it started.
          view.daily.remaining <= 0 ? 'Out of new runs for today — this one is still yours to finish.' : null,
        ]
          .filter((l): l is string => l != null)
          .join('\n'),
      )
      .addFields(
        { name: 'Where', value: `Depth ${run.depth} / ${run.depthCount} — ${nodeTitle(run.node)}`, inline: true },
        { name: truncate(run.fighter.name, 200), value: fighterBlock(run.fighter, run.currentHp), inline: true },
        { name: `Unbanked ${currencyName(run.currency)}`, value: currencyAmount(run.currency, run.unbankedCurrency) },
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
        view.zones.length
          ? 'Take your Buddy into a dungeon. HP carries from fight to fight — push deeper for more, or get out while you can.'
          : NO_ZONES,
      ].join('\n'),
    );
  const shown = view.zones.slice(0, 5);
  if (shown.length) embed.addFields({ name: 'Available Delves', value: `Open in ${view.region.name}:` });
  for (const zone of shown) embed.addFields(zoneField(zone));
  applyArt(embed, opts.art ?? {});
  const blocked = blockerLine(view.blocker);
  if (blocked) embed.addFields({ name: '⚠️ Can’t start yet', value: blocked });
  const spent = dailyLimitLine(view.daily);
  if (spent) embed.addFields({ name: '⏳ No runs left today', value: spent });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (view.unplayableRunId != null) {
    embed.addFields({ name: 'Stuck run', value: 'You have a run that cannot be played. Abandon it to start a new one.' });
    components.push(row(button(dgId.abandon(view.unplayableRunId), 'Abandon stuck run', ButtonStyle.Danger)));
  } else if (shown.length) {
    components.push(row(...shown.map((z) => button(dgId.zone(z.key), z.name, ButtonStyle.Primary))));
  }
  components.push(row(menuButton()));
  return { content: opts.status ?? '', embeds: [embed], components, files: files(opts.art ?? {}) };
}

// ── zone detail ─────────────────────────────────────────────────────────────

export function buildZoneDetail(view: DungeonZoneDetailView, opts: DungeonScreenOptions): SessionPayload {
  const { zone, stats, blocker } = view;
  const embed = new EmbedBuilder().setTitle(truncate(zone.name, 256)).setColor(COLOR);
  if (zone.description) embed.setDescription(zone.description);

  if (stats.buddy) {
    const gear = EQUIPMENT_SLOTS.map((slot) => `${SLOT_EMOJI[slot]} ${stats.loadout.slots[slot]?.name ?? EMPTY_SLOT}`);
    embed.addFields({
      name: `Your Buddy — ${truncate(stats.buddy.name, 200)}`,
      value: [
        `Current SP **${stats.buddy.currentSp}**`,
        `ATK ${stats.stats.attack ?? EMPTY_SLOT} · DEF ${stats.stats.defense ?? EMPTY_SLOT} · HP ${stats.stats.maxHp ?? EMPTY_SLOT}`,
        ...gear,
      ].join('\n'),
      inline: true,
    });
  } else {
    embed.addFields({ name: 'Your Buddy', value: 'No active Buddy.', inline: true });
  }
  embed.addFields({
    name: 'The run',
    value: [
      `Depth: **${depthRange(zone)}** nodes${zone.hasBoss ? ', ending in a boss' : ''}`,
      'HP carries between fights.',
      zone.currency
        ? `${currencyName(zone.currency)} are banked when you extract or finish. If you fall, you keep ${percent(zone.defeatRetentionBasisPoints)}.`
        : null,
      'Gear you find is yours at once.',
    ]
      .filter((l): l is string => l != null)
      .join('\n'),
    inline: true,
  });
  if (zone.currency) embed.addFields({ name: 'You hold', value: currencyAmount(zone.currency, zone.balance) });
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
    actions.push(button(dgId.start(zone.key), 'Start Run', ButtonStyle.Success, '⛏️').setDisabled(blocker != null || spent != null));
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

/** What the node the player is standing on holds, before it is resolved. */
function nodeBrief(view: DungeonRunView): string {
  const { node } = view;
  if (node.enemy) {
    return `**${node.enemy.name}**\nATK ${node.enemy.attack} · DEF ${node.enemy.defense} · HP ${node.enemy.hp}`;
  }
  if (node.event) return `**${node.event.name}**\n${node.event.description}`.trim();
  if (node.type === 'rest') {
    return `A quiet corner. Resting restores **${percent(node.restHealBasisPoints ?? 0)}** of max HP.`;
  }
  if (node.type === 'reward') return 'A sealed cache.';
  return node.terminal ? 'The way out.' : 'A way back to the surface.';
}

/** What resolving the current node did. */
function resolutionBlock(view: DungeonRunView, opts: DungeonScreenOptions): { name: string; value: string }[] {
  const r = view.resolution;
  if (!r) return [];
  const fields: { name: string; value: string }[] = [];
  const paid = (rewards: DungeonRewards) => {
    if (hasRewards(rewards)) {
      fields.push({ name: 'Rewards', value: truncate(rewardLines(rewards, view.currency, opts.itemName).join('\n'), 1024) });
    }
  };
  switch (r.kind) {
    case 'combat': {
      const word = r.result === 'player_victory' ? '🏆 Victory' : r.result === 'enemy_victory' ? '💀 Defeat' : '⏱️ Stalemate';
      fields.push({
        name: `${word} — ${truncate(r.enemyName, 200)}`,
        value: [
          `Your HP: ${r.hpBefore} → **${r.hpAfter}** / ${view.fighter.maxHp}`,
          `${r.enemyName}: ${r.enemyHpAfter} / ${r.enemyMaxHp}`,
          `Rounds: ${r.rounds}`,
        ].join('\n'),
      });
      if (view.combatEvents?.length) {
        fields.push({ name: 'Combat summary', value: truncate(summarizeCombatEvents(view.combatEvents).join('\n'), 1024) });
      }
      paid(r.rewards);
      break;
    }
    case 'rest':
      fields.push({
        name: '🔥 Rested',
        value: `HP ${r.hpBefore} → **${r.hpAfter}** / ${view.fighter.maxHp} (+${r.hpAfter - r.hpBefore})`,
      });
      break;
    case 'event': {
      const delta = r.hpAfter - r.hpBefore;
      fields.push({
        name: `❓ ${truncate(view.node.event?.name ?? 'Event', 200)}`,
        value:
          delta === 0
            ? 'Nothing here changes your footing.'
            : `HP ${r.hpBefore} → **${r.hpAfter}** / ${view.fighter.maxHp} (${delta > 0 ? '+' : ''}${delta})`,
      });
      paid(r.rewards);
      break;
    }
    case 'reward':
      if (hasRewards(r.rewards)) paid(r.rewards);
      else fields.push({ name: '🎁 Cache', value: 'Empty.' });
      break;
    case 'exit':
      fields.push({ name: '🚪 Exit', value: 'The way out is open.' });
      break;
  }
  return fields;
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
  const total = s.earned + s.bonusCurrency;
  const lines = [`Depth reached: **${s.depth} / ${view.depthCount}**`, `HP: ${s.finalHp} / ${view.fighter.maxHp}`];
  if (s.cause === 'stalemate') lines.push('The fight ran out the clock — you were forced back.');
  lines.push(`Earned: ${currencyAmount(view.currency, s.earned)}`);
  if (s.bonusCurrency > 0) {
    lines.push(`${s.outcome === 'completed' ? 'Completion' : 'Extraction'} bonus: +${currencyAmount(view.currency, s.bonusCurrency)}`);
  }
  if (s.bankingSkipped) {
    lines.push(`Banked: nothing — ${currencyName(view.currency)} cannot be banked right now.`);
  } else if (s.retentionBasisPoints < BASIS_POINTS) {
    lines.push(`Kept (${percent(s.retentionBasisPoints)}): **${currencyAmount(view.currency, s.banked)}** · Lost: ${currencyAmount(view.currency, s.lost)}`);
  } else {
    lines.push(`Banked: **${currencyAmount(view.currency, s.banked)}**${total === 0 ? '' : ' — all of it'}`);
  }
  if (s.balanceAfter != null) lines.push(`You now hold ${currencyAmount(view.currency, s.balanceAfter)}.`);
  return lines;
}

/**
 * The run screen. One builder for every state of a run: standing on an
 * unresolved node, looking at its result with the path ahead, and the end.
 */
export function buildRunScreen(view: DungeonRunView, opts: DungeonScreenOptions): SessionPayload {
  const over = view.status !== 'active';
  const { node } = view;
  const embed = new EmbedBuilder()
    .setTitle(
      truncate(
        over && view.settlement
          ? `${OUTCOME_TITLE[view.settlement.outcome]} — ${view.zone.name}`
          : `${view.zone.name} — Depth ${view.depth} / ${view.depthCount}`,
        256,
      ),
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

  if (view.nodeStatus === 'entered' && !over) {
    embed.setDescription(`${NODE_EMOJI[node.type]} **${NODE_LABEL[node.type]}**\n${nodeBrief(view)}`);
  } else {
    embed.setDescription(`${NODE_EMOJI[node.type]} ${nodeTitle(node)}`);
    embed.addFields(...resolutionBlock(view, opts));
  }

  embed.addFields({ name: truncate(view.fighter.name, 200), value: fighterBlock(view.fighter, view.currentHp), inline: true });
  if (over) {
    embed.addFields({ name: 'Result', value: settlementLines(view).join('\n') || '—' });
    const bonus = view.settlement?.bonusRewards;
    if (bonus && hasRewards({ ...bonus, currency: 0 })) {
      embed.addFields({ name: 'Bonus rewards', value: rewardLines({ ...bonus, currency: 0 }, view.currency, opts.itemName).join('\n') });
    }
    embed.addFields({ name: 'Secured — yours to keep', value: securedSummary(view.secured, opts.itemName) });
  } else {
    embed.addFields(
      { name: `Unbanked ${currencyName(view.currency)}`, value: currencyAmount(view.currency, view.unbankedCurrency), inline: true },
      { name: 'Secured', value: securedSummary(view.secured, opts.itemName), inline: true },
    );
    if (node.extraction) {
      embed.addFields({
        name: '🚪 Extraction point',
        value: view.canExtract
          ? `You can leave here and bank all ${currencyAmount(view.currency, view.unbankedCurrency)}.`
          : 'You can leave from here once this node is done.',
      });
    }
  }

  const art = opts.art ?? {};
  applyArt(embed, art);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (over) {
    components.push(row(homeButton('Delve Again'), menuButton()));
  } else if (view.nodeStatus === 'entered') {
    const fights = node.enemy != null;
    components.push(
      row(
        button(
          dgId.resolve(view.id, node.id),
          RESOLVE_LABEL[node.type],
          fights ? ButtonStyle.Danger : ButtonStyle.Primary,
          NODE_EMOJI[node.type],
        ),
      ),
      row(button(dgId.abandonConfirm(view.id), 'Abandon', ButtonStyle.Secondary), menuButton()),
    );
  } else {
    const paths = view.next.map((n) =>
      button(
        dgId.enter(view.id, n.id),
        view.next.length === 1 ? `Continue — ${nodeTitle(n)}` : nodeTitle(n),
        ButtonStyle.Primary,
        NODE_EMOJI[n.type],
      ),
    );
    if (view.next.length > 1) embed.addFields({ name: 'Path ahead', value: view.next.map((n) => `${NODE_EMOJI[n.type]} ${nodeTitle(n)}`).join('\n') });
    if (view.canExtract) paths.push(button(dgId.extractConfirm(view.id, node.id), 'Extract', ButtonStyle.Success, '🚪'));
    if (paths.length) components.push(row(...paths));
    components.push(row(button(dgId.abandonConfirm(view.id), 'Abandon', ButtonStyle.Secondary), menuButton()));
  }
  return { content: opts.status ?? '', embeds: [embed], components, files: files(art) };
}

/** The status line for an action's result; null when it simply happened. */
export function actionNotice(result: Pick<DungeonActionResult, 'status' | 'refusal'>): string | null {
  if (result.status === 'applied') return null;
  if (result.status === 'replayed') return REPLAYED_NOTICE;
  switch (result.refusal) {
    case 'run_over':
      return RUN_OVER_NOTICE;
    case 'not_extractable':
      return NOT_EXTRACTABLE_NOTICE;
    default:
      return STALE_NOTICE;
  }
}

// ── confirmations ───────────────────────────────────────────────────────────

export function buildExtractConfirm(view: DungeonRunView): SessionPayload {
  const embed = new EmbedBuilder()
    .setTitle(`🚪 Extract from ${truncate(view.zone.name, 200)}?`)
    .setColor(COLOR_GOOD)
    .setDescription(
      [
        `You'll bank all **${currencyAmount(view.currency, view.unbankedCurrency)}** and the run ends here, at depth ${view.depth} / ${view.depthCount}.`,
        'Everything you have secured is already yours.',
        'There is no coming back to this run.',
      ].join('\n'),
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      row(
        button(dgId.extract(view.id, view.node.id), 'Extract', ButtonStyle.Success, '🚪'),
        button(dgId.run(view.id), 'Keep Going', ButtonStyle.Secondary),
      ),
    ],
    files: [],
  };
}

export function buildAbandonConfirm(view: DungeonRunView): SessionPayload {
  const embed = new EmbedBuilder()
    .setTitle(`🏳️ Abandon ${truncate(view.zone.name, 200)}?`)
    .setColor(COLOR_BAD)
    .setDescription(
      [
        `Abandoning counts as a defeat: you keep ${percent(view.defeatRetentionBasisPoints)} of your **${currencyAmount(view.currency, view.unbankedCurrency)}** unbanked.`,
        'Everything you have secured is already yours.',
        view.canExtract ? 'You are on an extraction point — extracting banks all of it instead.' : null,
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
