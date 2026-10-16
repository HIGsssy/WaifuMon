/**
 * A stand-in Region Pools API for browser tests that keeps the parts that
 * matter real: every issue comes from the server's own `validateRegionPool`,
 * and every probability from the server's own `describeRegionDistribution` /
 * `diffDistributions` over the shipped `content/tables.json`. The draft
 * revision check, the review fingerprint, the acknowledgement gate and the
 * rollback rules follow `regionPoolService.ts`.
 *
 * Backend modules are imported at test runtime only, like `dungeonBackend.ts`;
 * nothing from `src/` reaches the Portal bundle.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATION = '../../src/modules/regionPools/regionPoolValidation';
const DISTRIBUTION = '../../src/modules/regionPools/regionPoolDistribution';

export interface FakeSpecies {
  slug: string;
  name: string;
  rarity: string;
  enabled: boolean;
  tags: string[];
  race: string;
  affinity: string;
}
export interface FakeRegion {
  id: string;
  name: string;
  released: boolean;
  isDefault: boolean;
  shipped: Array<{ species: string; weight: number }> | null;
}
interface Entry {
  species: string;
  weight: number;
}
interface Revision {
  number: number;
  source: 'bootstrap' | 'editor' | 'rollback';
  rolledBackFrom: number | null;
  publishedAt: string;
  publishedBy: string | null;
  entries: Entry[];
}
interface Pool {
  draft: Entry[];
  draftRevision: number;
  updatedAt: string;
  updatedBy: string | null;
  revisions: Revision[];
}
interface Event {
  cursor: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

const ACTOR = '123456789012345678';
const REGION_EXCLUSIVE = 'region_exclusive';
const DUNGEON_EXCLUSIVE = 'dungeon_exclusive';
const meta = { requestId: 'region-pool-backend' };
const now = () => new Date('2026-10-15T12:00:00.000Z').toISOString();

const tables = (() => {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'content/tables.json'), 'utf8'));
  return {
    hunt: { rarityTable: raw.hunt.rarityTable, resultTable: raw.hunt.resultTable },
    progression: { rareEncounterShift: raw.progression.rareEncounterShift },
  };
})();
const HUNTED = tables.hunt.rarityTable
  .filter((r: { weight: number }) => r.weight > 0)
  .map((r: { rarity: string }) => r.rarity) as string[];

const sameEntries = (a: Entry[], b: Entry[]) =>
  a.length === b.length &&
  a.every((e, i) => e.species === b[i]!.species && e.weight === b[i]!.weight);
const toMap = (list: Entry[]) => new Map(list.map((e) => [e.species, e.weight]));
function diff(before: Entry[], after: Entry[]) {
  const b = toMap(before);
  const a = toMap(after);
  return {
    added: after.filter((e) => !b.has(e.species)),
    removed: before.filter((e) => !a.has(e.species)),
    reweighted: after
      .filter((e) => b.has(e.species) && b.get(e.species) !== e.weight)
      .map((e) => ({ species: e.species, from: b.get(e.species)!, to: e.weight })),
  };
}

/** A 2×2 PNG, so the thumbnail decodes as a real image in the browser. */
const THUMBNAIL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=',
  'base64',
);

export class RegionPoolBackend {
  readonly species: Map<string, FakeSpecies>;
  readonly regions: FakeRegion[];
  readonly pools = new Map<string, Pool>();
  readonly events = new Map<string, Event[]>();
  readonly publishes: Array<{ regionId: string; body: unknown }> = [];
  /** Species with no artwork on the server: the thumbnail route answers 404 for them. */
  readonly missingArtwork = new Set<string>(['alley_cat']);
  /** Slugs the thumbnail route was asked for, in order. */
  readonly artworkRequests: string[] = [];
  private nextCursor = 1;

  constructor(species: FakeSpecies[], regions: FakeRegion[], published: Record<string, Entry[]>) {
    this.species = new Map(species.map((s) => [s.slug, s]));
    this.regions = regions;
    for (const r of regions) {
      const entries = published[r.id] ?? [];
      this.pools.set(r.id, {
        draft: [...entries],
        draftRevision: 1,
        updatedAt: '2026-10-01T09:00:00.000Z',
        updatedBy: null,
        revisions: [
          {
            number: 1,
            source: 'bootstrap',
            rolledBackFrom: null,
            publishedAt: '2026-10-01T09:00:00.000Z',
            publishedBy: null,
            entries: [...entries],
          },
        ],
      });
      this.events.set(r.id, []);
      this.record(r.id, 'bootstrapped', null, { revisionNumber: 1 });
    }
  }

