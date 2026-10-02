/**
 * Combat Trial screens: the Trial list, the pre-fight detail and the fight
 * result. Pure builders from `CombatTrialService` read models.
 *
 * Every number shown is copied from the service: live `CombatStats` before a
 * fight, the attempt's stored snapshot after one. Nothing here calculates a
 * stat or a damage value, and the structured combat events are *formatted*
 * here (see {@link summarizeCombatEvents}) — the engine's event model never
 * carries prose.
 *
 * Layout: one large image (the Trial's or enemy's artwork) and the active
 * Buddy as a thumbnail. Missing art on either side simply leaves it out.
 *
 * Custom ids (`ct` scope):
 *
 *   ct|home|<page>                 Trial list (the main menu opens page 0)
 *   ct|view|<trialKey>             pre-fight detail
 *   ct|fight|<trialKey>|<nonce>    Fight — the nonce is minted per rendered
 *                                  button and is the fight's idempotency key
 *   ct|noop|page                   disabled page indicator
 *
 * The explicit Fight button is the seam future interactive combat replaces
 * with Basic Attack / Special / Defend; opening a Trial never starts a fight.
 */
import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type {
  CombatTrialAttemptView,
  CombatTrialDetailView,
  CombatTrialFightOutcome,
  CombatTrialListView,
  CombatTrialProgress,
  CombatTrialSummary,
} from '../modules/combatTrials/combatTrialService';
import type { CombatEvent, CombatResultKind } from '../modules/combat/combatTypes';
import type { CombatTrialDefinition, CombatTrialReward } from '../modules/combat/trialDefinitions';
import { EQUIPMENT_SLOTS } from '../modules/equipment/vocabulary';
import type { SessionPayload } from './ephemeralSession';
import { EMPTY_SLOT, SLOT_EMOJI } from './equipmentPresenter';
import { buildCustomId } from './types';

export const COMBAT_TRIALS_TITLE = '⚔️ Combat Trials';
export const COMBAT_TRIALS_LABEL = 'Combat Trials';
export const TRIALS_PAGE_SIZE = 5;
export const LOCKED_TRIALS = '🔒 Combat Trials unlock once you have Equipment.';
export const TRIAL_UNAVAILABLE = 'That Trial isn’t available right now.';
export const REPLAYED_FIGHT = 'That fight was already resolved — here’s how it went.';
export const NO_BUDDY_BLOCKER = 'An active Buddy is required to fight. Choose one from your Collection.';
export const INCOMPLETE_LOADOUT_BLOCKER = 'Equip Attack, Defense and Health gear before fighting.';
export const NO_TRIALS = 'No Trials are available right now. Check back soon.';
/** The onboarding completion's pointer at Combat Trials. */
export const COMBAT_TRIALS_CTA_TITLE = 'Your gear is ready.';
export const COMBAT_TRIALS_CTA_TEXT = 'Try it out in **Combat Trials**.';

const COLOR = 0xb45309;
const RESULT_COLOR: Readonly<Record<CombatResultKind, number>> = {
  player_victory: 0x16a34a,
  enemy_victory: 0xdc2626,
  draw: 0x6b7280,
};
export const RESULT_TITLE: Readonly<Record<CombatResultKind, string>> = {
  player_victory: '🏆 Victory!',
  enemy_victory: '💀 Defeat',
  draw: '⏱️ Draw',
};
const RESULT_WORD: Readonly<Record<CombatResultKind, string>> = {
  player_victory: 'Victory',
  enemy_victory: 'Defeat',
  draw: 'Draw',
};

/** How many opening hits the summary lists before skipping to the end. */
export const SUMMARY_OPENING_HITS = 3;

export const ctId = {
  home: (page = 0) => buildCustomId('ct', 'home', String(page)),
  view: (trialKey: string) => buildCustomId('ct', 'view', trialKey),
  fight: (trialKey: string, nonce: string) => buildCustomId('ct', 'fight', trialKey, nonce),
  noop: () => buildCustomId('ct', 'noop', 'page'),
};

