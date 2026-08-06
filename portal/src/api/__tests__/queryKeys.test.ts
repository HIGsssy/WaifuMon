/**
 * Query-key invariants (plan §13).
 *
 * The prefix rule is what makes a future runtime player switcher (§25.2) a
 * one-line `invalidateQueries({ queryKey: ['player', id] })` instead of a cache
 * wipe, so it is worth a test even though the keys look obvious.
 */
import { describe, expect, it } from 'vitest';

import { queryKeys } from '../queryKeys';

describe('query keys', () => {
  it('prefixes every player-scoped key with ["player", playerId]', () => {
    const playerScoped = [
      queryKeys.playerRecord(7),
      queryKeys.playerProfile(7),
      queryKeys.care(7),
      queryKeys.inventory(7),
      queryKeys.collectionList(7, 1, 'SR'),
      queryKeys.collectionEntry(7, 12),
      queryKeys.collectionStats(7),
      queryKeys.buddy(7),
      queryKeys.ownedSlugs(7),
    ];

    for (const key of playerScoped) {
      expect(key.slice(0, 2)).toEqual(['player', 7]);
    }
  });

  it('never puts a player id in a content or shop key', () => {
    const global = [
      queryKeys.contentSpecies(),
      queryKeys.contentItems(),
      queryKeys.contentTables(),
      queryKeys.contentQuests(),
      queryKeys.shopCatalog(),
    ];

    for (const key of global) {
      expect(key[0]).not.toBe('player');
    }
  });

  it('distinguishes collection pages and rarity filters', () => {
    expect(queryKeys.collectionList(1, 1, 'SR')).not.toEqual(queryKeys.collectionList(1, 2, 'SR'));
    expect(queryKeys.collectionList(1, 1, 'SR')).not.toEqual(
      queryKeys.collectionList(1, 1, undefined),
    );
  });
});
