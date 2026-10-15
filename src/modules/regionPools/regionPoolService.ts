/**
 * Region Pool administration (RP2B): drafts, publication, rollback, history,
 * drift and probability analysis over the RP2A tables.
 *
 * Every write runs in one transaction under the Region Pool advisory lock and
 * a row lock on the region's `region_pools` row, and names the draft revision
 * it was based on (`REGION_POOL_STALE` otherwise).
 *
 *   - A **draft save** writes only `region_pools` and an audit event. The hunt
 *     projection is never touched.
 *   - **Publish** and **rollback** also name the `reviewHash` that `validate`
 *     (or `rollbackPreview`) returned, and acknowledge its warnings by id. The
 *     hash covers the draft, every species fact the pool depends on and the
 *     resulting issues, so a draft edit, a species retag or a conflicting
 *     publish elsewhere since the review refuses the publish
 *     (`REGION_POOL_REVIEW_STALE`) instead of publishing an unreviewed state.
 *     Then: a new immutable revision with its species evidence, the pointer,
 *     the region's projection rows and the audit event — all or nothing.
 *
 * Species stay content-owned: nothing here writes `species`. Regions come
 * from a {@link RegionCatalogue}, never from the code list directly.
 */
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, lt } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  regionEncounterPools,
  regionPoolEvents,
  regionPoolRevisionEntries,
  regionPoolRevisions,
  regionPools,
  species,
  type RegionPoolManifestEntry,
  type RegionPoolRevisionSource,
  type RegionPoolRow,
} from '../../db/schema';
import {
  RegionPoolAcknowledgementRequiredError,
  RegionPoolInvalidError,
  RegionPoolNotFoundError,
  RegionPoolPublishBlockedError,
  RegionPoolReviewStaleError,
  RegionPoolRevisionNotFoundError,
  RegionPoolScenarioInvalidError,
  RegionPoolShippedUnavailableError,
  RegionPoolStaleError,
} from '../../shared/errors';
import { findBuddyBonus } from '../buddyBonus/buddyBonusService';
import { resolveRace } from '../cards/race';
import type { LoadedContent, TablesContent } from '../content/schemas';
import type { SpeciesFilter } from '../encounters/speciesSelection';
import { DUNGEON_EXCLUSIVE_TAG, REGION_EXCLUSIVE_TAG } from '../locations/regions';
import type { RegionCatalogue, RegionCatalogueEntry } from './regionCatalogue';
import {
  describeRegionDistribution,
  diffDistributions,
  type DistributionDiff,
  type DistributionMode,
  type DistributionResult,
  type DistributionSpecies,
} from './regionPoolDistribution';
import {
  diffRegionPools,
  lockRegionPools,
  projectRegion,
  recordRegionPoolEvent,
  regionPoolHash,
  resolveShippedRegionPool,
  type RegionPoolDiff,
} from './regionPoolStore';
import {
  blockingIssues,
  parseRegionPoolEntries,
  requiredAcknowledgements,
  validateRegionPool,
  type PoolSpeciesFacts,
  type RegionPoolEntry,
  type RegionPoolIssue,
  type ValidationPurpose,
} from './regionPoolValidation';

// ── Read models ─────────────────────────────────────────────────────────────

export interface RegionPoolEntryView {
  species: string;
  weight: number;
  name: string | null;
  rarity: string | null;
  enabled: boolean;
  inContent: boolean;
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  race: string | null;
  affinity: string | null;
  imagePath: string | null;
}

export interface RegionSummaryView {
  id: string;
  name: string;
  released: boolean;
  isDefault: boolean;
}

export interface PublishedRevisionView {
  number: number;
  source: RegionPoolRevisionSource;
  rolledBackFrom: number | null;
  publishedAt: string;
  publishedBy: string | null;
  contentHash: string;
  entryCount: number;
}

export interface RegionPoolView {
  region: RegionSummaryView;
  draft: {
    revision: number;
    hash: string;
    entries: RegionPoolEntryView[];
    updatedAt: string;
    updatedBy: string | null;
    /** The draft differs from the published revision. */
    unpublishedChanges: boolean;
  };
  published: (PublishedRevisionView & { entries: RegionPoolEntryView[] }) | null;
  /** Draft-level validation of the saved draft. */
  issues: RegionPoolIssue[];
}

export interface RegionPoolListItem {
  region: RegionSummaryView;
  hasPool: boolean;
  draftRevision: number | null;
  unpublishedChanges: boolean;
  published: PublishedRevisionView | null;
  /** Huntable species per rarity in the published pool. */
  rarityCounts: Record<string, number>;
  driftStatus: 'clean' | 'drift' | 'none';
}

export interface ReviewResult {
  purpose: string;
  draftRevision: number;
  issues: RegionPoolIssue[];
  requiredAcknowledgements: string[];
  /** Name this when publishing / rolling back. Changes whenever anything reviewed changes. */
  reviewHash: string;
  canPublish: boolean;
  diffFromPublished: RegionPoolDiff;
}

export interface ShippedPoolView {
  available: boolean;
  hash: string | null;
  entries: RegionPoolEntry[];
  /** Slugs in the file with no species row. */
  skipped: string[];
  diffFromDraft: RegionPoolDiff;
  diffFromPublished: RegionPoolDiff;
  /** Shipped species the draft does not list — what a merge would add. */
  mergeCandidates: RegionPoolEntry[];
  /** Species in both with different weights. A merge keeps the draft's. */
  weightConflicts: Array<{ species: string; draft: number; shipped: number }>;
}