  /** Another administrator saves the draft (the stale-draft case). */
  saveAsSomeoneElse(regionId: string, entries: Entry[]) {
    const pool = this.pools.get(regionId)!;
    pool.draft = entries;
    pool.draftRevision += 1;
    pool.updatedBy = '999999999999999999';
    pool.updatedAt = now();
    this.record(regionId, 'draft_saved', pool.updatedBy, { draftRevision: pool.draftRevision });
  }

  private record(
    regionId: string,
    action: string,
    actor: string | null,
    details: Record<string, unknown>,
  ) {
    this.events
      .get(regionId)!
      .unshift({ cursor: String(this.nextCursor++), action, actor, details, createdAt: now() });
  }

  private region(id: string) {
    return this.regions.find((r) => r.id === id) ?? null;
  }
  private published(pool: Pool) {
    return pool.revisions[pool.revisions.length - 1]!;
  }
  private facts() {
    return new Map(
      [...this.species.values()].map((s) => [
        s.slug,
        {
          ...s,
          inContent: true,
          perSpeciesWeight: 1,
          imagePath: `waifumon/${s.slug}/standard.png`,
        },
      ]),
    );
  }
  private otherPublished(regionId: string) {
    return new Map(
      this.regions
        .filter((r) => r.id !== regionId)
        .map((r) => [
          r.id,
          new Set(this.published(this.pools.get(r.id)!).entries.map((e) => e.species)),
        ]),
    );
  }

  private async validate(regionId: string, entries: Entry[], purpose: 'draft' | 'publish') {
    const { validateRegionPool } = await import(VALIDATION);
    const region = this.region(regionId)!;
    const fallback = this.regions.find((r) => r.isDefault);
    return validateRegionPool({
      regionId,
      region: { ...region, shippedPool: null },
      entries,
      facts: this.facts(),
      huntedRarities: HUNTED,
      otherPublished: this.otherPublished(regionId),
      fallbackRegionName: fallback && fallback.id !== regionId ? fallback.name : null,
      purpose,
    }) as Array<{ id: string; severity: string; acknowledgementRequired: boolean }>;
  }

  private async review(regionId: string, purpose: string, entries: Entry[]) {
    const pool = this.pools.get(regionId)!;
    const issues: Array<
      Record<string, unknown> & { id: string; severity: string; acknowledgementRequired: boolean }
    > = await this.validate(regionId, entries, 'publish');
    const live = this.published(pool).entries;
    if (sameEntries(entries, live)) {
      issues.push(
        purpose === 'publish'
          ? {
              id: 'draft_unchanged',
              code: 'draft_unchanged',
              severity: 'error',
              message: 'The draft is identical to the published pool; there is nothing to publish.',
              acknowledgementRequired: false,
            }
          : {
              id: 'revision_already_published',
              code: 'revision_already_published',
              severity: 'error',
              message: 'That revision has the same pool as the one already published.',
              acknowledgementRequired: false,
            },
      );
    }
    if (purpose !== 'publish' && !sameEntries(pool.draft, live)) {
      issues.push({
        id: 'draft_replaced_by_rollback',
        code: 'draft_replaced_by_rollback',
        severity: 'warning',
        message:
          'The draft has unpublished changes; rolling back replaces the draft with the restored pool.',
        acknowledgementRequired: true,
      });
    }
    const facts = entries.map((e) => this.species.get(e.species) ?? null);
    const reviewHash =
      'sha256:' +
      createHash('sha256')
        .update(
          JSON.stringify({ purpose, regionId, rev: pool.draftRevision, entries, facts, issues }),
        )
        .digest('hex');
    return {
      purpose,
      draftRevision: pool.draftRevision,
      issues,
      requiredAcknowledgements: issues
        .filter((i) => i.severity === 'warning' && i.acknowledgementRequired)
        .map((i) => i.id),
      reviewHash,
      canPublish: !issues.some((i) => i.severity === 'error'),
      diffFromPublished: diff(live, entries),
    };
  }

