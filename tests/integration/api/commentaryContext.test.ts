/**
 * The commentary context endpoint, end to end over HTTP and a real database.
 *
 * What matters here is not the shape of a happy response but four boundaries:
 *
 *   1. **Correlation.** A Discord message resolves to the player the record
 *      names — through the real `sendRareAnnouncement` and the ledger — so two
 *      trainers who share a display name can never be confused.
 *   2. **Guild.** Only the configured guild answers, and only for messages
 *      recorded in it. Every other case is one indistinguishable 404.
 *   3. **Disclosure.** Nothing beyond what a guild-mate can already see, plus
 *      what the announcement itself published. Checked against the response's
 *      actual keys, so a field added upstream fails here.
 *   4. **Honesty.** A verified zero and an unavailable fact never look alike,
 *      and a slow or failing query degrades one fact, not the answer.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { IdentityResolver } from '../../../src/api/identity';
import { createIntegrationRateLimiter } from '../../../src/api/integrationAuth';
import { PORTAL_SESSION_COOKIE, type PortalSessionService } from '../../../src/api/portalSession';
import type { IntegrationApiConfig } from '../../../src/config/config';
import {
  announcementLedger,
  bossEncounters,
  bossParticipations,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
  type Rarity,
  type SpeciesRow,
} from '../../../src/db/schema';
import type { Db } from '../../../src/db/client';
import {
  createAnnouncementLedger,
  ledgerEntryForEvent,
  type AnnouncementLedger,
} from '../../../src/modules/announcements/announcementLedger';
import {
  createCommentaryContextService,
  type CommentaryContextService,
} from '../../../src/modules/commentary/commentaryContextService';
import { buildGameEvent } from '../../../src/modules/events/gameEvents';
import { sendRareAnnouncement } from '../../../src/discord/commands/waifumonHunt';
import type { AppContext } from '../../../src/discord/types';
import { DatabaseUnavailableError } from '../../../src/shared/errors';
import { ASSETS_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const GUILD = '310000000000000001';
const OTHER_GUILD = '320000000000000002';

/** Two trainers who share a display name — the case names cannot resolve. */
const SAM_A = '910000000000000001';
const SAM_B = '910000000000000002';
const OUTSIDER = '910000000000000003';

const SECRET = 'c'.repeat(64);
const INTEGRATION: IntegrationApiConfig = {
  guildId: GUILD,
  keys: [{ keyId: 'gallery-test', secretSha256: createHash('sha256').update(SECRET).digest('hex') }],
};
const KEY = { authorization: `Integration gallery-test.${SECRET}` };

let t: TestDb;
let app: App;
let api: ZodFastify;
let ledger: AnnouncementLedger;
let commentary: CommentaryContextService;
let guildDbId: number;
let otherGuildDbId: number;
const ids: Record<string, number> = {};
let rare: SpeciesRow;
let common: SpeciesRow;
let samACopy: PlayerWaifuRow;
let samAReleased: PlayerWaifuRow;

let nextMessage = 1_400_000_000_000_000_000n;
const messageId = () => String((nextMessage += 1n));

/** The real rare-announcement path, against a channel that only records sends. */
function announcementHarness(services: Partial<AppContext['services']>) {
  const sends: { options: { embeds: { data: { title?: string; description?: string } }[] }; id: string }[] = [];
  const channel = {
    send: vi.fn(async (options: (typeof sends)[number]['options']) => {
      const id = messageId();
      sends.push({ options, id });
      return { id, channelId: '330000000000000003' };
    }),
  };
  const ctx = {
    config: { assetsDir: ASSETS_DIR, contentDir: process.cwd() },
    logger: t.logger,
    db: t.db,
    content: app.content,
    services: { ...app, ...services },
  } as unknown as AppContext;
  const interaction = {
    guildId: GUILD,
    channelId: '330000000000000003',
    client: { channels: { fetch: async () => channel } },
  } as never;
  return { ctx, interaction, channel, sends };
}

async function ask(id: string, headers: Record<string, string> = KEY, guild = GUILD) {
  return api.inject({
    method: 'GET',
    url: `/api/v1/integrations/commentary/context?discordGuildId=${guild}&messageId=${id}`,
    headers,
  });
}

