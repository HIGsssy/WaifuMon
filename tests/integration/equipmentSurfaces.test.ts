/**
 * The active loadout on the surfaces that *mention* Equipment — the Equipment
 * home, Buddy inspect, the Player Profile and the Care Mode Trainer Profile —
 * against a real database and the real handlers.
 *
 * The headline case is consistency: one player state, four surfaces, one set
 * of numbers, all equal to what `combatStatsService` returns. The rest pin the
 * edges: gear only on the active Buddy's inspect card, nothing for a locked
 * player, `—` for an empty slot, no internal metadata in what is shown, and
 * fresh state on every paint.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { players, species as speciesTable } from '../../src/db/schema';
import { handleProfile } from '../../src/discord/commands/waifumon';
import { handleCollectionPickId, handleInspectBuddy } from '../../src/discord/commands/waifumonCollection';
import { handleEquipmentHome } from '../../src/discord/commands/waifumonEquipment';
import { createTrainerProfileService, type ProfileChannel, type TrainerProfileService } from '../../src/discord/trainerProfile';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  createEquipmentManagementService,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { ASSETS_DIR, bootstrapApp, createEventHarness, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { fixedRange, buildEquipmentServices, grant, unlockEquipment, type EquipmentServices } from '../helpers/equipmentFixtures';

const CHANNEL_ID = 'c-eq-surfaces';

/** At Current SP 420: ATK 336, DEF 231, HP 1344. */
const COIL = { key: 'surface_coil', name: 'Plasma Coil Ring', slot: 'attack', rarity: 'SR', ...fixedRange(8_000) } as const;
const BELT = { key: 'surface_belt', name: 'Reinforced Battle Belt', slot: 'defense', rarity: 'R', ...fixedRange(5_500) } as const;
const CORSET = { key: 'surface_corset', name: 'Tactical Corset', slot: 'health', rarity: 'R', ...fixedRange(32_000) } as const;
/** At Current SP 420: ATK 189. */
const PIPE = { key: 'surface_pipe', name: 'Rusty Surface Pipe', slot: 'attack', rarity: 'N', ...fixedRange(4_500) } as const;

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let mgmt: EquipmentManagementService;
let ctx: AppContext;
let profile: TrainerProfileService;
let speciesId: number;
const channel = {
  id: CHANNEL_ID,
  send: vi.fn(async (_payload: unknown) => ({ id: `m-${Math.random()}` })),
  messages: { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
};

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  const harness = createEventHarness(app, t.logger);
  svc = buildEquipmentServices(t.db);
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  mgmt = createEquipmentManagementService({ equipment: svc.equipment, combatStats: combat, featureUnlocks: svc.featureUnlocks });
  for (const g of [COIL, BELT, CORSET, PIPE]) await svc.definitions.create(g);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.slug, 'alley_catgirl'));
  speciesId = row!.id;
  ctx = {
    config: { assetsDir: ASSETS_DIR, contentDir: process.cwd(), dailyTimezone: 'UTC' },
    logger: t.logger,
    db: t.db,
    content: app.content,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    services: {
      guilds: app.guilds,
      travel: app.travel,
      players: app.players,
      currency: app.currency,
      collection: app.collection,
      availability: app.availability,
      appearance: app.appearance,
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      gifts: app.gifts,
      session: app.session,
      equipmentManagement: mgmt,
    },
  } as unknown as AppContext;
  profile = createTrainerProfileService({
    logger: t.logger,
    services: ctx.services,
    resolveChannel: async () => channel as unknown as ProfileChannel,
  });
});

afterAll(async () => {
  await t?.cleanup();
});

// ── fixtures ──────────────────────────────────────────────────────────────

let seq = 0;

/** A player whose Buddy has Current SP 420, optionally unlocked and fully equipped. */
async function setup(opts: { unlocked?: boolean; equip?: boolean; buddy?: boolean } = {}) {
  seq += 1;
  const prov = await provisionPlayer(app, `g-eqs-${seq}`, `u-eqs-${seq}`);
  const playerId = prov.playerId;
  let buddyId: number | null = null;
  if (opts.buddy !== false) {
    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 420, nickname: 'Warband Princess' });
    await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
    buddyId = buddy.id;
  }
  const ids: Record<string, number> = {};
  if (opts.unlocked !== false) {
    await unlockEquipment(t.db, svc, playerId);
    ids.coil = await grant(t.db, svc, playerId, COIL.key);
    ids.belt = await grant(t.db, svc, playerId, BELT.key);
    ids.corset = await grant(t.db, svc, playerId, CORSET.key);
    ids.pipe = await grant(t.db, svc, playerId, PIPE.key);
    if (opts.equip !== false) {
      await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ids.coil });
      await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: ids.belt });
      await svc.equipment.equip(playerId, { slot: 'health', equipmentId: ids.corset });
    }
  }
  return { prov: prov as Provisioned, playerId, buddyId, ids };
}

