/**
 * Encounter promotion against a real database.
 *
 * The claims that need a database are the ones about *writes*: that an import
 * is a single transaction, that it upserts by slug rather than by surrogate
 * key, that it never deletes what the package omits, and that a rejected
 * package leaves the server exactly as it was. Doubles cannot show any of
 * that, because the transaction is the thing under test.
 *
 * The suite also exercises a true round trip — export the shipped catalogue,
 * wipe it, import it back — which is the closest thing to the real staging →
 * production promotion this repository can run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  worldEncounterImportLog,
  worldEncounterVendors,
  worldEncounters,
  worldEncounterChoices,
} from '../../../src/db/schema';
import { bootstrapApp, type App } from '../../helpers/fixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import {
  createEncounterPromotionService,
  EncounterImportRejectedError,
  type EncounterPromotionService,
} from '../../../src/modules/worldEncounters/encounterImportService';
import { stableJson, toPackagedEncounter } from '../../../src/modules/worldEncounters/encounterPackage';

let t: TestDb;
let app: App;
let promotion: EncounterPromotionService;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  promotion = createEncounterPromotionService({
    db: t.db,
    getContent: () => app.content,
  });
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(worldEncounterImportLog);
});

const ACTOR = '777888999000111222';

/** A minimal, valid package built around one authored encounter. */
function packageOf(encounters: unknown[], vendors: unknown[] = []) {
  return {
    format: 'waifumon-world-encounters',
    version: 1,
    exportedAt: '2026-09-05T00:00:00.000Z',
    label: 'staging',
    vendors,
    encounters,
  };
}

function newEncounter(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    name: `Test ${slug}`,
    description: 'An imported encounter.',
    type: 'decision',
    rarity: 'common',
    weight: 10,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 60,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [
      {
        label: 'Look closer',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [{ type: 'waifubux_gain', amount: 25 }],
        failureEffects: [],
      },
    ],
    metadata: {},
    ...overrides,
  };
}

async function slugsInDb(): Promise<string[]> {
  const rows = await t.db.select({ slug: worldEncounters.slug }).from(worldEncounters);
  return rows.map((r) => r.slug).sort();
}

/* ─────────────────────── Round trip ─────────────────────── */

describe('export → import round trip', () => {
  it('reproduces every shipped encounter definition exactly', async () => {
    // Export the seeded catalogue, delete every encounter, import it back, and
    // compare the authored projections. This is the promotion path end to end.
    const exported = await promotion.exportPackage({ label: 'round-trip' });
    expect(exported.encounters.length).toBeGreaterThan(0);
    const before = new Map(
      (await Promise.all(
        exported.encounters.map(async (e) => {
          const loaded = await app.worldEncounterAdmin.getBySlug(e.slug);
          return [e.slug, stableJson(toPackagedEncounter(loaded!))] as const;
        }),
      )),
    );

    await t.db.delete(worldEncounterChoices);
    await t.db.delete(worldEncounters);
    expect(await slugsInDb()).toEqual([]);

    const result = await promotion.apply(exported, { actorDiscordUserId: ACTOR });
    expect(result.plan.ok).toBe(true);
    expect(result.plan.counts.created).toBe(exported.encounters.length);

    for (const [slug, expected] of before) {
      const reloaded = await app.worldEncounterAdmin.getBySlug(slug);
      expect(reloaded, `missing after import: ${slug}`).not.toBeNull();
      expect(stableJson(toPackagedEncounter(reloaded!))).toEqual(expected);
    }
  });

  it('a re-import of an unchanged package writes nothing new', async () => {
    const exported = await promotion.exportPackage();
    const plan = await promotion.preview(exported);

    expect(plan.ok).toBe(true);
    expect(plan.counts.created).toBe(0);
    expect(plan.counts.updated).toBe(0);
    expect(plan.counts.unchanged).toBe(exported.encounters.length);
  });

  it('chained encounters and vendors survive the trip', async () => {
    // `tv_bandit_ambush` chains to `tv_bandit_aftermath`; `tv_wandering_merchant`
    // opens the seeded vendor. Both relationships are by slug/key only.
    const exported = await promotion.exportPackage();
    const slugs = exported.encounters.map((e) => e.slug);
    expect(slugs).toContain('tv_bandit_aftermath');
    expect(exported.vendors.map((v) => v.vendorKey)).toContain('wandering_merchant');

    const ambush = exported.encounters.find((e) => e.slug === 'tv_bandit_ambush');
    const chainRef =
      ambush?.chainedEncounterSlug ??
      ambush?.choices
        .flatMap((c) => [...c.successEffects, ...c.failureEffects])
        .find((e) => e.type === 'trigger_encounter');
    expect(chainRef).toBeTruthy();

    const plan = await promotion.preview(exported);
    expect(plan.ok).toBe(true);
  });
});

