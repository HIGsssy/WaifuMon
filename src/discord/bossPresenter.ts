/**
 * Boss encounter presentation — every string and every button, in one place.
 *
 * Split out of the interaction handlers so the wording is unit-testable
 * without a Discord client, and so the scheduler's announcer and the button
 * handlers cannot drift into rendering the same encounter two different ways.
 * Nothing here touches the database or performs a side effect: it takes rows
 * and returns payloads.
 *
 * Two rules the copy follows throughout:
 *
 *   - **Countdowns are Discord timestamps, never rendered text.** `<t:…:R>`
 *     re-renders in the reader's own locale and keeps counting down between
 *     our edits, so a minute-resolution refresh loop still looks live.
 *   - **The announcement is edited, never re-posted and never repurposed.**
 *     One encounter owns exactly two public messages: the announcement, which
 *     is edited in place from open → live → *completed*, and a separate
 *     results message posted beneath it when the window closes. The channel
 *     therefore reads chronologically as encounter/result, encounter/result,
 *     permanently.
 *
 * Three builders, one per public state:
 *
 *   {@link buildAnnouncement}           — the live scouting message.
 *   {@link buildCompletedAnnouncement}  — the same message, terminal. Keeps
 *     the artwork and identity, swaps the scouting prose for the outcome, and
 *     carries **no components at all**.
 *   {@link buildResults}                — the second message. Owns every
 *     result control, including pagination and My Result.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import type {
  BossEncounterRow,
  BossParticipationRow,
  BossResolutionReason,
} from '../db/schema';
import type {
  BossCommitPreview,
  BossParticipationResult,
} from '../modules/bosses/bossEncounterService';
import { advantageLabelFor, affinityLabel } from '../modules/bosses/bossAffinity';
import { formatBonusPercent, formatDamage } from '../modules/bosses/bossDamage';
import type { BossContent, BossEncountersConfig } from '../modules/content/schemas';
import { regionLabel } from '../modules/bosses/regions';
import { buddyBonusLine } from '../modules/buddyBonus/buddyBonusEffects';
import { buildCustomId } from './types';

/** Boss-channel accent. Distinct from the rarity palette on purpose. */
const BOSS_COLOR = 0x8b2f4a;
const REPELLED_COLOR = 0x4ba36b;
const UNCHALLENGED_COLOR = 0x6c6c78;

/** Filename the artwork attachment carries. Safe: derived from the boss id. */
export function bossArtworkFilename(bossId: string): string {
  return `boss-${bossId}.webp`;
}

/** `<t:1730000000:R>` — "in 42 minutes", localized by Discord for each reader. */
export function discordRelative(at: Date): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

/** `<t:…:t>` — a wall-clock time, for the "closes at" line. */
export function discordTime(at: Date): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:t>`;
}

/**
 * The reconciliation marker stamped into every public boss message's footer.
 *
 * Discord's send and our database write cannot be one transaction, so a crash
 * in between leaves a message on Discord that no row points at. This marker is
 * what lets recovery *find* that message instead of posting a second one:
 * `publishResults` scans the tail of the channel for a footer carrying the
 * encounter's marker before it sends anything.
 *
 * Deliberately readable rather than an opaque token — a reader sees
 * "Boss Encounter #128", which is meaningful context, and an operator
 * reporting a problem can quote it. `#` plus a bare integer is unambiguous
 * enough to match on without ever colliding with the prose above it.
 */
export function encounterMarker(encounterId: number): string {
  return `Boss Encounter #${encounterId}`;
}

/** True when `footerText` was stamped by {@link encounterMarker} for this id. */
export function matchesEncounterMarker(
  footerText: string | null | undefined,
  encounterId: number,
): boolean {
  if (!footerText) return false;
  // Anchored on both sides so #12 cannot match #128.
  return new RegExp(`Boss Encounter #${encounterId}(?!\\d)`).test(footerText);
}

