/**
 * Player identity resolution (`src/api/identity.ts`).
 *
 * The caching wrapper sits in front of a gateway call on the API's hottest
 * read, so its failure behaviour matters more than its happy path: a slow or
 * broken Discord client must degrade to `identity: null` without slowing or
 * failing the request.
 */
import { describe, expect, it, vi } from 'vitest';

import { noIdentity, withIdentityCache, type PlayerIdentity } from '../../../src/api/identity';

const ALICE: PlayerIdentity = {
  displayName: 'Alice',
  avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png',
};

describe('withIdentityCache', () => {
  it('resolves and then serves from cache within the TTL', async () => {
    const raw = vi.fn(async () => ALICE);
    const resolve = withIdentityCache(raw, { ttlMs: 1000 });

    expect(await resolve('1')).toEqual(ALICE);
    expect(await resolve('1')).toEqual(ALICE);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('re-resolves once the TTL expires', async () => {
    let clock = 0;
    const raw = vi.fn(async () => ALICE);
    const resolve = withIdentityCache(raw, { ttlMs: 1000, now: () => clock });

    await resolve('1');
    clock = 1001;
    await resolve('1');

    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('caches a miss briefly so a poll does not hammer the gateway', async () => {
    let clock = 0;
    const raw = vi.fn(async () => null);
    const resolve = withIdentityCache(raw, { negativeTtlMs: 500, now: () => clock });

    expect(await resolve('missing')).toBeNull();
    expect(await resolve('missing')).toBeNull();
    expect(raw).toHaveBeenCalledTimes(1);

    clock = 501;
    expect(await resolve('missing')).toBeNull();
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('answers null instead of rejecting when the resolver throws', async () => {
    const resolve = withIdentityCache(async () => {
      throw new Error('gateway exploded');
    });
    await expect(resolve('1')).resolves.toBeNull();
  });

  it('abandons a resolution that outlives the timeout', async () => {
    const resolve = withIdentityCache(
      () => new Promise<PlayerIdentity>((r) => setTimeout(() => r(ALICE), 5_000)),
      { timeoutMs: 10 },
    );

    const started = Date.now();
    expect(await resolve('1')).toBeNull();
    // The point is that the request answered, not that it answered instantly.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('shares one lookup between concurrent callers', async () => {
    const raw = vi.fn(
      () => new Promise<PlayerIdentity>((r) => setTimeout(() => r(ALICE), 20)),
    );
    const resolve = withIdentityCache(raw, { timeoutMs: 500 });

    const [a, b, c] = await Promise.all([resolve('1'), resolve('1'), resolve('1')]);

    expect([a, b, c]).toEqual([ALICE, ALICE, ALICE]);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry once the cache is full', async () => {
    const raw = vi.fn(async (id: string) => ({ ...ALICE, displayName: id }));
    const resolve = withIdentityCache(raw, { maxEntries: 2 });

    await resolve('a');
    await resolve('b');
    await resolve('c'); // evicts 'a'
    await resolve('a'); // must be a fresh lookup

    expect(raw).toHaveBeenCalledTimes(4);
  });
});

describe('noIdentity', () => {
  it('is the absent-identity resolver used when the host injects none', async () => {
    await expect(noIdentity('1')).resolves.toBeNull();
  });
});