/* ─────────────────────── Preview writes nothing ─────────────────────── */

describe('preview', () => {
  it('writes nothing at all', async () => {
    const before = await slugsInDb();
    const plan = await promotion.preview(packageOf([newEncounter('imp_preview_only')]));

    expect(plan.ok).toBe(true);
    expect(plan.counts.created).toBe(1);
    expect(await slugsInDb()).toEqual(before);
    expect(await t.db.select().from(worldEncounterImportLog)).toHaveLength(0);
  });

  it('rejects an invalid dependency without touching the database', async () => {
    const before = await slugsInDb();
    const plan = await promotion.preview(
      packageOf([newEncounter('imp_bad', { chainedEncounterSlug: 'does_not_exist' })]),
    );

    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('missing_chained_encounter');
    expect(await slugsInDb()).toEqual(before);
  });
});

/* ─────────────────────── Apply ─────────────────────── */

describe('apply', () => {
  it('creates new encounters and records an audit row', async () => {
    const result = await promotion.apply(
      packageOf([newEncounter('imp_created_a'), newEncounter('imp_created_b')]),
      { actorDiscordUserId: ACTOR, sourceFilename: 'staging-export.json' },
    );

    expect(result.plan.counts.created).toBe(2);
    expect(await slugsInDb()).toEqual(expect.arrayContaining(['imp_created_a', 'imp_created_b']));

    const [log] = await t.db.select().from(worldEncounterImportLog);
    expect(log).toMatchObject({
      actorDiscordUserId: ACTOR,
      packageFormat: 'waifumon-world-encounters',
      packageVersion: 1,
      packageLabel: 'staging',
      sourceFilename: 'staging-export.json',
      createdCount: 2,
    });
    expect(log!.encounterSlugs).toEqual(['imp_created_a', 'imp_created_b']);
    expect(log!.appliedAt).toBeInstanceOf(Date);
  });

  it('updates an existing encounter by slug, keeping its row identity', async () => {
    await promotion.apply(packageOf([newEncounter('imp_upsert')]), {
      actorDiscordUserId: ACTOR,
    });
    const [before] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'imp_upsert'));

    await promotion.apply(
      packageOf([newEncounter('imp_upsert', { name: 'Renamed', weight: 99 })]),
      { actorDiscordUserId: ACTOR },
    );
    const [after] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'imp_upsert'));

    // Same row, new content — the slug is the identity, not the id.
    expect(after!.id).toBe(before!.id);
    expect(after!.name).toBe('Renamed');
    expect(after!.weight).toBe(99);
  });

  it('replaces choices rather than accumulating them', async () => {
    await promotion.apply(packageOf([newEncounter('imp_choices')]), {
      actorDiscordUserId: ACTOR,
    });
    await promotion.apply(
      packageOf([
        newEncounter('imp_choices', {
          choices: [
            {
              label: 'Only choice now',
              emoji: null,
              requirements: {},
              check: { type: 'none' },
              successEffects: [],
              failureEffects: [],
            },
          ],
        }),
      ]),
      { actorDiscordUserId: ACTOR },
    );

    const loaded = await app.worldEncounterAdmin.getBySlug('imp_choices');
    expect(loaded!.choices).toHaveLength(1);
    expect(loaded!.choices[0]!.label).toBe('Only choice now');
  });

  it('never deletes an encounter merely absent from the package', async () => {
    await promotion.apply(packageOf([newEncounter('imp_keeper')]), {
      actorDiscordUserId: ACTOR,
    });
    const seeded = await slugsInDb();

    await promotion.apply(packageOf([newEncounter('imp_other')]), {
      actorDiscordUserId: ACTOR,
    });

    const after = await slugsInDb();
    for (const slug of seeded) expect(after).toContain(slug);
    expect(after).toContain('imp_other');
  });

  it('imports a vendor the package carries', async () => {
    await promotion.apply(
      packageOf(
        [
          newEncounter('imp_vendor_host', {
            choices: [
              {
                label: 'Shop',
                emoji: null,
                requirements: {},
                check: { type: 'none' },
                successEffects: [{ type: 'open_vendor', vendorKey: 'imported_merchant' }],
                failureEffects: [],
              },
            ],
          }),
        ],
        [
          {
            vendorKey: 'imported_merchant',
            name: 'Imported Merchant',
            description: 'Arrived with the package.',
            stockTemplate: [
              { itemSlug: 'basic_charm', quantity: 2, price: 100, currency: 'waifubux' },
            ],
          },
        ],
      ),
      { actorDiscordUserId: ACTOR },
    );

    const [vendor] = await t.db
      .select()
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, 'imported_merchant'));
    expect(vendor).toMatchObject({ name: 'Imported Merchant' });
    expect(vendor!.stockTemplateJson).toEqual([
      { itemSlug: 'basic_charm', quantity: 2, price: 100, currency: 'waifubux' },
    ]);
  });
});

