/**
 * Unit tests for {@link GuildOwnershipService} — cache behaviour, TTL,
 * invalidation, and error handling.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';

describe('GuildOwnershipService', () => {
  it('reads through on a cache miss', async () => {
    const fetchOwnerId = vi.fn(async () => 'owner-1');
    const svc = createGuildOwnershipService({ fetchOwnerId });
    expect(await svc.getOwnerId('g-1')).toBe('owner-1');
    expect(fetchOwnerId).toHaveBeenCalledOnce();
  });

  it('serves subsequent lookups from cache', async () => {
    const fetchOwnerId = vi.fn(async () => 'owner-1');
    const svc = createGuildOwnershipService({ fetchOwnerId, ttlMs: 60_000 });
    await svc.getOwnerId('g-1');
    await svc.getOwnerId('g-1');
    await svc.getOwnerId('g-1');
    expect(fetchOwnerId).toHaveBeenCalledOnce();
  });

  it('primes the cache via `set` without ever calling the fetcher', async () => {
    const fetchOwnerId = vi.fn(async () => 'unused');
    const svc = createGuildOwnershipService({ fetchOwnerId });
    svc.set('g-1', 'primed');
    expect(await svc.getOwnerId('g-1')).toBe('primed');
    expect(fetchOwnerId).not.toHaveBeenCalled();
  });

  it('invalidates one entry and re-fetches on next lookup', async () => {
    let call = 0;
    const fetchOwnerId = vi.fn(async () => (call++ === 0 ? 'owner-old' : 'owner-new'));
    const svc = createGuildOwnershipService({ fetchOwnerId });
    expect(await svc.getOwnerId('g-1')).toBe('owner-old');
    svc.invalidate('g-1');
    expect(await svc.getOwnerId('g-1')).toBe('owner-new');
  });

  it('caches a null (unknown guild) briefly rather than hammering the fetcher', async () => {
    const fetchOwnerId = vi.fn(async () => null);
    const svc = createGuildOwnershipService({ fetchOwnerId, ttlMs: 60_000 });
    expect(await svc.getOwnerId('g-x')).toBeNull();
    expect(await svc.getOwnerId('g-x')).toBeNull();
    expect(fetchOwnerId).toHaveBeenCalledOnce();
  });

  it('swallows a fetcher error and returns null', async () => {
    const fetchOwnerId = vi.fn(async () => {
      throw new Error('discord api down');
    });
    const svc = createGuildOwnershipService({ fetchOwnerId });
    expect(await svc.getOwnerId('g-1')).toBeNull();
  });
});
