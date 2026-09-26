/**
 * Expeditions — the Discord screens.
 *
 * Presentation and orchestration only. Every rule lives in
 * `modules/expeditions`: this file never computes a chance, never rolls a
 * reward, never decides whether a mission is due, and never writes a row. It
 * calls the service and renders what comes back.
 *
 * Three conventions carry most of the weight:
 *
 *   - **Match quality is the contract.** No percentage reaches a player on any
 *     screen. The service returns how well she fits the mission (PERFECT …
 *     POOR MATCH) and never exposes `successChance`, so this file could not
 *     leak one even by accident — there is nothing to read. Match quality is
 *     a separate model from the hidden chance, not a relabelling of it.
 *     Candidate rows explain a match with *chips* (`Dominant ✓`) rather
 *     than numbers, so the player learns which WaifuMon suits which mission
 *     without being handed the formula.
 *
 *   - **Time is Discord's job.** Completion is rendered with `<t:…:R>`, so the
 *     client counts down locally. No timer, no message-edit loop, no drift,
 *     and the countdown keeps working while the bot is down.
 *
 *   - **Opening the screen is what resolves a mission.** `getActive` resolves
 *     anything due before returning, so every entry point below runs it first
 *     and the resolve path is exercised constantly rather than on a rare timer.
 *
 *   - **A player has missions, plural.** Concurrency is regional: one active
 *     mission per region, as many regions as the player can reach. So the
 *     front door is an *overview* of every region with something running, the
 *     single-mission screen is one press below it, and the board says plainly
 *     whether the region the player is standing in is already taken. No screen
 *     counts slots, because there are none to count.
 *
 * Stale controls are expected, not exceptional: a custom id is a string that
 * outlives the message that painted it. Every handler re-reads state and
 * re-renders rather than trusting its own arguments, and the conditional
 * updates in the service mean a stale press can refuse but never double-apply.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AppError } from '../../shared/errors';
import type { AppContext, PlayerInteraction, Provisioned } from '../types';
import { buildCustomId } from '../types';
import { respondEphemeral } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import { gameEvent } from '../../modules/events/gameEvents';
import { regionLabel } from '../../modules/locations/regions';
import { affinityLabel } from '../../modules/capture/affinityMath';
import type {
  ExpeditionBoard,
  ExpeditionCandidate,
  ExpeditionClaimResult,
  ExpeditionView,
} from '../../modules/expeditions/types';
import type { MatchVerdict } from '../../modules/expeditions/expeditionMatch';
import type {
  ExpeditionRewardPayload,
  RewardTableKind,
} from '../../modules/expeditions/expeditionRewards';
import type { MatchQuality, RegionalExpedition } from '../../modules/content/schemas';

type Rows = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
interface Screen {
  embeds: EmbedBuilder[];
  components: Rows;
}

const COLOR_BOARD = 0x8ec7ff;
const COLOR_ACTIVE = 0xffc46f;
const COLOR_SUCCESS = 0x6fdc8c;
const COLOR_EXCEPTIONAL = 0xffd76f;
const COLOR_FAILURE = 0xb0b6c0;
const COLOR_DANGER = 0xff6f6f;

/**
 * Match-quality presentation, best to worst. Describes *fit* — how many of the
 * mission's stated requirements she meets — never the hidden success chance.
 * Deliberately not a green-to-red ramp: a poor match is a choice the game
 * wants players to be able to make, not a mistake it wants to scold.
 */
const MATCH_DISPLAY: Readonly<Record<MatchQuality, { icon: string; label: string }>> = {
  PERFECT_MATCH: { icon: '★', label: 'PERFECT MATCH' },
  STRONG_MATCH: { icon: '✦', label: 'STRONG MATCH' },
  PARTIAL_MATCH: { icon: '✧', label: 'PARTIAL MATCH' },
  WEAK_MATCH: { icon: '·', label: 'WEAK MATCH' },
  POOR_MATCH: { icon: '✗', label: 'POOR MATCH' },
};

/** Broad reward-preview vocabulary → what a player sees on the board. */
const PREVIEW_DISPLAY: Readonly<Record<string, string>> = {
  waifubux: '💰 WaifuBux',
  essence: '✨ Essence',
  salvage: '📦 Salvage',
  charms: '🎀 Charms',
  consumables: '🧃 Consumables',
  waifu_xp: '📈 WaifuMon XP',
  rare_find: '🌟 Rare find',
  key_item: '🔑 Key item',
};

export function matchTag(quality: MatchQuality): string {
  const display = MATCH_DISPLAY[quality];
  return `${display.label} ${display.icon}`;
}

/** `<t:…:R>` — Discord renders and counts this down on the client. */
function relativeTimestamp(at: Date): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

/** "6h", "2h 30m", "45m" — a duration a player reads at a glance. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function previewLine(previews: readonly string[]): string {
  if (previews.length === 0) return '_Rewards unknown._';
  return previews.map((p) => PREVIEW_DISPLAY[p] ?? p).join(' · ');
}

/**
 * What a mission is looking for, as chips rather than numbers.
 *
 * This is the non-numeric half of the explanation: the board says "wants
 * Dominant, Demon", the candidate row says whether *she* is those things, and
 * between them the player can reason about the match without ever being shown
 * a percentage.
 */
