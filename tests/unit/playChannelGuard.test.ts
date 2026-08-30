import { describe, expect, it } from 'vitest';
import {
  blockedMessage,
  decidePlayChannel,
  type GuardChannelInfo,
} from '../../src/discord/playChannelGuard';

function channel(overrides: Partial<GuardChannelInfo> = {}): GuardChannelInfo {
  return {
    isGuildChannel: true,
    channelId: 'chan-1',
    parentChannelId: null,
    ...overrides,
  };
}

describe('decidePlayChannel — allowlist × thread × DM matrix (NSFW gate removed)', () => {
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

  it('allows a guild channel regardless of NSFW metadata when no allowlist is configured (null)', () => {
    expect(decidePlayChannel(channel(), null)).toEqual({ allow: true });
  });

  it('allows any guild channel when the allowlist is empty (= any channel)', () => {
    expect(decidePlayChannel(channel(), [])).toEqual({ allow: true });
  });

  it('allows a channel on the allowlist', () => {
    expect(decidePlayChannel(channel(), ['other', 'chan-1'])).toEqual({ allow: true });
  });

  it('blocks a channel off the allowlist', () => {
    expect(decidePlayChannel(channel(), ['other'])).toEqual({
      allow: false,
      reason: 'not_allowed',
    });
  });

  it('allows a thread regardless of parent NSFW metadata (no allowlist)', () => {
    expect(
      decidePlayChannel(channel({ channelId: 'thread-1', parentChannelId: 'chan-1' }), null),
    ).toEqual({ allow: true });
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

  it('has a friendly generic message for an off-allowlist channel', () => {
    expect(blockedMessage('not_allowed', null)).toMatch(/doesn't play in this channel/);
  });

  it('has a DM-specific message', () => {
    expect(blockedMessage('dm', null)).toMatch(/DM/i);
  });

  it('never mentions an NSFW requirement anymore', () => {
    expect(blockedMessage('dm', null)).not.toMatch(/NSFW/i);
    expect(blockedMessage('not_allowed', ['123'])).not.toMatch(/NSFW/i);
  });
});
