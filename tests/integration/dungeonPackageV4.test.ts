/** P4D1 portability plus the P4D2 export → repair → publish → play lifecycle. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRevisions, dungeonSpeciesAcquisitions, playerWaifus, species, items } from '../../src/db/schema';
import { type DungeonDefinition } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import {
  buildDungeonPackage,
  DungeonPackageV4Schema,
  dungeonContentHash,
  portableHash,
  dungeonPackageIntegrityHash,
  readDungeonPackage,
} from '../../src/modules/dungeons/package/dungeonPackage';
import type { DungeonImportApplyInput } from '../../src/modules/dungeons/package/dungeonImportService';
import type { DungeonLootImportDecisions } from '../../src/modules/dungeons/package/dungeonLootImport';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { CHARM, FINITE, attemptRoll, findSeed, installExclusiveSpecies, namedEncounter } from '../helpers/dungeonCaptureFixtures';
import { getItemBySlug } from '../helpers/fixtures';

let w: DungeonWorld;
let seq = 0;
const fresh = () => `p4d1_${++seq}`;
beforeAll(async () => {
  w = await createDungeonWorld();
});
afterAll(async () => {
  await w?.cleanup();
});
function definition(
  opts: {
    slug?: string;
    direct?: boolean;
    charm?: string;
    global?: boolean;
    mixed?: boolean;
  } = {},
) {
  const key = fresh();
  const bundle = {
    guaranteed: [],
    chances: [],
    tables: [{ id: 'coins', table: `${key}_loot`, draws: 1 }],
  };
  return singleRoomDungeon(
    [
      {
        id: 'meet',
        ...(opts.direct
          ? { type: 'rescue' as const, mode: 'direct' as const }
          : {
              type: 'wild_encounter' as const,
              capture: opts.global
                ? {}
                : {
                    allowedItems: [opts.charm ?? 'basic_charm'],
                    allowGuaranteedItems: false,
                  },
            }),
        source: { kind: 'pool', poolId: 'finds' },
        intro: 'A visitor.',
      },
      ...(opts.mixed
        ? [
            {
              id: 'event',
              type: 'event' as const,
              source: { kind: 'event' as const, eventId: 'chest' },
            },
            { id: 'loot', type: 'reward' as const, rewards: bundle },
          ]
        : []),
    ],
    (d) => {
      d.key = key;
      d.speciesPools = [
        {
          id: 'finds',
          name: 'Finds',
          entries: [
            { id: 'species', species: opts.slug ?? 'neko_barista', weight: 9 },
            { id: 'none', weight: 1, nothing: true },
          ],
        },
        {
          id: 'unused',
          name: 'Unused',
          entries: [{ id: 'unknown', species: 'unused_absent', weight: 1 }],
        },
      ];
      if (opts.mixed)
        d.events = [
          {
            id: 'chest',
            title: 'Chest',
            text: 'Open?',
            choices: [
              {
                id: 'take',
                label: 'Open',
                items: [{ item: 'basic_charm', quantity: 1 }],
                outcome: { rewards: bundle },
              },
              { id: 'skip', label: 'Leave', outcome: {} },
            ],
          },
        ];
    },
  );
}
const coins = (amount: number) =>
  DungeonLootTableBodySchema.parse({
    chances: [],
    pools: [],
    guaranteed: [
      {
        id: 'cash',
        grant: {
          type: 'currency',
          currency: 'waifubux',
          amount: { min: amount, max: amount },
        },
      },
    ],
  });
function pkg(d = definition()) {
  const snapshot =
    resolveDungeonRewardDependencies(d, {
      lootTables: new Map([[`${d.key}_loot`, { name: 'Coins', body: coins(7), revision: 1, archivedAt: null }]]),
    }).snapshot ?? undefined;
  const slugs = d.speciesPools![0]!.entries.flatMap((e) => ('species' in e ? [e.species] : []));
  return DungeonPackageV4Schema.parse(
    buildDungeonPackage({
      definition: d,
      source: {
        environment: 'source',
        origin: 'draft',
        draftRevision: 1,
        publishedRevision: null,
      },
      rewardSnapshot: snapshot,
      species: new Map(
        slugs.map((slug) => [
          slug,
          {
            slug,
            rarity: 'N',
            enabled: true,
            regionExclusive: false,
            dungeonExclusive: false,
            dungeonAccess: [{ dungeon: d.key, directRescue: true, perPlayerLimit: 2 }],
          },
        ]),
      ),
    }),
  );
}
async function request(
  p: ReturnType<typeof pkg>,
  allowMissingDependencies = false,
  lootTables: DungeonLootImportDecisions = {},
  world = w,
): Promise<DungeonImportApplyInput> {
  const plan = await world.content.planImport(p, lootTables);
  expect(plan.validPackage).toBe(true);
  expect(plan.planHash).not.toBeNull();
  return {
    package: p,
    requestId: randomUUID(),
    expectedPlanHash: plan.planHash!,
    expectedRevision: plan.target!.expectedRevision,
    decisions: {
      dungeon: plan.target!.status === 'new' ? 'create' : plan.target!.status === 'identical' ? 'unchanged' : 'replace',
      enemies: {},
      lootTables,
      allowMissingDependencies,
    },
  };
}
async function state(world = w) {
  const names = [
    'dungeon_definitions',
    'dungeon_revisions',
    'dungeon_runs',
    'dungeon_content_events',
    'dungeon_import_history',
    'dungeon_loot_tables',
    'dungeon_loot_table_events',
    'combat_enemies',
    'species',
    'items',
  ];
  const result: Record<string, unknown> = {};
  for (const name of names)
    result[name] = (
      await world.t.pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM "${name}" t`,
      )
    ).rows[0].rows;
  return result;
}
describe('v4 destination validation and repair', () => {
  it('imports a complete package as disabled/unpublished, publishes frozen pools and species evidence', async () => {
    const p = pkg();
    const before = await state();
    const r = await request(p);
    expect(await state()).toEqual(before);
    expect(await w.content.applyImport(r, 'admin')).toMatchObject({
      sourceSchemaVersion: 4,
      publishable: true,
      createdLootTables: [],
    });
    expect(await w.content.get(p.dungeon.key)).toMatchObject({
      enabled: false,
      published: null,
      draft: p.dungeon,
    });
    expect((await state()).species).toEqual(before.species);
    expect((await state()).items).toEqual(before.items);
    await w.content.publish(p.dungeon.key, { expectedRevision: 1 }, 'author');
    const exported = await w.content.exportPackage(p.dungeon.key, 'published', 'exporter');
    expect(exported).toMatchObject({
      schemaVersion: 4,
      dependencies: {
        requiredSpecies: [expect.objectContaining({ slug: 'neko_barista', rarity: 'N' })],
      },
    });
    expect(exported.dungeon.speciesPools).toEqual(p.dungeon.speciesPools);
    expect((await w.content.history(p.dungeon.key)).find((e) => e.action === 'published')?.details).toMatchObject({
      speciesManifest: {
        entries: [expect.objectContaining({ slug: 'neko_barista' })],
      },
    });
  });
  it.each([
    'missing',
    'disabled',
    'dungeon_exclusive',
    'region_exclusive',
    'direct_no_authorization',
    'direct_unlimited',
  ] as const)('blocks %s, permits explicit repair drafts, then revalidates publication', async (kind) => {
    const slug = kind === 'missing' ? 'missing_species' : 'gym_oni';
    const p = pkg(definition({ slug, direct: kind.startsWith('direct') }));
    const [row] = await w.t.db.select().from(species).where(eq(species.slug, 'gym_oni'));
    if (kind === 'disabled') await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, slug));
    if (kind.endsWith('exclusive')) {
      await w.t.db
        .update(species)
        .set({ tags: [kind] })
        .where(eq(species.slug, slug));
      w.speciesAccess.set(slug, [{ dungeon: 'another_dungeon', perPlayerLimit: 2, directRescue: true }]);
    }
    if (kind === 'direct_no_authorization')
      w.speciesAccess.set(slug, [{ dungeon: p.dungeon.key, perPlayerLimit: 2, directRescue: false }]);
    if (kind === 'direct_unlimited')
      w.speciesAccess.set(slug, [
        {
          dungeon: p.dungeon.key,
          perPlayerLimit: 'unlimited',
          directRescue: true,
        },
      ]);
    try {
      const plan = await w.content.planImport(p);
      expect(plan.publishable).toBe(false);
      const before = await state();
      await expect(w.content.applyImport(await request(p), 'admin')).rejects.toMatchObject({
        code: 'DUNGEON_IMPORT_INVALID',
      });
      expect(await state()).toEqual(before);
      expect((await w.content.applyImport(await request(p, true), 'admin')).publishable).toBe(false);
      expect((await w.content.get(p.dungeon.key))!.draft.speciesPools).toEqual(p.dungeon.speciesPools);
      await expect(w.content.publish(p.dungeon.key, { expectedRevision: 1 }, 'author')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
      });
      if (kind === 'missing') {
        const repaired = structuredClone(p.dungeon);
        const e = repaired.speciesPools![0]!.entries[0]!;
        if ('species' in e) e.species = 'neko_barista';
        await w.content.saveDraft(p.dungeon.key, { expectedRevision: 1, definition: repaired }, 'author');
        await w.content.publish(p.dungeon.key, { expectedRevision: 2 }, 'author');
      } else {
        await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, slug));
        w.speciesAccess.set(slug, [{ dungeon: p.dungeon.key, perPlayerLimit: 2, directRescue: true }]);
        await w.content.publish(p.dungeon.key, { expectedRevision: 1 }, 'author');
      }
    } finally {
      await w.t.db.update(species).set({ enabled: row!.enabled, tags: row!.tags }).where(eq(species.slug, 'gym_oni'));
      w.speciesAccess.delete(slug);
    }
  });
  it('reports rarity drift while compatible capture rules remain publishable', async () => {
    const p = pkg(definition({ global: true }));
    p.dependencies.requiredSpecies[0]!.rarity = 'R';
    p.dependenciesHash = portableHash(p.dependencies);
    p.integrityHash = dungeonPackageIntegrityHash(p);
    const plan = await w.content.planImport(p);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: 'package_species_rarity_changed',
        severity: 'warning',
      }),
    );
    expect(plan.publishable).toBe(true);
    expect(plan.encounterDependencies!.captureItems).toEqual([]);
  });
  it.each(['missing', 'disabled', 'wrong_category', 'incompatible', 'guaranteed_disallowed'] as const)(
    'checks %s charms and keeps an incomplete draft unpublishable',
    async (kind) => {
      const charm = kind === 'guaranteed_disallowed' ? 'mythic_contract' : `${fresh()}_charm`;
      if (!['missing', 'guaranteed_disallowed'].includes(kind))
        await w.t.db.insert(items).values({
          slug: charm,
          name: 'Test charm',
          category: kind === 'wrong_category' ? 'material' : 'capture',
          enabled: kind !== 'disabled',
          captureRarities: kind === 'incompatible' ? ['EX'] : ['N'],
        });
      const p = pkg(definition({ charm }));
      expect((await w.content.planImport(p)).publishable).toBe(false);
      await expect(w.content.applyImport(await request(p), 'admin')).rejects.toMatchObject({
        code: 'DUNGEON_IMPORT_INVALID',
      });
      expect((await w.content.applyImport(await request(p, true), 'admin')).publishable).toBe(false);
      await expect(w.content.publish(p.dungeon.key, { expectedRevision: 1 }, 'author')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
      });
      const fixed = structuredClone(p.dungeon);
      const a = fixed.rooms[0]!.actions[0]!;
      if (a.type === 'wild_encounter') a.capture!.allowedItems = ['basic_charm'];
      await w.content.saveDraft(p.dungeon.key, { expectedRevision: 1, definition: fixed }, 'author');
      await w.content.publish(p.dungeon.key, { expectedRevision: 2 }, 'author');
    },
  );
  it('keeps a disabled explicit charm unpublishable even when another permitted charm works', async () => {
    const charm = `${fresh()}_disabled`;
    await w.t.db
      .insert(items)
      .values({ slug: charm, name: 'Disabled charm', category: 'capture', enabled: false, captureRarities: ['N'] });
    const d = definition();
    const action = d.rooms[0]!.actions[0]!;
    if (action.type === 'wild_encounter') action.capture!.allowedItems!.push(charm);
    const p = pkg(d);
    expect(
      (await w.content.planImport(p)).encounterDependencies!.captureItems.find((i) => i.key === charm)!.status,
    ).toBe('disabled');
    await w.content.applyImport(await request(p, true), 'admin');
    await expect(w.content.publish(d.key, { expectedRevision: 1 }, 'author')).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'capture_item_disabled',
          severity: 'error',
          path: 'rooms[0].actions[0].capture.allowedItems[1]',
        }),
      ]),
    });
  });
  it('revalidates newly restricted policy at publication and refuses live-policy export', async () => {
    const p = pkg(definition({ slug: 'gym_oni' }));
    await w.content.applyImport(await request(p), 'admin');
    await w.t.db
      .update(species)
      .set({ tags: ['dungeon_exclusive'] })
      .where(eq(species.slug, 'gym_oni'));
    try {
      await expect(w.content.publish(p.dungeon.key, { expectedRevision: 1 }, 'author')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
      });
      await expect(w.content.exportPackage(p.dungeon.key, 'draft', 'author')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
      });
    } finally {
      await w.t.db.update(species).set({ tags: [] }).where(eq(species.slug, 'gym_oni'));
    }
  });
});
describe('v4 atomic imports, conflicts and isolation', () => {
  it.each(['species', 'item', 'access'] as const)(
    'invalidates a reviewed plan when %s policy changes',
    async (kind) => {
      const p = pkg();
      const r = await request(p);
      if (kind === 'species')
        await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, 'neko_barista'));
      if (kind === 'item') await w.t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'basic_charm'));
      if (kind === 'access') w.speciesAccess.set('neko_barista', [{ dungeon: p.dungeon.key, perPlayerLimit: 3 }]);
      try {
        await expect(w.content.applyImport(r, 'admin')).rejects.toMatchObject({
          code: 'DUNGEON_IMPORT_STALE',
        });
        expect(await w.content.get(p.dungeon.key)).toBeNull();
      } finally {
        await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, 'neko_barista'));
        await w.t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'basic_charm'));
        w.speciesAccess.delete('neko_barista');
      }
    },
  );
  it.each(['copy', 'use_existing'] as const)(
    'preserves mixed Event/reward conflict handling with %s',
    async (action) => {
      const p = pkg(definition({ mixed: true }));
      const key = `${p.dungeon.key}_loot`;
      const loot = createDungeonLootTableService({ db: w.t.db });
      await loot.create({ key, name: 'Local coins', body: coins(99) }, 'admin');
      const copy = `${key}_copy`;
      const choices = {
        [key]: action === 'copy' ? { action, key: copy } : { action },
      } as DungeonLootImportDecisions;
      const plan = await w.content.planImport(p, choices);
      expect(plan.eventDependencies!.requiredItems).toMatchObject([{ key: 'basic_charm', status: 'available' }]);
      expect(plan.encounterDependencies!.captureItems).toMatchObject([{ key: 'basic_charm', status: 'available' }]);
      expect((await w.content.applyImport(await request(p, false, choices), 'admin')).publishable).toBe(true);
      const draft = (await w.content.get(p.dungeon.key))!.draft;
      expect(draft.speciesPools).toEqual(p.dungeon.speciesPools);
      expect(draft.events![0]!.choices[0]!.outcome!.rewards!.tables[0]!.table).toBe(action === 'copy' ? copy : key);
      expect((await loot.get(key))!.body).toEqual(coins(99));
    },
  );
  it('rolls back created loot, draft, audit and receipt when the final audit write fails', async () => {
    const p = pkg(definition({ mixed: true }));
    const r = await request(p);
    const before = await state();
    await w.t.pool.query(
      "CREATE FUNCTION p4d1_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'imported' THEN RAISE EXCEPTION 'p4d1 audit failure'; END IF; RETURN NEW; END $$",
    );
    await w.t.pool.query(
      'CREATE TRIGGER p4d1_reject BEFORE INSERT ON dungeon_content_events FOR EACH ROW EXECUTE FUNCTION p4d1_reject()',
    );
    try {
      await expect(w.content.applyImport(r, 'admin')).rejects.toThrow(/p4d1 audit failure/);
      expect(await state()).toEqual(before);
    } finally {
      await w.t.pool.query('DROP TRIGGER p4d1_reject ON dungeon_content_events');
      await w.t.pool.query('DROP FUNCTION p4d1_reject()');
    }
  });
  it('concurrent exact retries reuse one committed receipt', async () => {
    const p = pkg();
    const r = await request(p);
    const results = await Promise.all([w.content.applyImport(r, 'admin'), w.content.applyImport(r, 'admin')]);
    expect(results.map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(await w.content.importHistory(p.dungeon.key)).toHaveLength(1);
  });
  it('a distinct duplicate import keeps one draft, while exact replay keeps one receipt per request', async () => {
    const p = pkg();
    await w.content.applyImport(await request(p), 'admin');
    const before = await state();
    const duplicate = await request(p);
    expect(duplicate.decisions.dungeon).toBe('unchanged');
    expect(await w.content.applyImport(duplicate, 'admin')).toMatchObject({ result: 'unchanged', replayed: false });
    const after = await state();
    for (const name of ['dungeon_definitions', 'dungeon_revisions', 'dungeon_runs', 'species', 'items']) expect(after[name]).toEqual(before[name]);
    expect((await w.content.applyImport(duplicate, 'admin')).replayed).toBe(true);
    expect(await w.content.importHistory(p.dungeon.key)).toHaveLength(2);
  });
  it('replacement disables publication without mutating the historical revision or its active run', async () => {
    const d = definition();
    await w.publish(d);
    const { playerId } = await w.player();
    const item = await getItemBySlug(w.t.db, 'basic_charm');
    await w.app.inventory.addItem(w.t.db, playerId, item.id, 1);
    const started = await w.runs.start(playerId, d.key);
    const before = await state();
    const replacement = structuredClone(d);
    replacement.name = 'Imported replacement';
    await w.content.applyImport(await request(pkg(replacement)), 'admin');
    const after = await state();
    expect(after.dungeon_revisions).toEqual(before.dungeon_revisions);
    expect(after.dungeon_runs).toEqual(before.dungeon_runs);
    expect(await w.content.get(d.key)).toMatchObject({
      enabled: false,
      published: null,
      draft: replacement,
    });
    // The unpublished replacement does not stop the original pinned run.
    const resumed = await w.restartedRuns().run(playerId, started.id);
    expect(resumed.core.action?.encounter).toEqual(started.core.action?.encounter);
    const selected = (await w.act(playerId, resumed, { type: 'select_item', item: item.slug })).run;
    const attempt = await w.act(playerId, selected, { type: 'capture' });
    expect(attempt.status).toBe('applied');
    expect(attempt.encounterReceipts).toMatchObject([{ item: item.slug, attemptNumber: 1 }]);
  });
  it.each(['name', 'remove encounters'])(
    'refuses modified revision content (%s) even without reward snapshots',
    async (kind) => {
      const d = definition();
      await w.publish(d);
      const corrupted = structuredClone(d);
      corrupted.name = 'Tampered';
      if (kind === 'remove encounters') {
        delete corrupted.speciesPools;
        corrupted.rooms[0]!.actions = [];
      }
      await expect(
        w.t.db.update(dungeonRevisions).set({ content: corrupted }).where(eq(dungeonRevisions.dungeonKey, d.key)),
      ).rejects.toThrow(/immutable/);
      // Deliberate corruption in this disposable test database only.
      await w.t.pool.query('ALTER TABLE dungeon_revisions DISABLE TRIGGER dungeon_revisions_immutable_trg');
      try {
        await w.t.db.update(dungeonRevisions).set({ content: corrupted }).where(eq(dungeonRevisions.dungeonKey, d.key));
      } finally {
        await w.t.pool.query('ALTER TABLE dungeon_revisions ENABLE TRIGGER dungeon_revisions_immutable_trg');
      }
      await expect(w.content.exportPackage(d.key, 'published', 'author')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
        issues: [expect.objectContaining({ path: 'contentHash' })],
      });
    },
  );
  it('refuses tampered manifests without any writes, even with incomplete acceptance', async () => {
    const p = pkg();
    p.dependencies.requiredSpecies = [];
    p.dependenciesHash = portableHash(p.dependencies);
    p.integrityHash = dungeonPackageIntegrityHash(p);
    const before = await state();
    expect((await w.content.planImport(p)).validPackage).toBe(false);
    await expect(
      w.content.applyImport(
        {
          package: p,
          requestId: randomUUID(),
          expectedPlanHash: `sha256:${'0'.repeat(64)}`,
          expectedRevision: null,
          decisions: {
            dungeon: 'create',
            enemies: {},
            allowMissingDependencies: true,
          },
        },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
  });
  it('exports from a second database and judges destination keys/access without importing policy', async () => {
    const source = await createDungeonWorld();
    try {
      const d = definition({ slug: 'gym_oni' });
      source.speciesAccess.set('gym_oni', [{ dungeon: d.key, directRescue: false, perPlayerLimit: 2 }]);
      await source.t.db
        .update(species)
        .set({ tags: ['dungeon_exclusive'] })
        .where(eq(species.slug, 'gym_oni'));
      await source.content.create({ definition: d }, 'author');
      const p = DungeonPackageV4Schema.parse(await source.content.exportPackage(d.key, 'draft', 'author'));
      expect(p.dependencies.requiredSpecies[0]).toMatchObject({
        dungeonExclusive: true,
        dungeonAccess: [{ dungeon: d.key }],
      });
      await w.t.db
        .update(species)
        .set({ tags: ['dungeon_exclusive'] })
        .where(eq(species.slug, 'gym_oni'));
      w.speciesAccess.set('gym_oni', [{ dungeon: 'another_dungeon', perPlayerLimit: 2 }]);
      const before = await state();
      expect((await w.content.planImport(p)).encounterDependencies!.requiredSpecies[0]!.status).toBe('restricted');
      await w.content.applyImport(await request(p, true), 'admin');
      expect((await state()).species).toEqual(before.species);
      w.speciesAccess.set('gym_oni', [{ dungeon: d.key, perPlayerLimit: 2 }]);
      await w.content.publish(d.key, { expectedRevision: 1 }, 'author');
      const renamed = structuredClone(p);
      renamed.packageId = randomUUID();
      renamed.dungeon.key = fresh();
      renamed.source.dungeonKey = renamed.dungeon.key;
      renamed.contentHash = dungeonContentHash(renamed.dungeon);
      renamed.integrityHash = dungeonPackageIntegrityHash(renamed);
      expect((await w.content.planImport(renamed)).encounterDependencies!.requiredSpecies[0]!.status).toBe(
        'restricted',
      );
    } finally {
      await source.cleanup();
      await w.t.db.update(species).set({ tags: [] }).where(eq(species.slug, 'gym_oni'));
      w.speciesAccess.delete('gym_oni');
    }
  });

  it('exports real v4, repairs missing species/charm and incompatible destination policy, then captures and enforces destination limits', async () => {
    const source = await createDungeonWorld();
    try {
      expect(source.t.pool.options.connectionString).not.toBe(w.t.pool.options.connectionString);
      await installExclusiveSpecies(source);
      const d = namedEncounter('p4d2_import_lifecycle', FINITE);
      const charm = 'p4d2_portable_charm';
      const { id: _id, ...baseItem } = await getItemBySlug(source.t.db, CHARM);
      await source.t.db.insert(items).values({ ...baseItem, slug: charm, name: 'Portable test charm' });
      const action = d.rooms[0]!.actions[0]!;
      if (action.type !== 'wild_encounter') throw new Error('fixture');
      action.capture.allowedItems = [charm];
      source.speciesAccess.set(FINITE, [{ dungeon: d.key, perPlayerLimit: 1 }]);
      await source.publish(d);
      const p = DungeonPackageV4Schema.parse(await source.content.exportPackage(d.key, 'published', 'creator'));
      expect(readDungeonPackage(p).ok).toBe(true);
      expect(p.dependencies).toMatchObject({ requiredSpecies: [{ slug: FINITE, dungeonExclusive: true }], captureItems: [charm] });
      const plan = await w.content.planImport(p);
      expect(plan.encounterDependencies).toMatchObject({ requiredSpecies: [{ status: 'missing' }], captureItems: [{ status: 'missing' }] });
      const initial = await state();
      await expect(w.content.applyImport(await request(p), 'creator')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
      expect(await state()).toEqual(initial);
      const repair = await request(p, true);
      const imported = await w.content.applyImport(repair, 'creator');
      expect(imported.publishable).toBe(false);
      expect((await w.content.applyImport(repair, 'creator')).replayed).toBe(true);
      expect(await w.content.importHistory(d.key)).toHaveLength(1);
      expect(await w.content.get(d.key)).toMatchObject({ enabled: false, published: null, draft: d });
      await expect(w.content.publish(d.key, { expectedRevision: 1 }, 'creator')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
      await installExclusiveSpecies(w);
      await w.t.db.insert(items).values({ ...baseItem, slug: charm, name: 'Destination test charm' });
      w.speciesAccess.set(FINITE, [{ dungeon: 'different_dungeon', perPlayerLimit: 1 }]);
      expect((await w.content.planImport(p)).encounterDependencies!.requiredSpecies[0]!.status).toBe('restricted');
      await expect(w.content.publish(d.key, { expectedRevision: 1 }, 'creator')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
      // Only destination configuration authorizes capture. Export evidence grants no access.
      w.speciesAccess.set(FINITE, [{ dungeon: d.key, perPlayerLimit: 1 }]);
      const published = await w.content.publish(d.key, { expectedRevision: 1 }, 'creator');
      await w.content.setEnabled(d.key, true, 'creator');
      const seed = findSeed(s => attemptRoll(s) < 0.01);
      const capture = async (playerId: number) => {
        await w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, charm)).id, 2);
        let run = await w.runs.start(playerId, d.key, { seed });
        expect(run.core.action?.encounter).toMatchObject({ species: FINITE, available: true });
        run = (await w.act(playerId, run, { type: 'select_item', item: charm })).run;
        const result = await w.act(playerId, run, { type: 'capture' });
        expect(result.encounterReceipts).toMatchObject([{ success: true, acquired: { speciesSlug: FINITE } }]);
        expect((await w.act(playerId, result.run, { type: 'move', connectionId: 'c_out' })).run.status).toBe('completed');
        const [grant] = await w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.playerId, playerId));
        expect(grant).toMatchObject({ dungeonKey: d.key, mode: 'capture', runId: run.id });
        expect((await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, grant!.waifuId)))[0]).toMatchObject({ playerId, grantKey: grant!.grantKey, acquiredVia: 'dungeon_capture' });
        expect((await w.runs.history(run.id)).filter(e => e.type === 'waifu_acquired')).toHaveLength(1);
        expect(await w.app.inventory.getQuantity(playerId, (await getItemBySlug(w.t.db, charm)).id)).toBe(1);
      };
      const { playerId } = await w.player();
      await capture(playerId);
      const second = await w.runs.start(playerId, d.key, { seed });
      expect(second.core.action?.encounter).toBeFalsy();
      expect(second.core.recent).toContainEqual(expect.objectContaining({ outcome: 'unavailable' }));
      await w.act(playerId, second, { type: 'move', connectionId: 'c_out' });
      expect(await w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.playerId, playerId))).toHaveLength(1);
      await capture((await w.player()).playerId);
      expect((await w.content.revisions(d.key))![0]!.revisionId).toBe(published.revision.revisionId);
      // Neither import nor destination play creates source ownership.
      expect(await source.t.db.select().from(dungeonSpeciesAcquisitions)).toEqual([]);
    } finally { await source.cleanup(); }
  });
});
