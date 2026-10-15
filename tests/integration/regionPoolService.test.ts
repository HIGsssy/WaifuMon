/**
 * RP2B: Region Pool administration against PostgreSQL — drafts, review-bound
 * publication, rollback, drift, the shipped-pool workflow, and what hunting
 * can see while all of that happens.
 */
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  regionEncounterPools,
  regionPoolEvents,
  regionPoolRevisionEntries,
  regionPoolRevisions,
  regionPools,
  species,
} from '../../src/db/schema';
import { applyContent, createContentReloader } from '../../src/modules/content/reloadService';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { contentRegionCatalogue } from '../../src/modules/regionPools/regionCatalogue';
import {
  createRegionPoolService,
  type RegionPoolService,
  type ReviewResult,
} from '../../src/modules/regionPools/regionPoolService';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { canonicalProjection } from '../helpers/regionPoolFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN = 'admin-1';

interface World {
  t: TestDb;
  app: App;
  pools: RegionPoolService;
  content: () => LoadedContent;
  setContent: (c: LoadedContent) => void;
}

async function world(): Promise<World> {
  const t = await createTestDb();
  const app = await bootstrapApp(t);
  let content = app.content;
  const pools = createRegionPoolService({
    db: t.db,
    getContent: () => content,
    catalogue: contentRegionCatalogue(() => content),
    huntTables: app.content.tables,
  });
  return { t, app, pools, content: () => content, setContent: (c) => (content = c) };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as { code: string }).code;
  }
  return 'NO_ERROR';
};

async function review(pools: RegionPoolService, regionId: string): Promise<ReviewResult> {
  return (await pools.validate(regionId, {})) as ReviewResult;
}

/** Validate then publish, acknowledging whatever the review asks for. */
async function publishReviewed(pools: RegionPoolService, regionId: string, actor = ADMIN) {
  const r = await review(pools, regionId);
  return pools.publish(
    regionId,
    { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: r.requiredAcknowledgements },
    actor,
  );
}

async function setDraft(pools: RegionPoolService, regionId: string, entries: Array<{ species: string; weight: number }>) {
  const current = await pools.get(regionId);
  return pools.saveDraft(regionId, { entries, expectedDraftRevision: current.draft.revision }, ADMIN);
}

const plain = (entries: Array<{ species: string; weight: number }>) => entries.map((e) => ({ species: e.species, weight: e.weight }));

async function projectionOf(t: TestDb, regionId: string): Promise<Map<string, number>> {
  const rows = await t.db
    .select({ slug: species.slug, weight: regionEncounterPools.weight })
    .from(regionEncounterPools)
    .innerJoin(species, eq(species.id, regionEncounterPools.speciesId))
    .where(eq(regionEncounterPools.regionId, regionId));
  return new Map(rows.map((r) => [r.slug, r.weight]));
}

async function speciesOf(t: TestDb, slug: string) {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  return row!;
}

// ── Drafts ──────────────────────────────────────────────────────────────────