export type SpeciesDriftKind = 'disabled' | 'enabled' | 'missing_from_content' | 'rarity_changed' | 'tags_changed';

export interface RegionPoolDrift {
  status: 'clean' | 'drift' | 'none';
  publishedRevision: number | null;
  species: Array<{
    species: string;
    kind: SpeciesDriftKind;
    from?: string;
    to?: string;
    addedTags?: string[];
    removedTags?: string[];
  }>;
  exclusiveConflicts: Array<{ species: string; regions: string[] }>;
  emptyTiers: Array<{ rarity: string; causedByContent: boolean }>;
  shipped: { available: boolean; differs: boolean; diff: RegionPoolDiff | null };
}

export interface RevisionHistoryItem extends PublishedRevisionView {
  current: boolean;
}

export interface RevisionDetail extends RevisionHistoryItem {
  entries: RegionPoolEntryView[];
  speciesManifest: RegionPoolManifestEntry[];
}

export interface RegionPoolEventView {
  cursor: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SpeciesCatalogueItem {
  slug: string;
  name: string;
  rarity: string;
  enabled: boolean;
  inContent: boolean;
  huntable: boolean;
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  race: string;
  affinity: string;
  imagePath: string;
  /** Regions whose published pool lists her. */
  publishedIn: string[];
}

export interface AnalysisRequest {
  source: 'draft' | 'published';
  mode: DistributionMode;
  level: number;
  /** Hunt only: the equipped Buddy, by species slug; her authored bonus is read from content. */
  buddySpecies?: string | null;
  /** Hunt only: species the player is assumed to own (ownership-targeted bonuses). */
  ownedSpecies?: string[];
  /** Filtered selector only. */
  filter?: SpeciesFilter;
  /** Also analyse the other source and return the difference. */
  compare?: boolean;
}

export interface AnalysisResponse {
  source: 'draft' | 'published';
  assumptions: string[];
  result: DistributionResult;
  comparison: { against: 'draft' | 'published'; result: DistributionResult; diff: DistributionDiff } | null;
}

export interface RegionPoolService {
  list(): Promise<RegionPoolListItem[]>;
  get(regionId: string): Promise<RegionPoolView>;
  speciesCatalogue(): Promise<SpeciesCatalogueItem[]>;
  saveDraft(
    regionId: string,
    input: { entries: unknown; expectedDraftRevision: number },
    actor: string | null,
  ): Promise<RegionPoolView>;
  discardDraft(regionId: string, input: { expectedDraftRevision: number }, actor: string | null): Promise<RegionPoolView>;
  shipped(regionId: string): Promise<ShippedPoolView>;
  loadShippedIntoDraft(
    regionId: string,
    input: { expectedDraftRevision: number },
    actor: string | null,
  ): Promise<RegionPoolView>;
  mergeShippedIntoDraft(
    regionId: string,
    input: { expectedDraftRevision: number; species?: string[] | undefined },
    actor: string | null,
  ): Promise<RegionPoolView>;
  /** With `entries`: draft-level issues for an unsaved list. Without: publish review of the saved draft. */
  validate(regionId: string, input: { entries?: unknown }): Promise<ReviewResult | { issues: RegionPoolIssue[] }>;
  publish(
    regionId: string,
    input: { expectedDraftRevision: number; reviewHash: string; acknowledgedWarnings: string[] },
    actor: string | null,
  ): Promise<RegionPoolView>;
  rollbackPreview(regionId: string, revision: number): Promise<ReviewResult>;
  rollback(
    regionId: string,
    input: { revision: number; expectedDraftRevision: number; reviewHash: string; acknowledgedWarnings: string[] },
    actor: string | null,
  ): Promise<RegionPoolView>;
  history(regionId: string): Promise<RevisionHistoryItem[]>;
  revision(regionId: string, revision: number): Promise<RevisionDetail>;
  events(regionId: string, opts: { limit: number; before?: string | undefined }): Promise<RegionPoolEventView[]>;
  drift(regionId: string): Promise<RegionPoolDrift>;
  analyse(regionId: string, request: AnalysisRequest): Promise<AnalysisResponse>;
}

export interface RegionPoolServiceDeps {
  db: Db;
  getContent: () => LoadedContent;
  catalogue: RegionCatalogue;
  /**
   * The rarity and result tables the running hunt uses. The hunt captures
   * `tables.json` at construction (a reload does not change it), so pass the
   * same object it was built with — not a live content getter.
   */
  huntTables: Pick<TablesContent, 'hunt' | 'progression'>;
}

type Tx = DbOrTx;

const sha256 = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const iso = (d: Date) => d.toISOString();

export function createRegionPoolService(deps: RegionPoolServiceDeps): RegionPoolService {
  const { db, catalogue } = deps;

  const huntedRarities = (): string[] =>
    deps.huntTables.hunt.rarityTable.filter((r) => r.weight > 0).map((r) => r.rarity as string);

  // ── facts ────────────────────────────────────────────────────────────────

  async function loadFacts(tx: Tx): Promise<{ bySlug: Map<string, PoolSpeciesFacts & { id: number }> }> {
    const content = deps.getContent();
    const authored = new Map(content.species.map((s) => [s.slug, s]));
    const rows = await tx.select().from(species);
    const bySlug = new Map<string, PoolSpeciesFacts & { id: number }>();
    for (const row of rows) {
      const a = authored.get(row.slug);
      bySlug.set(row.slug, {
        id: row.id,
        slug: row.slug,
        name: row.name,
        rarity: row.rarity,
        enabled: row.enabled,
        tags: [...row.tags],
        inContent: a !== undefined,
        race: resolveRace({ slug: row.slug, race: a?.race ?? null, archetype: row.archetype }),
        affinity: row.affinity,
        perSpeciesWeight: row.perSpeciesWeight,
        imagePath: row.imagePath,
      });
    }
    return { bySlug };
  }

  function entryView(entry: RegionPoolEntry, facts: ReadonlyMap<string, PoolSpeciesFacts>): RegionPoolEntryView {
    const f = facts.get(entry.species);
    return {
      species: entry.species,
      weight: entry.weight,
      name: f?.name ?? null,
      rarity: f?.rarity ?? null,
      enabled: f?.enabled ?? false,
      inContent: f?.inContent ?? false,
      regionExclusive: f?.tags.includes(REGION_EXCLUSIVE_TAG) ?? false,
      dungeonExclusive: f?.tags.includes(DUNGEON_EXCLUSIVE_TAG) ?? false,
      race: f?.race ?? null,
      affinity: f?.affinity ?? null,
      imagePath: f?.imagePath ?? null,
    };
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  function regionOrThrow(regionId: string): RegionCatalogueEntry {
    const region = catalogue.get(regionId);
    if (!region) throw new RegionPoolNotFoundError(regionId);
    return region;
  }

  async function poolRow(tx: Tx, regionId: string, forUpdate: boolean): Promise<RegionPoolRow> {
    const query = tx.select().from(regionPools).where(eq(regionPools.regionId, regionId));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw new RegionPoolNotFoundError(regionId);
    return row;
  }

  async function revisionRow(tx: Tx, revisionId: number) {
    const [row] = await tx.select().from(regionPoolRevisions).where(eq(regionPoolRevisions.id, revisionId));
    return row ?? null;
  }

  async function revisionEntries(tx: Tx, revisionId: number): Promise<RegionPoolEntry[]> {
    const rows = await tx
      .select({ species: species.slug, weight: regionPoolRevisionEntries.weight })
      .from(regionPoolRevisionEntries)
      .innerJoin(species, eq(regionPoolRevisionEntries.speciesId, species.id))
      .where(eq(regionPoolRevisionEntries.revisionId, revisionId))
      .orderBy(asc(regionPoolRevisionEntries.position));
    return rows;
  }

  async function revisionNumberOf(tx: Tx, revisionId: number | null): Promise<number | null> {
    if (revisionId === null) return null;
    return (await revisionRow(tx, revisionId))?.number ?? null;
  }

  async function publishedView(tx: Tx, revisionId: number): Promise<PublishedRevisionView> {
    const row = (await revisionRow(tx, revisionId))!;
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(regionPoolRevisionEntries)
      .where(eq(regionPoolRevisionEntries.revisionId, revisionId));
    return {
      number: row.number,
      source: row.source,
      rolledBackFrom: await revisionNumberOf(tx, row.rolledBackFrom),
      publishedAt: iso(row.publishedAt),
      publishedBy: row.publishedBy,
      contentHash: row.contentHash,
      entryCount: n,
    };
  }

  /** Every region's published pool as slugs, read through `tx`. */
  async function publishedSlugs(tx: Tx): Promise<Map<string, Set<string>>> {
    const rows = await tx
      .select({ regionId: regionPools.regionId, slug: species.slug })
      .from(regionPools)
      .innerJoin(regionPoolRevisionEntries, eq(regionPoolRevisionEntries.revisionId, regionPools.publishedRevisionId))
      .innerJoin(species, eq(species.id, regionPoolRevisionEntries.speciesId));
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = out.get(r.regionId) ?? new Set<string>();
      set.add(r.slug);
      out.set(r.regionId, set);
    }
    return out;
  }

  function fallbackRegionName(regionId: string): string | null {
    const def = catalogue.defaultRegionId();
    return regionId === def ? null : (catalogue.get(def)?.name ?? def);
  }

  async function validateEntries(
    tx: Tx,
    regionId: string,
    entries: readonly RegionPoolEntry[],
    purpose: ValidationPurpose,
    facts: ReadonlyMap<string, PoolSpeciesFacts>,
  ): Promise<RegionPoolIssue[]> {
    const others = await publishedSlugs(tx);
    others.delete(regionId);
    return validateRegionPool({
      regionId,
      region: catalogue.get(regionId),
      entries,
      facts,
      huntedRarities: huntedRarities(),
      otherPublished: others,
      fallbackRegionName: fallbackRegionName(regionId),
      purpose,
    });
  }

  /**
   * The review fingerprint: what is being published, every fact about each of
   * its species, and the issues those produced. Anything a reviewer saw that
   * changes, changes this.
   */
  function reviewHashOf(
    purpose: string,
    regionId: string,
    draftRevision: number,
    entries: readonly RegionPoolEntry[],
    facts: ReadonlyMap<string, PoolSpeciesFacts>,
    issues: readonly RegionPoolIssue[],
    released: boolean,
  ): string {
    return sha256({
      purpose,
      regionId,
      draftRevision,
      released,
      entries: entries.map((e) => [e.species, e.weight]),
      facts: entries.map((e) => {
        const f = facts.get(e.species);
        return f ? [f.slug, f.rarity, f.enabled, [...f.tags].sort(), f.inContent] : [e.species, null];
      }),
      hunted: huntedRarities(),
      issues: issues.map((i) => [i.id, i.severity, i.acknowledgementRequired, i.regions ?? null]),
    });
  }

  function toMap(entries: readonly RegionPoolEntry[]): Map<string, number> {
    return new Map(entries.map((e) => [e.species, e.weight]));
  }

  async function review(
    tx: Tx,
    regionId: string,
    purpose: 'publish' | `rollback:${number}`,
    pool: RegionPoolRow,
    entries: readonly RegionPoolEntry[],
    facts: ReadonlyMap<string, PoolSpeciesFacts>,
  ): Promise<ReviewResult> {
    const region = regionOrThrow(regionId);
    const issues = await validateEntries(tx, regionId, entries, 'publish', facts);
    const published = pool.publishedRevisionId ? await revisionEntries(tx, pool.publishedRevisionId) : [];
    const publishedHash = pool.publishedRevisionId ? (await revisionRow(tx, pool.publishedRevisionId))!.contentHash : null;
    if (publishedHash !== null && regionPoolHash(entries) === publishedHash) {
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
    if (purpose !== 'publish' && pool.draftHash !== publishedHash) {
      issues.push({
        id: 'draft_replaced_by_rollback',
        code: 'draft_replaced_by_rollback',
        severity: 'warning',
        message: 'The draft has unpublished changes; rolling back replaces the draft with the restored pool.',
        acknowledgementRequired: true,
      });
    }
    return {
      purpose,
      draftRevision: pool.draftRevision,
      issues,
      requiredAcknowledgements: requiredAcknowledgements(issues),
      reviewHash: reviewHashOf(purpose, regionId, pool.draftRevision, entries, facts, issues, region.released),
      canPublish: blockingIssues(issues).length === 0,
      diffFromPublished: diffRegionPools(toMap(published), toMap(entries)),
    };
  }

  function checkStale(pool: RegionPoolRow, expected: number): void {
    if (pool.draftRevision !== expected) {
      throw new RegionPoolStaleError(pool.regionId, expected, pool.draftRevision, pool.updatedBy, pool.updatedAt);
    }
  }

  /** Write a new draft (revision + 1). Never touches the projection. */
  async function writeDraft(
    tx: Tx,
    pool: RegionPoolRow,
    entries: readonly RegionPoolEntry[],
    actor: string | null,
  ): Promise<number> {
    const draftRevision = pool.draftRevision + 1;
    await tx
      .update(regionPools)
      .set({
        draftEntries: entries.map((e) => ({ species: e.species, weight: e.weight })),
        draftHash: regionPoolHash(entries),
        draftRevision,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(regionPools.regionId, pool.regionId));
    return draftRevision;
  }

  /** Insert revision N+1, move the pointer and re-project the region. */
  async function publishEntries(
    tx: Tx,
    pool: RegionPoolRow,
    entries: readonly RegionPoolEntry[],
    facts: ReadonlyMap<string, PoolSpeciesFacts & { id: number }>,
    opts: { source: RegionPoolRevisionSource; draftRevision: number; rolledBackFrom: number | null; actor: string | null },
  ): Promise<{ number: number; projectionChanged: boolean }> {
    const region = regionOrThrow(pool.regionId);
    const [latest] = await tx
      .select({ number: regionPoolRevisions.number })
      .from(regionPoolRevisions)
      .where(eq(regionPoolRevisions.regionId, pool.regionId))
      .orderBy(desc(regionPoolRevisions.number))
      .limit(1);
    const number = (latest?.number ?? 0) + 1;
    const manifest: RegionPoolManifestEntry[] = entries.map((e) => {
      const f = facts.get(e.species)!;
      return { species: f.slug, rarity: f.rarity, enabled: f.enabled, tags: [...f.tags] };
    });
    const [revision] = await tx
      .insert(regionPoolRevisions)
      .values({
        regionId: pool.regionId,
        number,
        contentHash: regionPoolHash(entries),
        source: opts.source,
        rolledBackFrom: opts.rolledBackFrom,
        draftRevision: opts.draftRevision,
        speciesManifest: manifest,
        publishedBy: opts.actor,
      })
      .returning({ id: regionPoolRevisions.id });
    if (entries.length > 0) {
      await tx.insert(regionPoolRevisionEntries).values(
        entries.map((e, position) => ({
          revisionId: revision!.id,
          speciesId: facts.get(e.species)!.id,
          weight: e.weight,
          position,
        })),
      );
    }
    await tx
      .update(regionPools)
      .set({ publishedRevisionId: revision!.id })
      .where(eq(regionPools.regionId, pool.regionId));
    const projected = await projectRegion(tx, pool.regionId, region.released ? revision!.id : null, opts.actor);
    return { number, projectionChanged: projected.changed };
  }

  function enforceReview(result: ReviewResult, reviewHash: string, acknowledged: readonly string[]): void {
    if (result.reviewHash !== reviewHash) throw new RegionPoolReviewStaleError(result.issues, result.reviewHash);
    if (!result.canPublish) throw new RegionPoolPublishBlockedError(blockingIssues(result.issues));
    const missing = result.requiredAcknowledgements.filter((id) => !acknowledged.includes(id));
    if (missing.length > 0) throw new RegionPoolAcknowledgementRequiredError(missing, result.issues);
  }

  async function view(tx: Tx, regionId: string): Promise<RegionPoolView> {
    const region = regionOrThrow(regionId);
    const pool = await poolRow(tx, regionId, false);
    const { bySlug } = await loadFacts(tx);
    const draftEntries = pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }));
    let published: RegionPoolView['published'] = null;
    let publishedHash: string | null = null;
    if (pool.publishedRevisionId) {
      const meta = await publishedView(tx, pool.publishedRevisionId);
      publishedHash = meta.contentHash;
      const entries = await revisionEntries(tx, pool.publishedRevisionId);
      published = { ...meta, entries: entries.map((e) => entryView(e, bySlug)) };
    }
    return {
      region: summary(region),
      draft: {
        revision: pool.draftRevision,
        hash: pool.draftHash,
        entries: draftEntries.map((e) => entryView(e, bySlug)),
        updatedAt: iso(pool.updatedAt),
        updatedBy: pool.updatedBy,
        unpublishedChanges: pool.draftHash !== publishedHash,
      },
      published,
      issues: await validateEntries(tx, regionId, draftEntries, 'draft', bySlug),
    };
  }