type Painted = { content?: string; embeds?: { toJSON(): unknown }[]; files?: unknown[] };

function button() {
  const painted: Painted[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as Painted);
  });
  const i = {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    update: paint,
    reply: paint,
    editReply: paint,
    followUp: paint,
    deferUpdate: vi.fn(async () => {}),
    channelId: CHANNEL_ID,
    user: { id: 'u', displayName: 'Hunter' },
    member: { displayName: 'Hunter' },
  };
  return { i: i as unknown as PlayerInteraction, painted };
}

type EmbedJson = { fields?: { name: string; value: string }[]; thumbnail?: { url: string }; image?: { url: string } };
const embedOf = (p: Painted): EmbedJson => (p.embeds?.[0]?.toJSON() ?? {}) as EmbedJson;
const field = (p: Painted, name: string) => embedOf(p).fields?.find((f) => f.name === name)?.value;

async function equipmentHome(c: Awaited<ReturnType<typeof setup>>) {
  const { i, painted } = button();
  await handleEquipmentHome(ctx, i as never, c.prov);
  return painted.at(-1)!;
}
async function inspect(c: Awaited<ReturnType<typeof setup>>, waifuId?: number) {
  const { i, painted } = button();
  if (waifuId === undefined) await handleInspectBuddy(ctx, i, c.prov);
  else await handleCollectionPickId(ctx, i as never, c.prov, [String(waifuId)]);
  return painted.at(-1)!;
}
async function playerProfile(c: Awaited<ReturnType<typeof setup>>) {
  const { i, painted } = button();
  await handleProfile(ctx, i, c.prov);
  return painted.at(-1)!;
}
async function trainerProfile(c: Awaited<ReturnType<typeof setup>>) {
  channel.send.mockClear();
  await profile.create({
    kind: 'PLAYER_ENTERED_CARE',
    playerId: c.playerId,
    guildDbId: c.prov.guildDbId,
    channelId: CHANNEL_ID,
    playerName: 'Hunter',
  } as never);
  expect(channel.send).toHaveBeenCalledTimes(1);
  return channel.send.mock.calls[0]![0] as Painted;
}

/** Every number each surface shows, parsed back out of what it painted. */
function numbers(text: string): { atk: string; def: string; hp: string } {
  const grab = (label: string) => text.match(new RegExp(`${label}\\s+\\**([0-9]+|—)`))?.[1] ?? 'missing';
  return { atk: grab('ATK'), def: grab('DEF'), hp: grab('HP') };
}

// ── consistency ───────────────────────────────────────────────────────────

describe('one player state, four surfaces', () => {
  it('every surface shows exactly the combat-stat service’s numbers', async () => {
    const c = await setup();
    const authoritative = await combat.calculateCombatStats(c.playerId);
    expect(authoritative.stats).toEqual({ attack: 336, defense: 231, maxHp: 1344 });
    const expected = { atk: '336', def: '231', hp: '1344' };

    const home = field(await equipmentHome(c), 'Combat Stats')!;
    const inspected = field(await inspect(c), '⚔️ Combat Stats')!;
    const prof = field(await playerProfile(c), '⚔️ Equipment')!;
    await app.care.start(c.playerId);
    const card = field(await trainerProfile(c), '⚔️ Equipment')!;

    for (const [surface, text] of Object.entries({ home, inspected, prof, card })) {
      expect(numbers(text), surface).toEqual(expected);
    }
    await app.care.leave(c.playerId);
  });

  it('a gear change is on every surface’s next paint, and nothing is cached', async () => {
    const c = await setup();
    await app.care.start(c.playerId);
    expect(numbers(field(await trainerProfile(c), '⚔️ Equipment')!).atk).toBe('336');

    await svc.equipment.equip(c.playerId, { slot: 'attack', equipmentId: c.ids.pipe! });
    expect((await combat.calculateCombatStats(c.playerId)).stats.attack).toBe(189);

    const card = field(await trainerProfile(c), '⚔️ Equipment')!;
    expect(card).toContain('Rusty Surface Pipe');
    expect(card).not.toContain('Plasma Coil Ring');
    expect(numbers(card).atk).toBe('189');
    expect(numbers(field(await equipmentHome(c), 'Combat Stats')!).atk).toBe('189');
    expect(numbers(field(await inspect(c), '⚔️ Combat Stats')!).atk).toBe('189');
    expect(numbers(field(await playerProfile(c), '⚔️ Equipment')!).atk).toBe('189');
    await app.care.leave(c.playerId);
  });
});

