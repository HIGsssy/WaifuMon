/**
 * Dispatch pipeline with stubbed interactions: PlayChannelGuard runs before
 * provisioning and before any handler; blocked interactions never provision
 * (write no rows) and never reach a handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { commandKey, createDispatcher, type DispatcherDeps } from '../../src/discord/commandRegistry';
import type { GuardChannelInfo } from '../../src/discord/playChannelGuard';
import { buildCustomId } from '../../src/discord/types';
import { silentLogger } from '../helpers/testDb';

interface FakeInteractionOptions {
  kind: 'command' | 'button';
  guildId?: string | null;
  customId?: string;
  sub?: string;
  group?: string | null;
}

function fakeInteraction(opts: FakeInteractionOptions) {
  const replies: unknown[] = [];
  const interaction = {
    guildId: opts.guildId ?? 'g-1',
    user: { id: 'u-1' },
    replied: false,
    deferred: false,
    isChatInputCommand: () => opts.kind === 'command',
    isButton: () => opts.kind === 'button',
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    customId: opts.customId ?? '',
    commandName: 'waifumon',
    options: {
      getSubcommandGroup: () => opts.group ?? null,
      getSubcommand: () => opts.sub ?? 'menu',
    },
    reply: vi.fn(async (payload: unknown) => {
      replies.push(payload);
    }),
    followUp: vi.fn(async (payload: unknown) => {
      replies.push(payload);
    }),
    replies,
  };
  return interaction;
}

function makeDeps(channelInfo: GuardChannelInfo, allowlist: string[] | null = null) {
  const provision = vi.fn(async () => ({ guildDbId: 1, playerId: 1 }));
  const handler = vi.fn(async () => {});
  const componentHandler = vi.fn(async () => {});
  const deps: DispatcherDeps = {
    logger: silentLogger(),
    lookupAllowlist: vi.fn(async () => allowlist),
    provision,
    commandHandlers: { 'waifumon:menu': handler },
    componentHandlers: { 'menu:daily': componentHandler },
    extractChannelInfo: () => channelInfo,
  };
  return { deps, provision, handler, componentHandler };
}

const nsfwChannel: GuardChannelInfo = {
  isGuildChannel: true,
  isNsfw: true,
  channelId: 'chan-1',
  parentChannelId: null,
};
const sfwChannel: GuardChannelInfo = { ...nsfwChannel, isNsfw: false };
const dmChannel: GuardChannelInfo = {
  isGuildChannel: false,
  isNsfw: false,
  channelId: null,
  parentChannelId: null,
};

describe('dispatcher — guard before everything', () => {
  it('allows an NSFW guild channel: provisions then calls the handler', async () => {
    const { deps, provision, handler } = makeDeps(nsfwChannel);
    const dispatch = createDispatcher(deps);
    await dispatch(fakeInteraction({ kind: 'command' }) as never);
    expect(provision).toHaveBeenCalledWith('g-1', 'u-1');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('blocks a non-NSFW channel: no provisioning, no handler, ephemeral message', async () => {
    const { deps, provision, handler } = makeDeps(sfwChannel);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({ kind: 'command' });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(String((interaction.reply.mock.calls[0]![0] as { content: string }).content)).toMatch(
      /NSFW/,
    );
  });

  it('blocks DMs before any lookup side effects', async () => {
    const { deps, provision, handler } = makeDeps(dmChannel);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({ kind: 'command', guildId: null });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('blocks NSFW channels off a configured allowlist', async () => {
    const { deps, provision } = makeDeps(nsfwChannel, ['some-other-channel']);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({ kind: 'command' });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(String((interaction.reply.mock.calls[0]![0] as { content: string }).content)).toContain(
      '<#some-other-channel>',
    );
  });

  it('guards buttons exactly like commands', async () => {
    const { deps, provision, componentHandler } = makeDeps(sfwChannel);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({
      kind: 'button',
      customId: buildCustomId('menu', 'daily'),
    });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(componentHandler).not.toHaveBeenCalled();
  });

  it('routes allowed buttons through provision to the component handler', async () => {
    const { deps, provision, componentHandler } = makeDeps(nsfwChannel);
    const dispatch = createDispatcher(deps);
    await dispatch(
      fakeInteraction({ kind: 'button', customId: buildCustomId('menu', 'daily') }) as never,
    );
    expect(provision).toHaveBeenCalledOnce();
    expect(componentHandler).toHaveBeenCalledOnce();
  });

  it('ignores foreign custom ids entirely', async () => {
    const { deps, provision } = makeDeps(nsfwChannel);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({ kind: 'button', customId: 'other-bot|thing' });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('rejects unknown custom-id versions gracefully', async () => {
    const { deps, provision } = makeDeps(nsfwChannel);
    const dispatch = createDispatcher(deps);
    const interaction = fakeInteraction({ kind: 'button', customId: 'wm|v99|menu|daily' });
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
  });
});

describe('dispatcher — select menus and autocomplete', () => {
  function fakeSelectInteraction(customId: string) {
    return {
      guildId: 'g-1',
      user: { id: 'u-1' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => true,
      isAutocomplete: () => false,
    isModalSubmit: () => false,
      isRepliable: () => true,
      customId,
      values: ['42'],
      commandName: 'waifumon',
      options: { getSubcommandGroup: () => null, getSubcommand: () => 'menu' },
      reply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
    };
  }

  function fakeAutocompleteInteraction() {
    return {
      guildId: 'g-1',
      user: { id: 'u-1' },
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isAutocomplete: () => true,
      isModalSubmit: () => false,
      isRepliable: () => false,
      commandName: 'waifumon',
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => 'inspect',
        getFocused: () => ({ name: 'name', value: 'ne' }),
      },
      respond: vi.fn(async () => {}),
    };
  }

  it('routes string-select menus through provision + component handler', async () => {
    const provision = vi.fn(async () => ({ guildDbId: 1, playerId: 1 }));
    const componentHandler = vi.fn(async () => {});
    const deps: DispatcherDeps = {
      logger: silentLogger(),
      lookupAllowlist: vi.fn(async () => null),
      provision,
      commandHandlers: {},
      componentHandlers: { 'col:pick': componentHandler },
      extractChannelInfo: () => nsfwChannel,
    };
    const dispatch = createDispatcher(deps);
    await dispatch(fakeSelectInteraction(buildCustomId('col', 'pick')) as never);
    expect(provision).toHaveBeenCalledOnce();
    expect(componentHandler).toHaveBeenCalledOnce();
  });

  it('autocomplete bypasses the guard and provision, calls handler with playerId', async () => {
    const provision = vi.fn(async () => ({ guildDbId: 1, playerId: 1 }));
    const lookup = vi.fn(async () => 99);
    const autocompleteHandler = vi.fn<(i: never, playerId: number | null) => Promise<void>>(
      async () => {},
    );
    const deps: DispatcherDeps = {
      logger: silentLogger(),
      lookupAllowlist: vi.fn(async () => null),
      provision,
      lookupPlayerId: lookup,
      commandHandlers: {},
      componentHandlers: {},
      autocompleteHandlers: { 'waifumon:inspect': autocompleteHandler },
      extractChannelInfo: () => nsfwChannel,
    };
    const dispatch = createDispatcher(deps);
    const interaction = fakeAutocompleteInteraction();
    await dispatch(interaction as never);
    expect(provision).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledOnce();
    expect(autocompleteHandler).toHaveBeenCalledOnce();
    expect(autocompleteHandler.mock.calls[0]![1]).toBe(99);
  });

  it('autocomplete without lookup or handler responds with an empty list', async () => {
    const provision = vi.fn(async () => ({ guildDbId: 1, playerId: 1 }));
    const deps: DispatcherDeps = {
      logger: silentLogger(),
      lookupAllowlist: vi.fn(async () => null),
      provision,
      commandHandlers: {},
      componentHandlers: {},
      extractChannelInfo: () => nsfwChannel,
    };
    const dispatch = createDispatcher(deps);
    const interaction = fakeAutocompleteInteraction();
    await dispatch(interaction as never);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(provision).not.toHaveBeenCalled();
  });
});

describe('commandKey', () => {
  it('builds name:sub and name:group:sub keys', () => {
    expect(
      commandKey({
        commandName: 'waifumon',
        options: { getSubcommandGroup: () => null, getSubcommand: () => 'shop' },
      }),
    ).toBe('waifumon:shop');
    expect(
      commandKey({
        commandName: 'waifumon-admin',
        options: { getSubcommandGroup: () => 'allow-channel', getSubcommand: () => 'add' },
      }),
    ).toBe('waifumon-admin:allow-channel:add');
  });
});