  const summary = (r: RegionCatalogueEntry): RegionSummaryView => ({
    id: r.id,
    name: r.name,
    released: r.released,
    isDefault: r.isDefault,
  });

  const readOnly = <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction(work, { isolationLevel: 'repeatable read', accessMode: 'read only' });

  /** A write: Region Pool lock, the region's row locked, staleness checked. */
  async function write<T>(
    regionId: string,
    expectedDraftRevision: number,
    work: (tx: Tx, pool: RegionPoolRow) => Promise<T>,
  ): Promise<T> {
    regionOrThrow(regionId);
    return db.transaction(async (tx) => {
      await lockRegionPools(tx);
      const pool = await poolRow(tx, regionId, true);
      checkStale(pool, expectedDraftRevision);
      return work(tx, pool);
    });
  }

  function shippedResolved(
    region: RegionCatalogueEntry,
    facts: ReadonlyMap<string, PoolSpeciesFacts & { id: number }>,
  ): { entries: RegionPoolEntry[]; skipped: string[]; hash: string } | null {
    if (!region.shippedPool) return null;
    const ids = new Map([...facts.values()].map((f) => [f.slug, f.id]));
    const resolved = resolveShippedRegionPool({ encounterPool: region.shippedPool }, deps.getContent().species, ids);
    return {
      entries: resolved.entries.map((e) => ({ species: e.species, weight: e.weight })),
      skipped: resolved.skipped,
      hash: resolved.hash,
    };
  }

