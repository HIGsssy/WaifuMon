/**
 * `createWildEncounter` and the `trigger_waifumon_encounter` bridge — real
 * Postgres, real transactions, real indexes.
 *
 * The properties that need a database to be worth anything:
 *
 *   - idempotency is enforced by `encounters_origin_uq`, not by a read-then-
 *     write check, so a replayed spawn cannot slip through a race;
 *   - the one-active-encounter rule is `encounters_active_player_uq`, the same
 *     index a hunt races on;
 *   - a spawn joined to a World Encounter resolution commits or rolls back
 *     with it;
 *   - the spawned row is an ordinary `encounters` row that the existing hunt
 *     and capture services accept without knowing where it came from.
 *
 * Requires Docker/testcontainers (or `TEST_DATABASE_URL`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  encounters,
  playerCurrencies,
  species,
  worldEncounters,
} from '../../src/db/schema';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;
/** A slug that exists in the shipped species table, resolved once. */
let knownSpeciesSlug: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-wild', 'u-wild'));
  const [sp] = await t.db.select().from(species).where(eq(species.enabled, true)).limit(1);
  if (!sp) throw new Error('no enabled species seeded');
  knownSpeciesSlug = sp.slug;
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 5000, essence: 1000, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

function spawnOpts(overrides: Record<string, unknown> = {}) {
  return {
    playerId,
    channelId: 'c-1',
    regionId: 'waifu-valley',
    playerLevel: 10,
    origin: { kind: 'quest' as const, ref: 'quest-1' },
    ...overrides,
  };
}

describe('createWildEncounter: the happy path', () => {
  it('writes one active encounter for the named species', async () => {
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );

    expect(spawn.status).toBe('created');
    if (spawn.status !== 'created') return;
    expect(spawn.species.slug).toBe(knownSpeciesSlug);
    expect(spawn.encounter.state).toBe('active');
    expect(spawn.encounter.originKind).toBe('quest');
    expect(spawn.encounter.originRef).toBe('quest-1');
  });

  it('produces a row the ordinary hunt service recognises as the active encounter', async () => {
    // This is what "playable" means: nothing downstream needs to know the
    // encounter was spawned rather than hunted.
    await app.wildEncounters.createWildEncounter(spawnOpts({ speciesSlug: knownSpeciesSlug }));
    const active = await app.hunt.getActiveEncounterDetail(playerId);

    expect(active).not.toBeNull();
    expect(active!.species.slug).toBe(knownSpeciesSlug);
  });

  it('offers capture items for the spawned encounter through the capture service', async () => {
    // The capture path is shared wholesale — no spawn-specific capture math.
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );
    if (spawn.status !== 'created') throw new Error('expected a spawn');
    await expect(
      app.capture.listEncounterItems(playerId, spawn.encounter.id),
    ).resolves.toBeInstanceOf(Array);
  });

  it('picks a species from the hunt pools when none is named', async () => {
    const spawn = await app.wildEncounters.createWildEncounter(spawnOpts());
    expect(spawn.status).toBe('created');
    if (spawn.status !== 'created') return;
    expect(spawn.species.enabled).toBe(true);
  });
});

describe('createWildEncounter: idempotency', () => {
  it('returns the original encounter for a replayed (kind, ref)', async () => {
    const first = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );
    const second = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );

    expect(first.status).toBe('created');
    expect(second.status).toBe('existing');
    if (first.status !== 'created' || second.status !== 'existing') return;
    expect(second.encounter.id).toBe(first.encounter.id);

    const rows = await t.db.select().from(encounters).where(eq(encounters.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('survives two concurrent spawns of the same origin without duplicating', async () => {
    // The unique index, not the read-then-write check, is what decides this.
    const results = await Promise.allSettled([
      app.wildEncounters.createWildEncounter(spawnOpts({ speciesSlug: knownSpeciesSlug })),
      app.wildEncounters.createWildEncounter(spawnOpts({ speciesSlug: knownSpeciesSlug })),
    ]);
    const settled = results.filter((r) => r.status === 'fulfilled');
    expect(settled.length).toBeGreaterThanOrEqual(1);

    const rows = await t.db.select().from(encounters).where(eq(encounters.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('treats a different ref as a genuinely different spawn', async () => {
    await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'quest', ref: 'quest-1' } }),
    );
    // The player is still mid-encounter, so the second spawn is *blocked*
    // rather than deduplicated — which is the correct distinction.
    const second = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'quest', ref: 'quest-2' } }),
    );
    expect(second.status).toBe('blocked');
  });
});

