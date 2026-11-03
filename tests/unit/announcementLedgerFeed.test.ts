/**
 * The seam between the Activity Feed and the announcement ledger: the feed
 * hands the poster the event it narrated (so the poster can record the message
 * id Discord returns), and the text it posts is exactly what it was before.
 */
import { describe, expect, it } from 'vitest';
import { createActivityFeedService, type ActivityPostRequest } from '../../src/modules/activity/activityFeedService';
import { ledgerEntryForEvent } from '../../src/modules/announcements/announcementLedger';
import { buildGameEvent, type GameEventSource } from '../../src/modules/events/gameEvents';
import { silentLogger } from '../helpers/testDb';

const SOURCE: GameEventSource = {
  guildId: 'g-1',
  guildDbId: 1,
  playerId: 42,
  playerName: 'Whistler',
  playerMention: '<@42>',
  channelId: 'c-play',
};

describe('activity feed → announcement ledger', () => {
  it('passes the narrated event to the poster without changing the line', async () => {
    const requests: ActivityPostRequest[] = [];
    const feed = createActivityFeedService({
      logger: silentLogger(),
      richEmbedMinRarity: 'SR',
      resolveChannel: async () => 'c-log',
      post: async (_channelId, request) => {
        requests.push(request);
      },
    });
    const event = buildGameEvent({ kind: 'PLAYER_LEVEL_UP', payload: { level: 9, rewardLabels: [] } }, SOURCE);
    await feed.handle(event);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toBe('⚡ Whistler reached level 9.');
    expect(requests[0]!.event).toBe(event);
  });

  it('maps exactly the four v1 feed kinds', () => {
    const entry = (descriptor: Parameters<typeof buildGameEvent>[0]) =>
      ledgerEntryForEvent(buildGameEvent(descriptor, SOURCE))?.kind ?? null;
    expect(entry({ kind: 'PLAYER_LEVEL_UP', payload: { level: 2, rewardLabels: ['x'] } })).toBe('level_up');
    expect(entry({ kind: 'COLLECTION_COMPLETED', payload: { distinctSpecies: 1, totalSpecies: 1 } })).toBe(
      'collection_completed',
    );
    expect(
      entry({
        kind: 'WAIFU_APPEARANCE_UNLOCKED',
        payload: {
          waifuId: 1,
          waifuName: 'Luna',
          speciesSlug: 'luna',
          appearanceId: 'lv20',
          appearanceName: 'Festival',
          assetId: { kind: 'waifumon', slug: 'luna', variant: 'lv20' },
          cosmeticRarity: 'rare',
          unlockLabel: 'Reach Level 20',
          source: 'level',
        },
      } as Parameters<typeof buildGameEvent>[0]),
    ).toBe('appearance_unlock');
    // Below-SR captures, item finds and the rest stay unrecorded in v1.
    expect(
      entry({ kind: 'PLAYER_CAPTURE_SUCCESS', payload: { speciesName: 'L', rarity: 'N', isDuplicate: false, waifuId: 1 } }),
    ).toBeNull();
    expect(entry({ kind: 'PLAYER_FOUND_WAIFUBUX', payload: { amount: 5, balanceAfter: 10 } })).toBeNull();
  });

  it('keeps reward labels and the asset id out of the stored payload', () => {
    const level = ledgerEntryForEvent(
      buildGameEvent({ kind: 'PLAYER_LEVEL_UP', payload: { level: 2, rewardLabels: ['+5 Energy'] } }, SOURCE),
    );
    expect(level?.payload).toEqual({ level: 2 });
  });
});