  async function computeDrift(tx: Tx, regionId: string, pool: RegionPoolRow | null): Promise<RegionPoolDrift> {
    const region = regionOrThrow(regionId);
    const { bySlug } = await loadFacts(tx);
    const shipped = shippedResolved(region, bySlug);
    if (!pool || !pool.publishedRevisionId) {
      return {
        status: 'none',
        publishedRevision: null,
        species: [],
        exclusiveConflicts: [],
        emptyTiers: [],
        shipped: { available: shipped !== null, differs: false, diff: null },
      };
    }
    const rev = (await revisionRow(tx, pool.publishedRevisionId))!;
    const entries = await revisionEntries(tx, rev.id);
    const manifest = new Map(rev.speciesManifest.map((m) => [m.species, m]));
    const speciesDrift: RegionPoolDrift['species'] = [];
    for (const e of entries) {
      const then = manifest.get(e.species);
      const now = bySlug.get(e.species);
      if (!now) continue;
      if (!now.inContent) speciesDrift.push({ species: e.species, kind: 'missing_from_content' });
      else if (then && then.enabled && !now.enabled) speciesDrift.push({ species: e.species, kind: 'disabled' });
      else if (then && !then.enabled && now.enabled) speciesDrift.push({ species: e.species, kind: 'enabled' });
      if (then && then.rarity !== now.rarity) {
        speciesDrift.push({ species: e.species, kind: 'rarity_changed', from: then.rarity, to: now.rarity });
      }
      if (then) {
        const before = new Set(then.tags);
        const after = new Set(now.tags);
        const added = [...after].filter((t) => !before.has(t)).sort();
        const removed = [...before].filter((t) => !after.has(t)).sort();
        if (added.length + removed.length > 0) {
          speciesDrift.push({ species: e.species, kind: 'tags_changed', addedTags: added, removedTags: removed });
        }
      }
    }
    const others = await publishedSlugs(tx);
    others.delete(regionId);
    const exclusiveConflicts = entries
      .filter((e) => bySlug.get(e.species)?.tags.includes(REGION_EXCLUSIVE_TAG))
      .map((e) => ({
        species: e.species,
        regions: [...others.entries()].filter(([, s]) => s.has(e.species)).map(([id]) => id).sort(),
      }))
      .filter((c) => c.regions.length > 0);
    const hunted = huntedRarities();
    const eligibleNow = new Set(
      entries
        .map((e) => bySlug.get(e.species))
        .filter((f): f is NonNullable<typeof f> => !!f && f.enabled && !f.tags.includes(DUNGEON_EXCLUSIVE_TAG))
        .map((f) => f.rarity),
    );
    const eligibleThen = new Set(
      rev.speciesManifest.filter((m) => m.enabled && !m.tags.includes(DUNGEON_EXCLUSIVE_TAG)).map((m) => m.rarity),
    );
    const emptyTiers = hunted
      .filter((r) => !eligibleNow.has(r))
      .map((rarity) => ({ rarity, causedByContent: eligibleThen.has(rarity) }));
    const shippedDiff = shipped ? diffRegionPools(toMap(entries), toMap(shipped.entries)) : null;
    const shippedDiffers = shipped !== null && shipped.hash !== rev.contentHash;
    const drifting =
      speciesDrift.length > 0 || exclusiveConflicts.length > 0 || emptyTiers.some((t) => t.causedByContent) || shippedDiffers;
    return {
      status: drifting ? 'drift' : 'clean',
      publishedRevision: rev.number,
      species: speciesDrift,
      exclusiveConflicts,
      emptyTiers,
      shipped: { available: shipped !== null, differs: shippedDiffers, diff: shippedDiffers ? shippedDiff : null },
    };
  }

