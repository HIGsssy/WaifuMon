/**
 * Best-effort cleanup for short-lived ephemeral responses.
 *
 * Discord hides ephemerals only when the player dismisses them, so a session
 * of hunting leaves a column of stale "you gained 3 Essence" notes above the
 * screen the player is actually using. This schedules a delete for the ones
 * that have finished saying what they had to say.
 *
 * Deliberately narrow. Cleanup is opt-in per call site, never a blanket
 * behaviour of `respondEphemeral`, because that helper also paints the
 * collection list and the inspect card — the *active UI*, which must stay put
 * until the player navigates away from it. Only two kinds of message are
 * scheduled:
 *
 *   - content-only confirmations and validation errors, at
 *     {@link EPHEMERAL_CONFIRM_TTL_MS};
 *   - appearance unlock toasts, at {@link EPHEMERAL_UNLOCK_TOAST_TTL_MS} —
 *     longer, because they carry Select Now / View Gallery buttons a player
 *     may reasonably take a minute to notice.
 *
 * Public Waifumon Log posts are channel messages, not interaction responses,
 * and nothing here can reach them.
 *
 * Everything is best-effort: a failed delete is swallowed. The message is
 * cosmetic, the gameplay write committed long ago, and a player who already
 * dismissed the ephemeral by hand must never see an error because of it.
 */
import { MessageFlags } from 'discord.js';
import type { AppContext, PlayerInteraction } from './types';
import { isStaleInteractionError } from './ui';

/** Confirmations and validation errors — long enough to read, then gone. */
export const EPHEMERAL_CONFIRM_TTL_MS = 45_000;

/** Unlock toasts carry buttons, so they linger well past a glance. */
export const EPHEMERAL_UNLOCK_TOAST_TTL_MS = 4 * 60_000;

/**
 * Interaction tokens are valid for 15 minutes; deleting a response needs the
 * token, so anything scheduled past that would fail by definition.
 */
export const INTERACTION_TOKEN_LIFETIME_MS = 15 * 60_000;

/**
 * Refuse to schedule inside the last minute of the token's life — a delete
 * fired at 14:59 is racing the expiry for no benefit.
 */
const MAX_CLEANUP_DELAY_MS = INTERACTION_TOKEN_LIFETIME_MS - 60_000;

/** The slice of an interaction this module needs. Structural, for testability. */
export interface DeletableInteraction {
  deleteReply(message?: string): Promise<unknown>;
}

export interface CleanupOptions {
  /** How long to leave the message up. Must be within the token's lifetime. */
  delayMs: number;
  /**
   * Follow-up message id. Omit to target the interaction's original response
   * (what `reply()` produced).
   */
  messageId?: string | undefined;
  /** Log context when a delete fails for an unexpected reason. */
  label?: string;
}

/**
 * Schedule a best-effort delete. Returns the timer (so a caller or a test can
 * inspect or cancel it), or `null` when the delay is outside the window in
 * which a delete could actually succeed.
 *
 * The timer is `unref`'d: pending cleanup never keeps the process alive, and a
 * shutdown mid-window simply leaves the ephemeral for the player to dismiss.
 */
export function scheduleEphemeralCleanup(
  ctx: Pick<AppContext, 'logger'>,
  interaction: DeletableInteraction,
  opts: CleanupOptions,
): NodeJS.Timeout | null {
  const { delayMs } = opts;
  if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > MAX_CLEANUP_DELAY_MS) {
    ctx.logger.debug(
      { tag: 'ephemeral-cleanup/skipped', delayMs, label: opts.label },
      'ephemeral cleanup not scheduled — delay outside the interaction token window',
    );
    return null;
  }

  const timer = setTimeout(() => {
    void (async () => {
      try {
        await interaction.deleteReply(opts.messageId);
      } catch (err) {
        // Already dismissed, already gone, or the token aged out — all normal.
        if (isStaleInteractionError(err)) return;
        ctx.logger.debug(
          { err, tag: 'ephemeral-cleanup/failed', label: opts.label },
          'ephemeral cleanup delete failed',
        );
      }
    })();
  }, delayMs);

  // Never hold the event loop open for a cosmetic delete.
  timer.unref?.();
  return timer;
}

/**
 * Reply with a content-only ephemeral notice and schedule its cleanup.
 *
 * Content-only by construction: a notice with components would be interactive,
 * and interactive surfaces are not safe to delete out from under the player.
 */
export async function replyEphemeralNotice(
  ctx: Pick<AppContext, 'logger'>,
  interaction: PlayerInteraction,
  content: string,
  label?: string,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  scheduleEphemeralCleanup(ctx, interaction, {
    delayMs: EPHEMERAL_CONFIRM_TTL_MS,
    ...(label === undefined ? {} : { label }),
  });
}

/**
 * Follow up with a content-only ephemeral notice and schedule its cleanup.
 * Used where the main screen was already painted and the note rides on top.
 */
export async function followUpEphemeralNotice(
  ctx: Pick<AppContext, 'logger'>,
  interaction: PlayerInteraction,
  content: string,
  label?: string,
): Promise<void> {
  const message = (await interaction.followUp({
    content,
    flags: MessageFlags.Ephemeral,
  })) as { id?: string } | undefined;
  scheduleEphemeralCleanup(ctx, interaction, {
    delayMs: EPHEMERAL_CONFIRM_TTL_MS,
    ...(message?.id === undefined ? {} : { messageId: message.id }),
    ...(label === undefined ? {} : { label }),
  });
}