describe('drafts', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('reads the bootstrapped pool: draft equals published, nothing unpublished', async () => {
    const view = await w.pools.get('twin-peeks');
    expect(view.region).toEqual({ id: 'twin-peeks', name: 'Twin Peeks', released: true, isDefault: false });
    expect(view.draft.revision).toBe(1);
    expect(view.draft.unpublishedChanges).toBe(false);
    expect(view.published!.number).toBe(1);
    expect(view.published!.source).toBe('bootstrap');
    expect(plain(view.draft.entries)).toEqual(plain(view.published!.entries));
    expect(view.draft.entries[0]).toMatchObject({ enabled: true, inContent: true, dungeonExclusive: false });
    expect(view.issues).toEqual([]);
  });

  it('saves a draft without touching the hunt projection, and audits the actor', async () => {
    const before = await canonicalProjection(w.t.db);
    const view = await w.pools.get('twin-peeks');
    const edited = plain(view.draft.entries).map((e, i) => (i === 0 ? { ...e, weight: e.weight + 5 } : e)).slice(0, -1);
    const saved = await w.pools.saveDraft('twin-peeks', { entries: edited, expectedDraftRevision: 1 }, ADMIN);
    expect(saved.draft.revision).toBe(2);
    expect(saved.draft.unpublishedChanges).toBe(true);
    expect(plain(saved.draft.entries)).toEqual(edited);
    expect(await canonicalProjection(w.t.db)).toEqual(before);
    const [event] = await w.pools.events('twin-peeks', { limit: 1 });
    expect(event).toMatchObject({ action: 'draft_saved', actor: ADMIN });
    expect((event!.details as { diff: { removed: unknown[] } }).diff.removed).toHaveLength(1);
  });

  it('refuses a stale save with the current revision and who wrote it', async () => {
    const err = await w.pools.saveDraft('twin-peeks', { entries: [], expectedDraftRevision: 1 }, 'admin-2').catch((e) => e);
    expect(err.code).toBe('REGION_POOL_STALE');
    expect(err).toMatchObject({ expectedDraftRevision: 1, currentDraftRevision: 2, updatedBy: ADMIN });
  });

  it('refuses unknown, duplicate and badly weighted species with per-entry issues', async () => {
    const err = await w.pools
      .saveDraft(
        'twin-peeks',
        {
          entries: [
            { species: 'alley_catgirl', weight: 1 },
            { species: 'alley_catgirl', weight: 2 },
            { species: 'no_such_waifu', weight: 1 },
            { species: 'cafe_maid', weight: 0 },
            { species: 'Not A Slug', weight: 1 },
          ],
          expectedDraftRevision: 2,
        },
        ADMIN,
      )
      .catch((e) => e);
    expect(err.code).toBe('REGION_POOL_INVALID');
    expect(err.issues.filter((i: { severity: string }) => i.severity === 'error').map((i: { id: string }) => i.id).sort()).toEqual(
      ['entry_invalid:4', 'species_duplicate:alley_catgirl:1', 'species_unknown:no_such_waifu', 'weight_invalid:cafe_maid'].sort(),
    );
    expect((await w.pools.get('twin-peeks')).draft.revision).toBe(2);
  });

  it('refuses a region that does not exist', async () => {
    expect(await codeOf(w.pools.get('atlantis'))).toBe('REGION_POOL_NOT_FOUND');
  });

  it('discards the draft back to the published pool', async () => {
    const discarded = await w.pools.discardDraft('twin-peeks', { expectedDraftRevision: 2 }, ADMIN);
    expect(discarded.draft.revision).toBe(3);
    expect(discarded.draft.unpublishedChanges).toBe(false);
  });
});

// ── Publication ─────────────────────────────────────────────────────────────

