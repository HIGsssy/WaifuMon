import { describe, expect, it } from 'vitest';
import {
  blockedMessage,
  decidePlayChannel,
  type GuardChannelInfo,
} from '../../src/discord/playChannelGuard';

function channel(overrides: Partial<GuardChannelInfo> = {}): GuardChannelInfo {
  return {
    isGuildChannel: true,
    isNsfw: true,
    channelId: 'chan-1',
    parentChannelId: null,
    ...overrides,
  };
}

describe('decidePlayChannel — NSFW × allowlist × thread × DM matrix', () => {
  it('blocks DMs / non-guild contexts', () => {
    expect(
      decidePlayChannel(channel({ isGuildChannel: false, channelId: null }), null),
    ).toEqual({ allow: false, reason: 'dm' });
  });

  it('blocks DMs even when an allowlist exists', () => {
    expect(
      decidePlayChannel(channel({ isGuildChannel: false, channelId: null }), ['chan-1']),
    ).toEqual({ allow: false, reason: 'dm' });
  });

  it('blocks non-NSFW guild channels', () => {
    expect(decidePlayChannel(channel({ isNsfw: false }), null)).toEqual({
      allow: false,
      reason: 'not_nsfw',
    });
  });

  it('blocks non-NSFW channels even when allowlisted', () => {
    expect(decidePlayChannel(channel({ isNsfw: false }), ['chan-1'])).toEqual({
      allow: false,
      reason: 'not_nsfw',
    });
  });

  it('allows NSFW channels when no allowlist is configured (null)', () => {
    expect(decidePlayChannel(channel(), null)).toEqual({ allow: true });
  });

  it('allows NSFW channels when the allowlist is empty (= any NSFW channel)', () => {
    expect(decidePlayChannel(channel(), [])).toEqual({ allow: true });
  });

  it('allows an NSFW channel on the allowlist', () => {
    expect(decidePlayChannel(channel(), ['other', 'chan-1'])).toEqual({ allow: true });
  });

  it('blocks an NSFW channel off the allowlist', () => {
    expect(decidePlayChannel(channel(), ['other'])).toEqual({
      allow: false,
      reason: 'not_allowed',
    });
  });

  it('threads inherit the parent NSFW flag (NSFW parent → allowed)', () => {
    expect(
      decidePlayChannel(channel({ channelId: 'thread-1', parentChannelId: 'chan-1' }), null),
    ).toEqual({ allow: true });
  });

  it('threads with non-NSFW parents are blocked', () => {
    expect(
      decidePlayChannel(
        channel({ isNsfw: false, channelId: 'thread-1', parentChannelId: 'chan-1' }),
        null,
      ),
    ).toEqual({ allow: false, reason: 'not_nsfw' });
  });

  it('threads count as allowed when their parent is on the allowlist', () => {
    expect(
      decidePlayChannel(
        channel({ channelId: 'thread-1', parentChannelId: 'chan-1' }),
        ['chan-1'],
      ),
    ).toEqual({ allow: true });
  });

  it('threads whose parent is off the allowlist are blocked', () => {
    expect(
      decidePlayChannel(
        channel({ channelId: 'thread-1', parentChannelId: 'chan-2' }),
        ['chan-1'],
      ),
    ).toEqual({ allow: false, reason: 'not_allowed' });
  });
});

describe('boss-channel exemption', () => {
  it('lets the configured boss channel through an allowlist it is not on', () => {
    // A boss encounter runs in a dedicated channel configured by its own admin
    // command. Requiring an admin to *also* list it as a play channel would
    // make working buttons look broken.
    expect(
      decidePlayChannel(channel({ channelId: 'boss-1' }), ['chan-1'], ['boss-1']),
    ).toEqual({ allow: true });
  });

  it('still requires the boss channel to be NSFW-marked', () => {
    // The compliance rule is the game's, not this feature's — the exemption
    // covers the allowlist and nothing else.
    expect(
      decidePlayChannel(
        channel({ channelId: 'boss-1', isNsfw: false }),
        ['chan-1'],
        ['boss-1'],
      ),
    ).toEqual({ allow: false, reason: 'not_nsfw' });
  });

  it('exempts a thread whose parent is the boss channel', () => {
    expect(
      decidePlayChannel(
        channel({ channelId: 'thread-9', parentChannelId: 'boss-1' }),
        ['chan-1'],
        ['boss-1'],
      ),
    ).toEqual({ allow: true });
  });

  it('exempts nothing when no boss channel is configured', () => {
    expect(
      decidePlayChannel(channel({ channelId: 'boss-1' }), ['chan-1'], [null]),
    ).toEqual({ allow: false, reason: 'not_allowed' });
    expect(
      decidePlayChannel(channel({ channelId: 'boss-1' }), ['chan-1'], [undefined]),
    ).toEqual({ allow: false, reason: 'not_allowed' });
  });

  it('changes nothing for a guild with no allowlist at all', () => {
    expect(decidePlayChannel(channel({ channelId: 'any' }), null, ['boss-1'])).toEqual({
      allow: true,
    });
  });
});

describe('blockedMessage', () => {
  it('names the first allowed channel when a list is configured', () => {
    expect(blockedMessage('not_allowed', ['123'])).toContain('<#123>');
  });

  it('has a friendly generic message without an allowlist', () => {
    expect(blockedMessage('not_nsfw', null)).toMatch(/NSFW/);
  });

  it('has a DM-specific message', () => {
    expect(blockedMessage('dm', null)).toMatch(/DM/i);
  });
});
