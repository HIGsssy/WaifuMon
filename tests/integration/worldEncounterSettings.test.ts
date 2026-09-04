/**
 * Settings persist, and the engine reads them — against real Postgres.
 *
 * The claim worth proving with a database is the one the whole feature rests
 * on: a value saved from Portal Admin is the value the next hunt uses. Doubles
 * cannot show that, because the seam being tested is precisely the one they
 * would replace.
 *
 * The fixture wires the settings service exactly as `src/index.ts` does —
 * `getConfig: () => settings.get()` — with a zero cache TTL so a write is
 * visible on the next read without waiting out production's window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activeWorldEncounters, worldEncounterSettings } from '../../src/db/schema';
import { WORLD_ENCOUNTER_SETTINGS_DEFAULTS } from '../../src/modules/worldEncounters/settingsService';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

/** Always loses a probability roll; only a force-trigger override gets past it. */
const alwaysLoses = { next: () => 0.999, intInclusive: (a: number) => a };
/** Always wins one. */
const alwaysWins = { next: () => 0, intInclusive: (a: number) => a };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-settings', 'u-settings'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(worldEncounterSettings);
  app.worldEncounterSettings.invalidate();
});

const HUNT = {
  playerId: 0,
  playerLevel: 10,
  guildId: 0,
  channelId: 'c-1',
  regionId: 'waifu-valley',
};
const hunt = () => ({ ...HUNT, playerId, guildId: guildDbId });

describe('settings row', () => {
  it('seeds itself with the values that shipped before the table existed', async () => {
    const settings = await app.worldEncounterSettings.get();

    expect(settings.huntChance).toBeCloseTo(WORLD_ENCOUNTER_SETTINGS_DEFAULTS.huntChance, 5);
    expect(settings.travelChance).toBeCloseTo(WORLD_ENCOUNTER_SETTINGS_DEFAULTS.travelChance, 5);
    expect(settings.defaultExpirySeconds).toBe(
      WORLD_ENCOUNTER_SETTINGS_DEFAULTS.defaultExpirySeconds,
    );
    expect(settings.forceTrigger).toBe(false);
  });

  it('persists an update and records who made it', async () => {
    await app.worldEncounterSettings.update({ huntChance: 0.5, forceTrigger: true }, 'u-admin');
    app.worldEncounterSettings.invalidate();

    const reread = await app.worldEncounterSettings.get();
    expect(reread.huntChance).toBeCloseTo(0.5, 5);
    expect(reread.forceTrigger).toBe(true);
    expect(reread.updatedBy).toBe('u-admin');
    expect(reread.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves untouched fields alone on a partial update', async () => {
    await app.worldEncounterSettings.update({ huntChance: 0.9 }, null);
    await app.worldEncounterSettings.update({ forceTrigger: true }, null);
    app.worldEncounterSettings.invalidate();

    const reread = await app.worldEncounterSettings.get();
    expect(reread.huntChance).toBeCloseTo(0.9, 5);
    expect(reread.forceTrigger).toBe(true);
    // Never set by either patch — still the shipped default.
    expect(reread.travelChance).toBeCloseTo(
      WORLD_ENCOUNTER_SETTINGS_DEFAULTS.travelChance,
      5,
    );
  });

  it('stays a singleton', async () => {
    await app.worldEncounterSettings.get();
    await app.worldEncounterSettings.update({ huntChance: 0.4 }, null);

    const rows = await t.db.select().from(worldEncounterSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
  });

  it('refuses an out-of-range value at the database, not only the API', async () => {
    await app.worldEncounterSettings.get();
    // The service and the API both validate; this is the constraint that
    // catches anything reaching the table another way.
    await expect(
      t.db
        .update(worldEncounterSettings)
        .set({ huntChance: 2 })
        .where(eq(worldEncounterSettings.id, 1)),
    ).rejects.toBeTruthy();
    await expect(
      t.db
        .update(worldEncounterSettings)
        .set({ defaultExpirySeconds: 5 })
        .where(eq(worldEncounterSettings.id, 1)),
    ).rejects.toBeTruthy();
  });
});

describe('the engine reads the persisted values', () => {
  it('does not fire when the saved hunt chance is zero', async () => {
    await app.worldEncounterSettings.update({ huntChance: 0 }, null);

    // Even an RNG that always wins cannot beat a rate of zero.
    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysWins }),
    ).resolves.toBeNull();
  });

  it('fires when the saved hunt chance is one', async () => {
    await app.worldEncounterSettings.update({ huntChance: 1 }, null);

    const activation = await app.worldEncounter.tryRollForHunt({
      ...hunt(),
      rng: alwaysWins,
    });
    expect(activation).not.toBeNull();
  });

  it('follows a change made between two hunts, with no restart', async () => {
    // The whole point of the feature: save, and the next roll behaves
    // differently. No redeploy, no content reload, no process restart.
    await app.worldEncounterSettings.update({ huntChance: 0 }, null);
    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysWins }),
    ).resolves.toBeNull();

    await app.worldEncounterSettings.update({ huntChance: 1 }, null);
    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysWins }),
    ).resolves.not.toBeNull();
  });

  it('applies the saved expiry to the encounter it creates', async () => {
    await app.worldEncounterSettings.update(
      { huntChance: 1, defaultExpirySeconds: 90 },
      null,
    );

    const before = Date.now();
    const activation = await app.worldEncounter.tryRollForHunt({
      ...hunt(),
      rng: alwaysWins,
    });
    expect(activation).not.toBeNull();

    const [row] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.id, activation!.activeId));
    const lifetimeSeconds = (row!.expiresAt.getTime() - before) / 1000;
    // 90s, give or take the round trips either side of the read.
    expect(lifetimeSeconds).toBeGreaterThan(80);
    expect(lifetimeSeconds).toBeLessThan(100);
  });
});

describe('force trigger, end to end', () => {
  it('turns a lost roll into an encounter', async () => {
    await app.worldEncounterSettings.update({ huntChance: 0.35, forceTrigger: false }, null);
    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysLoses }),
    ).resolves.toBeNull();

    await app.worldEncounterSettings.update({ forceTrigger: true }, null);
    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysLoses }),
    ).resolves.not.toBeNull();
  });

  it('does not bypass the one-pending-encounter rule', async () => {
    // The safety gate most likely to be noticed if force trigger overreached:
    // a second forced roll while one encounter is already pending.
    await app.worldEncounterSettings.update({ huntChance: 0, forceTrigger: true }, null);

    const first = await app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysLoses });
    expect(first).not.toBeNull();

    await expect(
      app.worldEncounter.tryRollForHunt({ ...hunt(), rng: alwaysLoses }),
    ).rejects.toBeTruthy();

    const rows = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('does not bypass region eligibility', async () => {
    await app.worldEncounterSettings.update({ huntChance: 0, forceTrigger: true }, null);

    // A region no shipped encounter is scoped to still produces nothing —
    // the forced roll reaches the selector and the selector declines.
    await expect(
      app.worldEncounter.tryRollForHunt({
        ...hunt(),
        regionId: 'not-a-real-region',
        rng: alwaysLoses,
      }),
    ).resolves.toBeNull();
  });
});