describe('publication', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('refuses to publish an unchanged draft', async () => {
    const r = await review(w.pools, 'twin-peeks');
    expect(r.canPublish).toBe(false);
    expect(r.issues.map((i) => i.id)).toEqual(['draft_unchanged']);
    const err = await w.pools
      .publish('twin-peeks', { expectedDraftRevision: 1, reviewHash: r.reviewHash, acknowledgedWarnings: [] }, ADMIN)
      .catch((e) => e);
    expect(err.code).toBe('REGION_POOL_PUBLISH_BLOCKED');
  });

  it('publishes atomically: new revision, pointer, projection and audit together', async () => {
    const view = await w.pools.get('twin-peeks');
    const edited = plain(view.draft.entries).map((e, i) => (i === 0 ? { ...e, weight: 77 } : e));
    await setDraft(w.pools, 'twin-peeks', edited);
    // The projection is still revision 1 until the publish commits.
    expect((await projectionOf(w.t, 'twin-peeks')).get(edited[0]!.species)).not.toBe(77);
    const published = await publishReviewed(w.pools, 'twin-peeks');
    expect(published.published!.number).toBe(2);
    expect(published.published!.source).toBe('editor');
    expect(published.published!.publishedBy).toBe(ADMIN);
    expect(published.draft.unpublishedChanges).toBe(false);
    expect(await projectionOf(w.t, 'twin-peeks')).toEqual(new Map(edited.map((e) => [e.species, e.weight])));
    const events = await w.pools.events('twin-peeks', { limit: 3 });
    expect(events.map((e) => e.action)).toEqual(['published', 'projection_rebuilt', 'draft_saved']);
    expect(events[0]!.details).toMatchObject({ revisionNumber: 2, projectionChanged: true });
    // Revision 1 is untouched.
    const history = await w.pools.history('twin-peeks');
    expect(history.map((h) => [h.number, h.source, h.current])).toEqual([
      [2, 'editor', true],
      [1, 'bootstrap', false],
    ]);
  });

  it('requires every warning to be acknowledged, by id', async () => {
    const view = await w.pools.get('twin-peeks');
    const withoutLr = plain(view.draft.entries).filter((e) => {
      const entry = view.draft.entries.find((x) => x.species === e.species)!;
      return entry.rarity !== 'LR';
    });
    await setDraft(w.pools, 'twin-peeks', withoutLr);
    const r = await review(w.pools, 'twin-peeks');
    expect(r.requiredAcknowledgements).toEqual(['rarity_tier_empty:LR']);
    expect(r.issues.find((i) => i.id === 'rarity_tier_empty:LR')!.message).toContain("Waifu Valley's LR");
    const err = await w.pools
      .publish('twin-peeks', { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: [] }, ADMIN)
      .catch((e) => e);
    expect(err.code).toBe('REGION_POOL_ACKNOWLEDGEMENT_REQUIRED');
    expect(err.missing).toEqual(['rarity_tier_empty:LR']);
    await w.pools.publish(
      'twin-peeks',
      { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: ['rarity_tier_empty:LR'] },
      ADMIN,
    );
    const lr = await w.t.db
      .select({ slug: species.slug })
      .from(regionEncounterPools)
      .innerJoin(species, eq(species.id, regionEncounterPools.speciesId))
      .where(and(eq(regionEncounterPools.regionId, 'twin-peeks'), eq(species.rarity, 'LR')));
    expect(lr).toEqual([]);
  });

  it('invalidates a review when the draft or a species changes after it', async () => {
    const view = await w.pools.get('twin-peeks');
    await setDraft(w.pools, 'twin-peeks', plain(view.published!.entries).slice(0, -1));
    const r = await review(w.pools, 'twin-peeks');
    // A species in the pool is disabled by content after the review.
    const victim = (await w.pools.get('twin-peeks')).draft.entries[0]!.species;
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, victim));
    const err = await w.pools
      .publish('twin-peeks', { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: r.requiredAcknowledgements }, ADMIN)
      .catch((e) => e);
    expect(err.code).toBe('REGION_POOL_REVIEW_STALE');
    expect(err.issues.map((i: { id: string }) => i.id)).toContain(`species_disabled:${victim}`);
    await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, victim));
    // And a draft edit after the review is a plain stale revision.
    const fresh = await review(w.pools, 'twin-peeks');
    await setDraft(w.pools, 'twin-peeks', plain((await w.pools.get('twin-peeks')).draft.entries).slice(0, -1));
    expect(
      await codeOf(
        w.pools.publish(
          'twin-peeks',
          { expectedDraftRevision: fresh.draftRevision, reviewHash: fresh.reviewHash, acknowledgedWarnings: fresh.requiredAcknowledgements },
          ADMIN,
        ),
      ),
    ).toBe('REGION_POOL_STALE');
  });

  it('rolls everything back when the publish fails part-way', async () => {
    const before = await Promise.all([
      canonicalProjection(w.t.db),
      w.t.db.select().from(regionPoolRevisions).orderBy(asc(regionPoolRevisions.id)),
      w.t.db.select().from(regionPools).orderBy(asc(regionPools.regionId)),
      w.t.db.select().from(regionPoolEvents).orderBy(asc(regionPoolEvents.id)),
    ]);
    await w.t.db.execute(sql`
      create function rp2b_fail() returns trigger as $$
      begin
        if new.action = 'published' then raise exception 'injected publish failure'; end if;
        return new;
      end $$ language plpgsql`);
    await w.t.db.execute(sql`create trigger rp2b_fail_trg before insert on region_pool_events for each row execute function rp2b_fail()`);
    try {
      await expect(publishReviewed(w.pools, 'twin-peeks')).rejects.toThrow(/injected publish failure/);
    } finally {
      await w.t.db.execute(sql`drop trigger rp2b_fail_trg on region_pool_events`);
    }
    const after = await Promise.all([
      canonicalProjection(w.t.db),
      w.t.db.select().from(regionPoolRevisions).orderBy(asc(regionPoolRevisions.id)),
      w.t.db.select().from(regionPools).orderBy(asc(regionPools.regionId)),
      w.t.db.select().from(regionPoolEvents).orderBy(asc(regionPoolEvents.id)),
    ]);
    expect(after).toEqual(before);
  });

  it('keeps every published revision immutable', async () => {
    const [rev] = await w.t.db.select().from(regionPoolRevisions).where(eq(regionPoolRevisions.regionId, 'twin-peeks')).limit(1);
    await expect(w.t.db.update(regionPoolRevisions).set({ publishedBy: 'x' }).where(eq(regionPoolRevisions.id, rev!.id))).rejects.toThrow(/immutable/);
    await expect(
      w.t.db.delete(regionPoolRevisionEntries).where(eq(regionPoolRevisionEntries.revisionId, rev!.id)),
    ).rejects.toThrow(/immutable/);
    const one = await w.pools.revision('twin-peeks', 1);
    expect(one.source).toBe('bootstrap');
    expect(one.entries).toHaveLength(40);
    expect(one.speciesManifest).toHaveLength(40);
  });

  it('survives a restart and a legacy Reload Content', async () => {
    const before = await canonicalProjection(w.t.db);
    await applyContent(w.t.db, w.content(), w.t.logger);
    expect(await canonicalProjection(w.t.db)).toEqual(before);
    const reload = createContentReloader({
      db: w.t.db,
      contentDir: path.join(ROOT, 'content'),
      assetsDir: path.join(ROOT, 'assets'),
      logger: w.t.logger,
    });
    const result = await reload();
    expect(result.regionPools.shippedDrift).toContain('twin-peeks');
    expect(await canonicalProjection(w.t.db)).toEqual(before);
  });
});