  function speciesForAnalysis(facts: ReadonlyMap<string, PoolSpeciesFacts>): Map<string, DistributionSpecies> {
    return new Map(
      [...facts.values()].map((f) => [
        f.slug,
        {
          slug: f.slug,
          name: f.name,
          rarity: f.rarity,
          enabled: f.enabled,
          tags: f.tags,
          race: f.race,
          affinity: f.affinity,
          perSpeciesWeight: f.perSpeciesWeight,
        },
      ]),
    );
  }

  return {
    async list() {
      return readOnly(async (tx) => {
        const rows = new Map((await tx.select().from(regionPools)).map((r) => [r.regionId, r]));
        const out: RegionPoolListItem[] = [];
        const { bySlug } = await loadFacts(tx);
        for (const region of catalogue.list()) {
          const pool = rows.get(region.id) ?? null;
          let published: PublishedRevisionView | null = null;
          const rarityCounts: Record<string, number> = {};
          if (pool?.publishedRevisionId) {
            published = await publishedView(tx, pool.publishedRevisionId);
            for (const e of await revisionEntries(tx, pool.publishedRevisionId)) {
              const f = bySlug.get(e.species);
              if (f && f.enabled && !f.tags.includes(DUNGEON_EXCLUSIVE_TAG)) {
                rarityCounts[f.rarity] = (rarityCounts[f.rarity] ?? 0) + 1;
              }
            }
          }
          out.push({
            region: summary(region),
            hasPool: pool !== null,
            draftRevision: pool?.draftRevision ?? null,
            unpublishedChanges: pool !== null && pool.draftHash !== (published?.contentHash ?? null),
            published,
            rarityCounts,
            driftStatus: (await computeDrift(tx, region.id, pool)).status,
          });
        }
        return out;
      });
    },

    get: (regionId) => readOnly((tx) => view(tx, regionId)),

    async speciesCatalogue() {
      return readOnly(async (tx) => {
        const { bySlug } = await loadFacts(tx);
        const published = await publishedSlugs(tx);
        const hunted = new Set(huntedRarities());
        return [...bySlug.values()]
          .map((f) => ({
            slug: f.slug,
            name: f.name,
            rarity: f.rarity,
            enabled: f.enabled,
            inContent: f.inContent,
            huntable: hunted.has(f.rarity),
            regionExclusive: f.tags.includes(REGION_EXCLUSIVE_TAG),
            dungeonExclusive: f.tags.includes(DUNGEON_EXCLUSIVE_TAG),
            race: f.race,
            affinity: f.affinity,
            imagePath: f.imagePath,
            publishedIn: [...published.entries()].filter(([, s]) => s.has(f.slug)).map(([id]) => id).sort(),
          }))
          .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      });
    },

    async saveDraft(regionId, input, actor) {
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const { entries, issues: parseIssues } = parseRegionPoolEntries(input.entries);
        const { bySlug } = await loadFacts(tx);
        const issues = [...parseIssues, ...(await validateEntries(tx, regionId, entries, 'draft', bySlug))];
        if (blockingIssues(issues).length > 0) throw new RegionPoolInvalidError(issues);
        const before = toMap(pool.draftEntries);
        const draftRevision = await writeDraft(tx, pool, entries, actor);
        await recordRegionPoolEvent(
          tx,
          regionId,
          'draft_saved',
          { draftRevision, hash: regionPoolHash(entries), entries: entries.length, diff: diffRegionPools(before, toMap(entries)) },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async discardDraft(regionId, input, actor) {
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const published = pool.publishedRevisionId ? await revisionEntries(tx, pool.publishedRevisionId) : [];
        const draftRevision = await writeDraft(tx, pool, published, actor);
        await recordRegionPoolEvent(
          tx,
          regionId,
          'draft_discarded',
          { draftRevision, diff: diffRegionPools(toMap(pool.draftEntries), toMap(published)) },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async shipped(regionId) {
      const region = regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const pool = await poolRow(tx, regionId, false);
        const { bySlug } = await loadFacts(tx);
        const shipped = shippedResolved(region, bySlug);
        const draft = pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }));
        const published = pool.publishedRevisionId ? await revisionEntries(tx, pool.publishedRevisionId) : [];
        const entries = shipped?.entries ?? [];
        const draftMap = toMap(draft);
        return {
          available: shipped !== null,
          hash: shipped?.hash ?? null,
          entries,
          skipped: shipped?.skipped ?? [],
          diffFromDraft: diffRegionPools(draftMap, toMap(entries)),
          diffFromPublished: diffRegionPools(toMap(published), toMap(entries)),
          mergeCandidates: entries.filter((e) => !draftMap.has(e.species)),
          weightConflicts: entries
            .filter((e) => draftMap.has(e.species) && draftMap.get(e.species) !== e.weight)
            .map((e) => ({ species: e.species, draft: draftMap.get(e.species)!, shipped: e.weight })),
        };
      });
    },

