/**
 * Best-effort ephemeral cleanup.
 *
 * These drive real timers through vitest's fake clock rather than a test seam,
 * so what is asserted is the actual scheduling behaviour: what gets deleted,
 * when, what is left alone, and what happens when the delete fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import {
  EPHEMERAL_CONFIRM_TTL_MS,
  EPHEMERAL_UNLOCK_TOAST_TTL_MS,
  INTERACTION_TOKEN_LIFETIME_MS,
  followUpEphemeralNotice,
  replyEphemeralNotice,
  scheduleEphemeralCleanup,
} from '../../src/discord/ephemeralCleanup';
import { silentLogger } from '../helpers/testDb';

const ctx = { logger: silentLogger() };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeInteraction(deleteImpl?: () => Promise<unknown>) {
  return {
    deleteReply: vi.fn(deleteImpl ?? (async () => undefined)),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => ({ id: 'm-follow' })),
  };
}

/** A real DiscordAPIError, so the swallow path is exercised for real. */
function discordError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'boom' },
    code,
    404,
    'DELETE',
    'https://discord.test',
    {},
  );
}

describe('scheduleEphemeralCleanup', () => {
  it('deletes the original response after the delay', async () => {
    const i = fakeInteraction();
    const timer = scheduleEphemeralCleanup(ctx, i, { delayMs: EPHEMERAL_CONFIRM_TTL_MS });

    expect(timer).not.toBeNull();
    expect(i.deleteReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS);
    expect(i.deleteReply).toHaveBeenCalledTimes(1);
    expect(i.deleteReply).toHaveBeenCalledWith(undefined);
  });

  it('does not delete before the delay elapses', async () => {
    const i = fakeInteraction();
    scheduleEphemeralCleanup(ctx, i, { delayMs: EPHEMERAL_CONFIRM_TTL_MS });

    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS - 1);
    expect(i.deleteReply).not.toHaveBeenCalled();
  });

  it('targets a specific follow-up when given a message id', async () => {
    const i = fakeInteraction();
    scheduleEphemeralCleanup(ctx, i, { delayMs: 1000, messageId: 'm-42' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(i.deleteReply).toHaveBeenCalledWith('m-42');
  });

  describe('refuses to schedule outside the token window', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['past the token lifetime', INTERACTION_TOKEN_LIFETIME_MS + 1],
      ['inside the final minute', INTERACTION_TOKEN_LIFETIME_MS - 30_000],
    ])('%s', async (_label, delayMs) => {
      const i = fakeInteraction();
      expect(scheduleEphemeralCleanup(ctx, i, { delayMs })).toBeNull();

      await vi.advanceTimersByTimeAsync(INTERACTION_TOKEN_LIFETIME_MS * 2);
      expect(i.deleteReply).not.toHaveBeenCalled();
    });
  });

  describe('swallows delete failures', () => {
    it.each([
      ['Unknown Message', 10008],
      ['Unknown Interaction', 10062],
      ['already acknowledged', 40060],
    ])('%s is ignored silently', async (_label, code) => {
      const i = fakeInteraction(async () => {
        throw discordError(code);
      });
      scheduleEphemeralCleanup(ctx, i, { delayMs: 1000 });

      // The rejection is swallowed inside the timer: advancing the clock must
      // neither throw here nor surface an unhandled rejection.
      await vi.advanceTimersByTimeAsync(1000);
      expect(i.deleteReply).toHaveBeenCalledTimes(1);
    });

    it('an unexpected error is logged, not thrown', async () => {
      const warn = vi.fn();
      const debug = vi.fn();
      const noisyCtx = { logger: { ...silentLogger(), warn, debug } as never };
      const i = fakeInteraction(async () => {
        throw new Error('network down');
      });
      scheduleEphemeralCleanup(noisyCtx, i, { delayMs: 1000, label: 'test' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(debug).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('does not hold the process open', () => {
    const i = fakeInteraction();
    const timer = scheduleEphemeralCleanup(ctx, i, { delayMs: 1000 });
    // `unref` is what keeps a pending cosmetic delete from blocking shutdown.
    expect(timer).not.toBeNull();
    expect(typeof timer!.unref).toBe('function');
  });
});

describe('replyEphemeralNotice', () => {
  it('replies ephemerally and schedules the confirm TTL', async () => {
    const i = fakeInteraction();
    await replyEphemeralNotice(ctx, i as never, 'Nickname cleared.');

    expect(i.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Nickname cleared.' }),
    );
    // Ephemeral flag is set (MessageFlags.Ephemeral === 64).
    expect((i.reply.mock.calls[0] as unknown as any[])[0].flags).toBe(64);

    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS);
    expect(i.deleteReply).toHaveBeenCalledTimes(1);
  });

  it('clears within a minute — the stated confirmation window', async () => {
    const i = fakeInteraction();
    await replyEphemeralNotice(ctx, i as never, 'done');

    await vi.advanceTimersByTimeAsync(30_000);
    const atThirtySeconds = i.deleteReply.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(atThirtySeconds).toBe(0);
    expect(i.deleteReply).toHaveBeenCalledTimes(1);
    expect(EPHEMERAL_CONFIRM_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(EPHEMERAL_CONFIRM_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('followUpEphemeralNotice', () => {
  it('schedules cleanup against the follow-up message id', async () => {
    const i = fakeInteraction();
    await followUpEphemeralNotice(ctx, i as never, 'levelled up');

    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS);
    expect(i.deleteReply).toHaveBeenCalledWith('m-follow');
  });

  it('falls back to the original response when no id comes back', async () => {
    const i = fakeInteraction();
    i.followUp.mockResolvedValue(undefined as never);
    await followUpEphemeralNotice(ctx, i as never, 'levelled up');

    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS);
    expect(i.deleteReply).toHaveBeenCalledWith(undefined);
  });
});

describe('TTL constants', () => {
  it('unlock toasts live 3–5 minutes, well inside the token window', () => {
    expect(EPHEMERAL_UNLOCK_TOAST_TTL_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(EPHEMERAL_UNLOCK_TOAST_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(EPHEMERAL_UNLOCK_TOAST_TTL_MS).toBeLessThan(INTERACTION_TOKEN_LIFETIME_MS);
  });

  it('toasts outlive plain confirmations — they carry buttons', () => {
    expect(EPHEMERAL_UNLOCK_TOAST_TTL_MS).toBeGreaterThan(EPHEMERAL_CONFIRM_TTL_MS);
  });
});