// ── Exclusivity ─────────────────────────────────────────────────────────────

describe('region-exclusive species', () => {
  let w: World;
  let exclusive: string;
  beforeAll(async () => {
    w = await world();
    // A Twin Peeks exclusive, freed from Twin Peeks so two other regions can race for her.
    const peeks = await w.pools.get('twin-peeks');
    exclusive = peeks.draft.entries.find((e) => e.regionExclusive && e.rarity === 'N')!.species;
    await setDraft(w.pools, 'twin-peeks', plain(peeks.draft.entries).filter((e) => e.species !== exclusive));
    await publishReviewed(w.pools, 'twin-peeks');
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('is a draft warning but a publish error while another region publishes her', async () => {
    const thirst = await w.pools.get('thirstlands');
    await setDraft(w.pools, 'thirstlands', [...plain(thirst.draft.entries), { species: exclusive, weight: 1 }]);
    await publishReviewed(w.pools, 'thirstlands');

    const foot = await w.pools.get('flaccid-foothills');
    const saved = await setDraft(w.pools, 'flaccid-foothills', [...plain(foot.draft.entries), { species: exclusive, weight: 1 }]);
    expect(saved.issues.find((i) => i.code === 'region_exclusive_conflict')).toMatchObject({
      severity: 'warning',
      regions: ['thirstlands'],
    });
    const r = await review(w.pools, 'flaccid-foothills');
    expect(r.canPublish).toBe(false);
    expect(await codeOf(publishReviewed(w.pools, 'flaccid-foothills'))).toBe('REGION_POOL_PUBLISH_BLOCKED');
    // Restore Thirstlands for the race below.
    const t2 = await w.pools.get('thirstlands');
    await setDraft(w.pools, 'thirstlands', plain(t2.draft.entries).filter((e) => e.species !== exclusive));
    await publishReviewed(w.pools, 'thirstlands');
  });

  it('two regions publishing her at once: exactly one wins', async () => {
    const foot = await w.pools.get('flaccid-foothills');
    expect(foot.draft.entries.some((e) => e.species === exclusive)).toBe(true);
    const base = await w.pools.get('base-80085');
    await setDraft(w.pools, 'base-80085', [...plain(base.draft.entries), { species: exclusive, weight: 1 }]);
    const [a, b] = await Promise.all([review(w.pools, 'flaccid-foothills'), review(w.pools, 'base-80085')]);
    expect(a.canPublish && b.canPublish).toBe(true);
    const results = await Promise.allSettled([
      w.pools.publish('flaccid-foothills', { expectedDraftRevision: a.draftRevision, reviewHash: a.reviewHash, acknowledgedWarnings: a.requiredAcknowledgements }, 'a'),
      w.pools.publish('base-80085', { expectedDraftRevision: b.draftRevision, reviewHash: b.reviewHash, acknowledgedWarnings: b.requiredAcknowledgements }, 'b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['REGION_POOL_REVIEW_STALE', 'REGION_POOL_PUBLISH_BLOCKED']).toContain(loser.reason.code);
    const holders = await w.t.db
      .select({ regionId: regionEncounterPools.regionId })
      .from(regionEncounterPools)
      .innerJoin(species, eq(species.id, regionEncounterPools.speciesId))
      .where(eq(species.slug, exclusive));
    expect(holders).toHaveLength(1);
  });
});

// ── Species policy, rollback and drift ──────────────────────────────────────

describe('species policy, rollback and drift', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('never lets a dungeon-exclusive species into a draft', async () => {
    const view = await w.pools.get('waifu-valley');
    const slug = view.draft.entries[0]!.species;
    await w.t.db.update(species).set({ tags: sql`${species.tags} || '["dungeon_exclusive"]'::jsonb` }).where(eq(species.slug, slug));
    try {
      const err = await w.pools
        .saveDraft('waifu-valley', { entries: plain(view.draft.entries).slice(0, -1), expectedDraftRevision: view.draft.revision }, ADMIN)
        .catch((e) => e);
      expect(err.code).toBe('REGION_POOL_INVALID');
      expect(err.issues.map((i: { id: string }) => i.id)).toEqual([`species_dungeon_exclusive:${slug}`]);
    } finally {
      await w.t.db.update(species).set({ tags: sql`${species.tags} - 'dungeon_exclusive'` }).where(eq(species.slug, slug));
    }
  });

  it('warns about disabled and never-huntable (EX) species', async () => {
    const view = await w.pools.get('waifu-valley');
    const disabled = view.draft.entries[1]!.species;
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, disabled));
    const ex = await speciesOf(w.t, view.draft.entries[2]!.species);
    const { id: _id, ...exRow } = ex;
    await w.t.db.insert(species).values({ ...exRow, slug: 'rp2b_ex_test', rarity: 'EX' });
    const saved = await setDraft(w.pools, 'waifu-valley', [...plain(view.draft.entries), { species: 'rp2b_ex_test', weight: 1 }]);
    const ids = saved.issues.map((i) => i.id);
    expect(ids).toContain(`species_disabled:${disabled}`);
    expect(ids).toContain('species_not_huntable:rp2b_ex_test');
    expect(ids).toContain('species_not_in_content:rp2b_ex_test');
    const r = await review(w.pools, 'waifu-valley');
    expect(r.requiredAcknowledgements).toEqual(
      expect.arrayContaining([`species_disabled:${disabled}`, 'species_not_huntable:rp2b_ex_test']),
    );
    await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, disabled));
    await w.pools.discardDraft('waifu-valley', { expectedDraftRevision: saved.draft.revision }, ADMIN);
  });

  it('rolls back to a valid revision as a new revision, restoring draft and projection', async () => {
    const original = await w.pools.get('twin-peeks');
    await setDraft(w.pools, 'twin-peeks', plain(original.draft.entries).slice(0, 10));
    await publishReviewed(w.pools, 'twin-peeks');
    expect((await projectionOf(w.t, 'twin-peeks')).size).toBe(10);

    const preview = await w.pools.rollbackPreview('twin-peeks', 1);
    expect(preview.canPublish).toBe(true);
    expect(preview.diffFromPublished.added).toHaveLength(30);
    const rolled = await w.pools.rollback(
      'twin-peeks',
      { revision: 1, expectedDraftRevision: preview.draftRevision, reviewHash: preview.reviewHash, acknowledgedWarnings: preview.requiredAcknowledgements },
      ADMIN,
    );
    expect(rolled.published).toMatchObject({ number: 3, source: 'rollback', rolledBackFrom: 1 });
    expect(plain(rolled.draft.entries)).toEqual(plain(original.draft.entries));
    expect(rolled.draft.unpublishedChanges).toBe(false);
    expect(await projectionOf(w.t, 'twin-peeks')).toEqual(new Map(plain(original.draft.entries).map((e) => [e.species, e.weight])));
    const [event] = await w.pools.events('twin-peeks', { limit: 1 });
    expect(event).toMatchObject({ action: 'rolled_back', actor: ADMIN, details: { fromRevisionNumber: 1, revisionNumber: 3 } });
    expect(await codeOf(w.pools.rollbackPreview('twin-peeks', 99))).toBe('REGION_POOL_REVISION_NOT_FOUND');
  });

  it('refuses a rollback that is no longer valid today, with actionable issues', async () => {
    // Revision 2 (ten species) is the target; one of them is now dungeon-exclusive.
    const two = await w.pools.revision('twin-peeks', 2);
    const slug = two.entries[0]!.species;
    await w.t.db.update(species).set({ tags: sql`${species.tags} || '["dungeon_exclusive"]'::jsonb` }).where(eq(species.slug, slug));
    try {
      const preview = await w.pools.rollbackPreview('twin-peeks', 2);
      expect(preview.canPublish).toBe(false);
      expect(preview.issues.filter((i) => i.severity === 'error').map((i) => i.id)).toEqual([`species_dungeon_exclusive:${slug}`]);
      const err = await w.pools
        .rollback('twin-peeks', { revision: 2, expectedDraftRevision: preview.draftRevision, reviewHash: preview.reviewHash, acknowledgedWarnings: preview.requiredAcknowledgements }, ADMIN)
        .catch((e) => e);
      expect(err.code).toBe('REGION_POOL_PUBLISH_BLOCKED');
      expect((await w.pools.get('twin-peeks')).published!.number).toBe(3);
    } finally {
      await w.t.db.update(species).set({ tags: sql`${species.tags} - 'dungeon_exclusive'` }).where(eq(species.slug, slug));
    }
  });

  it('reports published species drift and never rewrites the published pool', async () => {
    const view = await w.pools.get('thirstlands');
    expect((await w.pools.drift('thirstlands')).status).toBe('clean');
    const lr = view.published!.entries.filter((e) => e.rarity === 'LR').map((e) => e.species);
    const disabledOne = view.published!.entries.find((e) => e.rarity === 'N')!.species;
    const rerated = view.published!.entries.find((e) => e.rarity === 'R')!.species;
    const before = await canonicalProjection(w.t.db);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, disabledOne));
    await w.t.db.update(species).set({ rarity: 'SR' }).where(eq(species.slug, rerated));
    for (const slug of lr) await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, slug));

    const drift = await w.pools.drift('thirstlands');
    expect(drift.status).toBe('drift');
    expect(drift.species).toEqual(
      expect.arrayContaining([
        { species: disabledOne, kind: 'disabled' },
        { species: rerated, kind: 'rarity_changed', from: 'R', to: 'SR' },
        ...lr.map((s) => ({ species: s, kind: 'disabled' })),
      ]),
    );
    expect(drift.emptyTiers).toEqual([{ rarity: 'LR', causedByContent: true }]);
    expect(await canonicalProjection(w.t.db)).toEqual(before);
    expect((await w.pools.list()).find((r) => r.region.id === 'thirstlands')!.driftStatus).toBe('drift');

    await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, disabledOne));
    await w.t.db.update(species).set({ rarity: 'R' }).where(eq(species.slug, rerated));
    for (const slug of lr) await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, slug));
    expect((await w.pools.drift('thirstlands')).status).toBe('clean');
  });
});

