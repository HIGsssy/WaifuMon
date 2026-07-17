/**
 * Unit tests for the owner-identity helper. Real Discord interactions carry a
 * `GuildMember` instance; the duck-type fallback lets tests (and unusual
 * multi-realm situations) hand in a plain object.
 */
import { describe, expect, it } from 'vitest';
import { getGuildDisplayName, ownerFromInteraction } from '../../src/discord/userDisplay';

describe('getGuildDisplayName', () => {
  it('prefers the server display name from a member', () => {
    const name = getGuildDisplayName({
      member: { displayName: 'IanServerNick' },
      user: { id: 'u-1', username: 'ian', globalName: 'Ian Global' },
    });
    expect(name).toBe('IanServerNick');
  });

  it('falls back to globalName when member displayName is absent', () => {
    const name = getGuildDisplayName({
      user: { id: 'u-1', username: 'ian', globalName: 'Ian Global' },
    });
    expect(name).toBe('Ian Global');
  });

  it('falls back to username when neither member nor globalName is present', () => {
    const name = getGuildDisplayName({
      user: { id: 'u-1', username: 'ian', globalName: null },
    });
    expect(name).toBe('ian');
  });

  it('has a safe last-resort label when everything is missing', () => {
    const name = getGuildDisplayName({
      user: { id: 'u-1' },
    });
    expect(name).toBe('that player');
  });

  it('ignores an empty-string member displayName and falls through', () => {
    const name = getGuildDisplayName({
      member: { displayName: '' },
      user: { id: 'u-1', username: 'ian', globalName: null },
    });
    expect(name).toBe('ian');
  });
});

describe('ownerFromInteraction', () => {
  it('bundles mention + displayName + discordUserId', () => {
    const owner = ownerFromInteraction({
      user: { id: 'u-42', username: 'ian', globalName: 'Ian Global' },
      member: { displayName: 'IanServerNick' },
    });
    expect(owner).toEqual({
      discordUserId: 'u-42',
      displayName: 'IanServerNick',
      mention: '<@u-42>',
    });
  });
});
