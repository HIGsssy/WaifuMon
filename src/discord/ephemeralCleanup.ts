/**
 * Best-effort cleanup for Waifumon's ephemeral interaction responses.
 *
 * **What Discord actually allows.** There is no API for "delete this player's
 * ephemeral history". An ephemeral can only be removed through the interaction
 * that produced it, using that interaction's token, and tokens die 15 minutes
 * after the interaction is created. So this module can only clean up messages
 * that (a) Waifumon itself created, (b) we still hold a handle for in this
 * process, and (c) are still inside their token window. Anything older, or
 * anything created before the last restart, stays until the player dismisses
 * it by hand. Nothing here can reach public channel messages at all — those
 * are sent through `channel.send` and have no interaction token.
 *
 * **One registry, two triggers.** Every deletable ephemeral is registered
 * against its player. Handles are then removed either by a timer (the TTLs
 * below) or in a batch when the player enters Care Mode and the Trainer
 * Profile takes over their view. Both paths call the same delete, so there is
 * one notion of "what can be cleaned up" rather than two that drift.
 *
 * Registration and scheduling are separate on purpose:
 *   - `registerEphemeral` only makes a message *eligible* for batch cleanup.
 *     The collection list and inspect card are registered this way, so they
 *     survive normal play but get swept when Care Mode replaces them.
 *   - `scheduleEphemeralCleanup` additionally arms a timer, for confirmations
 *     and unlock toasts that have finished saying what they had to say.
 *
 * Everything is best-effort: a failed delete is swallowed. The message is
 * cosmetic, the gameplay write committed long ago, and a player who already
 * dismissed the ephemeral must never see an error because of it.
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
 * token, so a handle older than this can never be acted on.
 */
export const INTERACTION_TOKEN_LIFETIME_MS = 15 * 60_000;

/**
 * Refuse to schedule inside the last minute of the token's life — a delete
 * fired at 14:59 is racing the expiry for no benefit.
 */
const MAX_CLEANUP_DELAY_MS = INTERACTION_TOKEN_LIFETIME_MS - 60_000;

/** The slice of an interaction this module needs. Structural, for testability. */
export interface DeletableInteraction {
  id?: string;
  deleteReply(message?: string): Promise<unknown>;
}

/** One deletable ephemeral message. */
export interface EphemeralHandle {
  /** Registry key. */
  readonly id: string;
  readonly playerId: number;
  /** The interaction that produced it — lets a caller skip its own messages. */
  readonly interactionId: string | null;
  readonly createdAt: number;
  /** What this was, for logs and test assertions. */
  readonly label: string;
  /** Performs the delete. Rejections are the caller's to swallow. */
  delete(): Promise<unknown>;
}

export interface TakeOptions {
  /** Skip handles from this interaction — used to spare the caller's own UI. */
  excludeInteractionId?: string | null | undefined;
  now?: number;
}

export interface EphemeralRegistry {
  register(handle: Omit<EphemeralHandle, 'id'>): EphemeralHandle;
  /** Drop one handle without deleting (the timer path uses this after firing). */
  forget(id: string): void;
  /**
   * Remove and return this player's live handles. Expired ones are dropped
   * rather than returned — their tokens are dead, so a delete would only fail.
   */
  take(playerId: number, opts?: TakeOptions): EphemeralHandle[];
  /** Live handle count, for diagnostics and tests. */
  size(playerId?: number): number;
}

let handleSeq = 0;

export function createEphemeralRegistry(): EphemeralRegistry {
  const byPlayer = new Map<number, Map<string, EphemeralHandle>>();

  function expired(handle: EphemeralHandle, now: number): boolean {
    return now - handle.createdAt >= INTERACTION_TOKEN_LIFETIME_MS;
  }

  /** Drop dead handles wherever we happen to be walking the map. */
  function sweep(bucket: Map<string, EphemeralHandle>, now: number): void {
    for (const [id, handle] of bucket) {
      if (expired(handle, now)) bucket.delete(id);
    }
  }

  return {
    register(input) {
      const handle: EphemeralHandle = { ...input, id: `eph-${++handleSeq}` };
      let bucket = byPlayer.get(handle.playerId);
      if (!bucket) {
        bucket = new Map();
        byPlayer.set(handle.playerId, bucket);
      }
      // Opportunistic sweep on write keeps an idle process from accumulating
      // handles for players who wandered off — no timer to own.
      sweep(bucket, handle.createdAt);
      bucket.set(handle.id, handle);
      return handle;
    },

    forget(id) {
      for (const [playerId, bucket] of byPlayer) {
        if (bucket.delete(id) && bucket.size === 0) byPlayer.delete(playerId);
      }
    },

    take(playerId, opts = {}) {
      const now = opts.now ?? Date.now();
      const bucket = byPlayer.get(playerId);
      if (!bucket) return [];
      const taken: EphemeralHandle[] = [];
      for (const [id, handle] of bucket) {
        if (expired(handle, now)) {
          bucket.delete(id);
          continue;
        }
        if (
          opts.excludeInteractionId != null &&
          handle.interactionId === opts.excludeInteractionId
        ) {
          continue;
        }
        bucket.delete(id);
        taken.push(handle);
      }
      if (bucket.size === 0) byPlayer.delete(playerId);
      return taken;
    },

    size(playerId) {
      if (playerId != null) return byPlayer.get(playerId)?.size ?? 0;
      let total = 0;
      for (const bucket of byPlayer.values()) total += bucket.size;
      return total;
    },
  };
}

