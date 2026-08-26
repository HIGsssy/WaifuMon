/**
 * Alternate-appearance unlock announcements in the Waifumon Log.
 *
 * When a player crosses a level milestone (10/20/30/40/50) and genuinely
 * unlocks a new alternate look, the activity feed posts a rich embed with the
 * raw appearance PNG attached — so other players see the artwork itself and
 * have a reason to level their own Waifumon.
 *
 * The tests here drive the activity feed directly with `WAIFU_APPEARANCE_UNLOCKED`
 * events, so they cover the announcement path without spinning up the DB.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createActivityFeedService,
  type ActivityPostRequest,
  type ResolveAppearanceArtworkFn,
} from '../../src/modules/activity/activityFeedService';
import {
  buildGameEvent,
  gameEvent,
  type GameEventSource,
} from '../../src/modules/events/gameEvents';
import { silentLogger } from '../helpers/testDb';

const SOURCE: GameEventSource = {
  guildId: 'g-1',
  guildDbId: 1,
  playerId: 7,
  playerName: 'Whistler',
  playerMention: '<@u-1>',
  channelId: 'c-play',
};

function makeUnlockEvent(overrides: {
  waifuName?: string;
  speciesSlug?: string;
  appearanceId?: string;
  appearanceName?: string;
  unlockLabel?: string;
  source?: 'owned' | 'level' | 'content_add';
}) {
  return buildGameEvent(
    gameEvent('WAIFU_APPEARANCE_UNLOCKED', {
      waifuId: 42,
      waifuName: overrides.waifuName ?? 'Luna',
      speciesSlug: overrides.speciesSlug ?? 'alley_catgirl',
      appearanceId: overrides.appearanceId ?? 'level_20',
      appearanceName: overrides.appearanceName ?? 'Midnight Bloom',
      assetId: {
        kind: 'waifumon',
        slug: overrides.speciesSlug ?? 'alley_catgirl',
        variant: overrides.appearanceId ?? 'level_20',
      },
      cosmeticRarity: 'standard',
      unlockLabel: overrides.unlockLabel ?? 'Reach Level 20',
      source: overrides.source ?? 'level',
    }),
    SOURCE,
  );
}

function harness(opts: {
  resolveAppearanceArtwork?: ResolveAppearanceArtworkFn | undefined;
  channelId?: string | null;
} = {}) {
  const posts: Array<{ channelId: string; request: ActivityPostRequest }> = [];
  const post = vi.fn(async (channelId: string, request: ActivityPostRequest) => {
    posts.push({ channelId, request });
  });
  const feed = createActivityFeedService({
    logger: silentLogger(),
    richEmbedMinRarity: 'SR',
    resolveChannel: async () => (opts.channelId === undefined ? 'c-log' : opts.channelId),
    resolveAppearanceArtwork: opts.resolveAppearanceArtwork,
    post,
  });
  return { feed, post, posts };
}

const DEFAULT_ARTWORK = { absolutePath: '/tmp/a/alley_catgirl-level_20.png', filename: 'alley_catgirl-level_20.png' };

describe('WAIFU_APPEARANCE_UNLOCKED — announcement', () => {
  for (const level of [10, 20, 30, 40, 50] as const) {
    it(`Level ${level} milestone → rich embed with raw appearance artwork`, async () => {
      const artwork = { absolutePath: `/tmp/a/alley_catgirl-level_${level}.png`, filename: `alley_catgirl-level_${level}.png` };
      const resolveAppearanceArtwork = vi.fn(() => artwork);
      const { feed, posts } = harness({ resolveAppearanceArtwork });

      await feed.handle(
        makeUnlockEvent({
          appearanceId: `level_${level}`,
          appearanceName: `Milestone ${level}`,
          unlockLabel: `Reach Level ${level}`,
        }),
      );

      expect(posts).toHaveLength(1);
      const { request } = posts[0]!;
      expect(request.richEmbed?.image).toEqual(artwork);
      expect(request.richEmbed?.title).toContain('New Appearance Unlocked');
      expect(request.richEmbed?.description).toContain('Whistler');
      expect(request.richEmbed?.description).toContain('Luna');
      expect(request.richEmbed?.description).toContain(`Milestone ${level}`);
      expect(request.richEmbed?.description).toContain(`Reach Level ${level}`);
      // The text line is still present as a fallback.
      expect(request.text).toContain('Luna');
      expect(request.text).toContain(`Milestone ${level}`);
      expect(resolveAppearanceArtwork).toHaveBeenCalledTimes(1);
    });
  }

  it('never announces when the unlock source is `owned` (fresh-catch default)', async () => {
    const resolveAppearanceArtwork = vi.fn(() => DEFAULT_ARTWORK);
    const { feed, posts } = harness({ resolveAppearanceArtwork });

    await feed.handle(
      makeUnlockEvent({
        source: 'owned',
        appearanceId: 'standard',
        appearanceName: 'Standard',
        unlockLabel: 'Owned',
      }),
    );

    // The plain text line still fires — backward compatibility — but no
    // rich embed and no artwork attach for a "she came wearing it" unlock.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.request.richEmbed).toBeUndefined();
    expect(resolveAppearanceArtwork).not.toHaveBeenCalled();
  });

  it('falls back to a text-only post when artwork cannot be resolved', async () => {
    const { feed, posts } = harness({ resolveAppearanceArtwork: () => null });
    await feed.handle(makeUnlockEvent({}));

    expect(posts).toHaveLength(1);
    expect(posts[0]!.request.richEmbed).toBeUndefined();
    expect(posts[0]!.request.text).toContain('Luna');
  });

  it('falls back to a text-only post when the artwork resolver throws', async () => {
    const { feed, posts } = harness({
      resolveAppearanceArtwork: () => {
        throw new Error('assets root offline');
      },
    });
    await feed.handle(makeUnlockEvent({}));

    expect(posts).toHaveLength(1);
    expect(posts[0]!.request.richEmbed).toBeUndefined();
  });

  it('is silent when the log channel is unavailable', async () => {
    const { feed, post } = harness({
      channelId: null,
      resolveAppearanceArtwork: () => DEFAULT_ARTWORK,
    });
    await feed.handle(makeUnlockEvent({}));
    expect(post).not.toHaveBeenCalled();
  });

  it('never throws — a post failure never bubbles into gameplay', async () => {
    const post = vi.fn(async () => {
      throw new Error('missing permissions');
    });
    const feed = createActivityFeedService({
      logger: silentLogger(),
      richEmbedMinRarity: 'SR',
      resolveChannel: async () => 'c-log',
      resolveAppearanceArtwork: () => DEFAULT_ARTWORK,
      post,
    });
    await expect(feed.handle(makeUnlockEvent({}))).resolves.toBeUndefined();
  });

  it('emits one announcement per genuinely new milestone when several are crossed at once', async () => {
    const artworks = new Map([
      ['level_10', { absolutePath: '/tmp/a/alley_catgirl-level_10.png', filename: 'alley_catgirl-level_10.png' }],
      ['level_20', { absolutePath: '/tmp/a/alley_catgirl-level_20.png', filename: 'alley_catgirl-level_20.png' }],
    ]);
    const { feed, posts } = harness({
      resolveAppearanceArtwork: (assetId) => artworks.get(assetId.variant) ?? null,
    });

    await feed.handle(
      makeUnlockEvent({ appearanceId: 'level_10', appearanceName: 'Dawn', unlockLabel: 'Reach Level 10' }),
    );
    await feed.handle(
      makeUnlockEvent({ appearanceId: 'level_20', appearanceName: 'Bloom', unlockLabel: 'Reach Level 20' }),
    );

    expect(posts).toHaveLength(2);
    expect(posts[0]!.request.richEmbed?.image.filename).toContain('level_10');
    expect(posts[1]!.request.richEmbed?.image.filename).toContain('level_20');
    // Each embed says which milestone it celebrates.
    expect(posts[0]!.request.richEmbed?.description).toContain('Reach Level 10');
    expect(posts[1]!.request.richEmbed?.description).toContain('Reach Level 20');
  });
});

describe('appearance-change is never announced as an unlock', () => {
  it('does not narrate WAIFU_APPEARANCE_CHANGED', async () => {
    const { feed, post } = harness({ resolveAppearanceArtwork: () => DEFAULT_ARTWORK });
    await feed.handle(
      buildGameEvent(
        gameEvent('WAIFU_APPEARANCE_CHANGED', {
          waifuId: 42,
          waifuName: 'Luna',
          appearanceId: 'level_20',
          appearanceName: 'Midnight Bloom',
          assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_20' },
        }),
        SOURCE,
      ),
    );
    expect(post).not.toHaveBeenCalled();
  });
});
