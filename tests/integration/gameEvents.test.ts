/**
 * Coordinator-level event emission (phase 1 of the Gameplay UX Redesign).
 *
 * These run the real Discord handlers against a real Postgres and a real
 * event bus + Activity Feed, with only Discord itself faked. They pin the
 * things unit tests can't: *when* events fire, in what order, and that a
 * broken subscriber cannot break gameplay.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerCurrencies,
  playerInventory,
  playerWaifus,
  players,
  species,
  type EncounterRow,
} from '../../src/db/schema';
import {
  handleCareLeave,
  handleCareStart,
  handleMenu,
} from '../../src/discord/commands/waifumon';
import { handleEncounterCharm, handleHunt } from '../../src/discord/commands/waifumonHunt';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import type { GameEvent, GameEventPayloads } from '../../src/modules/events/gameEvents';
import {
  bootstrapApp,
  createEventHarness,
  getItemBySlug,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let ctx: AppContext;
let prov: Provisioned;

const GUILD_ID = 'g-events';
const USER_ID = 'u-events';
const CHANNEL_ID = 'c-events';

beforeAll(async () => {
  t = await createTestDb();
  // Always-fail capture rolls, so charm attempts run the encounter to escape.
  // Guaranteed items (Mythic Contract) bypass the roll entirely.
  app = await bootstrapApp(t, { captureRng: { next: () => 0.999, intInclusive: () => 0 } });
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, GUILD_ID, USER_ID);
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
      session: app.session,
    },
  };
});
afterAll(async () => {
  await t.cleanup();
});

function fakeInteraction(): PlayerInteraction {
  const channel = {
    id: CHANNEL_ID,
    send: vi.fn(async () => ({ id: `m-${Math.random().toString(36).slice(2, 8)}` })),
    messages: { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
  };
  return {
    isChatInputCommand: () => true,
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
    deferReply: vi.fn(async () => {}),
    channel,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID, username: 'Whistler', globalName: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** `handleEncounterCharm` needs a button-shaped interaction with a client. */
function fakeCharmButton(): PlayerInteraction {
  const btn = fakeInteraction();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = btn as any;
  any.isChatInputCommand = () => false;
  any.isButton = () => true;
  any.message = { id: 'm-board' };
  any.client = { channels: { fetch: vi.fn(async () => null) } };
  return btn;
}

async function clearEncounters(): Promise<void> {
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, prov.playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
}

async function setLastHuntAt(at: Date | null): Promise<void> {
  await t.db.update(players).set({ lastHuntAt: at }).where(eq(players.id, prov.playerId));
}

async function resetPlayer(): Promise<void> {
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, prov.playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
  await t.db
    .update(players)
    .set({
      lastHuntAt: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, prov.playerId));
  harness.huntSessions.close(prov.playerId);
  harness.reset();
}

function kinds(): string[] {
  return harness.events.map((e) => e.kind);
}

function payloadOf<K extends GameEvent['kind']>(kind: K): GameEventPayloads[K] {
  const found = harness.ofKind(kind)[0];
  if (!found) throw new Error(`no ${kind} event was emitted (saw: ${kinds().join(', ')})`);
  return found.payload as GameEventPayloads[K];
}

describe('hunt-session narration', () => {
  beforeEach(resetPlayer);

  it('emits PLAYER_STARTED_HUNT once when a session opens, and narrates it', async () => {
    await handleHunt(ctx, fakeInteraction(), prov);

    const started = harness.ofKind('PLAYER_STARTED_HUNT');
    expect(started).toHaveLength(1);
    expect(app.content.tables.hunt.locationFlavors).toContain(started[0]!.payload.location);
    expect(harness.lines.some((l) => l.text.startsWith('🌿 Whistler ventured into'))).toBe(true);
  });

  it('stays silent for a follow-up hunt inside the same session', async () => {
    await handleHunt(ctx, fakeInteraction(), prov);
    harness.reset();
    // Past the 10s hunt cooldown but well inside the 15m session window.
    await setLastHuntAt(new Date(Date.now() - 60_000));
    await clearEncounters();

    await handleHunt(ctx, fakeInteraction(), prov);

    expect(harness.ofKind('PLAYER_STARTED_HUNT')).toHaveLength(0);
    expect(harness.ofKind('PLAYER_COMPLETED_HUNT')).toHaveLength(0);
  });

  it('sweeps an abandoned session past the idle threshold, matching open/close locations', async () => {
    await handleHunt(ctx, fakeInteraction(), prov);
    const openedLocation = harness.ofKind('PLAYER_STARTED_HUNT')[0]!.payload.location;
    harness.reset();

    await setLastHuntAt(new Date(Date.now() - 30 * 60_000));
    await clearEncounters();
    await handleHunt(ctx, fakeInteraction(), prov);

    const completed = harness.ofKind('PLAYER_COMPLETED_HUNT');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.reason).toBe('inactivity');
    // The closing line names the same venue the opening line did.
    expect(completed[0]!.payload.location).toBe(openedLocation);
    // …and a new session opened right after it.
    expect(kinds().indexOf('PLAYER_COMPLETED_HUNT')).toBeLessThan(
      kinds().indexOf('PLAYER_STARTED_HUNT'),
    );
  });

  it('narrates the hunt outcome (encounter or find) alongside the session line', async () => {
    await handleHunt(ctx, fakeInteraction(), prov);
    const outcomes = harness.events.filter((e) =>
      [
        'PLAYER_ENCOUNTER',
        'PLAYER_FOUND_ITEM',
        'PLAYER_FOUND_WAIFUBUX',
        'PLAYER_FOUND_ESSENCE',
      ].includes(e.kind),
    );
    // A flavor roll produces no outcome event; every other roll produces one.
    expect(outcomes.length).toBeLessThanOrEqual(1);
    if (outcomes[0]?.kind === 'PLAYER_ENCOUNTER') {
      expect(outcomes[0].payload.speciesName.length).toBeGreaterThan(0);
      expect(harness.lines.some((l) => l.text.startsWith('👀 Whistler spotted'))).toBe(true);
    }
  });
});