describe('createWildEncounter: refusals', () => {
  it('is blocked while the player is already in an encounter', async () => {
    await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'quest', ref: 'a' } }),
    );
    const blocked = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'event', ref: 'b' } }),
    );
    expect(blocked.status).toBe('blocked');
    if (blocked.status !== 'blocked') return;
    expect(blocked.reason).toBe('active_encounter');
  });

  it('spawns over an encounter that has already expired', async () => {
    const first = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'quest', ref: 'a' } }),
    );
    if (first.status !== 'created') throw new Error('expected a spawn');
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(encounters.id, first.encounter.id));

    const second = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'event', ref: 'b' } }),
    );
    expect(second.status).toBe('created');
  });

  it('refuses an unknown species slug', async () => {
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: 'definitely_not_a_species' }),
    );
    expect(spawn.status).toBe('unavailable');
    if (spawn.status !== 'unavailable') return;
    expect(spawn.reason).toBe('unknown_species');
  });

  it('refuses a disabled species', async () => {
    const [disabled] = await t.db
      .update(species)
      .set({ enabled: false })
      .where(eq(species.slug, knownSpeciesSlug))
      .returning();
    try {
      const spawn = await app.wildEncounters.createWildEncounter(
        spawnOpts({ speciesSlug: knownSpeciesSlug }),
      );
      expect(spawn.status).toBe('unavailable');
    } finally {
      await t.db
        .update(species)
        .set({ enabled: true })
        .where(eq(species.id, disabled!.id));
    }
  });
});

describe('createWildEncounter: Hunt Energy', () => {
  it('costs nothing by default', async () => {
    const before = await app.currency.getBalances(playerId);
    await app.wildEncounters.createWildEncounter(spawnOpts({ speciesSlug: knownSpeciesSlug }));
    const after = await app.currency.getBalances(playerId);
    expect(after.huntEnergy).toBe(before.huntEnergy);
  });

  it('spends one Energy only when the caller asks it to', async () => {
    const before = await app.currency.getBalances(playerId);
    await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, consumeHuntEnergy: true }),
    );
    const after = await app.currency.getBalances(playerId);
    expect(after.huntEnergy).toBe(before.huntEnergy - 1);
  });

  it('refuses rather than going negative when Energy is exhausted', async () => {
    await t.db
      .update(playerCurrencies)
      .set({ huntEnergy: 0 })
      .where(eq(playerCurrencies.playerId, playerId));
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, consumeHuntEnergy: true }),
    );
    expect(spawn.status).toBe('unavailable');
    if (spawn.status !== 'unavailable') return;
    expect(spawn.reason).toBe('insufficient_energy');
    const rows = await t.db.select().from(encounters).where(eq(encounters.playerId, playerId));
    expect(rows).toHaveLength(0);
  });
});

describe('getPlayerEncounter: ownership scoping', () => {
  it('returns the encounter to its owner', async () => {
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );
    if (spawn.status !== 'created') throw new Error('expected a spawn');
    const found = await app.wildEncounters.getPlayerEncounter(playerId, spawn.encounter.id);
    expect(found?.species.slug).toBe(knownSpeciesSlug);
  });

  it('hides it from anyone else', async () => {
    const other = await provisionPlayer(app, 'g-wild', 'u-wild-2');
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );
    if (spawn.status !== 'created') throw new Error('expected a spawn');
    await expect(
      app.wildEncounters.getPlayerEncounter(other.playerId, spawn.encounter.id),
    ).resolves.toBeNull();
  });

  it('hides an expired encounter from its own owner', async () => {
    const spawn = await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug }),
    );
    if (spawn.status !== 'created') throw new Error('expected a spawn');
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(encounters.id, spawn.encounter.id));
    await expect(
      app.wildEncounters.getPlayerEncounter(playerId, spawn.encounter.id),
    ).resolves.toBeNull();
  });
});

/* ───────────── trigger_waifumon_encounter, end to end ───────────── */

/**
 * A purpose-built encounter rather than a shipped one.
 *
 * The seeded `wv_lost_cub` choice that carries the effect also requires a
 * caregiver buddy, which would make this test about buddy provisioning. What
 * is under test is the bridge, so the fixture states exactly the two things
 * that matter: an auto-succeeding check and the wild-Waifumon effect.
 */
const BRIDGE_SLUG = 'test_wild_bridge';

