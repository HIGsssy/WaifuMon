/**
 * Boss encounter interactions — the four buttons that live on the public
 * announcement, plus the ephemeral preview flow behind Commit Buddy.
 *
 * This file contains **no scheduling and no reward logic**. Every handler is
 * the same three steps: parse the custom id, call `BossEncounterService`, and
 * paint. That separation is what lets the resolution path be tested without
 * Discord and the wording be tested without a database.
 *
 * The commit flow is deliberately two-step:
 *
 *   Commit Buddy → ephemeral preview (writes nothing)
 *                → Confirm            (writes the participation)
 *                → Cancel             (writes nothing, dismisses)
 *
 * A player may cancel, change buddies with `/wm buddy`, and reopen the preview
 * as often as they like. Only Confirm is a decision, and after it the snapshot
 * is locked: the participation row holds the stats the battle will use, so
 * switching buddies afterwards changes nothing.
 */
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BossResolutionReason } from '../../db/schema';
import type { BossEncounterService } from '../../modules/bosses/bossEncounterService';
import { gameEvent } from '../../modules/events/gameEvents';
import { AppError } from '../../shared/errors';
import {
  buildCommitPreview,
  buildMyResult,
  buildResults,
} from '../bossPresenter';
import { respondEphemeral } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import type { AppContext, Provisioned } from '../types';
import { ownerFromInteraction } from '../userDisplay';
import { resolveBossArtwork } from '../bossArtwork';