/**
 * Registry for this context. Production wires one in `index.ts`; a context
 * without one gets a lazily-attached registry of its own, so tests stay
 * isolated instead of sharing process-wide state.
 */
const contextRegistries = new WeakMap<object, EphemeralRegistry>();

export function ephemeralRegistry(ctx: Pick<AppContext, 'ephemerals'>): EphemeralRegistry {
  if (ctx.ephemerals) return ctx.ephemerals;
  let registry = contextRegistries.get(ctx);
  if (!registry) {
    registry = createEphemeralRegistry();
    contextRegistries.set(ctx, registry);
  }
  return registry;
}

type CleanupCtx = Pick<AppContext, 'logger' | 'ephemerals'>;

export interface RegisterOptions {
  playerId: number;
  /** Follow-up id; omit to target the interaction's original response. */
  messageId?: string | undefined;
  label: string;
  now?: number;
}

/**
 * Make an ephemeral eligible for batch cleanup. Does **not** arm a timer — the
 * message stays until either a scheduled cleanup or Care Mode removes it.
 */
export function registerEphemeral(
  ctx: CleanupCtx,
  interaction: DeletableInteraction,
  opts: RegisterOptions,
): EphemeralHandle {
  return ephemeralRegistry(ctx).register({
    playerId: opts.playerId,
    interactionId: interaction.id ?? null,
    createdAt: opts.now ?? Date.now(),
    label: opts.label,
    delete: () => interaction.deleteReply(opts.messageId),
  });
}

/** Run one handle's delete, swallowing the failures that are expected. */
async function runDelete(ctx: CleanupCtx, handle: EphemeralHandle): Promise<boolean> {
  try {
    await handle.delete();
    return true;
  } catch (err) {
    // Already dismissed, already gone, or the token aged out — all normal.
    if (isStaleInteractionError(err)) return false;
    ctx.logger.debug(
      { err, tag: 'ephemeral-cleanup/failed', label: handle.label },
      'ephemeral cleanup delete failed',
    );
    return false;
  }
}

export interface CleanupOptions extends RegisterOptions {
  /** How long to leave the message up. Must be within the token's lifetime. */
  delayMs: number;
}

/**
 * Register an ephemeral and arm a best-effort delete. Returns the timer (so a
 * caller or test can inspect or cancel it), or `null` when the delay falls
 * outside the window in which a delete could actually succeed — the handle is
 * still registered in that case, so batch cleanup can reach it.
 *
 * The timer is `unref`'d: pending cleanup never keeps the process alive.
 */
export function scheduleEphemeralCleanup(
  ctx: CleanupCtx,
  interaction: DeletableInteraction,
  opts: CleanupOptions,
): NodeJS.Timeout | null {
  const handle = registerEphemeral(ctx, interaction, opts);
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
      // Claim it first: a Care Mode sweep that already took this handle must
      // not race us into a second delete.
      ephemeralRegistry(ctx).forget(handle.id);
      await runDelete(ctx, handle);
    })();
  }, delayMs);

  timer.unref?.();
  return timer;
}

export interface PlayerCleanupResult {
  /** Handles taken from the registry (expired ones are never included). */
  attempted: number;
  /** Deletes Discord accepted. */
  deleted: number;
}

/**
 * Best-effort sweep of one player's tracked ephemerals.
 *
 * Called when Care Mode takes over the player's view: the Trainer Profile is
 * now the thing to look at, so the collection card, inspect screen, toasts and
 * notices stacked above it are noise. Handles are removed from the registry
 * whether or not their delete succeeded — a failure means the message is
 * already gone or unreachable, and either way retrying is pointless.
 *
 * Never throws: Care Mode has already started by the time this runs.
 */
export async function cleanupPlayerEphemerals(
  ctx: CleanupCtx,
  playerId: number,
  opts: TakeOptions = {},
): Promise<PlayerCleanupResult> {
  const handles = ephemeralRegistry(ctx).take(playerId, opts);
  if (handles.length === 0) return { attempted: 0, deleted: 0 };

  const results = await Promise.all(handles.map((handle) => runDelete(ctx, handle)));
  const deleted = results.filter(Boolean).length;
  ctx.logger.debug(
    { tag: 'ephemeral-cleanup/player-sweep', playerId, attempted: handles.length, deleted },
    'swept tracked ephemerals for player',
  );
  return { attempted: handles.length, deleted };
}

/**
 * Reply with a content-only ephemeral notice, register it, and schedule its
 * cleanup. Content-only by construction: a notice with components would be
 * interactive, and interactive surfaces are not safe to delete on a timer.
 */
export async function replyEphemeralNotice(
  ctx: CleanupCtx,
  interaction: PlayerInteraction,
  playerId: number,
  content: string,
  label: string,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  scheduleEphemeralCleanup(ctx, interaction, {
    delayMs: EPHEMERAL_CONFIRM_TTL_MS,
    playerId,
    label,
  });
}

/**
 * Follow up with a content-only ephemeral notice, register it, and schedule
 * its cleanup. Used where the main screen was already painted.
 */
export async function followUpEphemeralNotice(
  ctx: CleanupCtx,
  interaction: PlayerInteraction,
  playerId: number,
  content: string,
  label: string,
): Promise<void> {
  const message = (await interaction.followUp({
    content,
    flags: MessageFlags.Ephemeral,
  })) as { id?: string } | undefined;
  scheduleEphemeralCleanup(ctx, interaction, {
    delayMs: EPHEMERAL_CONFIRM_TTL_MS,
    playerId,
    label,
    ...(message?.id === undefined ? {} : { messageId: message.id }),
  });
}