/** Every key anywhere in a JSON value, for disclosure checks. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

const sessions = {
  async getSession(token: string | undefined) {
    if (token !== 'sam-session') return null;
    return {
      sessionDigest: token,
      discordUserId: SAM_A,
      discordUsername: 'Sam',
      discordAvatarUrl: null,
      selectedDiscordGuildId: GUILD,
      selectedGuildDbId: guildDbId,
      playerId: ids[SAM_A]!,
      eligibleGuilds: [],
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 60_000),
    };
  },
} as unknown as PortalSessionService;

async function buildApi(service: CommentaryContextService): Promise<ZodFastify> {
  const resolveIdentity: IdentityResolver = async (discordUserId) =>
    [SAM_A, SAM_B].includes(discordUserId) ? { displayName: 'Sam', avatarUrl: null } : null;
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3197, token: TEST_TOKEN },
    integration: INTEGRATION,
    integrationRateLimiter: createIntegrationRateLimiter({ burst: 10_000, perMinute: 60_000 }),
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: {
        publicUrl: 'http://localhost',
        forwardedProto: 'http',
        discordClientId: 'x',
        discordClientSecret: 'x',
        sessionSecret: 'x',
        sessionTtlSeconds: 3600,
      },
      sessions,
    },
    ctx: {
      services: app,
      getContent: () => app.content,
      resolveIdentity,
      integration: { guildId: GUILD, commentary: service },
    },
  });
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  for (const [guild, user] of [
    [GUILD, SAM_A],
    [GUILD, SAM_B],
    [OTHER_GUILD, OUTSIDER],
  ] as const) {
    const p = await provisionPlayer(app, guild, user);
    ids[user] = p.playerId;
    if (guild === GUILD) guildDbId = p.guildDbId;
    else otherGuildDbId = p.guildDbId;
  }
  await t.db.update(players).set({ level: 12, xp: 5000 }).where(eq(players.id, ids[SAM_A]!));
  await t.db.update(players).set({ level: 30, xp: 90000 }).where(eq(players.id, ids[SAM_B]!));

  const [rareRow] = await t.db.select().from(species).where(eq(species.rarity, 'SSR')).limit(1);
  const [commonRow] = await t.db.select().from(species).where(eq(species.rarity, 'N')).limit(1);
  if (!rareRow || !commonRow) throw new Error('shipped content lacks an SSR or N species');
  rare = rareRow;
  common = commonRow;

  // Sam A: one active rare copy, one released rare copy, one common.
  samACopy = await insertOwnedWaifu(t.db, { playerId: ids[SAM_A]!, speciesId: rare.id, level: 7 });
  samAReleased = await insertOwnedWaifu(t.db, {
    playerId: ids[SAM_A]!,
    speciesId: rare.id,
    level: 3,
    releasedAt: new Date(),
  });
  await insertOwnedWaifu(t.db, { playerId: ids[SAM_A]!, speciesId: common.id, level: 1 });
  // Sam B owns no rare copy at all. The outsider owns two, in another guild.
  await insertOwnedWaifu(t.db, { playerId: ids[SAM_B]!, speciesId: common.id, level: 2 });
  await insertOwnedWaifu(t.db, { playerId: ids[OUTSIDER]!, speciesId: rare.id, level: 9 });
  await insertOwnedWaifu(t.db, { playerId: ids[OUTSIDER]!, speciesId: rare.id, level: 9 });

  ledger = createAnnouncementLedger({ db: t.db, logger: t.logger });
  commentary = createCommentaryContextService({
    db: t.db,
    ledger,
    collection: app.collection,
    leaderboards: app.leaderboards,
    logger: t.logger,
  });
  api = await buildApi(commentary);
});

afterAll(async () => {
  await api?.close();
  await t?.cleanup();
});

describe('rare capture correlation through the real announcement', () => {
  let huntMessage: string;
  let delveMessage: string;

  beforeAll(async () => {
    const { ctx, interaction, sends } = announcementHarness({ announcementLedger: ledger });
    expect(
      await sendRareAnnouncement(ctx, interaction, rare, `<@${SAM_A}>`, false, samACopy, {
        playerId: ids[SAM_A]!,
        source: 'hunt',
      }),
    ).toBe('sent');
    expect(
      await sendRareAnnouncement(ctx, interaction, rare, `<@${SAM_B}>`, true, null, {
        playerId: ids[SAM_B]!,
        source: 'delve_recruit',
      }),
    ).toBe('sent');
    [huntMessage, delveMessage] = sends.map((s) => s.id) as [string, string];

    // Presentation is untouched: same title, same description wording.
    expect(sends[0]!.options.embeds[0]!.data.title).toBe(`🌟 ${rare.name} captured! (${rare.rarity})`);
    expect(sends[0]!.options.embeds[0]!.data.description).toBe(
      `<@${SAM_A}> just landed a **${rare.rarity}** encounter!`,
    );
    expect(sends[1]!.options.embeds[0]!.data.description).toContain('(duplicate)');
  });

  it('stores the message id Discord returned, with guild, channel and player', async () => {
    const [row] = await t.db.select().from(announcementLedger).where(eq(announcementLedger.messageId, huntMessage));
    expect(row).toMatchObject({
      guildId: guildDbId,
      channelId: '330000000000000003',
      kind: 'rare_capture',
      playerId: ids[SAM_A],
      payload: {
        species: { slug: rare.slug, name: rare.name, rarity: rare.rarity },
        source: 'hunt',
        isDuplicate: false,
        waifuId: samACopy.id,
      },
    });
    expect(row!.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps two trainers with one display name apart', async () => {
    const a = (await ask(huntMessage)).json().data;
    const b = (await ask(delveMessage)).json().data;
    expect(a.player).toEqual({ playerId: ids[SAM_A], discordUserId: SAM_A, displayName: 'Sam', status: 'active' });
    expect(b.player).toEqual({ playerId: ids[SAM_B], discordUserId: SAM_B, displayName: 'Sam', status: 'active' });
    expect(a.facts.playerLevel.value).toBe(12);
    expect(b.facts.playerLevel.value).toBe(30);
  });

  it('distinguishes a hunt capture from a Delve recruit and keeps the duplicate flag as announced', async () => {
    const a = (await ask(huntMessage)).json().data;
    const b = (await ask(delveMessage)).json().data;
    expect(a.announced).toMatchObject({ source: 'hunt', isDuplicate: false });
    expect(b.announced).toMatchObject({ source: 'delve_recruit', isDuplicate: true, waifuId: null });
  });

  it('counts only active copies, and reports verified zeros as zeros', async () => {
    const a = (await ask(huntMessage)).json().data;
    // One active and one released copy of the species: released is excluded.
    expect(a.facts.activeCopiesOfSpecies).toMatchObject({ status: 'verified', value: 1 });
    expect(a.facts.collection.value).toEqual({ owned: 2, distinctSpecies: 2, totalSpecies: expect.any(Number) });
    expect(a.facts.rarityDistribution.value).toMatchObject({ N: 1, SSR: 1, EX: 0, LR: 0 });
    const b = (await ask(delveMessage)).json().data;
    expect(b.facts.activeCopiesOfSpecies).toMatchObject({ status: 'verified', value: 0 });
    expect(b.facts.activeCopiesOfSpecies.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('compares within the configured guild only', async () => {
    const a = (await ask(huntMessage)).json().data;
    // Sam A is the only trainer in the guild with an active copy; the
    // outsider's two copies are in another guild and do not count.
    expect(a.facts.guildOwnersOfSpecies.value).toEqual({ trainers: 1, guildTrainers: 2 });
  });

  it('names what it will not or cannot say instead of inventing it', async () => {
    const a = (await ask(huntMessage)).json().data;
    expect(a.facts.firstEverCopy).toEqual({ status: 'unavailable', reason: 'withheld' });
    expect(a.facts.captureRegion).toEqual({ status: 'unavailable', reason: 'not_recorded' });
  });

  it('discloses nothing beyond the guild-public tier', async () => {
    const res = await ask(huntMessage);
    const body = res.json();
    expect(Object.keys(body.data).sort()).toEqual(['announced', 'announcement', 'contractVersion', 'facts', 'player']);
    const keys = allKeys(body);
    for (const forbidden of [
      'xp', 'affection', 'baseSp', 'currentSp', 'seductivePower', 'waifubux', 'essence', 'energy',
      'releasedAt', 'settings', 'inventory', 'equipment', 'rewardItems', 'xpAwarded', 'assetId',
      'guildId', 'buddyWaifuId', 'giftRollCounter',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    // The released copy never surfaces in any form.
    expect(res.body).not.toContain(`"waifuId":${samAReleased.id}`);
  });

  it('carries the versioned contract envelope', async () => {
    const body = (await ask(huntMessage)).json();
    expect(body.data.contractVersion).toBe(1);
    expect(body.data.announcement).toMatchObject({
      messageId: huntMessage,
      discordGuildId: GUILD,
      kind: 'rare_capture',
      occurredAt: expect.stringMatching(/Z$/),
    });
    expect(body.meta.requestId).toEqual(expect.any(String));
  });
});

describe('ledger failures never break an announcement', () => {
  it('still reports the announcement as sent when the ledger cannot write', async () => {
    const broken = createAnnouncementLedger({
      db: {
        insert: () => {
          throw new Error('connection refused');
        },
      } as unknown as Db,
      logger: t.logger,
    });
    const { ctx, interaction, channel } = announcementHarness({ announcementLedger: broken });
    const result = await sendRareAnnouncement(ctx, interaction, rare, `<@${SAM_A}>`, false, samACopy, {
      playerId: ids[SAM_A]!,
      source: 'hunt',
    });
    expect(result).toBe('sent');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('records nothing when Discord refuses the post', async () => {
    const { ctx, interaction, channel } = announcementHarness({ announcementLedger: ledger });
    channel.send.mockRejectedValueOnce(new Error('Missing Permissions'));
    const before = await t.db.select({ n: sql<number>`count(*)::int` }).from(announcementLedger);
    expect(
      await sendRareAnnouncement(ctx, interaction, rare, `<@${SAM_A}>`, false, samACopy, {
        playerId: ids[SAM_A]!,
        source: 'hunt',
      }),
    ).toBe('failed');
    const after = await t.db.select({ n: sql<number>`count(*)::int` }).from(announcementLedger);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('feed announcements', () => {
  function event(kind: 'PLAYER_LEVEL_UP' | 'COLLECTION_COMPLETED' | 'WAIFU_APPEARANCE_UNLOCKED' | 'PLAYER_FOUND_ITEM', payload: unknown, playerId = ids[SAM_A]!) {
    return buildGameEvent({ kind, payload } as never, {
      guildId: GUILD,
      guildDbId,
      playerId,
      playerName: 'Sam',
      playerMention: `<@${SAM_A}>`,
      channelId: null,
    });
  }

  it('records level-ups and answers with a rank, not a value', async () => {
    const id = messageId();
    const e = event('PLAYER_LEVEL_UP', { level: 12, rewardLabels: [] });
    await ledger.recordEvent(e, { id, channelId: '330000000000000004' });
    const data = (await ask(id)).json().data;
    expect(data.announcement).toMatchObject({ kind: 'level_up', eventId: e.eventId });
    expect(data.announced).toEqual({ level: 12 });
    // Sam B has more XP, so Sam A ranks second of two.
    expect(data.facts.trainerRank.value).toEqual({ rank: 2, guildTrainers: 2 });
    expect(JSON.stringify(data)).not.toContain('5000');
  });

  it('records collection completion', async () => {
    const id = messageId();
    await ledger.recordEvent(event('COLLECTION_COMPLETED', { distinctSpecies: 2, totalSpecies: 2 }), {
      id,
      channelId: '330000000000000004',
    });
    const data = (await ask(id)).json().data;
    expect(data.announced).toEqual({ distinctSpecies: 2, totalSpecies: 2 });
    expect(data.facts.collection.status).toBe('verified');
  });

  it('answers a released copy as withheld, never as a level', async () => {
    const payload = {
      waifuId: samAReleased.id,
      waifuName: rare.name,
      speciesSlug: rare.slug,
      appearanceId: 'lv20',
      appearanceName: 'Festival',
      assetId: { kind: 'waifumon', slug: rare.slug, variant: 'lv20' },
      cosmeticRarity: 'rare',
      unlockLabel: 'Reach Level 20',
      source: 'level',
    };
    const released = messageId();
    await ledger.recordEvent(event('WAIFU_APPEARANCE_UNLOCKED', payload), { id: released, channelId: 'c' });
    expect((await ask(released)).json().data.facts.copyLevel).toEqual({ status: 'unavailable', reason: 'withheld' });

    const active = messageId();
    await ledger.recordEvent(event('WAIFU_APPEARANCE_UNLOCKED', { ...payload, waifuId: samACopy.id }), {
      id: active,
      channelId: 'c',
    });
    const data = (await ask(active)).json().data;
    expect(data.facts.copyLevel).toMatchObject({ status: 'verified', value: 7 });
    // The asset id rode on the event; it never reaches the integration.
    expect(allKeys(data).has('assetId')).toBe(false);
  });

  it('does not record kinds outside v1', async () => {
    expect(ledgerEntryForEvent(event('PLAYER_FOUND_ITEM', { itemSlug: 'x', itemName: 'X', quantity: 1, rare: false }))).toBeNull();
  });

  it('reports a missing player as unavailable, not as zeros', async () => {
    const id = messageId();
    await ledger.record({
      kind: 'level_up',
      payload: { level: 4 },
      messageId: id,
      channelId: 'c',
      guildDbId,
      eventId: '00000000-0000-4000-8000-000000000001',
      playerId: null,
      occurredAt: new Date(),
    });
    const data = (await ask(id)).json().data;
    expect(data.player).toEqual({ playerId: null, discordUserId: null, displayName: null, status: 'unavailable' });
    expect(data.facts.playerLevel).toEqual({ status: 'unavailable', reason: 'player_unavailable' });
  });
});

describe('guild boundary', () => {
  it('answers 404 for an unknown message', async () => {
    const res = await ask('1');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ANNOUNCEMENT_NOT_FOUND');
  });

  it('answers the same 404 for another guild, by message or by guild id', async () => {
    const id = messageId();
    await ledger.record({
      kind: 'level_up',
      payload: { level: 3 },
      messageId: id,
      channelId: 'c',
      guildDbId: otherGuildDbId,
      eventId: '00000000-0000-4000-8000-000000000002',
      playerId: ids[OUTSIDER]!,
      occurredAt: new Date(),
    });
    const strip = (r: { json: () => { requestId: string } }) => {
      const { requestId: _r, ...rest } = r.json();
      return rest;
    };
    const unknown = await ask('2');
    const otherMessage = await ask(id);
    const otherGuild = await ask(id, KEY, OTHER_GUILD);
    for (const res of [otherMessage, otherGuild]) {
      expect(res.statusCode).toBe(404);
      expect(strip(res)).toEqual(strip(unknown));
    }
  });

  it('refuses malformed identifiers before touching the database', async () => {
    const res = await ask('not-a-snowflake');
    expect(res.statusCode).toBe(400);
  });
});

describe('route credentials', () => {
  it('refuses the bearer token', async () => {
    const res = await ask('1', { authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INTEGRATION_REQUIRED');
  });

  it('refuses a Portal session', async () => {
    const res = await ask('1', { cookie: `${PORTAL_SESSION_COOKIE}=sam-session` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INTEGRATION_REQUIRED');
  });

  it('refuses writes to it', async () => {
    const res = await api.inject({
      method: 'POST',
      url: `/api/v1/integrations/commentary/context?discordGuildId=${GUILD}&messageId=1`,
      headers: KEY,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('boss posts', () => {
  let spawnMessage: string;
  let completedMessage: string;
  let resultsMessage: string;

  const bossRow = (guildId: number, extra: Partial<typeof bossEncounters.$inferInsert>) => ({
    guildId,
    region: 'waifu-valley',
    bossId: 'test_boss',
    bossName: 'Test Boss',
    bossAffinity: 'dominant',
    rewardTable: 't',
    rewardTableVersion: '1',
    calcVersion: 1,
    affinityVersion: 1,
    scheduledAt: new Date(),
    channelId: '340000000000000004',
    ...extra,
  });

  beforeAll(async () => {
    completedMessage = messageId();
    resultsMessage = messageId();
    spawnMessage = messageId();
    const [resolved] = await t.db
      .insert(bossEncounters)
      .values(
        bossRow(guildDbId, {
          status: 'resolved',
          resolutionReason: 'repelled',
          messageId: completedMessage,
          resultsMessageId: resultsMessage,
          participantCount: 2,
          totalDamage: 4800,
          resolvedAt: new Date('2026-11-02T20:30:00Z'),
          resultsPublishedAt: new Date('2026-11-02T20:30:05Z'),
        }),
      )
      .returning();
    await t.db.insert(bossEncounters).values(
      bossRow(guildDbId, { status: 'resolved', resolutionReason: 'unchallenged', resolvedAt: new Date() }),
    );
    await t.db.insert(bossEncounters).values(bossRow(guildDbId, { status: 'scouting', messageId: spawnMessage }));
    await t.db
      .insert(bossEncounters)
      .values(bossRow(otherGuildDbId, { status: 'resolved', resolutionReason: 'repelled', messageId: '77' }));

    const participant = (playerId: number, discordUserId: string, waifu: PlayerWaifuRow, committedAt: Date, attacks: number) => ({
      encounterId: resolved!.id,
      playerId,
      discordUserId,
      trainerName: 'Sam',
      waifuId: waifu.id,
      speciesId: waifu.speciesId,
      speciesSlug: 'x',
      waifuName: `Copy ${waifu.id}`,
      level: 5,
      baseSp: 10,
      currentSp: 10,
      rarity: 'N',
      affinity: 'switch',
      race: 'human',
      affection: 0,
      committedAt,
      attackCount: attacks,
      totalDamage: 2400,
      xpAwarded: 999,
    });
    const [samBCopy] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, ids[SAM_B]!));
    // Sam B committed first, so Sam B is first on the scene.
    await t.db.insert(bossParticipations).values([
      participant(ids[SAM_B]!, SAM_B, samBCopy!, new Date('2026-11-02T20:00:00Z'), 15),
      participant(ids[SAM_A]!, SAM_A, samACopy, new Date('2026-11-02T20:01:00Z'), 22),
    ]);
  });

  it('resolves the edited announcement as a completed encounter with public totals', async () => {
    const data = (await ask(completedMessage)).json().data;
    expect(data.player).toBeNull();
    expect(data.announcement).toMatchObject({ kind: 'boss_completed', eventId: expect.stringMatching(/^boss:\d+:completed$/) });
    expect(data.announced).toMatchObject({
      boss: { id: 'test_boss', name: 'Test Boss' },
      outcome: 'repelled',
      participantCount: 2,
      totalDamage: 4800,
      totalAttacks: 37,
    });
    expect(data.announced.firstOnScene).toBeUndefined();
  });

  it('names the verified first-on-scene trainer on the results post', async () => {
    const data = (await ask(resultsMessage)).json().data;
    expect(data.announcement.kind).toBe('boss_results');
    expect(data.announcement.occurredAt).toBe('2026-11-02T20:30:05.000Z');
    expect(data.announced.firstOnScene).toEqual({
      playerId: ids[SAM_B],
      discordUserId: SAM_B,
      trainerName: 'Sam',
      waifuName: expect.any(String),
    });
  });

  it('keeps per-player rewards private and does not invent wins or losses', async () => {
    const data = (await ask(resultsMessage)).json().data;
    expect(data.facts.perPlayerRewards).toEqual({ status: 'unavailable', reason: 'withheld' });
    expect(data.facts.perPlayerOutcome).toEqual({ status: 'unavailable', reason: 'not_recorded' });
    expect(allKeys(data).has('xpAwarded')).toBe(false);
    expect(JSON.stringify(data)).not.toContain('999');
  });

  it('counts this boss’s history in this guild only', async () => {
    const data = (await ask(resultsMessage)).json().data;
    expect(data.facts.guildBossHistory.value).toEqual({
      encounters: 2,
      repelled: 1,
      unchallenged: 1,
      cancelled: 0,
      channelLost: 0,
    });
  });

  it('answers a live spawn without an outcome', async () => {
    const data = (await ask(spawnMessage)).json().data;
    expect(data.announcement.kind).toBe('boss_spawn');
    expect(data.announced.outcome).toBeUndefined();
  });

  it('never answers for another guild’s boss message', async () => {
    expect((await ask('77')).statusCode).toBe(404);
  });
});

describe('reliability', () => {
  it('answers concurrent requests for one message identically', async () => {
    const id = messageId();
    await ledger.record({
      kind: 'level_up',
      payload: { level: 12 },
      messageId: id,
      channelId: 'c',
      guildDbId,
      eventId: '00000000-0000-4000-8000-000000000003',
      playerId: ids[SAM_A]!,
      occurredAt: new Date(),
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => ask(id)));
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([200]));
    expect(new Set(responses.map((r) => JSON.stringify(r.json().data.announced))).size).toBe(1);
  });

  it('serves a cached answer for 60 seconds, then reads fresh', async () => {
    const id = messageId();
    await ledger.record({
      kind: 'level_up',
      payload: { level: 12 },
      messageId: id,
      channelId: 'c',
      guildDbId,
      eventId: '00000000-0000-4000-8000-000000000004',
      playerId: ids[SAM_A]!,
      occurredAt: new Date(),
    });
    const first = (await ask(id)).json().data;
    await t.db.update(players).set({ level: 13 }).where(eq(players.id, ids[SAM_A]!));
    const cached = (await ask(id)).json().data;
    expect(cached.facts.playerLevel).toEqual(first.facts.playerLevel);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      const fresh = (await ask(id)).json().data;
      expect(fresh.facts.playerLevel.value).toBe(13);
    } finally {
      spy.mockRestore();
      await t.db.update(players).set({ level: 12 }).where(eq(players.id, ids[SAM_A]!));
    }
  });

  it('degrades one slow fact and still answers the rest', async () => {
    const slow = createCommentaryContextService({
      db: t.db,
      ledger,
      collection: {
        getDexStats: () => new Promise((resolve) => setTimeout(() => resolve({ owned: 1, distinctSpecies: 1, totalSpecies: 1 }), 300)),
      },
      leaderboards: app.leaderboards,
      logger: t.logger,
      factBudgetMs: 50,
    });
    const id = messageId();
    await ledger.record({
      kind: 'rare_capture',
      payload: {
        species: { slug: rare.slug, name: rare.name, rarity: rare.rarity as Rarity },
        source: 'hunt',
        isDuplicate: false,
        waifuId: null,
      },
      messageId: id,
      channelId: 'c',
      guildDbId,
      eventId: '00000000-0000-4000-8000-000000000005',
      playerId: ids[SAM_A]!,
      occurredAt: new Date(),
    });
    const context = await slow.forMessage(guildDbId, id);
    expect(context!.facts.collection).toEqual({ status: 'unavailable', reason: 'degraded' });
    expect(context!.facts.playerLevel!.status).toBe('verified');
  });

  it('answers 503 when the database is unreachable', async () => {
    const down = createCommentaryContextService({
      db: t.db,
      ledger: {
        ...ledger,
        findByMessageId: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
        },
      },
      collection: app.collection,
      leaderboards: app.leaderboards,
      logger: t.logger,
    });
    await expect(down.forMessage(guildDbId, '5')).rejects.toBeInstanceOf(DatabaseUnavailableError);
    const downApi = await buildApi(down);
    try {
      const res = await downApi.inject({
        method: 'GET',
        url: `/api/v1/integrations/commentary/context?discordGuildId=${GUILD}&messageId=5`,
        headers: KEY,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('DB_UNAVAILABLE');
    } finally {
      await downApi.close();
    }
  });

  it('answers 503, not a guess, when the deciding lookup is too slow', async () => {
    const slowLookup = createCommentaryContextService({
      db: t.db,
      ledger: { ...ledger, findByMessageId: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)) },
      collection: app.collection,
      leaderboards: app.leaderboards,
      logger: t.logger,
      lookupBudgetMs: 50,
    });
    await expect(slowLookup.forMessage(guildDbId, '6')).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});

describe('ledger retention', () => {
  it('prunes rows past the cutoff in bounded batches and keeps recent ones', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    const oldIds = Array.from({ length: 5 }, () => messageId());
    for (const id of oldIds) {
      await ledger.record({
        kind: 'level_up',
        payload: { level: 2 },
        messageId: id,
        channelId: 'c',
        guildDbId,
        eventId: '00000000-0000-4000-8000-000000000006',
        playerId: ids[SAM_A]!,
        occurredAt: old,
      });
    }
    await t.db
      .update(announcementLedger)
      .set({ createdAt: old })
      .where(sql`${announcementLedger.messageId} in ${oldIds}`);
    const cutoff = new Date(Date.now() - 30 * 86_400_000);

    // One bounded pass removes at most batchSize × maxBatches.
    expect(await ledger.prune(cutoff, { batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await ledger.prune(cutoff, { batchSize: 2, maxBatches: 10 })).toBe(3);
    const remainingOld = await t.db
      .select()
      .from(announcementLedger)
      .where(and(sql`${announcementLedger.createdAt} < ${cutoff}`));
    expect(remainingOld).toHaveLength(0);
    // Recent rows survive.
    const recent = await t.db.select({ n: sql<number>`count(*)::int` }).from(announcementLedger);
    expect(recent[0]!.n).toBeGreaterThan(0);
  });
});
