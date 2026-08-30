/**
 * `/waifumon-admin boss …` — the operator surface for boss encounters.
 *
 * Slash commands rather than the admin web panel, deliberately. The panel owns
 * *content* — files on disk, shared by every guild — while everything here is
 * per-guild Discord configuration, which is what `allow-channel` and
 * `set-announce-channel` already are. Putting the boss channel next to them
 * keeps one answer to "where do I configure this server?".
 *
 * Every handler re-checks `ManageGuild` at runtime. Discord's
 * default-member-permissions gate is server-configurable and can be relaxed by
 * an admin who did not realise these mutate state, so the command definition's
 * gate is a convenience and this is the actual check — the same belt-and-braces
 * the player admin tools use.
 */
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { BOSS_ACTIVE_STATUSES } from '../../db/schema';
import type { BossEncounterService } from '../../modules/bosses/bossEncounterService';
import { gameEvent } from '../../modules/events/gameEvents';
import { AppError, BossChannelUnusableError } from '../../shared/errors';
import { verifyBossChannel } from '../bossAnnouncer';
import { buildAnnouncement } from '../bossPresenter';
import { resolveBossArtwork } from '../bossArtwork';
import { emitGameEvents } from '../../modules/events/gameEvents';
import type { AppContext } from '../types';

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** Runtime permission gate. Returns false once it has already replied. */
async function requireManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const permissions = interaction.memberPermissions;
  if (permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  await interaction.reply({
    content: 'You need **Manage Server** to configure boss encounters.',
    ...EPHEMERAL,
  });
  return false;
}

function service(ctx: AppContext): BossEncounterService | null {
  return ctx.services.bosses ?? null;
}

async function requireService(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<BossEncounterService | null> {
  const svc = service(ctx);
  if (svc) return svc;
  await interaction.reply({
    content: 'Boss encounters are not enabled on this deployment.',
    ...EPHEMERAL,
  });
  return null;
}

/** Resolve the guild's internal id, provisioning the row if this is first touch. */
async function guildDbId(ctx: AppContext, interaction: ChatInputCommandInteraction) {
  const guild = await ctx.services.guilds.ensureGuild(interaction.guildId!);
  return guild.id;
}

/**
 * `set-channel` — configure the dedicated venue.
 *
 * Validates *before* saving, and validates the same five permissions the
 * scheduler will check every minute. An admin who is told at configuration
 * time that Attach Files is missing has a much better afternoon than one who
 * finds out when the first encounter fails to announce.
 */
export async function handleBossSetChannel(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;

  const channel = interaction.options.getChannel('channel', true);
  const resolved = await interaction.guild?.channels.fetch(channel.id);
  if (!resolved || resolved.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: `<#${channel.id}> must be a text channel.`,
      ...EPHEMERAL,
    });
    return;
  }

  const verdict = await verifyBossChannel(interaction.client, channel.id);
  if (!verdict) {
    await interaction.reply({
      content: `I cannot see <#${channel.id}> at all — check my role's channel overrides.`,
      ...EPHEMERAL,
    });
    return;
  }
  if (verdict.missing.length > 0) {
    const err = new BossChannelUnusableError(channel.id, verdict.missing);
    await interaction.reply({ content: err.userMessage, ...EPHEMERAL });
    return;
  }

  await ctx.services.guilds.setBossChannel(interaction.guildId!, channel.id);
  const id = await guildDbId(ctx, interaction);
  await svc.ensureState(id);
  // Configuring a working channel is also the "I fixed it" signal, so an old
  // suspension is lifted here rather than waiting for the next tick.
  await svc.clearSuspension(id);
  await interaction.reply({
    content:
      `Boss encounters will run in <#${channel.id}>.\n` +
      'The first boss will arrive within the next scheduling pass.',
    ...EPHEMERAL,
  });
}

/** `clear-channel` — turn boss encounters off for this server. */
export async function handleBossClearChannel(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  await ctx.services.guilds.setBossChannel(interaction.guildId!, null);
  await interaction.reply({
    content:
      'Boss encounter channel cleared — no new encounters will be scheduled.\n' +
      'Any encounter already running will still resolve and pay out.',
    ...EPHEMERAL,
  });
}