  private entryView(e: Entry) {
    const s = this.species.get(e.species);
    return {
      ...e,
      name: s?.name ?? null,
      rarity: s?.rarity ?? null,
      enabled: s?.enabled ?? false,
      inContent: Boolean(s),
      regionExclusive: s?.tags.includes(REGION_EXCLUSIVE) ?? false,
      dungeonExclusive: s?.tags.includes(DUNGEON_EXCLUSIVE) ?? false,
      race: s?.race ?? null,
      affinity: s?.affinity ?? null,
      imagePath: s ? `waifumon/${s.slug}/standard.png` : null,
    };
  }
  private meta(rev: Revision) {
    return {
      number: rev.number,
      source: rev.source,
      rolledBackFrom: rev.rolledBackFrom,
      publishedAt: rev.publishedAt,
      publishedBy: rev.publishedBy,
      contentHash: `sha256:${rev.number}`,
      entryCount: rev.entries.length,
    };
  }
  private regionRef(r: FakeRegion) {
    return { id: r.id, name: r.name, released: r.released, isDefault: r.isDefault };
  }
  async view(regionId: string) {
    const pool = this.pools.get(regionId)!;
    const pub = this.published(pool);
    return {
      region: this.regionRef(this.region(regionId)!),
      draft: {
        revision: pool.draftRevision,
        hash: 'sha256:' + createHash('sha256').update(JSON.stringify(pool.draft)).digest('hex'),
        entries: pool.draft.map((e) => this.entryView(e)),
        updatedAt: pool.updatedAt,
        updatedBy: pool.updatedBy,
        unpublishedChanges: !sameEntries(pool.draft, pub.entries),
      },
      published: { ...this.meta(pub), entries: pub.entries.map((e) => this.entryView(e)) },
      issues: await this.validate(regionId, pool.draft, 'draft'),
    };
  }

  private async analyse(
    regionId: string,
    body: {
      source: 'draft' | 'published';
      mode: string;
      level: number;
      filter?: unknown;
      compare?: boolean;
      ownedSpecies?: string[];
    },
  ) {
    const { describeRegionDistribution, diffDistributions } = await import(DISTRIBUTION);
    const pool = this.pools.get(regionId)!;
    const valley = this.regions.find((r) => r.isDefault)!;
    const species = new Map(
      [...this.species.values()].map((s) => [s.slug, { ...s, perSpeciesWeight: 1 }]),
    );
    const run = (source: 'draft' | 'published') =>
      describeRegionDistribution({
        mode: body.mode,
        level: body.level ?? 1,
        regionId,
        defaultRegionId: valley.id,
        pool: source === 'draft' ? pool.draft : this.published(pool).entries,
        defaultPool: valley.released ? this.published(this.pools.get(valley.id)!).entries : [],
        species,
        tables,
        buddyBonus: null,
        ownedSpecies: new Set(body.ownedSpecies ?? []),
        ...(body.filter ? { filter: body.filter } : {}),
      });
    const result = run(body.source);
    const against = body.source === 'draft' ? 'published' : 'draft';
    const comparison = body.compare
      ? (() => {
          const other = run(against);
          return { against, result: other, diff: diffDistributions(other, result) };
        })()
      : null;
    return {
      source: body.source,
      assumptions: [
        `Player level ${body.level}${body.level >= 40 ? ' (rare-encounter shift applies)' : ''}.`,
        body.mode === 'hunt' ? 'No Buddy equipped.' : 'No Buddy Bonus applies in this mode.',
        'Owned species assumed: none.',
        `Fallback pool: ${valley.name} as currently projected; global tier from current species.`,
      ],
      result,
      comparison,
    };
  }

  private fail(route: Route, status: number, code: string, message: string, details?: unknown) {
    return route.fulfill({
      status,
      json: { error: { code, message, ...(details ? { details } : {}) }, meta },
    });
  }
  private ok(route: Route, data: unknown) {
    return route.fulfill({ json: { data, meta } });
  }
  private stale(route: Route, pool: Pool, expected: number) {
    return this.fail(
      route,
      409,
      'REGION_POOL_STALE',
      'Someone else changed this draft. Reload to see it.',
      {
        expectedDraftRevision: expected,
        currentDraftRevision: pool.draftRevision,
        updatedBy: pool.updatedBy,
        updatedAt: pool.updatedAt,
      },
    );
  }

  private async writeDraft(
    route: Route,
    regionId: string,
    expected: number,
    entries: Entry[],
    action: string,
  ) {
    const pool = this.pools.get(regionId)!;
    if (expected !== pool.draftRevision) return this.stale(route, pool, expected);
    const issues = await this.validate(regionId, entries, 'draft');
    if (issues.some((i) => i.severity === 'error'))
      return this.fail(route, 400, 'REGION_POOL_INVALID', 'That pool cannot be saved.', { issues });
    pool.draft = entries;
    pool.draftRevision += 1;
    pool.updatedBy = ACTOR;
    pool.updatedAt = now();
    this.record(regionId, action, ACTOR, { draftRevision: pool.draftRevision });
    return this.ok(route, await this.view(regionId));
  }

