/**
 * The per-player ephemeral registry.
 *
 * Its whole job is deciding *what may be deleted*, so these tests concentrate
 * on the boundaries: expiry against the interaction-token window, isolation
 * between players, and the exclusion that stops a caller sweeping away its own
 * freshly-painted screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import {
  INTERACTION_TOKEN_LIFETIME_MS,
  cleanupPlayerEphemerals,
  createEphemeralRegistry,
  registerEphemeral,
} from '../../src/discord/ephemeralCleanup';
import { silentLogger } from '../helpers/testDb';

const NOW = 1_000_000;

function ctxWith(registry = createEphemeralRegistry()) {
  return { logger: silentLogger(), ephemerals: registry };
}

function fakeInteraction(id: string, deleteImpl?: () => Promise<unknown>) {
  return { id, deleteReply: vi.fn(deleteImpl ?? (async () => undefined)) };
}

function discordError(code: number): DiscordAPIError {
  return new DiscordAPIError({ code, message: 'gone' }, code, 404, 'DELETE', 'https://d.test', {});
}

describe('registry bookkeeping', () => {
  it('tracks handles per player', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-1'), { playerId: 1, label: 'a', now: NOW });
    registerEphemeral(ctx, fakeInteraction('i-2'), { playerId: 1, label: 'b', now: NOW });
    registerEphemeral(ctx, fakeInteraction('i-3'), { playerId: 2, label: 'c', now: NOW });

    expect(ctx.ephemerals.size(1)).toBe(2);
    expect(ctx.ephemerals.size(2)).toBe(1);
    expect(ctx.ephemerals.size()).toBe(3);
  });

  it('take() empties the player and leaves others alone', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-1'), { playerId: 1, label: 'a', now: NOW });
    registerEphemeral(ctx, fakeInteraction('i-2'), { playerId: 2, label: 'b', now: NOW });

    expect(ctx.ephemerals.take(1, { now: NOW })).toHaveLength(1);
    expect(ctx.ephemerals.size(1)).toBe(0);
    expect(ctx.ephemerals.size(2)).toBe(1);
  });

  it('take() on an unknown player is empty, not an error', () => {
    expect(ctxWith().ephemerals.take(99)).toEqual([]);
  });

  it('carries the label through for logging and assertions', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-1'), { playerId: 1, label: 'inspect-card', now: NOW });
    expect(ctx.ephemerals.take(1, { now: NOW })[0]!.label).toBe('inspect-card');
  });
});

describe('expiry', () => {
  it('drops handles past the token lifetime instead of returning them', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-old'), { playerId: 1, label: 'old', now: NOW });

    const taken = ctx.ephemerals.take(1, { now: NOW + INTERACTION_TOKEN_LIFETIME_MS });
    expect(taken).toEqual([]);
    expect(ctx.ephemerals.size(1)).toBe(0);
  });

  it('keeps handles still inside the window', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-fresh'), { playerId: 1, label: 'fresh', now: NOW });

    const taken = ctx.ephemerals.take(1, { now: NOW + INTERACTION_TOKEN_LIFETIME_MS - 1 });
    expect(taken).toHaveLength(1);
  });

  it('never attempts a delete for an expired handle', async () => {
    const ctx = ctxWith();
    const i = fakeInteraction('i-old');
    registerEphemeral(ctx, i, { playerId: 1, label: 'old', now: NOW });

    const result = await cleanupPlayerEphemerals(ctx, 1, {
      now: NOW + INTERACTION_TOKEN_LIFETIME_MS + 1,
    });

    expect(i.deleteReply).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, deleted: 0 });
  });

  it('sweeps stale handles on write so an idle process does not accumulate', () => {
    const ctx = ctxWith();
    registerEphemeral(ctx, fakeInteraction('i-old'), { playerId: 1, label: 'old', now: NOW });
    registerEphemeral(ctx, fakeInteraction('i-new'), {
      playerId: 1,
      label: 'new',
      now: NOW + INTERACTION_TOKEN_LIFETIME_MS + 1,
    });

    expect(ctx.ephemerals.size(1)).toBe(1);
  });
});

describe('cleanupPlayerEphemerals', () => {
  it('deletes every tracked handle and reports the tally', async () => {
    const ctx = ctxWith();
    const a = fakeInteraction('i-1');
    const b = fakeInteraction('i-2');
    registerEphemeral(ctx, a, { playerId: 1, label: 'a', now: NOW });
    registerEphemeral(ctx, b, { playerId: 1, label: 'b', now: NOW });

    const result = await cleanupPlayerEphemerals(ctx, 1, { now: NOW });

    expect(a.deleteReply).toHaveBeenCalledTimes(1);
    expect(b.deleteReply).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 2, deleted: 2 });
    expect(ctx.ephemerals.size(1)).toBe(0);
  });

  it('spares handles from the excluded interaction', async () => {
    const ctx = ctxWith();
    const old = fakeInteraction('i-old');
    const current = fakeInteraction('i-current');
    registerEphemeral(ctx, old, { playerId: 1, label: 'old-screen', now: NOW });
    registerEphemeral(ctx, current, { playerId: 1, label: 'care-menu', now: NOW });

    await cleanupPlayerEphemerals(ctx, 1, { now: NOW, excludeInteractionId: 'i-current' });

    expect(old.deleteReply).toHaveBeenCalledTimes(1);
    expect(current.deleteReply).not.toHaveBeenCalled();
    // The spared handle stays registered for its own timer or a later sweep.
    expect(ctx.ephemerals.size(1)).toBe(1);
  });

  it('touches only the requested player', async () => {
    const ctx = ctxWith();
    const mine = fakeInteraction('i-1');
    const theirs = fakeInteraction('i-2');
    registerEphemeral(ctx, mine, { playerId: 1, label: 'a', now: NOW });
    registerEphemeral(ctx, theirs, { playerId: 2, label: 'b', now: NOW });

    await cleanupPlayerEphemerals(ctx, 1, { now: NOW });

    expect(mine.deleteReply).toHaveBeenCalled();
    expect(theirs.deleteReply).not.toHaveBeenCalled();
  });

  it.each([
    ['Unknown Message', 10008],
    ['Unknown Interaction', 10062],
  ])('swallows %s and still clears the handle', async (_label, code) => {
    const ctx = ctxWith();
    registerEphemeral(
      ctx,
      fakeInteraction('i-1', async () => {
        throw discordError(code);
      }),
      { playerId: 1, label: 'a', now: NOW },
    );

    const result = await cleanupPlayerEphemerals(ctx, 1, { now: NOW });

    expect(result).toEqual({ attempted: 1, deleted: 0 });
    expect(ctx.ephemerals.size(1)).toBe(0);
  });

  it('one failure does not stop the others', async () => {
    const ctx = ctxWith();
    const good = fakeInteraction('i-good');
    registerEphemeral(
      ctx,
      fakeInteraction('i-bad', async () => {
        throw new Error('network down');
      }),
      { playerId: 1, label: 'bad', now: NOW },
    );
    registerEphemeral(ctx, good, { playerId: 1, label: 'good', now: NOW });

    const result = await cleanupPlayerEphemerals(ctx, 1, { now: NOW });

    expect(good.deleteReply).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 2, deleted: 1 });
  });

  it('is a no-op when nothing is tracked', async () => {
    expect(await cleanupPlayerEphemerals(ctxWith(), 1)).toEqual({ attempted: 0, deleted: 0 });
  });
});
