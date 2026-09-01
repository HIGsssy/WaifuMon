/**
 * Phase 2 read endpoints against the real stack: real Postgres, real
 * migrations, real seeded content, real services. Only HTTP is injected.
 *
 * The unit tests own the contract (auth, envelope, validation, 404 mapping)
 * with doubles. These own the part doubles cannot prove: that each endpoint
 * reports what the service layer actually holds, and that a read never writes.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { encounters, items, species } from '../../../src/db/schema';
import {
  bootstrapApp,
  insertOwnedWaifus,
  provisionPlayer,
  type App,
} from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
// Real snowflake shapes: the guild and user ids travel through path and query
// params that validate as Discord ids.
const GUILD_ID = '111222333444555666';
const USER_ID = '777888999000111222';
const CHANNEL_ID = '9001';

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;
let guildDbId: number;
let buddyWaifuId: number;
let secondWaifuId: number;
let encounterId: number;
let charmItemId: number;
let firstSpeciesSlug: string;

/** GET through the API and return the parsed body, asserting the status. */
async function get(url: string, expectedStatus = 200): Promise<any> {
  const res = await api.inject({ method: 'GET', url, headers: AUTH });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(expectedStatus);
  return res.json();
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId, playerId } = await provisionPlayer(app, GUILD_ID, USER_ID));

  // Two owned copies of two different species, so the dex stats and the
  // rarity filter both have something real to report.
  const speciesRows = await t.db
    .select()
    .from(species)
    .where(eq(species.enabled, true))
    .limit(2);
  const [first, second] = speciesRows;
  firstSpeciesSlug = first!.slug;
  const inserted = await insertOwnedWaifus(t.db, [
    { playerId, speciesId: first!.id, level: 3, xp: 25, affection: 4 },
    { playerId, speciesId: second!.id, level: 1, xp: 0, affection: 0 },
  ]);
  buddyWaifuId = inserted[0]!.id;
  secondWaifuId = inserted[1]!.id;

  await app.collection.setBuddy(playerId, buddyWaifuId);

  const [charm] = await t.db.select().from(items).where(eq(items.slug, 'basic_charm'));
  charmItemId = charm!.id;
  await app.inventory.addItem(t.db, playerId, charmItemId, 3);

  await app.session.ensureSession(guildDbId, playerId, CHANNEL_ID);
  await app.guilds.setAnnounceChannel(GUILD_ID, '4242');
  await app.quests.ensureDailyQuests(playerId);
  await app.care.start(playerId, buddyWaifuId);

  // Inserted rather than hunted: `hunt()` rolls the weighted result table, and
  // this test is about the read endpoint, not the roll.
  const [encounter] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: second!.id,
      channelId: CHANNEL_ID,
      state: 'active',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  encounterId = encounter!.id;

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: {
        guilds: app.guilds,
        travel: app.travel,
        players: app.players,
        currency: app.currency,
        inventory: app.inventory,
        daily: app.daily,
        shop: app.shop,
        hunt: app.hunt,
        capture: app.capture,
        care: app.care,
        collection: app.collection,
        appearance: app.appearance,
        progression: app.progression,
        quests: app.quests,
        session: app.session,
        effects: app.effects,
        itemUse: app.itemUse,
      gifts: app.gifts,
      },
      getContent: () => app.content,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

