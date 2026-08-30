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
 *
 * **Which buttons live on which message** — the distinction every handler here
 * turns on, because it decides whether answering with `update()` is correct or
 * catastrophic:
 *
 *   Commit Buddy   → the **public** announcement. Must answer with a *new*
 *                    ephemeral reply. `update()` here would edit the public
 *                    encounter message and replace the boss embed with one
 *                    player's private preview.
 *   Confirm/Cancel → the player's own ephemeral preview. `update()` is right:
 *                    it replaces that private screen in place.
 *   View My Rewards → the **public results message**, answered privately with a
 *                    fresh ephemeral reply for the same reason as Commit. The
 *                    public results message is static — it carries no other
 *                    controls, so no player interaction can repaint it.
 */
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BossEncounterService } from '../../modules/bosses/bossEncounterService';
import { gameEvent } from '../../modules/events/gameEvents';
import { AppError } from '../../shared/errors';
import {
  buildCommitPreview,
  buildMyResult,
} from '../bossPresenter';
import { replyEphemeral, respondEphemeral } from '../ephemeralSession';
import { emitEvents } from '../gameEventEmitter';
import type { AppContext, Provisioned } from '../types';
import { ownerFromInteraction } from '../userDisplay';

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

/**
 * Shared refusal for a button that no longer points anywhere.
 *
 * `replyEphemeral`, not `respondEphemeral`: a stale button is most likely a
 * **Commit Buddy** on an old public announcement, and refusing it with an
 * `update()` would blank that encounter's permanent history to say so.
 */
async function rejectStale(interaction: ButtonInteraction): Promise<void> {
  await replyEphemeral(
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
  /**
   * Whether the pressed button lives on a public message. Commit Buddy does;
   * Confirm does not. Defaulting to the safe answer would be worse than an
   * explicit one — the unsafe case is silent and public.
   */
  onPublicMessage: boolean,
): Promise<void> {
  if (err instanceof AppError) {
    if (onPublicMessage) await replyEphemeral(interaction, err.userMessage);
    else await respondEphemeral(interaction, err.userMessage);
    return;
  }
  throw err;
}

/**
 * Commit Buddy → the ephemeral preview. Writes nothing.
 *
 * **This button lives on the public announcement**, so the reply must be a new
 * ephemeral message. `respondEphemeral` would answer an un-replied component
 * with `interaction.update()`, which edits the message the button is attached
 * to — replacing the boss embed, the artwork and the button itself with one
 * player's private preview, publicly, for the rest of the encounter's life.
 * That is exactly the regression this handler exists to not have.
 */
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
    await replyEphemeral(interaction, buildCommitPreview(preview));
  } catch (err) {
    await replyDomainError(interaction, err, true);
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

    // Push the new participant count to the public announcement.
    //
    // An ordinary message *edit*, made through the announcer, not an
    // `interaction.update()`: the announcement is not this interaction's
    // message, and the edit re-renders the same `buildAnnouncement` payload —
    // boss embed, artwork and Commit Buddy button all preserved — with the
    // count refreshed. Nothing player-specific goes near it.
    //
    // Best-effort, and deliberately after the ephemeral confirmation: the
    // participation is already committed and durable, so a failed edit costs a
    // count that is stale until the scheduler's next refresh a minute later.
    // It must never turn a successful commit into an error.
    await refreshPublicCount(ctx, encounterId);

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
    // Confirm lives on the player's own ephemeral preview, so an `update()`
    // reply is correct here — it replaces that private screen.
    await replyDomainError(interaction, err, false);
  }
}

/**
 * Re-render the public announcement so its "Trainers Committed" field is
 * current, without disturbing anything else on it.
 *
 * Routed through `ctx.bossAnnouncer.refreshAnnouncement`, the same call the
 * scheduler makes every minute, so there is exactly one definition of what a
 * live announcement looks like and a commit-time edit cannot drift from a
 * tick-time one.
 */
async function refreshPublicCount(ctx: AppContext, encounterId: number): Promise<void> {
  const announcer = ctx.bossAnnouncer;
  const service = bossService(ctx);
  if (!announcer || !service) return;
  try {
    const encounter = await service.getEncounter(encounterId);
    // Only while the window is open. A resolved encounter's message is
    // permanent history and must never be repainted back into its live form.
    if (!encounter || encounter.status !== 'scouting') return;
    await announcer.refreshAnnouncement(encounter);
  } catch (err) {
    ctx.logger.warn(
      { tag: 'boss/commit-refresh-failed', encounterId, err },
      'boss participant-count refresh failed after a commit — the next tick will correct it',
    );
  }
}

/**
 * My Result — the requesting player's full record, privately. */
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
  // A fresh ephemeral reply rather than an update: this button lives on the
  // public results message, and one player asking for their own line must not
  // repaint it for everybody else.
  await interaction.reply({
    content: buildMyResult(encounter, entry),
    flags: MessageFlags.Ephemeral,
  });
}
