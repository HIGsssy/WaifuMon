/**
 * Seductive Power on the player-facing surfaces — the API resource, the
 * inspect embed, and the trainer profile.
 *
 * Every assertion compares against the *domain function's* answer rather than
 * a literal, so a surface that quietly rounds differently fails here instead of
 * shipping a number that disagrees with the one next to it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { players, playerWaifus, species } from '../../src/db/schema';
import { handleInspectCommand } from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import { buildTrainerProfileView } from '../../src/discord/trainerProfile';
import { toOwnedWaifuResource } from '../../src/api/resources';
import { ownedWaifuSchema } from '../../src/api/schemas/collection';
import {
  currentSeductivePower,
  SP_FORMULA_VERSION,
} from '../../src/modules/power/seductivePower';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-sp-ui', 'u-1');
  ctx = {
    config: {
      assetsDir: process.cwd(),
      contentDir: process.cwd(),
      dailyTimezone: 'UTC',
      discordToken: 'x',
      discordClientId: 'x',
      discordGuildId: undefined,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
      adminWeb: { enabled: false, host: '127.0.0.1', port: 3111, token: '' },
      platformApi: { enabled: false, host: '127.0.0.1', port: 3120, token: '' },
    },
    logger: t.logger,
    db: t.db,
    content: app.content,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    collectionFilters: createCollectionFilterTracker(),
    services: {
      guilds: app.guilds,
      players: app.players,
      currency: app.currency,
      inventory: app.inventory,
      daily: app.daily,
      shop: app.shop,
      hunt: app.hunt,
      capture: app.capture,
      collection: app.collection,
      appearance: app.appearance,
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      effects: app.effects,
      itemUse: app.itemUse,
      gifts: app.gifts,
      session: app.session,
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
});

async function grantWaifu(baseSp: number, level = 1): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, 'neko_barista'));
  const row = await insertOwnedWaifu(t.db, {
    playerId: prov.playerId,
    speciesId: sp!.id,
    baseSp,
    level,
  });
  return row.id;
}

function baseInteraction() {
  return {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-sp-ui',
    options: { getString: (): string | null => null },
  };
}

const fakeCommand = (name: string) => ({
  ...baseInteraction(),
  isChatInputCommand: () => true,
  options: { getString: (): string | null => name },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function painted(interaction: ReturnType<typeof baseInteraction>): any {
  for (const method of [interaction.editReply, interaction.update, interaction.reply]) {
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function embedText(payload: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embed = payload.embeds?.[0]?.data ?? {};
  const fields = (embed.fields ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((f: any) => `${f.name}\n${f.value}`)
    .join('\n');
  return [embed.title ?? '', embed.description ?? '', fields].join('\n');
}

// ────────────────────────────── the API resource ─────────────────────────

describe('API serialization', () => {
  it('carries base, current and the formula version, and validates', async () => {
    const waifuId = await grantWaifu(127, 20);
    const entry = await app.collection.getOwned(prov.playerId, waifuId);
    const resource = toOwnedWaifuResource(entry.waifu, entry.species, app.appearance);

    const parsed = ownedWaifuSchema.parse(resource);
    expect(parsed.seductivePower).toEqual({
      base: 127,
      current: currentSeductivePower(127, 20),
      formulaVersion: SP_FORMULA_VERSION,
    });
    // 127 x (1 + 0.025 x 19) = 187.325
    expect(parsed.seductivePower.current).toBe(187);
  });

  it('reports base exactly as current at level 1', async () => {
    const waifuId = await grantWaifu(94, 1);
    const entry = await app.collection.getOwned(prov.playerId, waifuId);
    const resource = ownedWaifuSchema.parse(
      toOwnedWaifuResource(entry.waifu, entry.species, app.appearance),
    );
    expect(resource.seductivePower.base).toBe(94);
    expect(resource.seductivePower.current).toBe(94);
  });

  it('rejects a malformed SP block at the schema boundary', () => {
    expect(() =>
      ownedWaifuSchema.parse({
        id: 1,
        playerId: 1,
        speciesId: 1,
        level: 1,
        xp: 0,
        affection: 0,
        nickname: null,
        isFavorite: false,
        variant: 'standard',
        cosmetics: [],
        selectedAppearance: {},
        seductivePower: { base: 'ninety', current: 90, formulaVersion: 1 },
        caughtAt: new Date().toISOString(),
        releasedAt: null,
      }),
    ).toThrow();
  });

  it('two copies of one species serialize their own values', async () => {
    const lowId = await grantWaifu(90, 50);
    const highId = await grantWaifu(100, 50);
    const low = await app.collection.getOwned(prov.playerId, lowId);
    const high = await app.collection.getOwned(prov.playerId, highId);

    const lowRes = toOwnedWaifuResource(low.waifu, low.species, app.appearance);
    const highRes = toOwnedWaifuResource(high.waifu, high.species, app.appearance);
    expect(lowRes.seductivePower).toMatchObject({ base: 90, current: 200 });
    expect(highRes.seductivePower).toMatchObject({ base: 100, current: 223 });
  });
});

// ─────────────────────────────── inspect embed ───────────────────────────

describe('collection inspect', () => {
  it('shows Current SP as the headline, with the permanent roll beside it', async () => {
    const waifuId = await grantWaifu(127, 20);
    const i = fakeCommand(String(waifuId));
    await handleInspectCommand(ctx, i as never, prov);
    const text = embedText(painted(i));

    expect(text).toContain('Seductive Power');
    expect(text).toContain(`**${currentSeductivePower(127, 20)} SP**`);
    expect(text).toContain('187 SP');
    expect(text).toContain('base 127');
  });

  it('does not repeat the base as a separate number at level 1', async () => {
    const waifuId = await grantWaifu(96, 1);
    const i = fakeCommand(String(waifuId));
    await handleInspectCommand(ctx, i as never, prov);
    const text = embedText(painted(i));
    expect(text).toContain('**96 SP**');
    expect(text).toContain('base roll');
    expect(text).not.toContain('base 96');
  });

  it('agrees with the API for the same copy — one calculation, two surfaces', async () => {
    const waifuId = await grantWaifu(143, 37);
    const entry = await app.collection.getOwned(prov.playerId, waifuId);
    const resource = toOwnedWaifuResource(entry.waifu, entry.species, app.appearance);

    const i = fakeCommand(String(waifuId));
    await handleInspectCommand(ctx, i as never, prov);
    expect(embedText(painted(i))).toContain(`**${resource.seductivePower.current} SP**`);
  });
});

// ────────────────────────────── trainer profile ──────────────────────────

describe('trainer profile', () => {
  it('shows the active buddy Current SP on the dashboard', async () => {
    const waifuId = await grantWaifu(152, 30);
    await app.collection.setBuddy(prov.playerId, waifuId);
    await app.care.start(prov.playerId, waifuId);

    const [player] = await t.db
      .select()
      .from(players)
      .where(eq(players.id, prov.playerId));
    const view = buildTrainerProfileView({
      playerName: 'Hunter',
      player: player!,
      currencies: await app.currency.getBalances(prov.playerId),
      careState: await app.care.getState(prov.playerId),
      collectionProgress: await app.collection.getDexStats(prov.playerId),
      maxEnergy: app.progression.computeMaxEnergy(player!.level),
      prestigeTitle: null,
    });

    const text = embedText({ embeds: view.embeds });
    // 152 x (1 + 0.025 x 29) = 262.2 -> 262
    expect(text).toContain(`${currentSeductivePower(152, 30)} SP`);
    expect(text).toContain('262 SP');
  });
});