/** `status` — what is happening now, what is next, and what is broken. */
export async function handleBossStatus(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;

  const id = await guildDbId(ctx, interaction);
  const state = await svc.ensureState(id);
  const channelId = await ctx.services.guilds.getBossChannelId(interaction.guildId!);
  const active = await svc.getActive(id);

  const lines: string[] = [
    `**Channel:** ${channelId ? `<#${channelId}>` : '_not configured — nothing will schedule_'}`,
    `**Region:** ${state.region}`,
    `**Scheduling:** ${state.paused ? 'paused by an admin' : 'running'}`,
  ];
  if (state.suspendedReason) {
    // The actionable warning. Deliberately verbatim: the scheduler writes the
    // reason with the fix already in it.
    lines.push(`⚠️ **Suspended:** ${state.suspendedReason}`);
  }
  if (active) {
    const participants = await svc.countParticipants(active.id);
    lines.push(
      '',
      `**Active encounter** #${active.id} — ${active.bossName} (${active.bossAffinity})`,
      `Status: \`${active.status}\`${active.forced ? ' · **forced test spawn**' : ''}`,
      `Committed trainers: ${participants}`,
      active.deadlineAt
        ? `Deadline: <t:${Math.floor(active.deadlineAt.getTime() / 1000)}:R>`
        : 'Deadline: not yet opened',
      active.messageId
        ? `Message: https://discord.com/channels/${interaction.guildId}/${active.channelId}/${active.messageId}`
        : 'Message: _not posted yet_',
    );
  } else {
    lines.push('', '**Active encounter:** none');
  }
  lines.push(
    state.nextSpawnAt
      ? `**Next appearance:** <t:${Math.floor(state.nextSpawnAt.getTime() / 1000)}:R>`
      : '**Next appearance:** as soon as the scheduler runs',
  );

  const bag = (state.bagState as { remaining?: unknown[] } | null)?.remaining;
  lines.push(`**Shuffle bag:** ${Array.isArray(bag) ? bag.length : 0} boss(es) still owed`);

  await interaction.reply({ content: lines.join('\n'), ...EPHEMERAL });
}

/**
 * `spawn` — a test appearance.
 *
 * Marked `forced` on the row and left out of the shuffle bag entirely, so a
 * live test neither consumes a draw the rotation still owes players nor
 * disturbs the affinity spacing. The reply says so, because "did my test
 * change the rotation?" is the first thing an operator will wonder.
 */
export async function handleBossSpawn(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;

  const channelId = await ctx.services.guilds.getBossChannelId(interaction.guildId!);
  if (!channelId) {
    await interaction.reply({
      content: 'Set a boss channel first with `/waifumon-admin boss set-channel`.',
      ...EPHEMERAL,
    });
    return;
  }

  const bossId = interaction.options.getString('boss') ?? undefined;
  const id = await guildDbId(ctx, interaction);
  try {
    const spawn = await svc.forceSpawn(id, bossId);
    // Announce immediately rather than waiting up to a minute for the tick —
    // an operator testing a boss wants to see it now. The same
    // post-then-record ordering the scheduler uses, for the same reason.
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) throw new Error('boss channel is not sendable');
    const message = await channel.send(
      buildAnnouncement({
        encounter: spawn.encounter,
        boss: spawn.boss,
        config: ctx.content.tables.bossEncounters,
        participantCount: 0,
        now: new Date(),
        ...resolveBossArtwork(ctx, spawn.encounter),
      }),
    );
    const opened = await svc.beginScouting(spawn.encounter.id, channelId, message.id);
    await interaction.reply({
      content:
        `Force-spawned **${spawn.boss.name}** (#${opened.id}) in <#${channelId}>.\n` +
        '_Test spawn — the shuffle bag was **not** consumed and the rotation is unchanged._',
      ...EPHEMERAL,
    });
    await emitGameEvents(
      ctx.events,
      {
        guildId: interaction.guildId ?? '',
        guildDbId: id,
        playerId: 0,
        playerName: 'admin',
        playerMention: '',
        channelId,
      },
      [
        gameEvent('BOSS_ENCOUNTER_STARTED', {
          encounterId: opened.id,
          bossId: opened.bossId,
          bossName: opened.bossName,
          bossAffinity: opened.bossAffinity,
          region: opened.region,
          deadlineAt: opened.deadlineAt?.toISOString() ?? '',
        }),
      ],
    );
  } catch (err) {
    await interaction.reply({
      content:
        err instanceof AppError
          ? err.userMessage
          : `Could not force-spawn: ${(err as Error).message}`,
      ...EPHEMERAL,
    });
  }
}