// ── Equipment home ────────────────────────────────────────────────────────

describe('Equipment home artwork', () => {
  it('shows the active Buddy’s worn artwork as a thumbnail', async () => {
    const c = await setup();
    const home = await equipmentHome(c);
    const thumb = embedOf(home).thumbnail?.url;
    expect(thumb).toMatch(/^attachment:\/\/card\.(webp|png)$/);
    expect(home.files).toHaveLength(1);
    expect(embedOf(home).image).toBeUndefined();
  });

  it('follows a Buddy change on the very next paint — never the old picture', async () => {
    const c = await setup();
    const pathOf = (p: Painted) => String((p.files?.[0] as { attachment: unknown }).attachment);
    expect(pathOf(await equipmentHome(c))).toMatch(/standard\.webp$/);
    // Her look is unlock-gated by level, so the new Buddy is level 20.
    const next = await insertOwnedWaifu(t.db, { playerId: c.playerId, speciesId, level: 20, baseSp: 100, variant: 'level_20' });
    await app.collection.setBuddy(c.playerId, next.id);
    const home = await equipmentHome(c);
    expect(pathOf(home)).toMatch(/level_20\.webp$/);
    expect(home.files).toHaveLength(1);
    expect(field(home, 'Buddy')).toContain('Lv. 20');
  });

  it('shows no picture and no attachment without a Buddy', async () => {
    const c = await setup({ buddy: false });
    const home = await equipmentHome(c);
    expect(embedOf(home).thumbnail).toBeUndefined();
    expect(home.files ?? []).toHaveLength(0);
  });
});

// ── Buddy inspect ─────────────────────────────────────────────────────────

describe('Buddy inspect', () => {
  it('shows combat stats and gear names on the active Buddy', async () => {
    const c = await setup();
    const card = await inspect(c);
    expect(field(card, '⚔️ Combat Stats')).toBe('ATK 336\nDEF 231\nHP 1344');
    expect(field(card, '🎒 Equipment')).toBe(
      'Attack: Plasma Coil Ring\nDefense: Reinforced Battle Belt\nHealth: Tactical Corset',
    );
  });

  it('never puts the Buddy’s stats on another owned Waifumon', async () => {
    const c = await setup();
    const other = await insertOwnedWaifu(t.db, { playerId: c.playerId, speciesId, level: 1, baseSp: 999 });
    const card = await inspect(c, other.id);
    expect(field(card, '⚔️ Combat Stats')).toBeUndefined();
    expect(field(card, '🎒 Equipment')).toBeUndefined();
  });

  it('follows a Buddy change: the new Buddy gets stats from her own SP, the old one none', async () => {
    const c = await setup();
    const other = await insertOwnedWaifu(t.db, { playerId: c.playerId, speciesId, level: 1, baseSp: 100 });
    await app.collection.setBuddy(c.playerId, other.id);
    expect(field(await inspect(c, other.id), '⚔️ Combat Stats')).toBe('ATK 80\nDEF 55\nHP 320');
    expect(field(await inspect(c, c.buddyId!), '⚔️ Combat Stats')).toBeUndefined();
  });

  it('shows an empty slot as unavailable, not zero', async () => {
    const c = await setup();
    await svc.equipment.unequip(c.playerId, { slot: 'defense' });
    const card = await inspect(c);
    expect(field(card, '⚔️ Combat Stats')).toBe('ATK 336\nDEF —\nHP 1344');
    expect(field(card, '🎒 Equipment')).toContain('Defense: —');
  });

  it('shows no Equipment section for a locked player', async () => {
    const c = await setup({ unlocked: false });
    const card = await inspect(c);
    expect(field(card, '⚔️ Combat Stats')).toBeUndefined();
    expect(field(card, '🎒 Equipment')).toBeUndefined();
  });
});

// ── Player Profile ────────────────────────────────────────────────────────