describe('capture narration', () => {
  async function activeEncounter(speciesSlug: string): Promise<EncounterRow> {
    await t.db
      .update(encounters)
      .set({ state: 'expired', resolvedAt: new Date() })
      .where(and(eq(encounters.playerId, prov.playerId), eq(encounters.state, 'active')));
    const [row] = await t.db.select().from(species).where(eq(species.slug, speciesSlug));
    if (!row) throw new Error(`missing seeded species ${speciesSlug}`);
    const [enc] = await t.db
      .insert(encounters)
      .values({
        playerId: prov.playerId,
        speciesId: row.id,
        channelId: CHANNEL_ID,
        state: 'active',
        attemptCount: 0,
        maxAttempts: 3,
        expiresAt: new Date(Date.now() + 120_000),
      })
      .returning();
    return enc!;
  }

  async function anySpeciesSlug(rarityIsSrPlus: boolean): Promise<string> {
    const rows = await t.db.select().from(species).where(eq(species.enabled, true));
    const srPlus = new Set(['SR', 'SSR', 'UR', 'LR', 'EX']);
    const match = rows.find((r) => srPlus.has(r.rarity) === rarityIsSrPlus);
    if (!match) throw new Error(`no seeded species with srPlus=${rarityIsSrPlus}`);
    return match.slug;
  }

  async function grant(slug: string, qty: number): Promise<void> {
    const item = await getItemBySlug(t.db, slug);
    await app.inventory.addItem(t.db, prov.playerId, item.id, qty);
  }

  beforeEach(async () => {
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, prov.playerId));
    await resetPlayer();
  });

  it('emits PLAYER_CAPTURE_SUCCESS with rarity and narrates below-SR catches', async () => {
    const slug = await anySpeciesSlug(false);
    const enc = await activeEncounter(slug);
    await grant('mythic_contract', 1);

    await handleEncounterCharm(
      ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeCharmButton() as any,
      prov,
      [String(enc.id), 'mythic_contract'],
    );

    const payload = payloadOf('PLAYER_CAPTURE_SUCCESS');
    expect(payload.rarity).toBeTruthy();
    expect(payload.waifuId).not.toBeNull();
    expect(harness.lines.some((l) => l.text.includes('added') && l.text.includes('collection'))).toBe(
      true,
    );
  });

  it('suppresses the narration for an SR+ catch — the rich embed owns that', async () => {
    const slug = await anySpeciesSlug(true);
    const enc = await activeEncounter(slug);
    await grant('mythic_contract', 1);

    await handleEncounterCharm(
      ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeCharmButton() as any,
      prov,
      [String(enc.id), 'mythic_contract'],
    );

    const success = harness.ofKind('PLAYER_CAPTURE_SUCCESS');
    expect(success).toHaveLength(1);
    expect(success[0]!.visibility).toBe('major');
    expect(harness.lines.some((l) => l.text.includes('added'))).toBe(false);
  });

  it('emits PLAYER_CAPTURE_FAILED only when the encounter actually ends', async () => {
    const slug = await anySpeciesSlug(false);
    const enc = await activeEncounter(slug);
    await grant('basic_charm', 5);
    const args = [String(enc.id), 'basic_charm'];

    // Attempts 1 and 2 fail but leave the encounter open — no feed line.
    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handleEncounterCharm(ctx, fakeCharmButton() as any, prov, args);
    }
    expect(harness.ofKind('PLAYER_CAPTURE_FAILED')).toHaveLength(0);

    // The third exhausts the attempts and she's gone for good.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEncounterCharm(ctx, fakeCharmButton() as any, prov, args);
    const failed = harness.ofKind('PLAYER_CAPTURE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload.attempts).toBe(3);
    expect(harness.lines.some((l) => l.text.includes('slipped away from Whistler'))).toBe(true);
  });
});

