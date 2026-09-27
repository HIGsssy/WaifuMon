/**
 * Startup seeding of World Encounters and vendors against a real database.
 *
 * The claim under test is ownership: the bootstrap catalogue supplies
 * *missing* content, and the database owns everything that already exists.
 * A restart runs the seed again, so every Portal edit — artwork, lifecycle,
 * outcome text, choices, regions, routes, vendor stock — has to come through
 * a second seed untouched, and so do the choice ids live Discord buttons
 * carry.
 *
 * "Untouched" is checked at the row-version level, not just by value: each
 * snapshot includes Postgres's `xmin`, which changes on any UPDATE and is new
 * for any row that was deleted and re-inserted. An equal snapshot therefore
 * means the seed issued no UPDATE or DELETE against those rows at all.
 *
 * Deliberately does not use `bootstrapApp`: its fixture seed runs in `reset`
 * mode, and these tests need to start from an empty catalogue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { worldEncounterVendors, worldEncounters } from '../../src/db/schema';
import {
  SEED_ENCOUNTERS,
  seedWorldEncounters,
} from '../../src/modules/worldEncounters/seed';
import {
  SEED_VENDORS,
  seedWorldEncounterVendors,
} from '../../src/modules/worldEncounters/vendorService';
import {
  createWorldEncounterRepository,
  type WorldEncounterRepository,
} from '../../src/modules/worldEncounters/worldEncounterRepository';
import type { EncounterInput } from '../../src/modules/worldEncounters/types';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let repo: WorldEncounterRepository;

const SEED_SLUGS = SEED_ENCOUNTERS.map((e) => e.slug).sort();

beforeAll(async () => {
  t = await createTestDb();
  repo = createWorldEncounterRepository(t.db);
});
afterAll(async () => {
  await t.cleanup();
});

/**
 * Every encounter-content row, with its row version. Equal before and after
 * means nothing was updated, deleted or re-inserted.
 */
async function snapshot() {
  const q = async (sql: string) => (await t.pool.query(sql)).rows;
  return {
    encounters: await q('SELECT xmin::text AS xmin, * FROM world_encounters ORDER BY id'),
    regions: await q(
      'SELECT xmin::text AS xmin, * FROM world_encounter_regions ORDER BY encounter_id, region_id',
    ),
    routes: await q(
      'SELECT xmin::text AS xmin, * FROM world_encounter_routes ORDER BY encounter_id, from_region, to_region',
    ),
    choices: await q('SELECT xmin::text AS xmin, * FROM world_encounter_choices ORDER BY id'),
    vendors: await q('SELECT xmin::text AS xmin, * FROM world_encounter_vendors ORDER BY id'),
  };
}

/** A production startup: both seeds, in the mode `src/index.ts` uses. */
async function startupSeed() {
  const result = await seedWorldEncounters(t.db, { mode: 'insert-missing' });
  await seedWorldEncounterVendors(t.db, { mode: 'insert-missing' });
  return result;
}

async function load(slug: string) {
  const loaded = await repo.loadBySlug(slug);
  expect(loaded, slug).not.toBeNull();
  return loaded!;
}

async function vendor(key: string) {
  const [row] = await t.db
    .select()
    .from(worldEncounterVendors)
    .where(eq(worldEncounterVendors.vendorKey, key));
  return row;
}

/* ─────────────────────── Fresh database ─────────────────────── */

describe('fresh database', () => {
  it('receives every bootstrap encounter', async () => {
    expect(await t.db.select().from(worldEncounters)).toHaveLength(0);

    const result = await startupSeed();

    expect([...result.created].sort()).toEqual(SEED_SLUGS);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    const rows = await t.db.select({ slug: worldEncounters.slug }).from(worldEncounters);
    expect(rows.map((r) => r.slug).sort()).toEqual(SEED_SLUGS);
  });

  it('receives the complete definition — choices, regions, routes', async () => {
    for (const seed of SEED_ENCOUNTERS) {
      const loaded = await load(seed.slug);
      expect(loaded.encounter.lifecycle).toBe(seed.lifecycle);
      expect(loaded.regions.map((r) => r.regionId).sort()).toEqual([...seed.regions].sort());
      expect(loaded.routes).toHaveLength(seed.routes.length);
      expect(loaded.choices.map((c) => c.label)).toEqual(seed.choices.map((c) => c.label));
    }
  });

  it('receives the bootstrap vendor', async () => {
    for (const seed of SEED_VENDORS) {
      const row = await vendor(seed.vendorKey);
      expect(row).toBeDefined();
      expect(row!.name).toBe(seed.name);
      expect(row!.description).toBe(seed.description);
      expect(row!.stockTemplateJson).toEqual(seed.stock);
    }
  });

  it('assigns each seeded encounter its configured artwork', async () => {
    for (const seed of SEED_ENCOUNTERS) {
      const loaded = await load(seed.slug);
      expect(seed.artworkPath, seed.slug).not.toBeNull();
      expect(loaded.encounter.artworkPath, seed.slug).toBe(seed.artworkPath);
    }
  });

  it('a second startup seed is idempotent and writes nothing', async () => {
    const before = await snapshot();

    const result = await startupSeed();

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect([...result.skipped].sort()).toEqual(SEED_SLUGS);
    expect(await snapshot()).toEqual(before);
  });
});