/**
 * `end` — close an encounter early.
 *
 * Resolves rather than deletes: anyone who already committed gave up their one
 * participation for this window and is paid in full. Only a genuinely empty
 * encounter is marked `cancelled`.
 */
export async function handleBossEnd(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;

  const id = await guildDbId(ctx, interaction);
  const active = await svc.getActive(id);
  if (!active) {
    await interaction.reply({ content: 'No active boss encounter to end.', ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  const result = await svc.cancel(active.id, 'cancelled_admin');
  if (!result) {
    await interaction.editReply(
      'That encounter is already resolving — it will finish on its own.',
    );
    return;
  }
  await ctx.bossAnnouncer?.publishResults(active.id).catch((err: unknown) => {
    ctx.logger.error(
      { tag: 'boss/publish-failed', encounterId: active.id, err },
      'boss results committed but the Discord update failed',
    );
  });
  await interaction.editReply(
    `Ended **${active.bossName}** (#${active.id}). ` +
      `${result.participants.length} participant(s) were paid in full.`,
  );
}

/**
 * `repair` — repost a lost announcement onto the *same* encounter.
 *
 * The point of this command is what it does **not** do: it never creates a
 * second encounter. It posts a fresh message and repoints the existing row at
 * it, so the deadline, the committed participants and the shuffle bag are all
 * untouched.
 */
export async function handleBossRepair(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;

  const id = await guildDbId(ctx, interaction);
  const active = await svc.getActive(id);
  if (!active) {
    await interaction.reply({ content: 'No active boss encounter to repair.', ...EPHEMERAL });
    return;
  }
  const channelId = await ctx.services.guilds.getBossChannelId(interaction.guildId!);
  if (!channelId) {
    await interaction.reply({
      content: 'Set a boss channel first with `/waifumon-admin boss set-channel`.',
      ...EPHEMERAL,
    });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  const channel = await interaction.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    await interaction.editReply('That channel is not sendable.');
    return;
  }
  const participantCount = await svc.countParticipants(active.id);
  const message = await channel.send(
    buildAnnouncement({
      encounter: active,
      boss: svc.bossFor(active),
      config: ctx.content.tables.bossEncounters,
      participantCount,
      now: new Date(),
      ...resolveBossArtwork(ctx, active),
    }),
  );
  await svc.repairMessage(active.id, channelId, message.id);
  await interaction.editReply(
    `Reposted the announcement for **${active.bossName}** (#${active.id}). ` +
      `${participantCount} committed trainer(s) and the original deadline are unchanged.`,
  );
}

/** `pause` / `resume` — stop or restart scheduling without losing state. */
export async function handleBossPause(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;
  const id = await guildDbId(ctx, interaction);
  await svc.setPaused(id, true);
  await interaction.reply({
    content:
      'Boss scheduling paused. No new encounters will be drawn; a live one still resolves normally.',
    ...EPHEMERAL,
  });
}

export async function handleBossResume(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;
  const svc = await requireService(ctx, interaction);
  if (!svc) return;
  const id = await guildDbId(ctx, interaction);
  await svc.setPaused(id, false);
  // Resume is also the "I fixed the permission" gesture: clearing the
  // suspension here means the next tick re-checks the channel rather than
  // skipping the guild forever.
  await svc.clearSuspension(id);
  await interaction.reply({
    content: 'Boss scheduling resumed. The next pass will check the channel and schedule.',
    ...EPHEMERAL,
  });
}

/** Statuses the admin surface treats as "there is something running". */
export { BOSS_ACTIVE_STATUSES };