async function seedBridgeEncounter(speciesSlug: string | null): Promise<void> {
  await app.worldEncounterAdmin.upsert({
    slug: BRIDGE_SLUG,
    name: 'Bridge Test',
    description: 'A rustle in the undergrowth.',
    type: 'discovery',
    rarity: 'common',
    weight: 1,
    lifecycle: 'active',
    // Hunt-eligible because the validator is right to refuse an encounter
    // nothing can reach: this one is not a chain target, so with both source
    // flags off it would be dead content. The tests below insert the active
    // row directly, so eligibility does not affect what is under test.
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    metadata: {},
    choices: [
      {
        label: 'Look closer',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [
          speciesSlug
            ? { type: 'trigger_waifumon_encounter', speciesSlug }
            : { type: 'trigger_waifumon_encounter' },
        ],
        failureEffects: [],
      },
    ],
  });
}

async function insertActiveFor(slug: string): Promise<number> {
  const [encounter] = await t.db
    .select()
    .from(worldEncounters)
    .where(eq(worldEncounters.slug, slug));
  if (!encounter) throw new Error(`unknown encounter slug ${slug}`);
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: encounter.id,
      source: 'hunt',
      regionId: 'waifu-valley',
      guildId: guildDbId,
      channelId: 'c-1',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

describe('trigger_waifumon_encounter: the World Encounter bridge', () => {
  async function presentBridge(): Promise<{ activeId: number; choiceId: number }> {
    const activeId = await insertActiveFor(BRIDGE_SLUG);
    const pending = await app.worldEncounter.getActivationById(activeId, playerId);
    if (!pending) throw new Error('no pending activation');
    const choice = pending.encounter.choices[0];
    if (!choice) throw new Error('bridge encounter has no choices');
    return { activeId, choiceId: choice.id };
  }

  it('spawns a real capturable encounter, not a marker', async () => {
    await seedBridgeEncounter(knownSpeciesSlug);
    const { activeId, choiceId } = await presentBridge();
    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(resolution.check.success).toBe(true);
    expect(resolution.wildEncounter?.status).toBe('created');
    expect(resolution.wildEncounter?.speciesSlug).toBe(knownSpeciesSlug);

    // The bridge's whole point: the ordinary hunt service now sees it.
    const active = await app.hunt.getActiveEncounterDetail(playerId);
    expect(active?.encounter.id).toBe(resolution.wildEncounter!.encounterId);
    expect(active?.encounter.originKind).toBe('world_encounter');
    expect(active?.encounter.originRef).toBe(String(activeId));
    expect(active?.species.slug).toBe(knownSpeciesSlug);
  });

  it('falls back to the hunt species draw when the author named none', async () => {
    await seedBridgeEncounter(null);
    const { activeId, choiceId } = await presentBridge();
    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(resolution.wildEncounter?.status).toBe('created');
    expect(resolution.wildEncounter?.speciesSlug).toBeTruthy();
  });

  it('spends no Hunt Energy', async () => {
    await seedBridgeEncounter(knownSpeciesSlug);
    const before = await app.currency.getBalances(playerId);
    const { activeId, choiceId } = await presentBridge();
    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const after = await app.currency.getBalances(playerId);
    expect(after.huntEnergy).toBe(before.huntEnergy);
  });

  it('cannot be double-resolved into two Waifumon', async () => {
    await seedBridgeEncounter(knownSpeciesSlug);
    const { activeId, choiceId } = await presentBridge();
    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    // The parent row is already `resolved`, so the replay is refused before
    // any effect — including the spawn — can run a second time.
    await expect(
      app.worldEncounter.resolveChoice({ activeId, playerId, choiceId }),
    ).rejects.toBeTruthy();

    const rows = await t.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.playerId, playerId), eq(encounters.originKind, 'world_encounter')));
    expect(rows).toHaveLength(1);
  });

  it('reports `blocked` rather than silently dropping the reward mid-encounter', async () => {
    await seedBridgeEncounter(knownSpeciesSlug);
    await app.wildEncounters.createWildEncounter(
      spawnOpts({ speciesSlug: knownSpeciesSlug, origin: { kind: 'admin', ref: 'pre-existing' } }),
    );
    const { activeId, choiceId } = await presentBridge();
    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(resolution.wildEncounter?.status).toBe('blocked');
    expect(resolution.wildEncounter?.encounterId).toBeNull();
    expect(resolution.wildEncounter?.blockedByEncounterId).not.toBeNull();
  });
});
