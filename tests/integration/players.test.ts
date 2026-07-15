import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guilds, playerCurrencies, players } from '../../src/db/schema';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

describe('guild + player provisioning', () => {
  it('provisions guild, player, and currency rows on first touch', async () => {
    const { guildDbId, playerId } = await provisionPlayer(app, 'g-prov', 'u-prov');
    const [guild] = await t.db.select().from(guilds).where(eq(guilds.id, guildDbId));
    expect(guild?.discordGuildId).toBe('g-prov');
    const [currency] = await t.db
      .select()
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    expect(currency?.huntEnergy).toBe(app.content.tables.energy.baseMax);
    expect(currency?.waifubux).toBe(0);
    expect(currency?.essence).toBe(0);
  });

  it('is idempotent — repeated ensure calls return the same rows', async () => {
    const first = await provisionPlayer(app, 'g-idem', 'u-idem');
    const second = await provisionPlayer(app, 'g-idem', 'u-idem');
    expect(second).toEqual(first);
  });

  it('scopes players per guild: same user in two guilds = two players', async () => {
    const a = await provisionPlayer(app, 'g-a', 'u-shared');
    const b = await provisionPlayer(app, 'g-b', 'u-shared');
    expect(a.playerId).not.toBe(b.playerId);
  });

  it('concurrent provisioning creates exactly one player row', async () => {
    const guild = await app.guilds.ensureGuild('g-race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => app.players.ensurePlayer(guild.id, 'u-race')),
    );
    const ids = new Set(results.map((p) => p.id));
    expect(ids.size).toBe(1);
    const rows = await t.db
      .select()
      .from(players)
      .where(eq(players.discordUserId, 'u-race'));
    expect(rows).toHaveLength(1);
  });
});

describe('guild config service', () => {
  it('manages the allowed-channel list', async () => {
    await app.guilds.ensureGuild('g-admin');
    expect(await app.guilds.getAllowedChannelIds('g-admin')).toBeNull();
    await app.guilds.addAllowedChannel('g-admin', 'chan-1');
    const list = await app.guilds.addAllowedChannel('g-admin', 'chan-2');
    expect(list).toEqual(['chan-1', 'chan-2']);
    // add is idempotent
    expect(await app.guilds.addAllowedChannel('g-admin', 'chan-1')).toEqual([
      'chan-1',
      'chan-2',
    ]);
    expect(await app.guilds.removeAllowedChannel('g-admin', 'chan-1')).toEqual(['chan-2']);
  });

  it('sets the announce channel', async () => {
    await app.guilds.setAnnounceChannel('g-admin', 'announce-1');
    const guild = await app.guilds.getByDiscordId('g-admin');
    expect(guild?.announceChannelId).toBe('announce-1');
  });

  it('read-only lookups never create guild rows (guard requirement)', async () => {
    expect(await app.guilds.getAllowedChannelIds('g-never-touched')).toBeNull();
    const rows = await t.db
      .select()
      .from(guilds)
      .where(eq(guilds.discordGuildId, 'g-never-touched'));
    expect(rows).toHaveLength(0);
  });
});