describe('players', () => {
  it('resolves a Discord identity to the internal id', async () => {
    const body = await get(
      `/api/v1/players/lookup?discordGuildId=${GUILD_ID}&discordUserId=${USER_ID}`,
    );
    expect(body.data).toEqual({ playerId });
  });

  it('404s a Discord identity that has never played, and provisions nothing', async () => {
    const body = await get(
      `/api/v1/players/lookup?discordGuildId=${GUILD_ID}&discordUserId=999000999000999000`,
      404,
    );
    expect(body.error.code).toBe('PLAYER_NOT_FOUND');
    expect(await app.players.findPlayerId(GUILD_ID, '999000999000999000')).toBeNull();
  });

  it('returns the player and their balances', async () => {
    const player = (await get(`/api/v1/players/${playerId}`)).data;
    expect(player).toMatchObject({
      id: playerId,
      guildId: guildDbId,
      discordUserId: USER_ID,
      buddyWaifuId,
    });
    expect(player.careMode.active).toBe(true);
    expect(player.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const profile = (await get(`/api/v1/players/${playerId}/profile`)).data;
    expect(profile.player.id).toBe(playerId);
    expect(profile.currencies).toMatchObject({ playerId });
    expect(typeof profile.currencies.huntEnergy).toBe('number');
  });

  it('agrees with the service layer on balances', async () => {
    const fromService = await app.currency.getBalances(playerId);
    const fromApi = (await get(`/api/v1/players/${playerId}/currency`)).data;
    expect(fromApi).toMatchObject({
      huntEnergy: fromService.huntEnergy,
      waifubux: fromService.waifubux,
      essence: fromService.essence,
    });
  });
});

describe('collection', () => {
  it('reports dex stats matching the service', async () => {
    const expected = await app.collection.getDexStats(playerId);
    expect((await get(`/api/v1/players/${playerId}/collection/stats`)).data).toEqual(expected);
  });

  it('lists owned copies with species and progress embedded', async () => {
    const body = await get(`/api/v1/players/${playerId}/collection/owned`);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.data).toHaveLength(2);

    const entry = body.data[0];
    expect(entry.species.id).toBeGreaterThan(0);
    expect(entry.species.slug).toBeTruthy();
    expect(entry.waifu.releasedAt).toBeNull();
    expect(entry.progress).toMatchObject({ level: entry.waifu.level, xp: entry.waifu.xp });
  });

  it('honors the rarity filter', async () => {
    const all = await get(`/api/v1/players/${playerId}/collection/owned`);
    const rarity = all.data[0].species.rarity;
    const filtered = await get(
      `/api/v1/players/${playerId}/collection/owned?rarity=${rarity}`,
    );
    expect(filtered.data.every((e: any) => e.species.rarity === rarity)).toBe(true);
    expect(filtered.total).toBeLessThanOrEqual(all.total);
  });

  it('returns one owned copy, and 404s another player\'s', async () => {
    const body = await get(`/api/v1/players/${playerId}/collection/owned/${secondWaifuId}`);
    expect(body.data.waifu.id).toBe(secondWaifuId);

    const missing = await get(`/api/v1/players/${playerId}/collection/owned/999999`, 404);
    expect(missing.error.code).toBe('WAIFU_NOT_OWNED');
  });

  it('returns the active buddy', async () => {
    const body = await get(`/api/v1/players/${playerId}/collection/buddy`);
    expect(body.data.waifu.id).toBe(buddyWaifuId);
  });
});

describe('inventory, effects, shop', () => {
  it('lists what the player holds', async () => {
    const body = await get(`/api/v1/players/${playerId}/inventory`);
    const charm = body.data.find((e: any) => e.item.slug === 'basic_charm');
    expect(charm).toMatchObject({ quantity: 3 });
    expect(charm.item.id).toBe(charmItemId);
  });

  it('reports no capture buff as data:null', async () => {
    expect((await get(`/api/v1/players/${playerId}/effects/capture-bonus`)).data).toBeNull();
  });

  it('serves the same catalog the service builds', async () => {
    const expected = await app.shop.getCatalog();
    const body = await get('/api/v1/shop/catalog');
    expect(body.data).toHaveLength(expected.length);
    expect(body.data.map((e: any) => e.item.slug)).toEqual(expected.map((e) => e.item.slug));
    expect(body.data.map((e: any) => e.available)).toEqual(expected.map((e) => e.available));
  });
});