/* ─────────────────────── Portal edits survive a restart ─────────────────────── */

describe('an edited seeded encounter survives another startup seed', () => {
  const SLUG = 'tv_bandit_ambush';
  const EDITED = {
    name: 'Bandit Ambush (retuned)',
    description: 'Rewritten in the Portal.',
    weight: 42,
    rarity: 'rare' as const,
    cooldownSeconds: 12345,
    huntEligible: true,
    travelEligible: false,
    lifecycle: 'disabled' as const,
    artworkPath: 'encounters/tp_mountain_bandit.webp',
    regions: ['thirstlands', 'twin-peeks'],
    routes: [{ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' }],
  };
  let editedChoiceIds: number[];
  let before: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    // The same writes the Portal editor's save makes: the row, then its
    // children replaced wholesale.
    const current = await load(SLUG);
    const e = current.encounter;
    await t.db.transaction(async (tx) => {
      await repo.update(tx, e.id, {
        slug: e.slug,
        name: EDITED.name,
        description: EDITED.description,
        type: e.type,
        rarity: EDITED.rarity,
        weight: EDITED.weight,
        lifecycle: EDITED.lifecycle,
        huntEligible: EDITED.huntEligible,
        travelEligible: EDITED.travelEligible,
        cooldownSeconds: EDITED.cooldownSeconds,
        artworkPath: EDITED.artworkPath,
        chainedEncounterSlug: e.chainedEncounterSlug,
        choicesRequired: e.choicesRequired,
        metadata: e.metadata as Record<string, unknown>,
      });
      await repo.replaceChildren(tx, e.id, EDITED.regions, EDITED.routes, [
        {
          sortOrder: 0,
          label: 'Parley',
          emoji: '🗣️',
          requirementsJson: {},
          checkJson: { type: 'none' },
          successEffectsJson: [{ type: 'waifubux_gain', amount: 7 }],
          failureEffectsJson: [],
          outcomeText: 'You talk them down.',
          successText: 'They let you pass.',
          failureText: 'They do not.',
        },
        {
          sortOrder: 1,
          label: 'Flee',
          emoji: '🏃',
          requirementsJson: {},
          checkJson: { type: 'none' },
          successEffectsJson: [],
          failureEffectsJson: [],
        },
      ]);
    });

    editedChoiceIds = (await load(SLUG)).choices.map((c) => c.id);
    before = await snapshot();
    await startupSeed();
  });

  it('keeps the edited name and description', async () => {
    const { encounter } = await load(SLUG);
    expect(encounter.name).toBe(EDITED.name);
    expect(encounter.description).toBe(EDITED.description);
  });

  it('keeps the edited weight, rarity, cooldown and eligibility', async () => {
    const { encounter } = await load(SLUG);
    expect(encounter.weight).toBe(EDITED.weight);
    expect(encounter.rarity).toBe(EDITED.rarity);
    expect(encounter.cooldownSeconds).toBe(EDITED.cooldownSeconds);
    expect(encounter.huntEligible).toBe(EDITED.huntEligible);
    expect(encounter.travelEligible).toBe(EDITED.travelEligible);
  });

  it('keeps lifecycle = disabled', async () => {
    expect((await load(SLUG)).encounter.lifecycle).toBe('disabled');
  });

  it('keeps the administrator-selected artwork', async () => {
    expect((await load(SLUG)).encounter.artworkPath).toBe(EDITED.artworkPath);
  });

  it('keeps outcome, success and failure text', async () => {
    const [first] = (await load(SLUG)).choices;
    expect(first!.outcomeText).toBe('You talk them down.');
    expect(first!.successText).toBe('They let you pass.');
    expect(first!.failureText).toBe('They do not.');
  });

  it('keeps the edited choices', async () => {
    const { choices } = await load(SLUG);
    expect(choices.map((c) => c.label)).toEqual(['Parley', 'Flee']);
    expect(choices[0]!.successEffectsJson).toEqual([{ type: 'waifubux_gain', amount: 7 }]);
  });

  it('keeps the existing choice ids', async () => {
    expect((await load(SLUG)).choices.map((c) => c.id)).toEqual(editedChoiceIds);
  });

  it('keeps the edited regions and routes', async () => {
    const { regions, routes } = await load(SLUG);
    expect(regions.map((r) => r.regionId).sort()).toEqual([...EDITED.regions].sort());
    expect(routes.map((r) => ({ fromRegion: r.fromRegion, toRegion: r.toRegion }))).toEqual(
      EDITED.routes,
    );
  });

  it('issues no UPDATE or DELETE against any encounter or child row', async () => {
    expect(await snapshot()).toEqual(before);
  });
});

