/**
 * Cache-behaviour lock (plan §22.5, §26 "Cache TTLs drift").
 *
 * These assertions restate plan §13's table. They exist so a distracted edit to
 * `cachePolicy.ts` fails a test rather than quietly making the Portal stale (or
 * chatty) in a way nobody notices until a player complains their currencies are
 * wrong.
 */
import { describe, expect, it } from 'vitest';

import { CONTENT_POLICY, PLAYER_POLICY, SHOP_POLICY } from '../cachePolicy';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe('cache policy (plan §13)', () => {
  it('treats content as effectively static and never refetches it on focus', () => {
    expect(CONTENT_POLICY.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(CONTENT_POLICY.refetchOnWindowFocus).toBe(false);
    expect(CONTENT_POLICY.gcTime).toBeGreaterThanOrEqual(60 * MINUTE);
  });

  it('keeps the shop long-lived but refreshing on focus', () => {
    expect(SHOP_POLICY.staleTime).toBe(5 * MINUTE);
    expect(SHOP_POLICY.refetchOnWindowFocus).toBe(true);
  });

  it('keeps player-scoped data short-lived and refreshing on focus', () => {
    expect(PLAYER_POLICY.staleTime).toBe(30 * SECOND);
    expect(PLAYER_POLICY.refetchOnWindowFocus).toBe(true);
  });
});
