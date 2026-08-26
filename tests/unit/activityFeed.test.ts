/**
 * Activity Feed — canonical narration and the two suppression rules.
 *
 * The wording table here is the contract: it is what players read in the
 * Waifumon Log, so it is pinned exactly rather than pattern-matched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createActivityFeedService,
  formatActivityLine,
} from '../../src/modules/activity/activityFeedService';
import {
  buildGameEvent,
  gameEvent,
  type EventVisibility,
  type GameEventDescriptor,
  type GameEventSource,
} from '../../src/modules/events/gameEvents';
import { silentLogger } from '../helpers/testDb';

interface ActivityLineCapture {
  channelId: string;
  text: string;
  visibility: EventVisibility;
}

const SOURCE: GameEventSource = {
  guildId: 'g-1',
  guildDbId: 1,
  playerId: 7,
  playerName: 'Whistler',
  playerMention: '<@u-1>',
  channelId: 'c-play',
};

function line(descriptor: GameEventDescriptor): string | null {
  return formatActivityLine(buildGameEvent(descriptor, SOURCE))?.text ?? null;
}

describe('formatActivityLine — canonical wording', () => {
  it.each([
    [
      gameEvent('PLAYER_STARTED_HUNT', { location: 'the Whispering Forest' }),
      '🌿 Whistler ventured into the Whispering Forest.',
    ],
    [
      gameEvent('PLAYER_COMPLETED_HUNT', {
        location: 'the Whispering Forest',
        reason: 'care_mode' as const,
      }),
      '🏕️ Whistler returned from the Whispering Forest.',
    ],
    [
      gameEvent('PLAYER_ENCOUNTER', { encounterId: 1, speciesName: 'Luna', rarity: 'SR' as const }),
      '👀 Whistler spotted a SR Luna…',
    ],
    [
      gameEvent('PLAYER_CAPTURE_SUCCESS', {
        speciesName: 'Luna',
        rarity: 'N' as const,
        isDuplicate: false,
        waifuId: 3,
      }),
      '💫 Whistler added Luna to their collection.',
    ],
    [
      gameEvent('PLAYER_CAPTURE_FAILED', { speciesName: 'Luna', rarity: 'N' as const, attempts: 3 }),
      '🌫️ Luna slipped away from Whistler.',
    ],
    [
      gameEvent('PLAYER_FOUND_ITEM', {
        itemSlug: 'basic_charm',
        itemName: 'Basic Charm',
        quantity: 2,
        rare: false,
      }),
      '🎁 Whistler pocketed 2 × Basic Charm.',
    ],
    [
      gameEvent('PLAYER_FOUND_WAIFUBUX', { amount: 40, balanceAfter: 140 }),
      '💰 Whistler came across 40 WaifuBux.',
    ],
    [
      gameEvent('PLAYER_FOUND_ESSENCE', { amount: 6, balanceAfter: 6 }),
      '✨ Whistler gathered 6 Essence.',
    ],
    [gameEvent('PLAYER_LEVEL_UP', { level: 12, rewardLabels: [] }), '⚡ Whistler reached level 12.'],
    [
      gameEvent('BUDDY_LEVEL_UP', { waifuId: 3, buddyName: 'Luna', level: 5 }),
      '💖 Luna grew stronger — now level 5.',
    ],
    [
      gameEvent('AFFECTION_MILESTONE', {
        waifuId: 3,
        buddyName: 'Luna',
        affection: 25,
        stage: 'Warm',
      }),
      '🌸 Whistler and Luna grew closer (Warm).',
    ],
    [
      gameEvent('PLAYER_ENTERED_CARE', { waifuId: 3, buddyName: 'Luna' }),
      '❤️ Whistler is spending time with Luna.',
    ],
    [
      gameEvent('PLAYER_LEFT_CARE', { waifuId: 3, buddyName: 'Luna', reason: 'manual' as const }),
      '🌸 Whistler finished spending time with Luna.',
    ],
    [
      gameEvent('AWAKENING', { waifuId: 3, buddyName: 'Luna' }),
      '🌌 Luna awakened for Whistler.',
    ],
    [
      gameEvent('COLLECTION_COMPLETED', { distinctSpecies: 40, totalSpecies: 40 }),
      '🌟 Whistler completed the collection.',
    ],
  ])('narrates %#', (descriptor, expected) => {
    expect(line(descriptor)).toBe(expected);
  });

  it('falls back to plain wording when no location pool is configured', () => {
    expect(line(gameEvent('PLAYER_STARTED_HUNT', { location: null }))).toBe(
      '🌿 Whistler started hunting.',
    );
    expect(
      line(gameEvent('PLAYER_COMPLETED_HUNT', { location: null, reason: 'explicit' })),
    ).toBe('🏕️ Whistler finished hunting.');
  });

  it('produces no line for internal-scope kinds', () => {
    expect(
      line(
        gameEvent('CARE_TICK_APPLIED', {
          waifuId: 3,
          buddyName: 'Luna',
          ticksProcessed: 2,
          energyGained: 2,
          waifuXpGained: 4,
          affectionGained: 2,
        }),
      ),
    ).toBeNull();
    expect(line(gameEvent('ENERGY_REGENERATED', { amount: 1, energyAfter: 10 }))).toBeNull();
    expect(line(gameEvent('CARE_BUDDY_CHANGED', { waifuId: 4, buddyName: 'Mika' }))).toBeNull();
  });

  it('carries the event visibility through to the caller', () => {
    const event = buildGameEvent(
      gameEvent('PLAYER_FOUND_ESSENCE', { amount: 1, balanceAfter: 1 }),
      SOURCE,
    );
    expect(formatActivityLine(event)?.visibility).toBe('minor');
  });
});

describe('createActivityFeedService', () => {
  function harness(opts: { channelId?: string | null } = {}) {
    const posts: ActivityLineCapture[] = [];
    const post = vi.fn(async (channelId: string, request: { text: string; visibility: EventVisibility }) => {
      posts.push({ channelId, text: request.text, visibility: request.visibility });
    });
    const feed = createActivityFeedService({
      logger: silentLogger(),
      richEmbedMinRarity: 'SR',
      resolveChannel: async () => (opts.channelId === undefined ? 'c-log' : opts.channelId),
      post,
    });
    return { feed, post, posts };
  }

  async function send(
    feed: ReturnType<typeof harness>['feed'],
    descriptor: GameEventDescriptor,
  ): Promise<void> {
    await feed.handle(buildGameEvent(descriptor, SOURCE));
  }

  it('posts player-visible lines to the resolved log channel with their visibility', async () => {
    const { feed, posts } = harness();
    await send(feed, gameEvent('PLAYER_LEVEL_UP', { level: 5, rewardLabels: [] }));
    expect(posts).toEqual([
      { channelId: 'c-log', text: '⚡ Whistler reached level 5.', visibility: 'major' },
    ]);
  });

  it('narrates below-SR capture successes but suppresses SR+ (rich embed owns those)', async () => {
    const { feed, posts } = harness();
    for (const rarity of ['N', 'R'] as const) {
      await send(
        feed,
        gameEvent('PLAYER_CAPTURE_SUCCESS', {
          speciesName: 'Luna',
          rarity,
          isDuplicate: false,
          waifuId: 1,
        }),
      );
    }
    for (const rarity of ['SR', 'SSR', 'UR', 'LR', 'EX'] as const) {
      await send(
        feed,
        gameEvent(
          'PLAYER_CAPTURE_SUCCESS',
          { speciesName: 'Nyx', rarity, isDuplicate: false, waifuId: 2 },
          'major',
        ),
      );
    }
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.text.includes('Luna'))).toBe(true);
  });

  it('never narrates internal-scope events', async () => {
    const { feed, post } = harness();
    await send(
      feed,
      gameEvent('CARE_TICK_APPLIED', {
        waifuId: 1,
        buddyName: 'Luna',
        ticksProcessed: 1,
        energyGained: 1,
        waifuXpGained: 2,
        affectionGained: 1,
      }),
    );
    await send(feed, gameEvent('ENERGY_REGENERATED', { amount: 1, energyAfter: 4 }));
    expect(post).not.toHaveBeenCalled();
  });

  it('stays silent when the guild has no Waifumon Log configured', async () => {
    const { feed, post } = harness({ channelId: null });
    await send(feed, gameEvent('PLAYER_LEVEL_UP', { level: 5, rewardLabels: [] }));
    expect(post).not.toHaveBeenCalled();
  });

  it('swallows a failing post so gameplay is never affected', async () => {
    const feed = createActivityFeedService({
      logger: silentLogger(),
      richEmbedMinRarity: 'SR',
      resolveChannel: async () => 'c-log',
      post: async () => {
        throw new Error('missing permissions');
      },
    });
    await expect(
      feed.handle(buildGameEvent(gameEvent('PLAYER_LEVEL_UP', { level: 2, rewardLabels: [] }), SOURCE)),
    ).resolves.toBeUndefined();
  });
});