    async loadShippedIntoDraft(regionId, input, actor) {
      const region = regionOrThrow(regionId);
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const { bySlug } = await loadFacts(tx);
        const shipped = shippedResolved(region, bySlug);
        if (!shipped) throw new RegionPoolShippedUnavailableError(regionId);
        const issues = await validateEntries(tx, regionId, shipped.entries, 'draft', bySlug);
        if (blockingIssues(issues).length > 0) throw new RegionPoolInvalidError(issues);
        const draftRevision = await writeDraft(tx, pool, shipped.entries, actor);
        await recordRegionPoolEvent(
          tx,
          regionId,
          'draft_reset_to_shipped',
          {
            draftRevision,
            shippedHash: shipped.hash,
            skipped: shipped.skipped,
            diff: diffRegionPools(toMap(pool.draftEntries), toMap(shipped.entries)),
          },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async mergeShippedIntoDraft(regionId, input, actor) {
      const region = regionOrThrow(regionId);
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const { bySlug } = await loadFacts(tx);
        const shipped = shippedResolved(region, bySlug);
        if (!shipped) throw new RegionPoolShippedUnavailableError(regionId);
        const draft = pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }));
        const present = new Set(draft.map((e) => e.species));
        const wanted = input.species ? new Set(input.species) : null;
        // Additive only: existing members and weights are kept, nothing is removed.
        const added = shipped.entries.filter((e) => !present.has(e.species) && (!wanted || wanted.has(e.species)));
        if (wanted) {
          const unknown = [...wanted].filter((s) => !shipped.entries.some((e) => e.species === s) || present.has(s));
          if (unknown.length > 0) {
            throw new RegionPoolInvalidError(
              unknown.map((s) => ({
                id: `species_unknown:${s}`,
                code: 'species_unknown',
                severity: 'error' as const,
                message: `"${s}" is not a shipped species missing from this draft.`,
                acknowledgementRequired: false,
                species: s,
              })),
            );
          }
        }
        const merged = [...draft, ...added];
        const issues = await validateEntries(tx, regionId, merged, 'draft', bySlug);
        if (blockingIssues(issues).length > 0) throw new RegionPoolInvalidError(issues);
        const draftRevision = await writeDraft(tx, pool, merged, actor);
        await recordRegionPoolEvent(
          tx,
          regionId,
          'draft_saved',
          { draftRevision, operation: 'merge_shipped', shippedHash: shipped.hash, added },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async validate(regionId, input) {
      regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const { bySlug } = await loadFacts(tx);
        if (input.entries !== undefined) {
          const { entries, issues } = parseRegionPoolEntries(input.entries);
          return { issues: [...issues, ...(await validateEntries(tx, regionId, entries, 'draft', bySlug))] };
        }
        const pool = await poolRow(tx, regionId, false);
        const entries = pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }));
        return review(tx, regionId, 'publish', pool, entries, bySlug);
      });
    },

    async publish(regionId, input, actor) {
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const { bySlug } = await loadFacts(tx);
        const entries = pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }));
        const result = await review(tx, regionId, 'publish', pool, entries, bySlug);
        enforceReview(result, input.reviewHash, input.acknowledgedWarnings);
        const published = await publishEntries(tx, pool, entries, bySlug, {
          source: 'editor',
          draftRevision: pool.draftRevision,
          rolledBackFrom: null,
          actor,
        });
        await recordRegionPoolEvent(
          tx,
          regionId,
          'published',
          {
            revisionNumber: published.number,
            draftRevision: pool.draftRevision,
            hash: regionPoolHash(entries),
            acknowledgedWarnings: result.requiredAcknowledgements,
            diff: result.diffFromPublished,
            projectionChanged: published.projectionChanged,
          },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async rollbackPreview(regionId, revision) {
      regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const pool = await poolRow(tx, regionId, false);
        const target = await targetRevision(tx, regionId, revision);
        const { bySlug } = await loadFacts(tx);
        return review(tx, regionId, `rollback:${revision}`, pool, await revisionEntries(tx, target.id), bySlug);
      });
    },

    async rollback(regionId, input, actor) {
      await write(regionId, input.expectedDraftRevision, async (tx, pool) => {
        const target = await targetRevision(tx, regionId, input.revision);
        const { bySlug } = await loadFacts(tx);
        const entries = await revisionEntries(tx, target.id);
        const result = await review(tx, regionId, `rollback:${input.revision}`, pool, entries, bySlug);
        enforceReview(result, input.reviewHash, input.acknowledgedWarnings);
        // The draft becomes the restored pool, so draft and published agree again.
        const draftRevision = await writeDraft(tx, pool, entries, actor);
        const published = await publishEntries(tx, { ...pool, draftRevision }, entries, bySlug, {
          source: 'rollback',
          draftRevision,
          rolledBackFrom: target.id,
          actor,
        });
        await recordRegionPoolEvent(
          tx,
          regionId,
          'rolled_back',
          {
            fromRevisionNumber: target.number,
            revisionNumber: published.number,
            draftRevision,
            hash: regionPoolHash(entries),
            acknowledgedWarnings: result.requiredAcknowledgements,
            diff: result.diffFromPublished,
            projectionChanged: published.projectionChanged,
          },
          actor,
        );
      });
      return readOnly((tx) => view(tx, regionId));
    },

    async history(regionId) {
      regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const pool = await poolRow(tx, regionId, false);
        const rows = await tx
          .select()
          .from(regionPoolRevisions)
          .where(eq(regionPoolRevisions.regionId, regionId))
          .orderBy(desc(regionPoolRevisions.number));
        const out: RevisionHistoryItem[] = [];
        for (const row of rows) {
          out.push({ ...(await publishedView(tx, row.id)), current: row.id === pool.publishedRevisionId });
        }
        return out;
      });
    },

    async revision(regionId, number) {
      regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const pool = await poolRow(tx, regionId, false);
        const target = await targetRevision(tx, regionId, number);
        const { bySlug } = await loadFacts(tx);
        return {
          ...(await publishedView(tx, target.id)),
          current: target.id === pool.publishedRevisionId,
          entries: (await revisionEntries(tx, target.id)).map((e) => entryView(e, bySlug)),
          speciesManifest: target.speciesManifest,
        };
      });
    },

    async events(regionId, opts) {
      regionOrThrow(regionId);
      const before = opts.before !== undefined ? Number(opts.before) : null;
      const rows = await db
        .select()
        .from(regionPoolEvents)
        .where(
          before !== null && Number.isSafeInteger(before)
            ? and(eq(regionPoolEvents.regionId, regionId), lt(regionPoolEvents.id, before))
            : eq(regionPoolEvents.regionId, regionId),
        )
        .orderBy(desc(regionPoolEvents.id))
        .limit(opts.limit);
      // Startup events (RP2A) name revisions by row id; the API names them by number.
      const numbers = new Map(
        (
          await db
            .select({ id: regionPoolRevisions.id, number: regionPoolRevisions.number })
            .from(regionPoolRevisions)
            .where(eq(regionPoolRevisions.regionId, regionId))
        ).map((r) => [r.id, r.number]),
      );
      const publicDetails = (details: Record<string, unknown>): Record<string, unknown> => {
        const { revisionId, publishedRevisionId, ...rest } = details;
        const out: Record<string, unknown> = { ...rest };
        if (typeof revisionId === 'number') out.revisionNumber ??= numbers.get(revisionId) ?? null;
        if (publishedRevisionId !== undefined) {
          out.publishedRevisionNumber =
            typeof publishedRevisionId === 'number' ? (numbers.get(publishedRevisionId) ?? null) : null;
        }
        return out;
      };
      return rows.map((r) => ({
        cursor: String(r.id),
        action: r.action,
        actor: r.actor,
        details: publicDetails(r.details),
        createdAt: iso(r.createdAt),
      }));
    },

    async drift(regionId) {
      regionOrThrow(regionId);
      return readOnly(async (tx) => {
        const [pool] = await tx.select().from(regionPools).where(eq(regionPools.regionId, regionId));
        return computeDrift(tx, regionId, pool ?? null);
      });
    },

    async analyse(regionId, request) {
      regionOrThrow(regionId);
      const content = deps.getContent();
      let buddyBonus = null;
      if (request.buddySpecies) {
        if (!content.species.some((s) => s.slug === request.buddySpecies)) {
          throw new RegionPoolScenarioInvalidError(`No Waifumon "${request.buddySpecies}" exists to be the Buddy.`);
        }
        buddyBonus = findBuddyBonus(content, request.buddySpecies);
      }
      if (request.mode === 'filtered_selector' && !request.filter) {
        throw new RegionPoolScenarioInvalidError('A filtered-selector analysis needs a filter.');
      }
      return readOnly(async (tx) => {
        const pool = await poolRow(tx, regionId, false);
        const { bySlug } = await loadFacts(tx);
        const speciesMap = speciesForAnalysis(bySlug);
        const owned = new Set(request.ownedSpecies ?? []);
        const defaultRegion = catalogue.defaultRegionId();
        // The default region's pool as hunts read it: its projection rows.
        const defaultPool = await tx
          .select({ species: species.slug, weight: regionEncounterPools.weight })
          .from(regionEncounterPools)
          .innerJoin(species, eq(species.id, regionEncounterPools.speciesId))
          .where(eq(regionEncounterPools.regionId, defaultRegion));
        const entriesOf = async (source: 'draft' | 'published'): Promise<RegionPoolEntry[]> =>
          source === 'draft'
            ? pool.draftEntries.map((e) => ({ species: e.species, weight: e.weight }))
            : pool.publishedRevisionId
              ? revisionEntries(tx, pool.publishedRevisionId)
              : [];
        const run = async (source: 'draft' | 'published') =>
          describeRegionDistribution({
            mode: request.mode,
            level: request.level,
            regionId,
            defaultRegionId: defaultRegion,
            pool: await entriesOf(source),
            defaultPool,
            species: speciesMap,
            tables: deps.huntTables,
            buddyBonus,
            ownedSpecies: owned,
            ...(request.filter ? { filter: request.filter } : {}),
          });
        const result = await run(request.source);
        const against: 'draft' | 'published' = request.source === 'draft' ? 'published' : 'draft';
        let comparison: AnalysisResponse['comparison'] = null;
        if (request.compare) {
          const other = await run(against);
          comparison = { against, result: other, diff: diffDistributions(other, result) };
        }
        const assumptions = [
          `Player level ${request.level}${request.level >= deps.huntTables.progression.rareEncounterShift.atLevel ? ' (rare-encounter shift applies)' : ''}.`,
          request.mode === 'hunt'
            ? request.buddySpecies
              ? `Buddy: ${request.buddySpecies}${buddyBonus ? '' : ' (authors no bonus)'}.`
              : 'No Buddy equipped.'
            : 'No Buddy Bonus applies in this mode.',
          `Owned species assumed: ${owned.size === 0 ? 'none' : [...owned].sort().join(', ')}.`,
          `Fallback pool: ${catalogue.get(defaultRegion)?.name ?? defaultRegion} as currently projected; global tier from current species.`,
        ];
        return { source: request.source, assumptions, result, comparison };
      });
    },
  };

  async function targetRevision(tx: Tx, regionId: string, number: number) {
    const [row] = await tx
      .select()
      .from(regionPoolRevisions)
      .where(and(eq(regionPoolRevisions.regionId, regionId), eq(regionPoolRevisions.number, number)));
    if (!row) throw new RegionPoolRevisionNotFoundError(regionId, number);
    return row;
  }
}