/* ─────────────────────── Vendor edits survive a restart ─────────────────────── */

describe('an edited vendor survives another startup seed', () => {
  const KEY = SEED_VENDORS[0]!.vendorKey;
  const STOCK = [{ itemSlug: 'basic_charm', quantity: 9, price: 1, currency: 'waifubux' }];

  it('keeps name, description and stock, and is not written', async () => {
    await t.db
      .update(worldEncounterVendors)
      .set({ name: 'Renamed Merchant', description: 'Edited.', stockTemplateJson: STOCK })
      .where(eq(worldEncounterVendors.vendorKey, KEY));
    const before = await snapshot();

    await startupSeed();

    const row = await vendor(KEY);
    expect(row!.name).toBe('Renamed Merchant');
    expect(row!.description).toBe('Edited.');
    expect(row!.stockTemplateJson).toEqual(STOCK);
    expect(await snapshot()).toEqual(before);
  });
});

/* ─────────────────────── New bootstrap content ─────────────────────── */

describe('a release that ships new bootstrap content', () => {
  it('inserts a new seed slug without modifying existing seeded encounters', async () => {
    const shipped: EncounterInput = {
      ...SEED_ENCOUNTERS[0]!,
      slug: 'wv_new_in_this_release',
      name: 'Brand New',
    };
    const before = await snapshot();

    const result = await seedWorldEncounters(t.db, {
      mode: 'insert-missing',
      catalogue: [...SEED_ENCOUNTERS, shipped],
    });

    expect(result.created).toEqual(['wv_new_in_this_release']);
    expect(result.updated).toEqual([]);
    const created = await load('wv_new_in_this_release');
    expect(created.encounter.name).toBe('Brand New');
    expect(created.encounter.artworkPath).toBe(shipped.artworkPath);
    expect(created.choices).toHaveLength(shipped.choices.length);

    const after = await snapshot();
    const newId = created.encounter.id;
    expect(after.encounters.filter((r) => Number(r.id) !== newId)).toEqual(before.encounters);
    expect(after.choices.filter((r) => Number(r.encounter_id) !== newId)).toEqual(before.choices);
    expect(after.regions.filter((r) => Number(r.encounter_id) !== newId)).toEqual(before.regions);
    expect(after.routes.filter((r) => Number(r.encounter_id) !== newId)).toEqual(before.routes);
  });

  it('creates a missing bootstrap vendor without modifying an existing one', async () => {
    const before = (await snapshot()).vendors;

    await seedWorldEncounterVendors(t.db, {
      mode: 'insert-missing',
      catalogue: [
        ...SEED_VENDORS,
        { vendorKey: 'new_vendor', name: 'New Vendor', description: '', stock: [] },
      ],
    });

    const after = (await snapshot()).vendors;
    expect(after.filter((r) => r.vendor_key !== 'new_vendor')).toEqual(before);
    expect((await vendor('new_vendor'))!.name).toBe('New Vendor');
  });
});

/* ─────────────────────── Explicit reset ─────────────────────── */

describe("mode: 'reset'", () => {
  it('is the only way to overwrite existing content from the catalogue', async () => {
    const result = await seedWorldEncounters(t.db, { mode: 'reset' });
    await seedWorldEncounterVendors(t.db, { mode: 'reset' });

    expect([...result.updated].sort()).toEqual(SEED_SLUGS);
    const seed = SEED_ENCOUNTERS.find((e) => e.slug === 'tv_bandit_ambush')!;
    const { encounter } = await load('tv_bandit_ambush');
    expect(encounter.name).toBe(seed.name);
    expect(encounter.lifecycle).toBe(seed.lifecycle);
    expect(encounter.artworkPath).toBe(seed.artworkPath);
    expect((await vendor(SEED_VENDORS[0]!.vendorKey))!.name).toBe(SEED_VENDORS[0]!.name);
  });
});
