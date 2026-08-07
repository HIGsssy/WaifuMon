/**
 * Cache-behaviour lock (plan §22.5, §26 "Cache TTLs drift").
 *
 * These assertions restate plan §13's table. They exist so a distracted edit to
 * `cachePolicy.ts` fails a test rather than quietly making the Portal stale (or
 * chatty) in a way nobody notices until a player complains their currencies are
 * wrong.
 *
 * The shape assertions matter as much as the numbers: "content never refetches
 * on reconnect" and "identity never refetches on focus" are the two rules that
 * keep a flaky link from turning into a burst of redundant requests, and both
 * are one careless keystroke from being reversed.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTENT_POLICY,
  IDENTITY_POLICY,
  PLAYER_POLICY,
  SHOP_POLICY,
  type CachePolicy,
} from '../cachePolicy';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const ALL: Array<[string, CachePolicy]> = [
  ['identity', IDENTITY_POLICY],
  ['content', CONTENT_POLICY],
  ['shop', SHOP_POLICY],
  ['player', PLAYER_POLICY],
];

describe('cache policy (plan §13)', () => {
  it('treats content as effectively static and never refetches it on focus', () => {
    expect(CONTENT_POLICY.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(CONTENT_POLICY.refetchOnWindowFocus).toBe(false);
    expect(CONTENT_POLICY.gcTime).toBeGreaterThanOrEqual(60 * MINUTE);
  });

  it('never refetches content on reconnect — nothing changed while offline', () => {
    // The whole tree refetching at once is the worst thing to do to a link that
    // has only just come back.
    expect(CONTENT_POLICY.refetchOnReconnect).toBe(false);
  });

  it('keeps the shop long-lived and off the focus path', () => {
    expect(SHOP_POLICY.staleTime).toBe(5 * MINUTE);
    expect(SHOP_POLICY.refetchOnWindowFocus).toBe(false);
    expect(SHOP_POLICY.refetchOnReconnect).toBe(true);
  });

  it('keeps player-scoped data inside the 30–60s window and refreshing on focus', () => {
    expect(PLAYER_POLICY.staleTime).toBeGreaterThanOrEqual(30 * SECOND);
    expect(PLAYER_POLICY.staleTime).toBeLessThanOrEqual(60 * SECOND);
    expect(PLAYER_POLICY.refetchOnWindowFocus).toBe(true);
    expect(PLAYER_POLICY.refetchOnReconnect).toBe(true);
  });

  it('holds identity longer than player state and never refetches it on focus', () => {
    // Who the Portal is acting as changes only when someone changes it. A focus
    // refetch here was one request per tab switch for a value that had not
    // moved, on top of the profile call that refreshes the same row anyway.
    expect(IDENTITY_POLICY.staleTime).toBeGreaterThan(PLAYER_POLICY.staleTime);
    expect(IDENTITY_POLICY.refetchOnWindowFocus).toBe(false);
  });

  it('gives every policy an explicit reconnect rule', () => {
    // It used to be forced on at the client level, which meant no policy could
    // opt out. Making it part of the policy is only useful if each one states it.
    for (const [name, policy] of ALL) {
      expect(typeof policy.refetchOnReconnect, name).toBe('boolean');
      expect(typeof policy.refetchOnWindowFocus, name).toBe('boolean');
    }
  });

  it('never garbage-collects sooner than data goes stale', () => {
    for (const [name, policy] of ALL) {
      if (policy.staleTime === Number.POSITIVE_INFINITY) continue;
      expect(policy.gcTime, name).toBeGreaterThan(policy.staleTime);
    }
  });
});