/* ─────────────────────── Transactionality ─────────────────────── */

describe('an import is all or nothing', () => {
  it('rolls back every record when one is invalid', async () => {
    // The first encounter is perfectly valid; the second references an item
    // that does not exist. Neither may land.
    const before = await slugsInDb();

    await expect(
      promotion.apply(
        packageOf([
          newEncounter('imp_tx_good'),
          newEncounter('imp_tx_bad', {
            choices: [
              {
                label: 'Take it',
                emoji: null,
                requirements: {},
                check: { type: 'none' },
                successEffects: [{ type: 'give_item', slug: 'no_such_item', quantity: 1 }],
                failureEffects: [],
              },
            ],
          }),
        ]),
        { actorDiscordUserId: ACTOR },
      ),
    ).rejects.toBeInstanceOf(EncounterImportRejectedError);

    const after = await slugsInDb();
    expect(after).toEqual(before);
    expect(after).not.toContain('imp_tx_good');
    // And no audit row: a log entry exists only when content actually landed.
    expect(await t.db.select().from(worldEncounterImportLog)).toHaveLength(0);
  });

  it('rolls back an update as well as an insert', async () => {
    await promotion.apply(packageOf([newEncounter('imp_tx_existing', { name: 'Original' })]), {
      actorDiscordUserId: ACTOR,
    });

    await expect(
      promotion.apply(
        packageOf([
          newEncounter('imp_tx_existing', { name: 'Should Not Stick' }),
          newEncounter('imp_tx_broken', { chainedEncounterSlug: 'nowhere_at_all' }),
        ]),
        { actorDiscordUserId: ACTOR },
      ),
    ).rejects.toBeInstanceOf(EncounterImportRejectedError);

    const reloaded = await app.worldEncounterAdmin.getBySlug('imp_tx_existing');
    expect(reloaded!.name).toBe('Original');
    expect(await app.worldEncounterAdmin.getBySlug('imp_tx_broken')).toBeNull();
  });

  it('carries the plan on the rejection so the operator sees why', async () => {
    const err = await promotion
      .apply(packageOf([newEncounter('imp_why', { chainedEncounterSlug: 'nope' })]), {
        actorDiscordUserId: ACTOR,
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(EncounterImportRejectedError);
    const plan = (err as EncounterImportRejectedError).plan;
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('missing_chained_encounter');
  });

  it('resolves a same-package dependency across the whole transaction', async () => {
    // Parent and child in one package, neither on the server beforehand.
    const result = await promotion.apply(
      packageOf([
        newEncounter('imp_chain_parent', { chainedEncounterSlug: 'imp_chain_child' }),
        newEncounter('imp_chain_child', { huntEligible: false, travelEligible: false }),
      ]),
      { actorDiscordUserId: ACTOR },
    );

    expect(result.plan.ok).toBe(true);
    const parent = await app.worldEncounterAdmin.getBySlug('imp_chain_parent');
    expect(parent!.chainedEncounterSlug).toBe('imp_chain_child');
    expect(await app.worldEncounterAdmin.getBySlug('imp_chain_child')).not.toBeNull();
  });
});

/* ─────────────────────── Export selection ─────────────────────── */

describe('selective export', () => {
  it('exports only the requested slugs', async () => {
    const pkg = await promotion.exportPackage({ slugs: ['tv_bandit_ambush'] });

    expect(pkg.encounters.map((e) => e.slug)).toEqual(['tv_bandit_ambush']);
  });

  it('refuses a slug that does not exist rather than silently omitting it', async () => {
    await expect(promotion.exportPackage({ slugs: ['not_a_real_slug'] })).rejects.toThrow();
  });
});