/** Every boss button carries the encounter id first. Non-numeric = a stale id. */
function parseEncounterId(args: readonly string[]): number | null {
  const raw = args[0];
  if (raw === undefined) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The service every handler needs.
 *
 * Optional on the context so a deployment (or a test) without bosses wired
 * simply never routes here — and if a stale button somehow arrives, the player
 * gets a plain note rather than a crash.
 */
function bossService(ctx: AppContext): BossEncounterService | null {
  return ctx.services.bosses ?? null;
}

/** Shared refusal for a button that no longer points anywhere. */
async function rejectStale(interaction: ButtonInteraction): Promise<void> {
  await respondEphemeral(
    interaction,
    'That boss encounter is over~ Watch the boss channel for the next arrival.',
  );
}

/**
 * Turn a domain error into its player-facing copy.
 *
 * Every boss error carries a `userMessage`, so this never leaks an internal
 * message; anything that is *not* an `AppError` is re-thrown to the
 * dispatcher's generic handler, which logs it properly.
 */
async function replyDomainError(
  interaction: ButtonInteraction,
  err: unknown,
): Promise<void> {
  if (err instanceof AppError) {
    await respondEphemeral(interaction, err.userMessage);
    return;
  }
  throw err;
}

/** Commit Buddy → the ephemeral preview. Writes nothing. */
export async function handleBossCommit(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = bossService(ctx);
  const encounterId = parseEncounterId(args);
  if (!service || encounterId === null) return rejectStale(interaction);

  try {
    const preview = await service.preview(encounterId, prov.guildDbId, prov.playerId);
    await respondEphemeral(interaction, buildCommitPreview(preview));
  } catch (err) {
    await replyDomainError(interaction, err);
  }
}

/** Cancel — dismiss the preview without writing anything. */
export async function handleBossCancel(
  ctx: AppContext,
  interaction: ButtonInteraction,
): Promise<void> {
  void ctx;
  await respondEphemeral(
    interaction,
    'Nothing committed~ Change buddies with `/wm buddy <name>` and press Commit Buddy again.',
  );
}

/**
 * Confirm — the one write on this path.
 *
 * The previewed buddy's id travels in the custom id and is re-checked here:
 * if the player swapped buddies between seeing the preview and pressing
 * Confirm, they are sent back to look at the new numbers rather than
 * committing a Waifumon whose damage they were never shown.
 */
export async function handleBossConfirm(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = bossService(ctx);
  const encounterId = parseEncounterId(args);
  if (!service || encounterId === null) return rejectStale(interaction);
  const previewedWaifuId = Number.parseInt(args[1] ?? '', 10);

  const owner = ownerFromInteraction(interaction);
  try {
    const preview = await service.preview(encounterId, prov.guildDbId, prov.playerId);
    if (Number.isSafeInteger(previewedWaifuId) && preview.waifuId !== previewedWaifuId) {
      await respondEphemeral(
        interaction,
        'Your active buddy changed since that preview~ Press **Commit Buddy** again to see the new numbers.',
      );
      return;
    }

    const participation = await service.commit(
      encounterId,
      prov.guildDbId,
      prov.playerId,
      { discordUserId: owner.discordUserId, trainerName: owner.displayName },
    );

    await respondEphemeral(
      interaction,
      `**${participation.waifuName}** is committed to **${preview.encounter.bossName}**~\n` +
        'Rewards arrive when the battle resolves.',
    );

    // Post-commit, never inside the transaction — and carrying none of the
    // preview's private numbers. See the payload's own comment.
    await emitEvents(ctx, interaction, prov, [
      gameEvent('BOSS_BUDDY_COMMITTED', {
        encounterId,
        bossId: preview.encounter.bossId,
        waifuId: participation.waifuId,
        waifuName: participation.waifuName,
        level: participation.level,
      }),
    ]);
  } catch (err) {
    await replyDomainError(interaction, err);
  }
}

/**
 * All Results pagination.
 *
 * Edits the public message in place rather than posting a page. The page
 * number lives in the custom id, so this survives a restart with no
 * server-side cursor to lose — a button pressed tomorrow renders correctly
 * from the stored participations.
 */
export async function handleBossPage(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = bossService(ctx);
  const encounterId = parseEncounterId(args);
  if (!service || encounterId === null) return rejectStale(interaction);
  const page = Math.max(1, Number.parseInt(args[1] ?? '1', 10) || 1);

  const encounter = await service.getEncounter(encounterId);
  if (!encounter || encounter.guildId !== prov.guildDbId) return rejectStale(interaction);

  const listing = await service.listParticipations(encounterId, { page });
  const payload = buildResults({
    encounter,
    reason: (encounter.resolutionReason ?? 'repelled') as BossResolutionReason,
    boss: service.bossFor(encounter),
    entries: listing.entries,
    page: listing.page,
    totalPages: listing.totalPages,
    totalParticipants: listing.total,
    // Encounter-level totals, not page-level: the header says what the whole
    // battle did, and it must not change as a reader turns pages.
    totalDamage: encounter.totalDamage,
    totalAttacks:
      encounter.participantCount * ctx.content.tables.bossEncounters.attacksPerParticipation,
    firstOnScene: await service.getFirstOnScene(encounterId),
    ...resolveBossArtwork(ctx, encounter),
  });
  // `update` keeps the results on the one message the encounter owns. Files
  // are re-sent because an edit that omits them drops the attachment.
  await interaction.update(payload);
}

/** My Result — the requesting player's full record, privately. */
export async function handleBossMyResult(
  ctx: AppContext,
  interaction: ButtonInteraction,
  prov: Provisioned,
  args: string[],
): Promise<void> {
  const service = bossService(ctx);
  const encounterId = parseEncounterId(args);
  if (!service || encounterId === null) return rejectStale(interaction);

  const encounter = await service.getEncounter(encounterId);
  if (!encounter || encounter.guildId !== prov.guildDbId) return rejectStale(interaction);

  const entry = await service.getParticipation(encounterId, prov.playerId);
  // A followUp rather than an update: the public results message belongs to
  // the encounter, and one player asking for their own line must not repaint
  // it for everybody else.
  await interaction.reply({
    content: buildMyResult(encounter, entry),
    flags: MessageFlags.Ephemeral,
  });
}