function preferenceLine(definition: RegionalExpedition): string | null {
  const parts: string[] = [];
  if (definition.preferredAffinities.length > 0) {
    parts.push(definition.preferredAffinities.map(affinityLabel).join(' / '));
  }
  if (definition.preferredRaces.length > 0) {
    parts.push(definition.preferredRaces.map(raceLabel).join(' / '));
  }
  if (parts.length === 0) return null;
  return `Prefers: ${parts.join(' • ')}`;
}

/** "demi-human" → "Demi-Human". */
export function raceLabel(race: string): string {
  return race
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

/**
 * "returns in …" or "ready to collect", for one open mission.
 *
 * `resolved` is the only status besides `active` that reaches these screens,
 * and it is the one the player is waiting for, so it gets the louder phrasing.
 */
function timingLine(view: ExpeditionView): string {
  return view.status === 'resolved'
    ? '✅ **Back — ready to collect**'
    : `⏳ Returns ${relativeTimestamp(view.completesAt)}`;
}

/** `🗺️ Waifu Valley — Lilith · Supply Run`, for a one-line roll-call. */
function missionSummaryLine(view: ExpeditionView): string {
  return `**${regionLabel(view.region)}** — ${view.waifuName} · ${view.name}`;
}

// ────────────────────────── Active overview ──────────────────────────

/**
 * Every region the player has something running in.
 *
 * The front door once a player has deployed anything, and the screen the
 * regional-concurrency change exists to make possible. It answers the two
 * questions a multi-region player actually has — *who is where*, and *is
 * anything ready* — without making them travel anywhere to find out.
 *
 * Capped at five entries for Discord's sake: five is also the number of
 * regions, so the cap is defensive rather than reachable. If a per-region
 * ladder ever makes it reachable, the overflow is stated rather than silently
 * dropped.
 */
const OVERVIEW_LIMIT = 5;

function overviewScreen(views: readonly ExpeditionView[], statusLine?: string): Screen {
  const shown = views.slice(0, OVERVIEW_LIMIT);
  const ready = shown.filter((v) => v.status === 'resolved').length;

  const embed = new EmbedBuilder()
    .setTitle('🧭 Your Expeditions')
    .setColor(ready > 0 ? COLOR_SUCCESS : COLOR_ACTIVE)
    .setDescription(
      [
        statusLine ?? null,
        `**${views.length}** ${views.length === 1 ? 'region' : 'regions'} working` +
          (ready > 0 ? ` · **${ready}** ready to collect` : ''),
        // The rule, stated once where a player can act on it, rather than
        // discovered by being refused at the board.
        '_One expedition per region — travel somewhere new to send another._',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );

  for (const view of shown) {
    embed.addFields({
      name: `${view.emoji ?? '•'} ${regionLabel(view.region)} — ${view.name}`,
      value: [
        `👤 **${view.waifuName}**` + (view.match ? ` · ${matchTag(view.match)}` : ''),
        timingLine(view),
      ].join('\n'),
    });
  }
  if (views.length > shown.length) {
    embed.addFields({
      name: '​',
      value: `_…and ${views.length - shown.length} more._`,
    });
  }

  // One button per region, so the label says where rather than what — that is
  // the thing the player is choosing between. Five fit in a single row.
  const missionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    shown.map((view) =>
      new ButtonBuilder()
        .setCustomId(buildCustomId('exp', 'mission', String(view.id)))
        .setLabel(
          `${regionLabel(view.region)}${view.status === 'resolved' ? ' — collect' : ''}`.slice(
            0,
            80,
          ),
        )
        .setStyle(view.status === 'resolved' ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );

  return {
    embeds: [embed],
    components: [
      missionRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'board'))
          .setLabel('Board here')
          .setEmoji('🗺️')
          .setStyle(ButtonStyle.Primary),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
      backRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    ],
  };
}

// ─────────────────────────────── Board ───────────────────────────────

function backRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('menu', 'back'))
      .setLabel('⟵ Back')
      .setStyle(ButtonStyle.Secondary),
  );
}