// ── Shipped JSON ────────────────────────────────────────────────────────────

describe('the shipped region file', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('drifts without overwriting, loads into the draft only on request, and never publishes', async () => {
    const shippedFile = w.content().regions.find((r) => r.id === 'base-80085')!;
    const first = shippedFile.encounterPool[0]!;
    const changed: LoadedContent = {
      ...w.content(),
      regions: w.content().regions.map((r) =>
        r.id === 'base-80085' ? { ...r, encounterPool: [{ ...first, weight: 99 }, ...r.encounterPool.slice(1)] } : r,
      ),
    };
    w.setContent(changed);
    await applyContent(w.t.db, changed, w.t.logger);
    const before = await canonicalProjection(w.t.db);

    const drift = await w.pools.drift('base-80085');
    expect(drift.shipped).toMatchObject({ available: true, differs: true });
    expect(drift.shipped.diff!.reweighted).toEqual([{ species: first.species, from: first.weight, to: 99 }]);

    const shipped = await w.pools.shipped('base-80085');
    expect(shipped.weightConflicts).toEqual([{ species: first.species, draft: first.weight, shipped: 99 }]);
    expect(shipped.mergeCandidates).toEqual([]);

    const view = await w.pools.get('base-80085');
    const loaded = await w.pools.loadShippedIntoDraft('base-80085', { expectedDraftRevision: view.draft.revision }, ADMIN);
    expect(loaded.draft.entries[0]).toMatchObject({ species: first.species, weight: 99 });
    expect(loaded.published!.number).toBe(1);
    expect(await canonicalProjection(w.t.db)).toEqual(before);
    const [event] = await w.pools.events('base-80085', { limit: 1 });
    expect(event!.action).toBe('draft_reset_to_shipped');
  });

  it('merges newly shipped species into the draft without removing or reweighting anything', async () => {
    const view = await w.pools.get('base-80085');
    const draft = plain(view.draft.entries);
    // An admin dropped two species and reweighted a third; the file still ships all three.
    const [gone1, gone2, kept] = [draft[3]!, draft[4]!, draft[5]!];
    const edited = draft.filter((e) => e !== gone1 && e !== gone2).map((e) => (e === kept ? { ...e, weight: kept.weight + 4 } : e));
    const saved = await setDraft(w.pools, 'base-80085', edited);
    const shipped = await w.pools.shipped('base-80085');
    expect(shipped.mergeCandidates.map((e) => e.species)).toEqual([gone1.species, gone2.species]);
    expect(shipped.weightConflicts.map((c) => c.species)).toContain(kept.species);

    const merged = await w.pools.mergeShippedIntoDraft('base-80085', { expectedDraftRevision: saved.draft.revision, species: [gone2.species] }, ADMIN);
    expect(plain(merged.draft.entries)).toEqual([...edited, gone2]);
    expect(await codeOf(w.pools.mergeShippedIntoDraft('base-80085', { expectedDraftRevision: merged.draft.revision, species: [kept.species] }, ADMIN))).toBe(
      'REGION_POOL_INVALID',
    );
    const all = await w.pools.mergeShippedIntoDraft('base-80085', { expectedDraftRevision: merged.draft.revision }, ADMIN);
    expect(plain(all.draft.entries)).toEqual([...edited, gone2, gone1]);
    expect(all.draft.entries.find((e) => e.species === kept.species)!.weight).toBe(kept.weight + 4);
  });
});

