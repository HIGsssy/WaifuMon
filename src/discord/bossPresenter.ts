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
 *   - **The announcement is edited, never re-posted.** There is one message per
 *     encounter and every state — open, updated, resolved — is a revision of
 *     it. That is what keeps a busy hour from becoming a wall of damage
 *     numbers.
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
    text: `Each committed buddy launches ${config.attacksPerParticipation} attacks. One buddy per trainer.`,
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

/** One participant's block: name, buddy, damage, then what they earned. */
export function resultLine(entry: BossParticipationResult, isFirst: boolean): string {
  const p = entry.participation;
  const rewards = entry.rewards
    .map((r) => (r.quantity > 1 ? `${r.quantity}× ${r.name}` : r.name))
    .join(' · ');
  const earned = [
    p.xpAwarded && p.xpAwarded > 0 ? `+${p.xpAwarded} XP` : null,
    rewards.length > 0 ? rewards : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');

  const head = `**${p.trainerName}** — ${p.waifuName} — ${formatDamage(p.totalDamage ?? 0)} DMG`;
  const crown = isFirst ? ' 🥇' : '';
  // A max-level buddy earns no XP and the line simply omits it rather than
  // printing "+0 XP", which would read as a bug.
  return `${head}${crown}\n${earned.length > 0 ? earned : '_no rewards recorded_'}`;
}

export interface ResultsInput {
  encounter: BossEncounterRow;
  reason: BossResolutionReason;
  boss: BossContent | undefined;
  entries: BossParticipationResult[];
  page: number;
  totalPages: number;
  totalParticipants: number;
  totalDamage: number;
  totalAttacks: number;
  firstOnScene: BossParticipationRow | null;
  artworkPath?: string | undefined;
}

/**
 * Result controls.
 *
 * `All Results` pagination appears only when there is a second page — a
 * six-person encounter should not carry dead buttons. Every control encodes
 * the encounter id and the page, so the pagination keeps working after a
 * restart: there is no in-memory cursor to lose.
 */
export function resultComponents(
  encounterId: number,
  page: number,
  totalPages: number,
  hasParticipants: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  if (!hasParticipants) return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (totalPages > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('boss', 'page', String(encounterId), String(page - 1)))
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(buildCustomId('boss', 'page', String(encounterId), String(page + 1)))
        .setLabel('All Results ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('boss', 'mine', String(encounterId)))
      .setLabel('My Result')
      .setEmoji('🎁')
      .setStyle(ButtonStyle.Primary),
  );
  return [row];
}

export function buildResults(input: ResultsInput): BaseMessageOptions {
  const { encounter, reason, boss, entries, totalParticipants } = input;
  const repelled = reason !== 'unchallenged';

  const outcomeText = repelled
    ? (boss?.repelledText ?? '')
    : (boss?.unchallengedText ?? '');

  const embed = new EmbedBuilder()
    .setTitle(resultTitle(encounter, reason))
    .setColor(repelled ? REPELLED_COLOR : UNCHALLENGED_COLOR);

  const summary =
    totalParticipants > 0
      ? `**${totalParticipants}** trainer${totalParticipants === 1 ? '' : 's'} joined the battle, ` +
        `launched **${formatDamage(input.totalAttacks)}** attacks, and dealt ` +
        `**${formatDamage(input.totalDamage)}** total damage.`
      : 'No trainer answered the call.';

  embed.setDescription([outcomeText, summary].filter((s) => s.length > 0).join('\n\n'));

  if (input.firstOnScene) {
    embed.addFields({
      name: 'First on the Scene',
      // Cosmetic only — the callout carries no mechanical reward, which is why
      // it is a field rather than a bonus line on that trainer's own entry.
      value: `${input.firstOnScene.trainerName} — ${input.firstOnScene.waifuName}`,
    });
  }

  for (const entry of entries) {
    embed.addFields({
      // A zero-width space: Discord requires a field name, and the blocks read
      // better as an unlabelled list than as a column of repeated headings.
      name: '​',
      value: resultLine(entry, input.firstOnScene?.id === entry.participation.id),
    });
  }

  if (input.totalPages > 1) {
    embed.setFooter({ text: `Page ${input.page} of ${input.totalPages}` });
  }

  const files: AttachmentBuilder[] = [];
  if (input.artworkPath) {
    const filename = bossArtworkFilename(encounter.bossId);
    files.push(new AttachmentBuilder(input.artworkPath, { name: filename }));
    embed.setThumbnail(`attachment://${filename}`);
  }

  return {
    embeds: [embed],
    components: resultComponents(
      encounter.id,
      input.page,
      input.totalPages,
      totalParticipants > 0,
    ),
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
    return `You did not commit a buddy to **${encounter.bossName}**~`;
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
  ]
    .filter((s): s is string => s !== null)
    .join('\n');
}