describe('Player Profile', () => {
  it('lists the equipped gear and the Buddy’s stats', async () => {
    const c = await setup();
    expect(field(await playerProfile(c), '⚔️ Equipment')).toBe(
      '⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset\nATK 336 · DEF 231 · HP 1344',
    );
  });

  it('renders missing slots cleanly', async () => {
    const c = await setup({ equip: false });
    await svc.equipment.equip(c.playerId, { slot: 'health', equipmentId: c.ids.corset! });
    expect(field(await playerProfile(c), '⚔️ Equipment')).toBe('⚔️ —\n🛡️ —\n❤️ Tactical Corset\nATK — · DEF — · HP 1344');
  });

  it('lists gear without stats when there is no Buddy', async () => {
    const c = await setup({ buddy: false });
    expect(field(await playerProfile(c), '⚔️ Equipment')).toBe('⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset');
  });

  it('is unchanged for a locked player', async () => {
    const c = await setup({ unlocked: false });
    expect(field(await playerProfile(c), '⚔️ Equipment')).toBeUndefined();
  });

  it('exposes no instance ids, keys, flags or grant sources', async () => {
    const c = await setup();
    await svc.equipment.setFlags(c.playerId, c.ids.coil!, { isFavorite: true, isLocked: true });
    for (const painted of [await playerProfile(c), await trainerProfile(c)]) {
      const json = JSON.stringify(painted.embeds?.map((e) => e.toJSON()));
      // Keys, flags, grant source, acquisition and multipliers (as × or raw bp).
      const leaks = [COIL.key, BELT.key, CORSET.key, 'admin', 'source', 'Favourite', 'favorite', '🔒', 'locked', '×', '8000', '5500', '32000', 'multiplier'];
      for (const leak of leaks) expect(json, leak).not.toContain(leak);
    }
  });
});

// ── Trainer Profile ───────────────────────────────────────────────────────

describe('Care Mode Trainer Profile', () => {
  it('shows the gear and the stats for the Buddy being cared for', async () => {
    const c = await setup();
    await app.care.start(c.playerId);
    expect(field(await trainerProfile(c), '⚔️ Equipment')).toBe(
      '⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset\nATK 336 · DEF 231 · HP 1344',
    );
    await app.care.leave(c.playerId);
  });

  it('names the Buddy when caring for a different Waifumon', async () => {
    const c = await setup();
    const other = await insertOwnedWaifu(t.db, { playerId: c.playerId, speciesId, level: 1, baseSp: 999, nickname: 'Other' });
    await app.care.start(c.playerId, other.id);
    const card = await trainerProfile(c);
    const value = field(card, '⚔️ Equipment')!;
    expect(value.split('\n').slice(-2)).toEqual([
      'Stats for active Buddy **Warband Princess**:',
      'ATK 336 · DEF 231 · HP 1344',
    ]);
    // The care target's panel carries no combat stats of its own.
    expect(field(card, '⭐ Buddy')).toContain('Other');
    expect(field(card, '⭐ Buddy')).not.toMatch(/ATK|DEF|HP \d/);
    await app.care.leave(c.playerId);
  });

  it('omits only the panel when the Equipment read fails', async () => {
    const c = await setup();
    const failing = createTrainerProfileService({
      logger: t.logger,
      services: {
        ...ctx.services,
        equipmentManagement: { ...mgmt, summary: vi.fn(async () => { throw new Error('db down'); }) },
      },
      resolveChannel: async () => channel as unknown as ProfileChannel,
    });
    channel.send.mockClear();
    await failing.create({ kind: 'PLAYER_ENTERED_CARE', playerId: c.playerId, guildDbId: c.prov.guildDbId, channelId: CHANNEL_ID, playerName: 'Hunter' } as never);
    expect(channel.send).toHaveBeenCalledTimes(1);
    const card = channel.send.mock.calls[0]![0] as Painted;
    expect(field(card, '⚔️ Equipment')).toBeUndefined();
    expect(field(card, '👤 Trainer')).toBeDefined();
    expect(field(card, '🎒 Collection')).toBeDefined();
  });

  it('renders without a Buddy, and without the panel when locked', async () => {
    const noBuddy = await setup({ buddy: false });
    expect(field(await trainerProfile(noBuddy), '⚔️ Equipment')).toBe(
      '⚔️ Plasma Coil Ring\n🛡️ Reinforced Battle Belt\n❤️ Tactical Corset',
    );
    const locked = await setup({ unlocked: false });
    const card = await trainerProfile(locked);
    expect(field(card, '⚔️ Equipment')).toBeUndefined();
    expect(field(card, '🎒 Collection')).toBeDefined();
  });
});