/** A picture to attach: `url` is what the embed points at (`attachment://…`). */
export interface TrialArtwork {
  file: AttachmentBuilder;
  url: string;
}

export interface TrialArt {
  /** The large image: Trial or enemy artwork. */
  scene?: TrialArtwork | null;
  /** The thumbnail: the active Buddy's own artwork. */
  buddy?: TrialArtwork | null;
}

function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components);
}

function menuButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('menu', 'start'))
    .setLabel('Back to Waifumon')
    .setStyle(ButtonStyle.Secondary);
}

function trialsButton(label = 'All Trials'): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ctId.home(0)).setLabel(label).setEmoji('⚔️').setStyle(ButtonStyle.Secondary);
}

/** The main menu's / onboarding's entry to Combat Trials. */
export function combatTrialsButton(style: ButtonStyle = ButtonStyle.Secondary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(ctId.home(0)).setLabel(COMBAT_TRIALS_LABEL).setEmoji('⚔️').setStyle(style);
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

// ── formatting ────────────────────────────────────────────────────────────

/** `ATK 70+ · DEF 55+ · HP 300+`, authored values only; null when nothing is authored. */
export function recommendedLine(trial: CombatTrialDefinition): string | null {
  const r = trial.recommended;
  if (!r) return null;
  const parts = [
    r.attack != null ? `ATK ${r.attack}+` : null,
    r.defense != null ? `DEF ${r.defense}+` : null,
    r.hp != null ? `HP ${r.hp}+` : null,
  ].filter((p): p is string => p != null);
  return parts.length ? parts.join(' · ') : null;
}

export function statusLine(progress: CombatTrialProgress): string {
  const status = progress.cleared ? '✅ Cleared' : 'Not Cleared';
  return progress.latest ? `${status} · Last: ${RESULT_WORD[progress.latest.result]}` : status;
}

function statsLine(s: { attack: number | null; defense: number | null; maxHp: number | null }): string {
  return `ATK ${s.attack ?? EMPTY_SLOT} · DEF ${s.defense ?? EMPTY_SLOT} · HP ${s.maxHp ?? EMPTY_SLOT}`;
}

/** `+100 WaifuBux`, `+2 Sticky Joystick` — item names resolved by the caller. */
export function rewardLines(reward: CombatTrialReward, itemName: (slug: string) => string): string[] {
  const lines: string[] = [];
  if (reward.waifubux > 0) lines.push(`+${reward.waifubux} WaifuBux`);
  for (const item of reward.items) lines.push(`+${item.quantity} ${itemName(item.slug)}`);
  return lines;
}

/**
 * A short, fixed-size prose summary of a fight's structured events: the
 * opening hits, then (if any were skipped) a count, then the final blow and
 * how it ended. Names come from the `combat_started` event, so the summary
 * describes exactly what was fought. Never more than ~7 lines.
 */
export function summarizeCombatEvents(events: readonly CombatEvent[]): string[] {
  const start = events.find((e): e is Extract<CombatEvent, { type: 'combat_started' }> => e.type === 'combat_started');
  const name = (actor: 'player' | 'enemy') => (start ? start[actor].name : actor === 'player' ? 'Your Buddy' : 'The enemy');
  const hits = events.filter((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage');
  const hitLine = (e: Extract<CombatEvent, { type: 'damage' }>) =>
    `R${e.round} · ${name(e.actor)} hits ${name(e.target)} for **${e.amount}** (${e.targetHpBefore} → ${e.targetHpAfter})`;

  const lines = hits.slice(0, SUMMARY_OPENING_HITS).map(hitLine);
  const ended = events.find((e): e is Extract<CombatEvent, { type: 'combat_ended' }> => e.type === 'combat_ended');
  const last = hits[hits.length - 1];
  const finalBlow = ended?.reason === 'defeat' ? last : undefined;
  const tail = hits.length - SUMMARY_OPENING_HITS - (finalBlow && hits.length > SUMMARY_OPENING_HITS ? 1 : 0);
  if (tail > 0) lines.push(`… ${tail} more ${tail === 1 ? 'hit' : 'hits'} …`);
  if (finalBlow && hits.length > SUMMARY_OPENING_HITS) lines.push(hitLine(finalBlow));
  if (finalBlow) lines.push(`💥 ${name(finalBlow.target)} is defeated.`);
  else if (ended?.reason === 'round_limit') lines.push(`⏱️ Round limit reached — both still standing.`);
  if (lines.length === 0) lines.push('No blows were landed.');
  return lines;
}

// ── list ──────────────────────────────────────────────────────────────────

function listEntry(summary: CombatTrialSummary): { name: string; value: string } {
  const { trial, enemy, progress } = summary;
  const recommended = recommendedLine(trial);
  const value = [
    `Enemy: **${enemy.name}**`,
    `_${truncate(trial.description, 200)}_`,
    recommended ? `Recommended: ${recommended}` : null,
    `Status: ${statusLine(progress)}`,
  ]
    .filter((l): l is string => l != null)
    .join('\n');
  return { name: truncate(trial.name, 256), value };
}

export function buildTrialList(view: CombatTrialListView, page: number, status?: string | null): SessionPayload {
  const totalPages = Math.max(1, Math.ceil(view.trials.length / TRIALS_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), totalPages - 1);
  const shown = view.trials.slice(current * TRIALS_PAGE_SIZE, (current + 1) * TRIALS_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(COMBAT_TRIALS_TITLE)
    .setColor(COLOR)
    .setDescription(
      shown.length
        ? 'Test your Buddy and gear against a ladder of opponents. Pick a Trial to see the matchup.'
        : NO_TRIALS,
    );
  for (const summary of shown) embed.addFields(listEntry(summary));

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (shown.length) {
    components.push(
      row(
        ...shown.map((s) =>
          new ButtonBuilder()
            .setCustomId(ctId.view(s.trial.key))
            .setLabel(truncate(s.trial.name, 80))
            .setStyle(s.progress.cleared ? ButtonStyle.Secondary : ButtonStyle.Primary),
        ),
      ),
    );
  }
  if (totalPages > 1) {
    components.push(
      row(
        new ButtonBuilder()
          .setCustomId(`${ctId.home(Math.max(current - 1, 0))}|p`)
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current <= 0),
        new ButtonBuilder()
          .setCustomId(ctId.noop())
          .setLabel(`Page ${current + 1} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${ctId.home(Math.min(current + 1, totalPages - 1))}|n`)
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(current >= totalPages - 1),
      ),
    );
  }
  components.push(row(menuButton()));
  return { content: status ?? '', embeds: [embed], components, files: [] };
}

// ── detail (pre-fight) ────────────────────────────────────────────────────

export function blockerLine(blocker: CombatTrialDetailView['blocker']): string | null {
  if (blocker === 'no_buddy') return NO_BUDDY_BLOCKER;
  if (blocker === 'incomplete_loadout') return INCOMPLETE_LOADOUT_BLOCKER;
  return null;
}

export function buildTrialDetail(
  view: CombatTrialDetailView,
  fightNonce: string,
  art: TrialArt = {},
  status?: string | null,
): SessionPayload {
  const { trial, enemy, stats, progress, blocker } = view;
  const embed = new EmbedBuilder()
    .setTitle(truncate(trial.name, 256))
    .setColor(COLOR)
    .setDescription(trial.description);

  if (stats.buddy) {
    const gear = EQUIPMENT_SLOTS.map((slot) => `${SLOT_EMOJI[slot]} ${stats.loadout.slots[slot]?.name ?? EMPTY_SLOT}`);
    embed.addFields({
      name: `Your Buddy — ${truncate(stats.buddy.name, 200)}`,
      value: [`Current SP **${stats.buddy.currentSp}**`, statsLine(stats.stats), ...gear].join('\n'),
      inline: true,
    });
  } else {
    embed.addFields({ name: 'Your Buddy', value: 'No active Buddy.', inline: true });
  }
  embed.addFields({
    name: `Enemy — ${truncate(enemy.name, 200)}`,
    value: statsLine({ attack: enemy.attack, defense: enemy.defense, maxHp: enemy.hp }),
    inline: true,
  });
  const recommended = recommendedLine(trial);
  if (recommended) embed.addFields({ name: 'Recommended', value: `${recommended}\n_Guidance only._` });
  embed.addFields({ name: 'Status', value: statusLine(progress) });
  const blocked = blockerLine(blocker);
  if (blocked) embed.addFields({ name: '⚠️ Can’t fight yet', value: blocked });

  // Buddy art only beside a Buddy panel — a picture with no Buddy would be nobody.
  const shownArt: TrialArt = { scene: art.scene ?? null, buddy: stats.buddy ? art.buddy ?? null : null };
  applyArt(embed, shownArt);

  const fight = new ButtonBuilder()
    .setCustomId(ctId.fight(trial.key, fightNonce))
    .setLabel('Fight')
    .setEmoji('⚔️')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(blocker != null);
  const actions = [fight];
  if (blocker === 'no_buddy') {
    actions.push(
      new ButtonBuilder()
        .setCustomId(buildCustomId('menu', 'collection'))
        .setLabel('Open Collection')
        .setEmoji('🎒')
        .setStyle(ButtonStyle.Primary),
    );
  } else if (blocker === 'incomplete_loadout') {
    actions.push(
      new ButtonBuilder().setCustomId(buildCustomId('eq', 'home')).setLabel('Equipment').setEmoji('🔧').setStyle(ButtonStyle.Primary),
    );
  }
  return {
    content: status ?? '',
    embeds: [embed],
    components: [row(...actions), row(trialsButton(), menuButton())],
    files: files(shownArt),
  };
}

// ── result ────────────────────────────────────────────────────────────────

function hpBlock(side: CombatTrialAttemptView['player']): string {
  return `**${side.name}**\nHP: ${side.remainingHp} / ${side.maxHp}`;
}

export interface FightResultOptions {
  /** Nonce for the Fight Again button; null hides it (e.g. the Trial is gone). */
  againNonce: string | null;
  itemName(slug: string): string;
  art?: TrialArt;
}

export function buildFightResult(outcome: CombatTrialFightOutcome, opts: FightResultOptions): SessionPayload {
  const { attempt, trial, replayed } = outcome;
  const embed = new EmbedBuilder()
    .setTitle(`${RESULT_TITLE[attempt.result]} — ${truncate(trial?.name ?? attempt.trialKey, 200)}`)
    .setColor(RESULT_COLOR[attempt.result])
    .setDescription([hpBlock(attempt.player), hpBlock(attempt.enemy), `Rounds: ${attempt.rounds}`].join('\n\n'));
  embed.addFields({ name: 'Combat summary', value: truncate(summarizeCombatEvents(attempt.events).join('\n'), 1024) });
  if (attempt.firstClear) {
    const lines = attempt.rewards ? rewardLines(attempt.rewards, opts.itemName) : [];
    embed.addFields({
      name: '🎉 First Clear!',
      value: lines.length ? lines.join('\n') : 'Trial cleared for the first time.',
    });
  }
  const art = opts.art ?? {};
  applyArt(embed, art);

  const buttons: ButtonBuilder[] = [];
  if (opts.againNonce && trial) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(ctId.fight(trial.key, opts.againNonce))
        .setLabel('Fight Again')
        .setEmoji('⚔️')
        .setStyle(ButtonStyle.Danger),
    );
  }
  buttons.push(trialsButton(), menuButton());
  return {
    content: replayed ? REPLAYED_FIGHT : '',
    embeds: [embed],
    components: [row(...buttons)],
    files: files(art),
  };
}

export function lockedTrialsView(): SessionPayload {
  return { content: LOCKED_TRIALS, embeds: [], components: [row(menuButton())], files: [] };
}