/**
 * Which rapid-response tier a player committing *right now* would land in.
 *
 * Shown on the announcement so the incentive is legible while it still
 * matters, rather than only appearing in the private preview after someone has
 * already decided to click.
 */
export function currentBracketLabel(
  encounter: BossEncounterRow,
  config: BossEncountersConfig,
  now: Date,
): string {
  const origin = encounter.scoutingStartedAt ?? encounter.createdAt;
  const elapsedMs = Math.max(0, now.getTime() - origin.getTime());
  for (const bracket of config.responseBrackets) {
    if (elapsedMs < bracket.withinMinutes * 60_000) {
      return `${formatBonusPercent(bracket.bonus)} (first ${bracket.withinMinutes} minutes)`;
    }
  }
  return 'no bonus remaining';
}

export interface AnnouncementInput {
  encounter: BossEncounterRow;
  /** Content behind the encounter; absent once a boss is retired mid-window. */
  boss: BossContent | undefined;
  config: BossEncountersConfig;
  participantCount: number;
  now: Date;
  /**
   * Absolute path to the boss artwork, when it exists on disk. Absent means a
   * text/embed-only encounter — the announcement is otherwise identical, which
   * is the whole point of degrading rather than failing.
   */
  artworkPath?: string | undefined;
}

/** The Commit Buddy row. Disabled once the window is closed. */
export function commitRow(
  encounterId: number,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      // The encounter id rides in the custom id, and the handler re-checks it
      // against the guild's *current* encounter. That is what makes a button
      // from a previous appearance inert rather than dangerous.
      .setCustomId(buildCustomId('boss', 'commit', String(encounterId)))
      .setLabel('Commit Buddy')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/** The live announcement: who is here, how long is left, what has the edge. */
export function buildAnnouncement(input: AnnouncementInput): BaseMessageOptions {
  const { encounter, boss, config, participantCount, now } = input;
  const advantage = advantageLabelFor(encounter.bossAffinity, {
    wheel: config.affinityWheel as Record<string, never>,
    advantageBonus: config.affinityAdvantageBonus,
  });

  const description = boss?.description ?? '';
  const scouting = boss?.scoutingText ?? '';

  const embed = new EmbedBuilder()
    .setTitle(`${encounter.bossName} is scouting ${regionLabel(encounter.region)}`)
    .setColor(BOSS_COLOR)
    .setDescription(
      [description, scouting].filter((s) => s.length > 0).join('\n\n') ||
        'A challenger prowls the valley.',
    )
    .addFields(
      {
        name: 'Boss Affinity',
        value: affinityLabel(encounter.bossAffinity),
        inline: true,
      },
      {
        name: 'Affinity Advantage',
        value: `${affinityLabel(advantage)} (${formatBonusPercent(config.affinityAdvantageBonus)})`,
        inline: true,
      },
      {
        name: 'Trainers Committed',
        value: String(participantCount),
        inline: true,
      },
      {
        name: 'Rapid Response',
        value: currentBracketLabel(encounter, config, now),
        inline: true,
      },
    );

  if (encounter.deadlineAt) {
    embed.addFields({
      name: 'Window Closes',
      value: `${discordRelative(encounter.deadlineAt)} · ${discordTime(encounter.deadlineAt)}`,
      inline: true,
    });
  }
  embed.setFooter({
    text:
      `Each committed buddy launches ${config.attacksPerParticipation} attacks. ` +
      `One buddy per trainer. · ${encounterMarker(encounter.id)}`,
  });

  const files: AttachmentBuilder[] = [];
  if (input.artworkPath) {
    const filename = bossArtworkFilename(encounter.bossId);
    files.push(new AttachmentBuilder(input.artworkPath, { name: filename }));
    embed.setImage(`attachment://${filename}`);
  }

  return {
    embeds: [embed],
    components: [commitRow(encounter.id)],
    files,
    allowedMentions: { parse: [] },
  };
}

export interface CompletedAnnouncementInput {
  encounter: BossEncounterRow;
  reason: BossResolutionReason;
  boss: BossContent | undefined;
  participantCount: number;
  totalDamage: number;
  totalAttacks: number;
  artworkPath?: string | undefined;
}

/**
 * The announcement's terminal form — the *same* message, edited in place.
 *
 * This is what an encounter looks like in the channel forever after. It keeps
 * the boss's artwork and identity, because the history is meant to be
 * browsable: scrolling back should show the boss that appeared, not a stub.
 * What changes is the prose (scouting copy → `repelledText` or
 * `unchallengedText`), the colour, and the fact that it is unmistakably over.
 *
 * `components: []` is the load-bearing line. Every participation control is
 * removed rather than disabled — a greyed-out Commit Buddy on a months-old
 * message is visual noise that still invites a click — and **no result control
 * is added here**, because result controls belong to the results message. That
 * separation is what stops a paginating reader from repainting a completed
 * encounter's message.
 */
export function buildCompletedAnnouncement(
  input: CompletedAnnouncementInput,
): BaseMessageOptions {
  const { encounter, reason, boss, participantCount } = input;
  const repelled = reason !== 'unchallenged';
  const outcomeText = repelled
    ? (boss?.repelledText ?? '')
    : (boss?.unchallengedText ?? '');

  const embed = new EmbedBuilder()
    .setTitle(resultTitle(encounter, reason))
    .setColor(repelled ? REPELLED_COLOR : UNCHALLENGED_COLOR)
    .setDescription(
      [
        outcomeText,
        `**${encounter.bossName}** scouted ${regionLabel(encounter.region)}. This encounter has ended.`,
      ]
        .filter((s) => s.length > 0)
        .join('\n\n'),
    )
    .addFields(
      {
        name: 'Boss Affinity',
        value: affinityLabel(encounter.bossAffinity),
        inline: true,
      },
      {
        name: 'Trainers Committed',
        value: String(participantCount),
        inline: true,
      },
    );

  // Damage and attacks are meaningless on an unchallenged encounter and the
  // fields are omitted rather than printed as zeroes, which would read as a
  // failed battle rather than an absent one.
  if (participantCount > 0) {
    embed.addFields(
      {
        name: 'Combined Damage',
        value: formatDamage(input.totalDamage),
        inline: true,
      },
      {
        name: 'Total Attacks',
        value: formatDamage(input.totalAttacks),
        inline: true,
      },
    );
  }

  if (encounter.deadlineAt) {
    embed.addFields({
      name: 'Window Closed',
      value: discordRelative(encounter.deadlineAt),
      inline: true,
    });
  }

  embed.setFooter({
    text: `Encounter ended · Results below · ${encounterMarker(encounter.id)}`,
  });

  const files: AttachmentBuilder[] = [];
  if (input.artworkPath) {
    const filename = bossArtworkFilename(encounter.bossId);
    files.push(new AttachmentBuilder(input.artworkPath, { name: filename }));
    embed.setImage(`attachment://${filename}`);
  }

  return {
    embeds: [embed],
    // Not `[commitRow(id, true)]`. See the doc comment: removed, not disabled.
    components: [],
    files,
    allowedMentions: { parse: [] },
  };
}

// ── Ephemeral commit preview ────────────────────────────────────────────────

/**
 * The private preview, in the shape the specification's example gives:
 *
 *   Ruby Succubus — Level 24 — 200 SP
 *   Affinity Advantage: +10%
 *   Rapid Response: +5%
 *   Estimated Damage: 1,955–2,645
 *
 * Bonus lines are shown only when they are non-zero — a row of "+0%"s reads as
 * a penalty the player has incurred rather than a bonus they have not earned.
 */
export function buildCommitPreview(preview: BossCommitPreview): BaseMessageOptions {
  const lines = [
    `**${preview.waifuName}** — Level ${preview.level} — ${preview.currentSp} SP`,
    `Buddy Affinity: ${affinityLabel(preview.buddyAffinity)} · ` +
      `Boss Affinity: ${affinityLabel(preview.bossAffinity)}`,
  ];
  if (preview.affinityBonus > 0) {
    lines.push(`Affinity Advantage: ${formatBonusPercent(preview.affinityBonus)}`);
  }
  if (preview.responseBonus > 0) {
    lines.push(`Rapid Response: ${formatBonusPercent(preview.responseBonus)}`);
  }
  lines.push(
    `Estimated Damage: ${formatDamage(preview.estimate.min)}–${formatDamage(preview.estimate.max)}`,
  );
  if (preview.hasDuplicates) {
    // Only when it is ambiguous. A player with one copy does not need to be
    // told which one is going.
    lines.push(`_Copy #${preview.waifuId} — you own more than one ${preview.speciesName}._`);
  }
  lines.push('');
  lines.push(`Commit **${preview.waifuName}** to this battle?`);
  lines.push('_Rewards are delivered only after the battle resolves._');

  return {
    content: lines.join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          // The waifu id is carried so a confirmation cannot silently commit a
          // *different* buddy than the one previewed: the handler refuses when
          // the active buddy has changed since the preview was drawn.
          .setCustomId(
            buildCustomId(
              'boss',
              'confirm',
              String(preview.encounter.id),
              String(preview.waifuId),
            ),
          )
          .setLabel('Confirm')
          .setEmoji('⚔️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildCustomId('boss', 'cancel', String(preview.encounter.id)))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

// ── Results ─────────────────────────────────────────────────────────────────

/** Headline wording, keyed on how the encounter ended. */
export function resultTitle(encounter: BossEncounterRow, reason: BossResolutionReason): string {
  if (reason === 'unchallenged') return `${encounter.bossName} Left Unchallenged`;
  if (reason === 'cancelled_admin') return `${encounter.bossName} Withdrew`;
  if (reason === 'channel_lost') return `${encounter.bossName} Slipped Away`;
  return `${encounter.bossName} Was Driven Away!`;
}

export interface ResultsInput {
  encounter: BossEncounterRow;
  reason: BossResolutionReason;
  /**
   * Kept on the input for symmetry with {@link CompletedAnnouncementInput}, and
   * so a future results layout can reach for boss prose without every caller
   * changing. The outcome text itself is deliberately *not* printed here — it
   * is already on the completed announcement immediately above.
   */
  boss: BossContent | undefined;
  totalParticipants: number;
  totalDamage: number;
  totalAttacks: number;
  firstOnScene: BossParticipationRow | null;
  artworkPath?: string | undefined;
}

/**
 * Result controls — attached to the **results message only**.
 *
 * A single **View My Rewards** button. It opens each player's own rewards
 * privately (an ephemeral reply), so the public results message is otherwise
 * static: it carries no pagination and nothing any reader can press to change
 * what everyone else sees. The button encodes the encounter id, so it keeps
 * working after a restart with no in-memory state to lose.
 */
export function resultComponents(
  encounterId: number,
  hasParticipants: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  if (!hasParticipants) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('boss', 'mine', String(encounterId)))
        .setLabel('View My Rewards')
        .setEmoji('🎁')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

/**
 * The public results message: a static, non-interactive announcement.
 *
 * It shows the boss name, the overall battle summary and the First-on-Scene
 * callout, then a note pointing each player to the ephemeral **View My Rewards**
 * button for their own payout. It deliberately lists no per-participant reward
 * detail and carries no pagination — a busy channel must not be able to fight
 * over a shared reward screen.
 */
export function buildResults(input: ResultsInput): BaseMessageOptions {
  const { encounter, reason, totalParticipants } = input;
  const repelled = reason !== 'unchallenged';

  const embed = new EmbedBuilder()
    // Names the boss explicitly: this is a standalone message that a reader may
    // meet on its own in a search result or a jump link, without the
    // announcement above it in view.
    .setTitle(`Boss Results — ${encounter.bossName}`)
    .setColor(repelled ? REPELLED_COLOR : UNCHALLENGED_COLOR);

  // The outcome *prose* has already been said on the completed announcement
  // directly above; repeating it here would make the pair read as a stutter.
  // The results message carries the numbers instead.
  const summary =
    totalParticipants > 0
      ? `**${totalParticipants}** trainer${totalParticipants === 1 ? '' : 's'} joined the battle, ` +
        `launched **${formatDamage(input.totalAttacks)}** attacks, and dealt ` +
        `**${formatDamage(input.totalDamage)}** total damage.`
      : `Nobody confronted **${encounter.bossName}**. No rewards were distributed.`;

  embed.setDescription(summary);

  if (input.firstOnScene) {
    embed.addFields({
      name: 'First on the Scene',
      // Cosmetic only — the callout carries no mechanical reward, which is why
      // it is a field rather than a bonus line on that trainer's own entry.
      value: `${input.firstOnScene.trainerName} — ${input.firstOnScene.waifuName}`,
    });
  }

  // Per-participant payouts are private now: the note replaces the old public
  // leaderboard and points each player at their own ephemeral view.
  if (totalParticipants > 0) {
    embed.addFields({
      name: '🎁 Rewards',
      value:
        'Rewards have been distributed. Press **View My Rewards** to see your personal results.',
    });
  }

  // The marker is unconditional — reconciliation has to be able to find the
  // results message reliably. No page counter: the message never paginates.
  embed.setFooter({ text: encounterMarker(encounter.id) });

  const files: AttachmentBuilder[] = [];
  if (input.artworkPath) {
    const filename = bossArtworkFilename(encounter.bossId);
    files.push(new AttachmentBuilder(input.artworkPath, { name: filename }));
    embed.setThumbnail(`attachment://${filename}`);
  }

  return {
    embeds: [embed],
    components: resultComponents(encounter.id, totalParticipants > 0),
    files,
    allowedMentions: { parse: [] },
  };
}

/** The ephemeral "My Result" view — one participant's full record. */
export function buildMyResult(
  encounter: BossEncounterRow,
  entry: BossParticipationResult | null,
): string {
  if (!entry) {
    return "You didn't earn rewards from this boss encounter.";
  }
  const p = entry.participation;
  if (p.rewardStatus !== 'applied') {
    return (
      `**${p.waifuName}** is committed to **${encounter.bossName}**.\n` +
      'Rewards are delivered when the battle resolves.'
    );
  }
  const rewards = entry.rewards
    .map((r) => (r.quantity > 1 ? `${r.quantity}× ${r.name}` : r.name))
    .join('\n• ');
  return [
    `**${encounter.bossName}** — your result`,
    `${p.waifuName} (Level ${p.level}, ${p.currentSp} SP) dealt **${formatDamage(p.totalDamage ?? 0)}** damage ` +
      `across ${p.attackCount ?? 0} attacks.`,
    p.affinityBonus > 0 ? `Affinity Advantage: ${formatBonusPercent(p.affinityBonus)}` : null,
    p.responseBonus > 0 ? `Rapid Response: ${formatBonusPercent(p.responseBonus)}` : null,
    '',
    p.xpAwarded && p.xpAwarded > 0
      ? `**+${p.xpAwarded} XP** to ${p.waifuName}`
      : `${p.waifuName} is at max level — no XP was gained.`,
    entry.rewards.length > 0 ? `**Items**\n• ${rewards}` : '_No items this time._',
    // The committed copy's own bonus, when it scaled this payout. Resolved
    // from the participation snapshot by the encounter service — a Buddy swap
    // after committing never changes what is reported here.
    entry.rewardBonus ? `\n${buddyBonusLine(entry.rewardBonus)}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join('\n');
}
