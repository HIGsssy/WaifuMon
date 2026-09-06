/**
 * GuildRoleService — the cache in front of Discord's role state.
 *
 * The property that matters is not speed, it is *bounded staleness*: a role
 * removed from a member must stop granting admin access promptly, so the
 * member-role TTL is short and the bot invalidates on gateway events. These
 * tests pin both, plus the fail-closed behaviour every caller relies on.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';

const GUILD = 'guild-A';
const USER = 'user-1';

function make(opts: {
  memberRoles?: readonly string[] | null;
  throws?: boolean;
  memberTtlMs?: number;
} = {}) {
  const fetchMemberRoleIds = vi.fn(async () => {
    if (opts.throws) throw new Error('gateway down');
    return opts.memberRoles === undefined ? ['r1'] : opts.memberRoles;
  });
  const fetchGuildRoles = vi.fn(async () => [
    { id: 'r1', name: 'Editors', color: 0, position: 2, managed: false },
  ]);
  const service = createGuildRoleService({
    fetchMemberRoleIds,
    fetchGuildRoles,
    memberTtlMs: opts.memberTtlMs ?? 60_000,
  });
  return { service, fetchMemberRoleIds, fetchGuildRoles };
}

describe('member roles', () => {
  it('reads through once and serves the rest from cache', async () => {
    const { service, fetchMemberRoleIds } = make();

    expect(await service.getMemberRoleIds(GUILD, USER)).toEqual(['r1']);
    expect(await service.getMemberRoleIds(GUILD, USER)).toEqual(['r1']);
    expect(fetchMemberRoleIds).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL lapses, so a removed role cannot linger', async () => {
    const { service, fetchMemberRoleIds } = make({ memberTtlMs: 1 });
    await service.getMemberRoleIds(GUILD, USER);
    await new Promise((r) => setTimeout(r, 5));
    await service.getMemberRoleIds(GUILD, USER);

    expect(fetchMemberRoleIds).toHaveBeenCalledTimes(2);
  });

  it('invalidating a member forces the next read back to Discord', async () => {
    // This is the path `guildMemberUpdate` takes: a role change is felt
    // immediately rather than at the end of the TTL.
    const { service, fetchMemberRoleIds } = make();
    await service.getMemberRoleIds(GUILD, USER);
    service.invalidateMember(GUILD, USER);
    await service.getMemberRoleIds(GUILD, USER);

    expect(fetchMemberRoleIds).toHaveBeenCalledTimes(2);
  });

  it('caches per (guild, user), never across them', async () => {
    const { service, fetchMemberRoleIds } = make();
    await service.getMemberRoleIds(GUILD, USER);
    await service.getMemberRoleIds('guild-B', USER);
    await service.getMemberRoleIds(GUILD, 'user-2');

    expect(fetchMemberRoleIds).toHaveBeenCalledTimes(3);
  });

  it('answers null when the fetcher throws, and does not hammer it', async () => {
    const { service, fetchMemberRoleIds } = make({ throws: true });

    expect(await service.getMemberRoleIds(GUILD, USER)).toBeNull();
    expect(await service.getMemberRoleIds(GUILD, USER)).toBeNull();
    // The failure is cached briefly, so a broken gateway is not retried per
    // request — but it is a *negative* cache, so nothing is granted meanwhile.
    expect(fetchMemberRoleIds).toHaveBeenCalledTimes(1);
  });

  it('distinguishes "no roles" from "unknown"', async () => {
    const empty = make({ memberRoles: [] });
    const unknown = make({ memberRoles: null });

    expect(await empty.service.getMemberRoleIds(GUILD, USER)).toEqual([]);
    expect(await unknown.service.getMemberRoleIds(GUILD, USER)).toBeNull();
  });

  it('hands back a frozen array a caller cannot mutate into more access', async () => {
    const { service } = make();
    const roles = (await service.getMemberRoleIds(GUILD, USER))!;

    expect(() => (roles as string[]).push('smuggled')).toThrow();
    expect(await service.getMemberRoleIds(GUILD, USER)).toEqual(['r1']);
  });
});

describe('guild role list', () => {
  it('caches, and invalidates on demand', async () => {
    const { service, fetchGuildRoles } = make();
    await service.listGuildRoles(GUILD);
    await service.listGuildRoles(GUILD);
    expect(fetchGuildRoles).toHaveBeenCalledTimes(1);

    service.invalidateGuildRoles(GUILD);
    await service.listGuildRoles(GUILD);
    expect(fetchGuildRoles).toHaveBeenCalledTimes(2);
  });

  it('answers null rather than an empty list when Discord cannot be reached', async () => {
    // The distinction the Portal renders: "no roles" would be a lie that hides
    // an outage behind an empty picker.
    const service = createGuildRoleService({
      fetchMemberRoleIds: async () => null,
      fetchGuildRoles: async () => {
        throw new Error('gateway down');
      },
    });

    expect(await service.listGuildRoles(GUILD)).toBeNull();
  });
});