// ── Hunting while publishing ────────────────────────────────────────────────

describe('hunting during a publish', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('a concurrent reader only ever sees the whole old pool or the whole new one', async () => {
    const view = await w.pools.get('assteroid-belt');
    const oldPool = new Map(plain(view.draft.entries).map((e) => [e.species, e.weight]));
    const next = plain(view.draft.entries).map((e) => ({ ...e, weight: e.weight + 1 })).slice(0, -3);
    const newPool = new Map(next.map((e) => [e.species, e.weight]));
    await setDraft(w.pools, 'assteroid-belt', next);
    const r = await review(w.pools, 'assteroid-belt');

    const seen: Array<'old' | 'new'> = [];
    let done = false;
    const reader = (async () => {
      while (!done) {
        const snapshot = await projectionOf(w.t, 'assteroid-belt');
        const same = (m: Map<string, number>) => m.size === snapshot.size && [...m].every(([k, v]) => snapshot.get(k) === v);
        if (same(oldPool)) seen.push('old');
        else if (same(newPool)) seen.push('new');
        else throw new Error(`mixed projection of ${snapshot.size} rows`);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    await w.pools.publish('assteroid-belt', { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: r.requiredAcknowledgements }, ADMIN);
    await new Promise((r) => setTimeout(r, 20));
    done = true;
    await reader;
    expect(seen[0]).toBe('old');
    expect(seen.at(-1)).toBe('new');
    expect(seen.slice(seen.indexOf('new'))).not.toContain('old');
  });

  it('hunts during the publish draw from the old or the new pool, never anything else', async () => {
    const { playerId } = await provisionPlayer(w.app, 'g-rp2b', 'u-hunter');
    await w.t.db.execute(sql`update players set current_region = 'assteroid-belt' where id = ${playerId}`);
    const view = await w.pools.get('assteroid-belt');
    const before = new Set(view.published!.entries.map((e) => e.species));
    // Swap to a pool that shares nobody with the current one: every rarity from Waifu Valley's.
    const valley = await w.pools.get('waifu-valley');
    const after = plain(valley.published!.entries).filter((e) => !before.has(e.species)).slice(0, 60);
    await setDraft(w.pools, 'assteroid-belt', after);
    const r = await review(w.pools, 'assteroid-belt');
    const allowed = new Set([...before, ...after.map((e) => e.species)]);

    const draws: string[] = [];
    let done = false;
    const hunter = (async () => {
      while (!done) {
        const picked = await w.app.hunt.pickSpeciesForSpawn(w.t.db, playerId, 1, 'assteroid-belt');
        draws.push(picked!.slug);
      }
    })();
    await new Promise((res) => setTimeout(res, 20));
    await w.pools.publish('assteroid-belt', { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: r.requiredAcknowledgements }, ADMIN);
    const afterPublish = draws.length;
    await new Promise((res) => setTimeout(res, 50));
    done = true;
    await hunter;
    expect(draws.every((s) => allowed.has(s))).toBe(true);
    // Every draw that started after the commit came from the new pool.
    const fresh = draws.slice(afterPublish + 1);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((s) => !before.has(s) || after.some((e) => e.species === s))).toBe(true);
  });
});
