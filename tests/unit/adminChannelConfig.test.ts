/**
 * Channel-config admin handlers after the NSFW policy removal.
 *
 * Waifumon no longer inspects `channel.nsfw` when configuring the announcement
 * (activity-log) channel or the boss encounter channel. These tests pin that a
 * plain guild text channel is accepted regardless of its NSFW flag, while the
 * legitimate validation — channel *type* and the bot's posting *permissions* —
 * still runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { handleAdminSetAnnounceChannel } from '../../src/discord/commands/waifumonAdmin';
import { handleBossSetChannel } from '../../src/discord/commands/waifumonBossAdmin';
import type { AppContext } from '../../src/discord/types';

function replyContent(reply: ReturnType<typeof vi.fn>): string {
  return String((reply.mock.calls[0]?.[0] as { content: string }).content);
}

// ─────────────────────────── announce channel ───────────────────────────

function announceCtx() {
  const setAnnounceChannel = vi.fn(async () => {});
  const ctx = {
    services: { guilds: { setAnnounceChannel } },
  } as unknown as AppContext;
  return { ctx, setAnnounceChannel };
}

function announceInteraction(resolved: { id: string; type: number; nsfw?: boolean } | null) {
  const reply = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interaction = {
    options: { getChannel: () => ({ id: 'c-1' }) },
    guild: { channels: { fetch: vi.fn(async () => resolved) } },
    guildId: 'g-1',
    reply,
  } as any;
  return { interaction, reply };
}

describe('handleAdminSetAnnounceChannel — NSFW no longer required', () => {
  it('accepts a normal guild text channel (nsfw flag unset)', async () => {
    const { ctx, setAnnounceChannel } = announceCtx();
    const { interaction, reply } = announceInteraction({ id: 'c-1', type: ChannelType.GuildText });
    await handleAdminSetAnnounceChannel(ctx, interaction);
    expect(setAnnounceChannel).toHaveBeenCalledWith('g-1', 'c-1');
    expect(replyContent(reply)).toContain('Rare-capture announcements will go to');
    expect(replyContent(reply)).not.toMatch(/NSFW/i);
  });

  it('accepts a guild text channel regardless of channel.nsfw (false)', async () => {
    const { ctx, setAnnounceChannel } = announceCtx();
    const { interaction } = announceInteraction({
      id: 'c-1',
      type: ChannelType.GuildText,
      nsfw: false,
    });
    await handleAdminSetAnnounceChannel(ctx, interaction);
    expect(setAnnounceChannel).toHaveBeenCalledWith('g-1', 'c-1');
  });

  it('accepts a guild text channel regardless of channel.nsfw (true)', async () => {
    const { ctx, setAnnounceChannel } = announceCtx();
    const { interaction } = announceInteraction({
      id: 'c-1',
      type: ChannelType.GuildText,
      nsfw: true,
    });
    await handleAdminSetAnnounceChannel(ctx, interaction);
    expect(setAnnounceChannel).toHaveBeenCalledWith('g-1', 'c-1');
  });

  it('still rejects a non-text channel type — without mentioning NSFW', async () => {
    const { ctx, setAnnounceChannel } = announceCtx();
    const { interaction, reply } = announceInteraction({ id: 'c-1', type: ChannelType.GuildVoice });
    await handleAdminSetAnnounceChannel(ctx, interaction);
    expect(setAnnounceChannel).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('<#c-1> must be a text channel to receive announcements.');
    expect(replyContent(reply)).not.toMatch(/NSFW/i);
  });
});

// ──────────────────────────── boss channel ────────────────────────────

function bossCtx() {
  const svc = { ensureState: vi.fn(async () => {}), clearSuspension: vi.fn(async () => {}) };
  const setBossChannel = vi.fn(async () => {});
  const ensureGuild = vi.fn(async () => ({ id: 1 }));
  const ctx = {
    services: { bosses: svc, guilds: { setBossChannel, ensureGuild } },
  } as unknown as AppContext;
  return { ctx, svc, setBossChannel };
}

/** A fetched channel shaped for verifyBossChannel. `has` decides permissions. */
function clientChannel(has: (flag: bigint) => boolean, type: number = ChannelType.GuildText) {
  const me = {};
  return {
    id: 'c-1',
    type,
    guild: { members: { me } },
    permissionsFor: (_m: unknown) => ({ has }),
  };
}

function bossInteraction(opts: {
  resolvedType?: number;
  clientChannel: unknown;
  manage?: boolean;
}) {
  const reply = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interaction = {
    memberPermissions: { has: () => opts.manage ?? true },
    options: { getChannel: () => ({ id: 'c-1' }) },
    guild: {
      channels: {
        fetch: vi.fn(async () => ({ id: 'c-1', type: opts.resolvedType ?? ChannelType.GuildText })),
      },
    },
    client: { channels: { fetch: vi.fn(async () => opts.clientChannel) } },
    guildId: 'g-1',
    reply,
  } as any;
  return { interaction, reply };
}

describe('handleBossSetChannel — NSFW no longer required', () => {
  it('accepts a normal guild text channel with all posting permissions', async () => {
    const { ctx, setBossChannel } = bossCtx();
    const { interaction, reply } = bossInteraction({ clientChannel: clientChannel(() => true) });
    await handleBossSetChannel(ctx, interaction);
    expect(setBossChannel).toHaveBeenCalledWith('g-1', 'c-1');
    expect(replyContent(reply)).toContain('Boss encounters will run in');
    expect(replyContent(reply)).not.toMatch(/NSFW/i);
  });

  it('still rejects a non-text channel type — without mentioning NSFW', async () => {
    const { ctx, setBossChannel } = bossCtx();
    const { interaction, reply } = bossInteraction({
      resolvedType: ChannelType.GuildVoice,
      clientChannel: clientChannel(() => true),
    });
    await handleBossSetChannel(ctx, interaction);
    expect(setBossChannel).not.toHaveBeenCalled();
    expect(replyContent(reply)).toBe('<#c-1> must be a text channel.');
    expect(replyContent(reply)).not.toMatch(/NSFW/i);
  });

  it('still enforces posting permissions (missing Attach Files is rejected)', async () => {
    const { ctx, setBossChannel } = bossCtx();
    const { interaction, reply } = bossInteraction({
      clientChannel: clientChannel((flag) => flag !== PermissionFlagsBits.AttachFiles),
    });
    await handleBossSetChannel(ctx, interaction);
    expect(setBossChannel).not.toHaveBeenCalled();
    expect(replyContent(reply)).toContain('Attach Files');
  });
});