  private async gate(
    route: Route,
    regionId: string,
    body: { expectedDraftRevision: number; reviewHash: string; acknowledgedWarnings?: string[] },
    purpose: string,
    entries: Entry[],
  ) {
    const pool = this.pools.get(regionId)!;
    if (body.expectedDraftRevision !== pool.draftRevision) {
      await this.stale(route, pool, body.expectedDraftRevision);
      return false;
    }
    const fresh = await this.review(regionId, purpose, entries);
    if (fresh.reviewHash !== body.reviewHash) {
      await this.fail(
        route,
        409,
        'REGION_POOL_REVIEW_STALE',
        'Something reviewed changed. Validate again.',
        { issues: fresh.issues, reviewHash: fresh.reviewHash },
      );
      return false;
    }
    if (!fresh.canPublish) {
      await this.fail(route, 422, 'REGION_POOL_PUBLISH_BLOCKED', 'This pool cannot be published.', {
        issues: fresh.issues,
      });
      return false;
    }
    const missing = fresh.requiredAcknowledgements.filter(
      (id) => !(body.acknowledgedWarnings ?? []).includes(id),
    );
    if (missing.length) {
      await this.fail(
        route,
        422,
        'REGION_POOL_ACKNOWLEDGEMENT_REQUIRED',
        'Acknowledge every warning first.',
        { missing, issues: fresh.issues },
      );
      return false;
    }
    return true;
  }