describe('Care Mode narration', () => {
  let waifuId: number;

  beforeEach(async () => {
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
    const [row] = await t.db.select().from(species).where(eq(species.enabled, true)).limit(1);
    const [waifu] = await t.db
      .insert(playerWaifus)
      .values({ playerId: prov.playerId, speciesId: row!.id, level: 1, xp: 0, affection: 0 })
      .returning();
    waifuId = waifu!.id;
    await t.db
      .update(players)
      .set({ buddyWaifuId: waifuId })
      .where(eq(players.id, prov.playerId));
    await resetPlayer();
  });

  it('emits PLAYER_ENTERED_CARE and narrates it', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);

    const entered = harness.ofKind('PLAYER_ENTERED_CARE');
    expect(entered).toHaveLength(1);
    expect(entered[0]!.payload.waifuId).toBe(waifuId);
    expect(harness.lines.some((l) => l.text.startsWith('❤️ Whistler is spending time with'))).toBe(
      true,
    );
  });

  it('closes an open hunt session when Care Mode starts', async () => {
    await handleHunt(ctx, fakeInteraction(), prov);
    expect(harness.huntSessions.isOpen(prov.playerId)).toBe(true);
    harness.reset();

    await handleCareStart(ctx, fakeInteraction(), prov);

    const completed = harness.ofKind('PLAYER_COMPLETED_HUNT');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.reason).toBe('care_mode');
    expect(harness.huntSessions.isOpen(prov.playerId)).toBe(false);
    // …and the completion is narrated before the care line.
    expect(kinds().indexOf('PLAYER_COMPLETED_HUNT')).toBeLessThan(
      kinds().indexOf('PLAYER_ENTERED_CARE'),
    );
  });

  it('emits PLAYER_LEFT_CARE on a voluntary leave, and nothing when not caring', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    harness.reset();

    await handleCareLeave(ctx, fakeInteraction(), prov);
    expect(harness.ofKind('PLAYER_LEFT_CARE')).toHaveLength(1);
    expect(harness.ofKind('PLAYER_LEFT_CARE')[0]!.payload.reason).toBe('manual');

    harness.reset();
    await handleCareLeave(ctx, fakeInteraction(), prov);
    expect(harness.ofKind('PLAYER_LEFT_CARE')).toHaveLength(0);
  });

  it('emits PLAYER_LEFT_CARE when a hunt ends Care Mode', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    harness.reset();

    await handleHunt(ctx, fakeInteraction(), prov);

    const left = harness.ofKind('PLAYER_LEFT_CARE');
    expect(left).toHaveLength(1);
    expect(left[0]!.payload.reason).toBe('hunt');
    // Leaving care precedes the new hunt session opening.
    expect(kinds().indexOf('PLAYER_LEFT_CARE')).toBeLessThan(kinds().indexOf('PLAYER_STARTED_HUNT'));
  });

  it('emits the internal CARE_TICK_APPLIED (never narrated) when ticks are credited', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    harness.reset();
    // Backdate the last tick so a menu paint credits exactly one interval.
    const interval = app.content.tables.energy.careMode.intervalMinutes;
    await t.db
      .update(players)
      .set({ careModeLastTickAt: new Date(Date.now() - interval * 60_000 - 1000) })
      .where(eq(players.id, prov.playerId));

    await handleMenu(ctx, fakeInteraction(), prov);

    const ticks = harness.ofKind('CARE_TICK_APPLIED');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.scope).toBe('internal');
    expect(ticks[0]!.payload.ticksProcessed).toBeGreaterThan(0);
    expect(harness.lines).toHaveLength(0);
  });
});

describe('subscriber isolation at the coordinator', () => {
  beforeEach(resetPlayer);

  it('a throwing subscriber does not fail the hunt or block the feed', async () => {
    const exploding = (): never => {
      throw new Error('subscriber exploded');
    };
    harness.bus.subscribe(exploding);
    try {
      const before = await app.currency.getBalances(prov.playerId);
      await expect(handleHunt(ctx, fakeInteraction(), prov)).resolves.toBeUndefined();
      const after = await app.currency.getBalances(prov.playerId);
      // Energy was spent, so the gameplay transaction committed normally.
      expect(after.huntEnergy).toBe(before.huntEnergy - 1);
      // …and the healthy subscriber still narrated.
      expect(harness.lines.length).toBeGreaterThan(0);
    } finally {
      harness.bus.unsubscribe(exploding);
    }
  });
});