function boardScreen(board: ExpeditionBoard, statusLine?: string): Screen {
  const embed = new EmbedBuilder()
    .setTitle(`🗺️ Expeditions — ${regionLabel(board.regionId)}`)
    .setColor(COLOR_BOARD);

  const status = statusLine ? `${statusLine}\n\n` : '';

  if (!board.enabled) {
    embed.setDescription(
      `${status}_Expeditions are closed for now. Check back soon~_`,
    );
    return { embeds: [embed], components: [backRow()] };
  }
  if (board.entries.length === 0) {
    embed.setDescription(
      `${status}_Nobody around here is hiring today._\n\n` +
        'Try again after the board rotates, or travel somewhere busier.',
    );
    embed.setFooter({ text: 'Board rotates' });
    embed.setTimestamp(board.rotatesAt);
    return { embeds: [embed], components: [backRow()] };
  }

  /**
   * The regional-concurrency statement, in the one place a player is about to
   * act on it.
   *
   * A busy region is stated *first* and in full — who is out, on what, and
   * when she is back — because the alternative is a player pressing a mission
   * and being refused, which teaches the rule the slow way. A busy region
   * *elsewhere* is never a refusal, so it is a footnote rather than a warning.
   */
  const busy = board.regionMission;
  embed.setDescription(
    [
      status.trimEnd() || null,
      busy
        ? `🚩 **${busy.waifuName}** is already working this region on **${busy.name}**.\n` +
          `${timingLine(busy)} — collect or recall her before sending anyone else here.`
        : 'Send one WaifuMon on a timed job. She is unavailable until she returns.',
      `Board rotates ${relativeTimestamp(board.rotatesAt)}`,
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  );

  // Where else she has people out. Never a blocker — it is here so "which
  // regions am I already using" is answerable without leaving the board.
  if (board.elsewhere.length > 0) {
    embed.addFields({
      name: 'Also out',
      value: board.elsewhere
        .map((view) => `${view.emoji ?? '•'} ${missionSummaryLine(view)} — ${timingLine(view)}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  for (const { definition } of board.entries) {
    const lines = [
      definition.description ? `_${definition.description}_` : null,
      `⏱️ ${formatDuration(definition.durationMinutes)} · Recommended Lv **${definition.recommendedLevel}**`,
      preferenceLine(definition),
      previewLine(definition.rewardPreview),
    ].filter(Boolean) as string[];
    embed.addFields({
      name: `${definition.emoji ?? '•'} ${definition.name}`,
      value: lines.join('\n'),
    });
  }

  // One button per mission. The board is capped at `boardSize` in content
  // (4 by default) and Discord allows 5 per row, so a single row holds a
  // sensible board; a larger one chunks across rows and the Back row still
  // fits inside the five-row message limit for boards up to 15.
  const buttons = board.entries.map(({ definition }) => {
    const button = new ButtonBuilder()
      .setCustomId(buildCustomId('exp', 'view', definition.key))
      .setLabel(definition.name.slice(0, 80))
      .setStyle(ButtonStyle.Primary)
      // Greyed out rather than hidden while this region is busy. The board is
      // still the honest list of what is on offer here — the player simply
      // cannot take any of it until the region frees up, and a disabled row
      // says that far more plainly than four missing buttons would.
      .setDisabled(!board.canDeploy);
    if (definition.emoji) button.setEmoji(definition.emoji);
    return button;
  });

  const rows: Rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + 5),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    );
  }
  // The way out of a busy region: straight to the WaifuMon holding it, or to
  // the roll-call of every region. Painted only when something is running, so
  // a first-time board keeps its original two-row shape.
  const openCount = board.elsewhere.length + (busy ? 1 : 0);
  if (openCount > 0) {
    const navRow = new ActionRowBuilder<ButtonBuilder>();
    if (busy) {
      navRow.addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'mission', String(busy.id)))
          .setLabel(
            (busy.status === 'resolved' ? 'Collect her' : `Check on ${busy.waifuName}`).slice(0, 80),
          )
          .setEmoji(busy.status === 'resolved' ? '📦' : '🧭')
          .setStyle(busy.status === 'resolved' ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
    }
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('exp', 'active'))
        .setLabel(`All expeditions (${openCount})`)
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(navRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  }
  rows.push(backRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  return { embeds: [embed], components: rows };
}

// ─────────────────────────── Active mission ───────────────────────────

/**
 * One mission, in full.
 *
 * `openCount` is how many regions the player has running in total, and is used
 * for one thing: deciding whether to offer the way back up to the overview. A
 * player with a single mission should not be handed a button to a list of one.
 */
function activeScreen(
  view: ExpeditionView,
  statusLine?: string,
  openCount = 1,
): Screen {
  const done = view.status === 'resolved';
  const embed = new EmbedBuilder()
    // The region is in the title because with several missions running it is
    // the only thing that distinguishes two screens at a glance.
    .setTitle(`${view.emoji ?? '🧭'} ${view.name} — ${regionLabel(view.region)}`)
    .setColor(done ? COLOR_SUCCESS : COLOR_ACTIVE);

  const status = statusLine ? `${statusLine}\n\n` : '';
  const timing = done
    ? '✅ **She is back.** Collect to see how it went.'
    : // Discord counts this down on the client, so the bot never edits a
      // message on a timer and the countdown survives a restart.
      `⏳ Returns ${relativeTimestamp(view.completesAt)}`;

  embed.setDescription(
    [
      status + `**${view.waifuName}** is out on this job.`,
      // Omitted for a row deployed under the legacy vocabulary.
      view.match ? `Match: **${matchTag(view.match)}**` : null,
      timing,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  );
  if (view.description) embed.addFields({ name: '​', value: `_${view.description}_` });
  // The question regional concurrency invites, answered before it is asked.
  // Location gates *starting* a mission and nothing else.
  if (view.status === 'active') {
    embed.setFooter({ text: 'Travel wherever you like — she carries on regardless.' });
  }

  const collect = new ButtonBuilder()
    .setCustomId(buildCustomId('exp', 'claim', String(view.id)))
    .setLabel(done ? 'Collect' : 'Not back yet')
    .setEmoji('📦')
    .setStyle(done ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!done);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(collect);
  // Recall is only offered while she is still out. Once a result exists there
  // is nothing to abandon — cancelling then would mean throwing away a payout
  // the player has already earned.
  if (!done) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('exp', 'cancel', String(view.id)))
        .setLabel('Recall')
        .setEmoji('🚩')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('exp', 'board'))
      .setLabel('View board')
      .setStyle(ButtonStyle.Secondary),
  );
  if (openCount > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('exp', 'active'))
        .setLabel(`All expeditions (${openCount})`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return {
    embeds: [embed],
    components: [
      row as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
      backRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    ],
  };
}

// ────────────────────────── Mission detail ──────────────────────────

/**
 * One candidate row.
 *
 *   `STRONG MATCH ✦ Lilith — Lv.31`
 *   `Dominant ✓ • Human ✗ • Lv 28+ ✓`
 *
 * The chips are the explanation, and they read the service's own per-axis
 * verdicts rather than re-deriving them: ✓ met, ✗ missed, `~` level just
 * short, ⚠ actively works against the mission (a temperament a preferred
 * affinity beats, or badly under-levelled). Nothing is shown when the mission
 * has no preference on an axis, because an empty requirement is not a failed
 * one.
 */
const VERDICT_MARK: Readonly<Record<MatchVerdict, string>> = {
  met: '✓',
  near: '~',
  missed: '✗',
  against: '⚠',
  none: '',
};

export function candidateChips(
  candidate: ExpeditionCandidate,
  definition: RegionalExpedition,
): string {
  const { match } = candidate;
  const chips: string[] = [];
  if (match.affinity !== 'none') {
    chips.push(`${affinityLabel(candidate.affinity)} ${VERDICT_MARK[match.affinity]}`);
  }
  if (match.race !== 'none') {
    chips.push(`${raceLabel(candidate.race)} ${VERDICT_MARK[match.race]}`);
  }
  // Level is a requirement every mission has, so it is always worth a chip.
  chips.push(`Lv ${definition.recommendedLevel}+ ${VERDICT_MARK[match.level]}`);
  return chips.join(' • ');
}

function detailScreen(
  definition: RegionalExpedition,
  candidates: ExpeditionCandidate[],
  statusLine?: string,
): Screen {
  const embed = new EmbedBuilder()
    .setTitle(`${definition.emoji ?? '•'} ${definition.name}`)
    .setColor(COLOR_BOARD);

  const status = statusLine ? `${statusLine}\n\n` : '';
  embed.setDescription(
    [
      status + (definition.description ? `_${definition.description}_` : ''),
      '',
      `⏱️ Duration: **${formatDuration(definition.durationMinutes)}**`,
      `🎯 Recommended level: **${definition.recommendedLevel}**`,
      preferenceLine(definition) ?? 'Prefers: _anyone willing_',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
  embed.addFields({ name: 'Possible rewards', value: previewLine(definition.rewardPreview) });

  const deployable = candidates.filter((c) => c.unavailableReasons.length === 0);

  if (candidates.length === 0) {
    embed.addFields({
      name: 'Who to send',
      value: '_You have no WaifuMon yet. Go hunting first~_',
    });
    return { embeds: [embed], components: [boardBackRow()] };
  }

  // The list the player reads, best fit first (the service sorts it).
  // Capped so the embed field stays inside Discord's 1024-character limit;
  // the select menu below is capped at 25 by Discord itself.
  const shown = candidates.slice(0, 10);
  const rows = shown.map((candidate) => {
    const head = candidate.unavailableReasons.length > 0
      ? `~~${matchTag(candidate.match.quality)} ${candidate.name} — Lv.${candidate.level}~~`
      : `**${matchTag(candidate.match.quality)}** ${candidate.name} — Lv.${candidate.level}`;
    const detail =
      candidate.unavailableReasons.length > 0
        ? unavailableNote(candidate.unavailableReasons)
        : candidateChips(candidate, definition);
    return detail ? `${head}\n${detail}` : head;
  });
  embed.addFields({
    name: 'Who to send',
    value: rows.join('\n\n').slice(0, 1024),
  });

  const components: Rows = [];
  if (deployable.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId('exp', 'pick', definition.key))
          .setPlaceholder('Choose who to send…')
          // Discord caps a select at 25 options.
          .addOptions(
            deployable.slice(0, 25).map((candidate) => ({
              label: `${matchTag(candidate.match.quality)} ${candidate.name}`.slice(0, 100),
              description: `Lv.${candidate.level} · ${candidateChips(candidate, definition)}`
                .slice(0, 100),
              value: String(candidate.waifuId),
            })),
          ),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    );
  } else {
    embed.addFields({
      name: '​',
      value: '🚫 _Nobody is free to go right now._',
    });
  }
  components.push(boardBackRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>);
  return { embeds: [embed], components };
}

function unavailableNote(reasons: readonly string[]): string {
  const [first] = reasons;
  if (first === 'on_expedition') return '🚫 Already away on an expedition';
  if (first === 'buddy') return '🚫 Your active Buddy';
  if (first === 'care_target') return '🚫 In Care Mode';
  if (first === 'released') return '🚫 Released';
  return '🚫 Unavailable';
}

function boardBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('exp', 'board'))
      .setLabel('⟵ Back to board')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ──────────────────────── Deployment confirmation ────────────────────────

function confirmScreen(
  definition: RegionalExpedition,
  candidate: ExpeditionCandidate,
): Screen {
  // Completion is computed here purely to *show* the player when she would be
  // back. The authoritative finish line is set by the database at deploy time
  // — this is a preview, and the active screen renders the real one.
  const completesAt = new Date(Date.now() + definition.durationMinutes * 60 * 1000);

  const embed = new EmbedBuilder()
    .setTitle(`Send ${candidate.name}?`)
    .setColor(COLOR_BOARD)
    .setDescription(
      [
        `${definition.emoji ?? '•'} **${definition.name}**`,
        '',
        `👤 Sending: **${candidate.name}** — Lv.${candidate.level}`,
        `🎯 Match: **${matchTag(candidate.match.quality)}**`,
        `   ${candidateChips(candidate, definition)}`,
        `⏱️ Duration: **${formatDuration(definition.durationMinutes)}**`,
        `📅 Back ${relativeTimestamp(completesAt)}`,
        preferenceLine(definition) ?? 'Prefers: _anyone willing_',
      ].join('\n'),
    );
  embed.addFields({ name: 'Possible rewards', value: previewLine(definition.rewardPreview) });
  embed.addFields({
    name: '​',
    value: `_She is unavailable until she returns — no Buddy, no Care Mode, no releasing._`,
  });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildCustomId('exp', 'deploy', definition.key, String(candidate.waifuId)),
          )
          .setLabel('Send her out')
          .setEmoji('🧭')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'view', definition.key))
          .setLabel('Pick someone else')
          .setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
      boardBackRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    ],
  };
}

// ───────────────────────── Cancel confirmation ─────────────────────────

/**
 * Recall is a two-step, and deliberately so.
 *
 * Abandoning an eighteen-hour mission for nothing is the single most destructive
 * thing this feature lets a player do, and it is one misclick away from the
 * Collect button. The confirmation states all four consequences plainly rather
 * than asking "are you sure?", because "are you sure" is a question players
 * answer reflexively and a list of consequences is one they read.
 */
function cancelConfirmScreen(view: ExpeditionView): Screen {
  const embed = new EmbedBuilder()
    .setTitle('🚩 Recall her?')
    .setColor(COLOR_DANGER)
    .setDescription(
      [
        `**${view.waifuName}** is part-way through **${view.name}** in ` +
          `**${regionLabel(view.region)}**.`,
        `She would otherwise be back ${relativeTimestamp(view.completesAt)}.`,
        '',
        '**Recalling her now:**',
        '• Returns her immediately — she is available again at once',
        '• Grants **no rewards** — no WaifuBux, no Essence, no items',
        '• Grants **no XP** — the trip counts for nothing',
        '• **Cannot be undone** — the mission is abandoned, not paused',
      ].join('\n'),
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        // Keep going is first and Primary; the destructive action is second
        // and Danger. The safe option is where the thumb already is.
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'active'))
          .setLabel('Let her finish')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'cancel_confirm', String(view.id)))
          .setLabel('Recall — abandon the mission')
          .setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    ],
  };
}

// ───────────────────────────── Results ─────────────────────────────

const OUTCOME_DISPLAY = {
  exceptional: {
    title: '🌟 Exceptional Success',
    color: COLOR_EXCEPTIONAL,
    lead: 'She went far beyond what the job asked for.',
  },
  success: {
    title: '✅ Success',
    color: COLOR_SUCCESS,
    lead: 'The job is done.',
  },
  failure: {
    title: '💤 Setback',
    color: COLOR_FAILURE,
    lead: 'It did not go to plan — but she did not come back empty-handed.',
  },
} as const;

/** One reward block: currency, essence, XP and item stacks, as lines. */
export function rewardLines(
  reward: {
    waifubux: number;
    essence: number;
    waifuXp: number;
    items: { slug: string; quantity: number }[];
  },
  itemNames: Map<string, string>,
  essenceOverride?: number,
): string[] {
  const lines: string[] = [];
  if (reward.waifubux > 0) lines.push(`💰 **${reward.waifubux}** WaifuBux`);
  const essence = essenceOverride ?? reward.essence;
  if (essence > 0) lines.push(`✨ **${essence}** Essence`);
  if (reward.waifuXp > 0) lines.push(`📈 **${reward.waifuXp}** WaifuMon XP`);
  for (const item of reward.items) {
    lines.push(`📦 **${itemNames.get(item.slug) ?? item.slug}** ×${item.quantity}`);
  }
  return lines;
}

function sourcesOfKind(rewards: ExpeditionRewardPayload, kind: RewardTableKind) {
  return rewards.sources.filter((s) => s.kind === kind);
}

function sumSources(
  sources: ExpeditionRewardPayload['sources'],
): { waifubux: number; essence: number; waifuXp: number; items: { slug: string; quantity: number }[] } {
  return {
    waifubux: sources.reduce((n, s) => n + s.waifubux, 0),
    essence: sources.reduce((n, s) => n + s.essence, 0),
    waifuXp: sources.reduce((n, s) => n + s.waifuXp, 0),
    items: sources.flatMap((s) => s.items),
  };
}

function resultScreen(result: ExpeditionClaimResult): Screen {
  const display = OUTCOME_DISPLAY[result.outcome];
  const itemNames = new Map(result.itemsGranted.map((i) => [i.slug, i.name]));

  const embed = new EmbedBuilder()
    .setTitle(display.title)
    .setColor(display.color)
    .setDescription(
      [
        `${result.expedition.emoji ?? '•'} **${result.expedition.name}**`,
        result.expedition.match
          ? `👤 **${result.expedition.waifuName}** · ${matchTag(result.expedition.match)}`
          : `👤 **${result.expedition.waifuName}**`,
        '',
        display.lead,
      ].join('\n'),
    );

  const normal = sourcesOfKind(result.rewards, 'success');
  const bonus = sourcesOfKind(result.rewards, 'bonus');
  const consolation = sourcesOfKind(result.rewards, 'failure');

  /**
   * Exceptional Success is rendered as two blocks, never one flattened list.
   *
   * The whole point of an additive bonus is that the player can see what
   * excelling earned them; merging it into the ordinary payout hides exactly
   * the information the outcome exists to convey.
   *
   * Essence is the one line that cannot be split faithfully: the Buddy Bonus
   * is applied to the *total* at claim time, so attributing the uplift to one
   * table or the other would be inventing a number. It is therefore reported
   * once, below the blocks, as the amount actually credited.
   */
  if (bonus.length > 0) {
    const normalLines = rewardLines(sumSources(normal), itemNames);
    const bonusLines = rewardLines(sumSources(bonus), itemNames);
    embed.addFields({
      name: 'Normal Rewards',
      value: normalLines.length > 0 ? normalLines.join('\n') : '_Nothing._',
    });
    embed.addFields({
      name: '🌟 Exceptional Bonus',
      value: bonusLines.length > 0 ? bonusLines.join('\n') : '_Nothing._',
    });
  } else if (result.outcome === 'failure') {
    const lines = rewardLines(sumSources(consolation), itemNames);
    embed.addFields({
      // Named so a consolation never reads as "you got nothing" — that is the
      // whole difference between a setback and a punishment.
      name: 'Brought home anyway',
      value: lines.length > 0 ? lines.join('\n') : '_Nothing at all this time._',
    });
  } else {
    const lines = rewardLines(sumSources(normal), itemNames);
    embed.addFields({
      name: 'Rewards',
      value: lines.length > 0 ? lines.join('\n') : '_Nothing._',
    });
  }

  // Essence as actually credited, once, after any Buddy Bonus.
  if (result.essenceGranted > 0) {
    const base = result.rewards.essence;
    const bonusNote = result.essenceGranted > base ? ` _(+${result.essenceGranted - base} Buddy Bonus)_` : '';
    embed.addFields({
      name: 'Essence',
      value: `✨ **${result.essenceGranted}** Essence${bonusNote}`,
    });
  }

  if (result.waifuLeveledUp) {
    embed.addFields({ name: '​', value: `🎉 **${result.expedition.waifuName} levelled up!**` });
  }

  embed.setFooter({
    text:
      `Balance: ${result.waifubuxAfter} WaifuBux · ${result.essenceAfter} Essence` +
      // Collecting is what frees the region, so the screen that does it is
      // where a player learns that it did — and that nothing else moved.
      ` · ${regionLabel(result.expedition.region)} is free again`,
  });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('exp', 'board'))
          .setLabel('Send her out again')
          .setEmoji('🗺️')
          .setStyle(ButtonStyle.Primary),
      ) as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
      backRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>,
    ],
  };
}

// ─────────────────────────── Entry points ───────────────────────────

/**
 * `menu:expeditions` — the front door.
 *
 * Defaults to whatever the player already has running, because that is what
 * they came to check. With one mission that is the mission; with several it is
 * the overview, which is the screen regional concurrency exists to fill. Only
 * a player with nothing out sees the board first.
 */
export async function handleExpeditions(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
): Promise<void> {
  // Resolves anything due before it answers, so opening the screen is what
  // makes a finished mission finish — all of them, not just the first.
  const active = await ctx.services.expeditions.getActive(prov.playerId);
  if (active.length === 1) {
    await respondEphemeral(interaction, activeScreen(active[0]!, undefined, 1));
    return;
  }
  if (active.length > 1) {
    await respondEphemeral(interaction, overviewScreen(active));
    return;
  }
  const board = await ctx.services.expeditions.getBoard(prov.playerId);
  await respondEphemeral(interaction, boardScreen(board));
}

/**
 * `exp:board` — this region's board, explicitly, whatever else is running.
 *
 * One call now: `getBoard` resolves due missions itself and carries the
 * player's standing in every region, so the screen no longer needs a separate
 * `getActive` to know whether this region is taken.
 */
export async function handleExpeditionBoard(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  statusLine?: string,
): Promise<void> {
  const board = await ctx.services.expeditions.getBoard(prov.playerId);
  await respondEphemeral(interaction, boardScreen(board, statusLine));
}

/**
 * `exp:active` — the roll-call of every region with something running.
 *
 * Also the universal fallback: a handler that has lost track of which mission
 * it was talking about lands here, and a player with exactly one mission is
 * taken straight to it rather than to a list of one.
 */
export async function handleExpeditionActive(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  statusLine?: string,
): Promise<void> {
  const active = await ctx.services.expeditions.getActive(prov.playerId);
  if (active.length === 0) {
    // Everything was collected or recalled — possibly in another window.
    // Falling back to the board is more useful than an error about a screen —
    // but the caller's own status line wins, because "you already collected
    // that one" is the thing the player needs to read, not "nobody is out".
    await handleExpeditionBoard(
      ctx,
      interaction,
      prov,
      statusLine ?? 'Nobody is out right now.',
    );
    return;
  }
  if (active.length === 1) {
    await respondEphemeral(interaction, activeScreen(active[0]!, statusLine, 1));
    return;
  }
  await respondEphemeral(interaction, overviewScreen(active, statusLine));
}

/**
 * `exp:mission|<id>` — one mission from the overview.
 *
 * Re-reads rather than trusting the id in the custom id, like every handler
 * here: the mission may have been collected in another window since the button
 * was painted, and the overview is the right place to land when it has.
 */
export async function handleExpeditionMission(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  rawId: string,
  statusLine?: string,
): Promise<void> {
  const expeditionId = Number(rawId);
  const active = await ctx.services.expeditions.getActive(prov.playerId);
  const view = active.find((v) => v.id === expeditionId);
  if (!view) {
    await handleExpeditionActive(
      ctx,
      interaction,
      prov,
      statusLine ?? '⚠️ That expedition is no longer running.',
    );
    return;
  }
  await respondEphemeral(interaction, activeScreen(view, statusLine, active.length));
}

/** `exp:view|<key>` — mission detail with the candidate list. */
export async function handleExpeditionView(
  ctx: AppContext,
  interaction: PlayerInteraction,
  prov: Provisioned,
  key: string,
): Promise<void> {
  const definition = findDefinition(ctx, key);
  if (!definition) {
    await handleExpeditionBoard(ctx, interaction, prov, '⚠️ That expedition is no longer listed.');
    return;
  }
  /**
   * The region gate, painted rather than thrown.
   *
   * `deploy` would refuse this anyway — it is the service and the unique index
   * that enforce one mission per region, never this file — but offering a
   * "choose who to send" menu that can only end in a refusal is a worse screen
   * than saying so up front. Note what this does *not* consult: missions in
   * other regions, which never block anything here.
   */
  const board = await ctx.services.expeditions.getBoard(prov.playerId);
  if (board.regionMission && board.regionMission.region === definition.region) {
    await respondEphemeral(interaction, boardScreen(board));
    return;
  }

  let candidates: ExpeditionCandidate[];
  try {
    candidates = await ctx.services.expeditions.getCandidates(prov.playerId, key);
  } catch (err) {
    if (err instanceof AppError) {
      await handleExpeditionBoard(ctx, interaction, prov, `⚠️ ${err.userMessage}`);
      return;
    }
    throw err;
  }
  await respondEphemeral(interaction, detailScreen(definition, candidates));
}

/** `exp:pick|<key>` select — the deployment confirmation. */
export async function handleExpeditionPick(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
  prov: Provisioned,
  key: string,
): Promise<void> {
  const waifuId = Number(interaction.values[0]);
  const definition = findDefinition(ctx, key);
  if (!definition || !Number.isInteger(waifuId)) {
    await handleExpeditionBoard(ctx, interaction, prov, '⚠️ That expedition is no longer listed.');
    return;
  }
  const candidates = await ctx.services.expeditions.getCandidates(prov.playerId, key);
  const candidate = candidates.find((c) => c.waifuId === waifuId);
  // Re-read rather than trusting the select: the copy may have become Buddy,
  // entered Care Mode or been sent elsewhere since the menu was painted.
  if (!candidate || candidate.unavailableReasons.length > 0) {
    await respondEphemeral(
      interaction,
      detailScreen(definition, candidates, '⚠️ She is not available any more — pick someone else.'),
    );
    return;
  }
  await respondEphemeral(interaction, confirmScreen(definition, candidate));
}

/** `exp:deploy|<key>|<waifuId>` — send her out. */
export async function handleExpeditionDeploy(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  key: string,
  rawWaifuId: string,
): Promise<void> {
  const waifuId = Number(rawWaifuId);
  if (!key || !Number.isInteger(waifuId)) {
    await handleExpeditionBoard(ctx, interaction, prov, '⚠️ That button no longer works~');
    return;
  }
  let view: ExpeditionView;
  try {
    view = await ctx.services.expeditions.deploy(prov.playerId, key, waifuId);
  } catch (err) {
    // Every refusal the service can raise is an AppError with player-facing
    // wording — a stale Deploy lands here and repaints rather than erroring.
    // A refused or lost deployment never reaches the narration below.
    if (err instanceof AppError) {
      await handleExpeditionBoard(ctx, interaction, prov, `⚠️ ${err.userMessage}`);
      return;
    }
    throw err;
  }

  // `deploy` has returned, so its transaction has committed: the mission
  // exists, and the event describing it is emitted now — before the screen,
  // so a failed interaction update cannot suppress it. Built from the
  // deployment's own result, no second lookup. `emitEvents` never rejects: a
  // Waifumon Log outage cannot turn a started mission into an error, nor keep
  // the player's screen from painting.
  //
  // Started rather than awaited here, and awaited once the screen is up: the
  // interaction has a few seconds to answer, and a slow log post must not
  // spend them.
  const emitted = emitEvents(ctx, interaction, prov, [
    gameEvent('EXPEDITION_DEPLOYED', {
      waifuName: view.waifuName,
      expeditionName: view.name,
      durationMinutes: view.durationMinutes,
    }),
  ]);

  try {
    // A second read, only to count the regions now working — which is what
    // decides whether the screen offers the overview. Cheap, and it keeps the
    // count honest rather than inferred from the press that got here.
    const active = await ctx.services.expeditions.getActive(prov.playerId);
    await respondEphemeral(
      interaction,
      activeScreen(
        view,
        `🧭 **${view.waifuName}** sets out into ${regionLabel(view.region)}.`,
        Math.max(1, active.length),
      ),
    );
  } finally {
    await emitted;
  }
}

/** `exp:claim|<id>` — collect a finished mission. */
export async function handleExpeditionClaim(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  rawId: string,
): Promise<void> {
  const expeditionId = Number(rawId);
  if (!Number.isInteger(expeditionId)) {
    await handleExpeditionBoard(ctx, interaction, prov, '⚠️ That button no longer works~');
    return;
  }
  try {
    const result = await ctx.services.expeditions.claim(prov.playerId, expeditionId);
    await respondEphemeral(interaction, resultScreen(result));
  } catch (err) {
    if (err instanceof AppError) {
      // A double-clicked Collect lands here having granted nothing — the
      // conditional claim in the service is what guarantees that, not this.
      await handleExpeditionActive(ctx, interaction, prov, `⚠️ ${err.userMessage}`);
      return;
    }
    throw err;
  }
}

/** `exp:cancel|<id>` — the confirmation screen. Nothing is written here. */
export async function handleExpeditionCancel(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  rawId: string,
): Promise<void> {
  const expeditionId = Number(rawId);
  const active = await ctx.services.expeditions.getActive(prov.playerId);
  const view = active.find((v) => v.id === expeditionId);
  if (!view) {
    await handleExpeditionActive(ctx, interaction, prov, '⚠️ There is nothing to recall.');
    return;
  }
  if (view.status !== 'active') {
    // She finished while the player was looking at the screen. Recalling now
    // would throw away a payout that already exists.
    await handleExpeditionMission(
      ctx,
      interaction,
      prov,
      rawId,
      '✅ She got back before you could recall her — collect instead.',
    );
    return;
  }
  await respondEphemeral(interaction, cancelConfirmScreen(view));
}

/** `exp:cancel_confirm|<id>` — the only place a cancellation is written. */
export async function handleExpeditionCancelConfirm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  rawId: string,
): Promise<void> {
  const expeditionId = Number(rawId);
  if (!Number.isInteger(expeditionId)) {
    await handleExpeditionBoard(ctx, interaction, prov, '⚠️ That button no longer works~');
    return;
  }
  try {
    const view = await ctx.services.expeditions.cancel(prov.playerId, expeditionId);
    // Back to the board — which, because only this region was touched, now
    // shows this region open and every other mission exactly as it was.
    await handleExpeditionBoard(
      ctx,
      interaction,
      prov,
      `🚩 **${view.waifuName}** was recalled from ${regionLabel(view.region)}. ` +
        'The mission was abandoned — no rewards.',
    );
  } catch (err) {
    if (err instanceof AppError) {
      // Lost the race (a second press, or she finished first): the service
      // refused, so nothing was abandoned.
      await handleExpeditionActive(ctx, interaction, prov, `⚠️ ${err.userMessage}`);
      return;
    }
    throw err;
  }
}

function findDefinition(ctx: AppContext, key: string): RegionalExpedition | undefined {
  return ctx.content.expeditions.find((e) => e.key === key);
}