  async install(page: Page) {
    await page.route('**/api/v1/admin/region-pools**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname
        .replace(/^.*\/admin\/region-pools\/?/, '')
        .split('/')
        .filter(Boolean);
      const method = request.method();
      const body = method === 'GET' ? {} : (request.postDataJSON() ?? {});

      if (parts.length === 0) {
        return this.ok(route, {
          regions: this.regions.map((r) => {
            const pool = this.pools.get(r.id)!;
            const pub = this.published(pool);
            const counts: Record<string, number> = {};
            for (const e of pub.entries) {
              const rarity = this.species.get(e.species)?.rarity ?? 'unknown';
              counts[rarity] = (counts[rarity] ?? 0) + 1;
            }
            return {
              region: this.regionRef(r),
              hasPool: true,
              draftRevision: pool.draftRevision,
              unpublishedChanges: !sameEntries(pool.draft, pub.entries),
              published: this.meta(pub),
              rarityCounts: counts,
              driftStatus: 'clean',
            };
          }),
        });
      }
      if (parts[0] === 'species' && parts[1] === 'artwork' && parts.length === 2) {
        const slug = url.searchParams.get('slug') ?? '';
        this.artworkRequests.push(slug);
        if (!this.species.has(slug) || this.missingArtwork.has(slug)) {
          return this.fail(route, 404, 'NOT_FOUND', 'No artwork for that WaifuMon.');
        }
        return route.fulfill({ status: 200, contentType: 'image/png', body: THUMBNAIL_PNG });
      }
      if (parts[0] === 'species' && parts.length === 1) {
        return this.ok(route, {
          species: [...this.species.values()].map((s) => ({
            slug: s.slug,
            name: s.name,
            rarity: s.rarity,
            enabled: s.enabled,
            inContent: true,
            huntable: HUNTED.includes(s.rarity),
            regionExclusive: s.tags.includes(REGION_EXCLUSIVE),
            dungeonExclusive: s.tags.includes(DUNGEON_EXCLUSIVE),
            race: s.race,
            affinity: s.affinity,
            imagePath: `waifumon/${s.slug}/standard.png`,
            publishedIn: this.regions
              .filter((r) =>
                this.published(this.pools.get(r.id)!).entries.some((e) => e.species === s.slug),
              )
              .map((r) => r.id),
          })),
        });
      }

      const regionId = parts[0]!;
      const region = this.region(regionId);
      if (!region) return this.fail(route, 404, 'REGION_POOL_NOT_FOUND', 'No such region.');
      const pool = this.pools.get(regionId)!;
      const rest = parts.slice(1).join('/');

      if (rest === '' && method === 'GET') return this.ok(route, await this.view(regionId));
      if (rest === 'draft' && method === 'PUT')
        return this.writeDraft(
          route,
          regionId,
          body.expectedDraftRevision,
          body.entries,
          'draft_saved',
        );
      if (rest === 'draft/discard')
        return this.writeDraft(
          route,
          regionId,
          body.expectedDraftRevision,
          [...this.published(pool).entries],
          'draft_discarded',
        );
      if (rest === 'shipped') {
        const shipped = region.shipped ?? [];
        const draftMap = toMap(pool.draft);
        return this.ok(route, {
          available: region.shipped !== null,
          hash: region.shipped ? 'sha256:shipped' : null,
          entries: shipped,
          skipped: [],
          diffFromDraft: diff(pool.draft, shipped),
          diffFromPublished: diff(this.published(pool).entries, shipped),
          mergeCandidates: shipped.filter((e) => !draftMap.has(e.species)),
          weightConflicts: shipped
            .filter((e) => draftMap.has(e.species) && draftMap.get(e.species) !== e.weight)
            .map((e) => ({
              species: e.species,
              draft: draftMap.get(e.species)!,
              shipped: e.weight,
            })),
        });
      }
      if (rest === 'draft/load-shipped')
        return this.writeDraft(
          route,
          regionId,
          body.expectedDraftRevision,
          [...(region.shipped ?? [])],
          'draft_reset_to_shipped',
        );
      if (rest === 'draft/merge-shipped') {
        const have = new Set(pool.draft.map((e) => e.species));
        const wanted = body.species ? new Set<string>(body.species) : null;
        const add = (region.shipped ?? []).filter(
          (e) => !have.has(e.species) && (!wanted || wanted.has(e.species)),
        );
        return this.writeDraft(
          route,
          regionId,
          body.expectedDraftRevision,
          [...pool.draft, ...add],
          'draft_saved',
        );
      }
      if (rest === 'validate') {
        if (Array.isArray(body.entries))
          return this.ok(route, { issues: await this.validate(regionId, body.entries, 'draft') });
        return this.ok(route, await this.review(regionId, 'publish', pool.draft));
      }
      if (rest === 'publish') {
        this.publishes.push({ regionId, body });
        if (!(await this.gate(route, regionId, body, 'publish', pool.draft))) return;
        const number = this.published(pool).number + 1;
        pool.revisions.push({
          number,
          source: 'editor',
          rolledBackFrom: null,
          publishedAt: now(),
          publishedBy: ACTOR,
          entries: [...pool.draft],
        });
        this.record(regionId, 'published', ACTOR, {
          revisionNumber: number,
          acknowledgedWarnings: body.acknowledgedWarnings ?? [],
        });
        return this.ok(route, await this.view(regionId));
      }
      if (rest === 'revisions') {
        const live = this.published(pool).number;
        return this.ok(route, {
          revisions: [...pool.revisions]
            .reverse()
            .map((r) => ({ ...this.meta(r), current: r.number === live })),
        });
      }
      const revMatch = /^revisions\/(\d+)(\/rollback-preview)?$/.exec(rest);
      if (revMatch) {
        const target = pool.revisions.find((r) => r.number === Number(revMatch[1]));
        if (!target)
          return this.fail(route, 404, 'REGION_POOL_REVISION_NOT_FOUND', 'No such revision.');
        if (revMatch[2])
          return this.ok(
            route,
            await this.review(regionId, `rollback:${target.number}`, target.entries),
          );
        return this.ok(route, {
          ...this.meta(target),
          current: target.number === this.published(pool).number,
          entries: target.entries.map((e) => this.entryView(e)),
          speciesManifest: [],
        });
      }
      if (rest === 'rollback') {
        const target = pool.revisions.find((r) => r.number === body.revision);
        if (!target)
          return this.fail(route, 404, 'REGION_POOL_REVISION_NOT_FOUND', 'No such revision.');
        if (!(await this.gate(route, regionId, body, `rollback:${target.number}`, target.entries)))
          return;
        const number = this.published(pool).number + 1;
        pool.revisions.push({
          number,
          source: 'rollback',
          rolledBackFrom: target.number,
          publishedAt: now(),
          publishedBy: ACTOR,
          entries: [...target.entries],
        });
        pool.draft = [...target.entries];
        pool.draftRevision += 1;
        this.record(regionId, 'rolled_back', ACTOR, {
          revisionNumber: number,
          fromRevisionNumber: target.number,
        });
        return this.ok(route, await this.view(regionId));
      }
      if (rest === 'events')
        return this.ok(route, { events: this.events.get(regionId)!.slice(0, 50) });
      if (rest === 'drift')
        return this.ok(route, {
          status: 'clean',
          publishedRevision: this.published(pool).number,
          species: [],
          exclusiveConflicts: [],
          emptyTiers: [],
          shipped: { available: region.shipped !== null, differs: false, diff: null },
        });
      if (rest === 'analysis') {
        if (body.mode === 'filtered_selector' && !body.filter)
          return this.fail(
            route,
            400,
            'REGION_POOL_SCENARIO_INVALID',
            'A filtered-selector analysis needs a filter.',
          );
        return this.ok(route, await this.analyse(regionId, body));
      }
      return this.fail(route, 404, 'NOT_FOUND', `Unhandled ${method} ${url.pathname}`);
    });
  }
}