describe('care, encounter, daily, quests, session', () => {
  it('reports Care Mode state without applying pending ticks', async () => {
    const before = await app.care.getState(playerId);
    const body = await get(`/api/v1/players/${playerId}/care`);
    expect(body.data.active).toBe(true);
    expect(body.data.target.waifu.id).toBe(buddyWaifuId);
    expect(body.data.enabled).toBe(true);

    // The read must not have advanced the tick clock.
    const after = await app.care.getState(playerId);
    expect(after.lastTickAt?.toISOString() ?? null).toBe(before.lastTickAt?.toISOString() ?? null);
  });

  it('returns the active encounter with its species', async () => {
    const body = await get(`/api/v1/players/${playerId}/encounter`);
    expect(body.data.id).toBe(encounterId);
    expect(body.data.state).toBe('active');
    expect(body.data.species.id).toBe(body.data.speciesId);
    expect(body.data.species.name).toBeTruthy();
  });

  it('reports daily status', async () => {
    const body = await get(`/api/v1/players/${playerId}/daily`);
    expect(body.data.claimedToday).toBe(false);
    expect(body.data.nextResetAt).toMatch(/Z$/);
  });

  it('returns assigned quests with frozen snapshots', async () => {
    const rows = await app.quests.getDailyQuests(playerId);
    const body = await get(`/api/v1/players/${playerId}/quests/daily`);
    expect(body.data.quests).toHaveLength(rows.length);
    expect(body.data.questDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.allCompleteBonusClaimed).toBe(false);

    const quest = body.data.quests[0];
    expect(quest.title).toBe(rows[0]!.titleSnapshot);
    expect(quest.description).toBe(rows[0]!.descriptionSnapshot);
    expect(quest.rewards).toHaveProperty('waifubux');
    expect(quest.progress).toBe(0);
  });

  it('never assigns quests as a side effect of reading them', async () => {
    const { playerId: freshId } = await provisionPlayer(app, GUILD_ID, 'u-no-quests');
    const body = await get(`/api/v1/players/${freshId}/quests/daily`);
    expect(body.data.quests).toEqual([]);
    expect(body.data.questDate).toBeNull();
    // And still none in the database.
    expect(await app.quests.getDailyQuests(freshId)).toEqual([]);
  });

  it('returns the session for a channel and 404s an unused one', async () => {
    const body = await get(`/api/v1/players/${playerId}/sessions/${CHANNEL_ID}`);
    expect(body.data).toMatchObject({ playerId, channelId: CHANNEL_ID, guildId: guildDbId });
    expect(body.data.summary).toHaveProperty('hunts');
    expect(typeof body.data.summaryFresh).toBe('boolean');

    const missing = await get(`/api/v1/players/${playerId}/sessions/9999999`, 404);
    expect(missing.error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('content', () => {
  it('serves the shipped species catalog from the snapshot', async () => {
    const body = await get('/api/v1/content/species');
    expect(body.data.length).toBe(app.content.species.length);
    expect(body.data[0]).not.toHaveProperty('id');

    const one = await get(`/api/v1/content/species/${firstSpeciesSlug}`);
    expect(one.data.slug).toBe(firstSpeciesSlug);
  });

  it('publishes canonical AssetIds for expansion species artwork', async () => {
    const body = await get('/api/v1/content/species/onsen_maid');
    const standard = body.data.appearances.find((entry: any) => entry.id === 'standard');

    expect(standard.assetId).toEqual({
      kind: 'waifumon',
      slug: 'onsen_maid',
      variant: 'standard',
    });
    expect(JSON.stringify(body.data)).not.toContain('expansions/');
    expect(body.data).not.toHaveProperty('imagePath');
  });

  it('filters species by rarity, archetype and enabled', async () => {
    const enabled = await get('/api/v1/content/species?enabled=true');
    expect(enabled.data.every((s: any) => s.enabled)).toBe(true);
    expect(enabled.data.length).toBe(app.content.species.filter((s) => s.enabled).length);

    const rare = await get('/api/v1/content/species?rarity=EX');
    expect(rare.data.every((s: any) => s.rarity === 'EX')).toBe(true);
  });

  it('serves the shipped item catalog', async () => {
    const body = await get('/api/v1/content/items');
    expect(body.data.length).toBe(app.content.items.length);

    const captureOnly = await get('/api/v1/content/items?category=capture');
    expect(captureOnly.data.every((i: any) => i.category === 'capture')).toBe(true);

    const one = await get('/api/v1/content/items/basic_charm');
    expect(one.data).toMatchObject({ slug: 'basic_charm', category: 'capture' });
  });

  it('serves the tuning tables whole and by key', async () => {
    const all = await get('/api/v1/content/tables');
    expect(Object.keys(all.data)).toEqual(expect.arrayContaining(['energy', 'hunt', 'capture']));

    const energy = await get('/api/v1/content/tables/energy');
    expect(energy.data.baseMax).toBe(app.content.tables.energy.baseMax);
  });

  it('serves the daily-quest catalog', async () => {
    const body = await get('/api/v1/content/quests');
    expect(body.data.questsPerDay).toBe(app.content.tables.dailyQuests.questsPerDay);
    expect(body.data.pool.length).toBe(app.content.tables.dailyQuests.pool.length);
    expect(body.data.pool[0]).toHaveProperty('rewards');
  });

  it('reflects a republished content snapshot without a restart', async () => {
    // What the admin panel's "Save + Reload" does: swap the snapshot object.
    const original = app.content;
    try {
      app.content = { ...original, species: original.species.slice(0, 1) };
      expect((await get('/api/v1/content/species')).data).toHaveLength(1);
    } finally {
      app.content = original;
    }
    expect((await get('/api/v1/content/species')).data).toHaveLength(original.species.length);
  });
});

describe('guilds', () => {
  it('returns the guild and its channel configuration', async () => {
    const guild = (await get(`/api/v1/guilds/${GUILD_ID}`)).data;
    expect(guild).toMatchObject({
      id: guildDbId,
      discordGuildId: GUILD_ID,
      announceChannelId: '4242',
    });

    const channels = (await get(`/api/v1/guilds/${GUILD_ID}/channels`)).data;
    expect(channels).toEqual({ announceChannelId: '4242', allowedChannelIds: null });
  });

  it('404s a guild the bot has never seen, without provisioning it', async () => {
    const body = await get('/api/v1/guilds/123456789012345678', 404);
    expect(body.error.code).toBe('GUILD_NOT_FOUND');
    expect(await app.guilds.getByDiscordId('123456789012345678')).toBeUndefined();
  });
});

describe('read-only guarantee', () => {
  it('leaves player, currency, inventory and quest state untouched after a full sweep', async () => {
    const before = {
      player: await app.players.getById(playerId),
      currencies: await app.currency.getBalances(playerId),
      inventory: await app.inventory.getInventory(playerId),
      quests: await app.quests.getDailyQuests(playerId),
      dex: await app.collection.getDexStats(playerId),
    };

    for (const url of [
      `/api/v1/players/${playerId}`,
      `/api/v1/players/${playerId}/profile`,
      `/api/v1/players/${playerId}/currency`,
      `/api/v1/players/${playerId}/inventory`,
      `/api/v1/players/${playerId}/collection/stats`,
      `/api/v1/players/${playerId}/collection/owned`,
      `/api/v1/players/${playerId}/collection/buddy`,
      `/api/v1/players/${playerId}/care`,
      `/api/v1/players/${playerId}/encounter`,
      `/api/v1/players/${playerId}/daily`,
      `/api/v1/players/${playerId}/quests/daily`,
      `/api/v1/players/${playerId}/effects/capture-bonus`,
      `/api/v1/players/${playerId}/sessions/${CHANNEL_ID}`,
      '/api/v1/shop/catalog',
      '/api/v1/content/species',
    ]) {
      await get(url);
    }

    expect(await app.players.getById(playerId)).toEqual(before.player);
    expect(await app.currency.getBalances(playerId)).toEqual(before.currencies);
    expect(await app.inventory.getInventory(playerId)).toEqual(before.inventory);
    expect(await app.quests.getDailyQuests(playerId)).toEqual(before.quests);
    expect(await app.collection.getDexStats(playerId)).toEqual(before.dex);
  });
});
