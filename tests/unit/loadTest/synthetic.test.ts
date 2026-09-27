/**
 * No external side effects from synthetic identities.
 *
 * Every lookup that would reach Discord for an id it has not cached —
 * display identity, guild ownership, member roles, guild roles — must answer
 * "unknown" for a load-test id without calling its fetcher at all. A call
 * would be a guaranteed-404 REST request against a rate-limited external API,
 * once per virtual player.
 */
import { describe, expect, it, vi } from 'vitest';
import { withIdentityCache } from '../../../src/api/identity';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import {
  isSyntheticDiscordId,
  SYNTHETIC_GUILD_DISCORD_ID,
  syntheticDiscordUserId,
} from '../../../src/modules/loadTest/synthetic';

describe('synthetic ids', () => {
  it('are valid snowflake strings that no real Discord entity can have', () => {
    expect(syntheticDiscordUserId(0)).toBe('7357001');
    expect(syntheticDiscordUserId(99)).toBe('7357100');
    expect(SYNTHETIC_GUILD_DISCORD_ID).toBe('7357000');
    // Digits only, so the API's snowflake schemas accept them…
    expect(/^\d+$/.test(syntheticDiscordUserId(0))).toBe(true);
    // …and far below any real snowflake, whose top bits are ms since 2015.
    const DISCORD_EPOCH = 1420070400000n;
    const createdMs = (BigInt(syntheticDiscordUserId(998)) >> 22n) + DISCORD_EPOCH;
    expect(createdMs - DISCORD_EPOCH).toBeLessThan(5n);
    expect(isSyntheticDiscordId(syntheticDiscordUserId(49))).toBe(true);
    expect(isSyntheticDiscordId(SYNTHETIC_GUILD_DISCORD_ID)).toBe(true);
    expect(isSyntheticDiscordId('123456789012345678')).toBe(false);
    expect(isSyntheticDiscordId('73570011')).toBe(false);
    expect(isSyntheticDiscordId(null)).toBe(false);
    expect(() => syntheticDiscordUserId(999)).toThrow(RangeError);
  });
});

describe('Discord lookups short-circuit for synthetic ids', () => {
  it('identity resolution', async () => {
    const resolve = vi.fn(async () => ({ displayName: 'x', avatarUrl: null }));
    const cached = withIdentityCache(resolve);
    expect(await cached(syntheticDiscordUserId(3))).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    // A real id still resolves.
    expect(await cached('123')).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('guild ownership', async () => {
    const fetchOwnerId = vi.fn(async () => '1');
    const svc = createGuildOwnershipService({ fetchOwnerId });
    expect(await svc.getOwnerId(SYNTHETIC_GUILD_DISCORD_ID)).toBeNull();
    expect(fetchOwnerId).not.toHaveBeenCalled();
  });

  it('member and guild roles', async () => {
    const fetchMemberRoleIds = vi.fn(async () => ['r']);
    const fetchGuildRoles = vi.fn(async () => []);
    const svc = createGuildRoleService({ fetchMemberRoleIds, fetchGuildRoles });
    expect(await svc.getMemberRoleIds(SYNTHETIC_GUILD_DISCORD_ID, syntheticDiscordUserId(0))).toBeNull();
    expect(await svc.getMemberRoleIds('999', syntheticDiscordUserId(0))).toBeNull();
    expect(await svc.listGuildRoles(SYNTHETIC_GUILD_DISCORD_ID)).toBeNull();
    expect(fetchMemberRoleIds).not.toHaveBeenCalled();
    expect(fetchGuildRoles).not.toHaveBeenCalled();
  });
});
