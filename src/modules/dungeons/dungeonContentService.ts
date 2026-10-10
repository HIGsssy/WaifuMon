/**
 * Dungeon authoring: drafts, publication, rollback, audit and export.
 *
 * ## Lifecycle
 *
 *   draft      one per dungeon, mutable, guarded by `draftRevision`: a save
 *              names the revision it edited and is refused (`DungeonDraftStaleError`)
 *              if someone else got there first. A draft must have a readable
 *              shape, but it may carry validation errors — it is work in
 *              progress.
 *   publish    an explicit act with its own permission. It re-validates the
 *              draft against this server with errors blocking, then writes an
 *              **immutable** revision and moves the published pointer to it.
 *              Nothing else publishes: not a save, not (later) an import.
 *   rollback   moves the pointer to an earlier revision. No content is copied.
 *
 * Players only ever meet a published revision, and a run names the one it
 * started on (`dungeonRunService`), so a publish or a rollback changes what
 * *new* runs get and never touches a run in progress.
 *
 * ## Two documents
 *
 * The gameplay definition and the editor layout are stored, saved and
 * exported side by side and hashed apart: `draftHash` covers the definition
 * only. A layout-only save bumps `draftRevision` (it is the lock) and leaves
 * the hash alone.
 *
 * ## Audit
 *
 * Every write appends to `dungeon_content_events` in its own transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  artworkAssets,
  dungeonContentEvents,
  dungeonDefinitions,
  dungeonRevisions,
  dungeonRuns,
  progressionCurrencies,
  rewardTables,
  type DungeonContentEventAction,
  type DungeonDefinitionRow,
  type DungeonRevisionRow,
  type DungeonRevisionSource,
} from '../../db/schema';
import {
  DungeonDraftStaleError,
  DungeonInvalidError,
  DungeonKeyTakenError,
  DungeonNotFoundError,
  DungeonRevisionNotFoundError,
  uniqueViolationConstraint,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import {
  DUNGEON_ACTION_TYPES,
  DungeonDefinitionSchema,
  RESERVED_ACTION_TYPES,
  type DungeonDefinition,
} from './content/dungeonDefinition';
import { DungeonLayoutSchema, EMPTY_DUNGEON_LAYOUT, pruneDungeonLayout, type DungeonLayout } from './content/dungeonLayout';
import { buildDungeonPackage, dungeonContentHash, type DungeonPackage } from './package/dungeonPackage';
import {
  hasErrors,
  validateDungeonDefinition,
  type DungeonIssue,
  type DungeonValidationContext,
} from './validation/dungeonValidation';

/** Keys the admin routes use as path segments; a dungeon cannot be called one. */
export const RESERVED_DUNGEON_KEYS: ReadonlySet<string> = new Set([
  'reference',
  'export',
  'validate',
  'sandbox',
  'settings',
  'currencies',
  'artwork',
  'import',
  'definitions',
]);

export interface DungeonPublishedInfo {
  revisionId: number;
  number: number;
  contentHash: string;
  publishedAt: Date;
  publishedBy: string | null;
}

export interface DungeonSummary {
  key: string;
  name: string;
  enabled: boolean;
  position: number;
  roomCount: number;
  draftRevision: number;
  draftHash: string;
  published: DungeonPublishedInfo | null;
  /** The draft holds gameplay changes the published revision does not. */
  draftDiffers: boolean;
  /** Enabled and published: players can start runs. */
  open: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface DungeonDetail extends DungeonSummary {
  draft: DungeonDefinition;
  layout: DungeonLayout;
  issues: DungeonIssue[];
}

export interface DungeonRevisionSummary {
  revisionId: number;
  number: number;
  contentHash: string;
  source: DungeonRevisionSource;
  draftRevision: number;
  publishedAt: Date;
  publishedBy: string | null;
  /** The revision new runs start on. */
  current: boolean;
  activeRuns: number;
}

export interface DungeonRevisionDetail extends DungeonRevisionSummary {
  content: DungeonDefinition;
  layout: DungeonLayout;
}

export interface DungeonContentEvent {
  id: number;
  dungeonKey: string;
  action: DungeonContentEventAction;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface DungeonReferenceData {
  actionTypes: readonly string[];
  reservedActionTypes: Readonly<Record<string, string>>;
  enemies: { key: string; name: string; enabled: boolean; attack: number; defense: number; hp: number }[];
  rewardTables: { id: string; enabled: boolean }[];
  currencies: { key: string; singularName: string; pluralName: string; enabled: boolean }[];
  regions: { id: string; name: string; enabled: boolean }[];
}

export interface DungeonValidationReport {
  /** The definition with defaults applied; null when its shape could not be read. */
  definition: DungeonDefinition | null;
  contentHash: string | null;
  issues: DungeonIssue[];
  publishable: boolean;
}

export interface DungeonPublishResult {
  dungeon: DungeonDetail;
  revision: DungeonRevisionSummary;
  /** The draft was already what is published; no new revision was written. */
  unchanged: boolean;
}

/** Which content an export carries. */
export type DungeonExportOrigin = 'draft' | 'published' | { revision: number };

/** A published revision as a run starts on it. */
export interface PublishedDungeon {
  row: DungeonDefinitionRow;
  revision: DungeonRevisionRow;
  definition: DungeonDefinition;
}

export interface DungeonContentService {
  list(): Promise<DungeonSummary[]>;
  get(key: string): Promise<DungeonDetail | null>;
  reference(): Promise<DungeonReferenceData>;
  /** Dry run against this server. Writes nothing. */
  validate(definition: unknown): Promise<DungeonValidationReport>;
  /** @throws {DungeonInvalidError | DungeonKeyTakenError} */
  create(input: { definition: unknown; layout?: unknown }, actor: string | null): Promise<DungeonDetail>;
  /**
   * Save the draft, the layout, or both.
   * @throws {DungeonNotFoundError | DungeonInvalidError | DungeonDraftStaleError}
   */
  saveDraft(
    key: string,
    input: { definition?: unknown; layout?: unknown; expectedRevision: number },
    actor: string | null,
  ): Promise<DungeonDetail>;
  /**
   * Publish the draft as a new immutable revision.
   * @throws {DungeonNotFoundError | DungeonInvalidError | DungeonDraftStaleError}
   */
  publish(key: string, input: { expectedRevision: number }, actor: string | null): Promise<DungeonPublishResult>;
  /**
   * Point the dungeon at an earlier published revision.
   * @throws {DungeonNotFoundError | DungeonRevisionNotFoundError | DungeonInvalidError}
   */
  rollback(key: string, input: { revision: number }, actor: string | null): Promise<DungeonPublishResult>;
  /** @throws {DungeonNotFoundError} */
  setEnabled(key: string, enabled: boolean, actor: string | null): Promise<DungeonDetail>;
  revisions(key: string): Promise<DungeonRevisionSummary[] | null>;
  revision(key: string, number: number): Promise<DungeonRevisionDetail | null>;
  history(key: string, limit?: number): Promise<DungeonContentEvent[]>;
  /** @throws {DungeonNotFoundError | DungeonRevisionNotFoundError} */
  exportPackage(key: string, origin: DungeonExportOrigin, actor: string | null): Promise<DungeonPackage>;

  // ── runtime ───────────────────────────────────────────────────────────────
  /** Every dungeon players can start: enabled, published. In list order. */
  openDungeons(tx?: DbOrTx): Promise<PublishedDungeon[]>;
  /** One dungeon's published revision, or why there is none to play. */
  published(tx: DbOrTx, key: string): Promise<PublishedDungeon | 'missing' | 'unpublished' | 'disabled'>;
  /** The revision a run is pinned to. */
  revisionById(tx: DbOrTx, revisionId: number): Promise<{ revision: DungeonRevisionRow; definition: DungeonDefinition } | null>;
  /** What validation needs to know about this server. */
  validationContext(tx?: DbOrTx): Promise<DungeonValidationContext>;
}

export interface DungeonContentServiceDeps {
  db: Db;
  enemies: { definitions(tx?: DbOrTx): Promise<CombatEnemyDefinition[]> };
  /** Regions, from loaded content. */
  getRegions: () => readonly { id: string; name: string; enabled: boolean }[];
  /** Where shipped artwork lives; omitted, shipped paths are not checked. */
  assetsDir?: string | undefined;
  /** Written into exported packages: `staging`, `production`, `development`. */
  environment?: string | undefined;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> | undefined;
}

function parseStoredDefinition(key: string, raw: unknown): DungeonDefinition {
  const parsed = DungeonDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DungeonInvalidError(
      parsed.error.issues.map((i) => ({ code: 'schema', severity: 'error' as const, path: i.path.join('.'), message: `stored dungeon "${key}": ${i.message}` })),
    );
  }
  return parsed.data;
}

function parseStoredLayout(raw: unknown): DungeonLayout {
  const parsed = DungeonLayoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...EMPTY_DUNGEON_LAYOUT };
}

export function createDungeonContentService(deps: DungeonContentServiceDeps): DungeonContentService {
  const { db } = deps;

  async function validationContext(tx: DbOrTx = db): Promise<DungeonValidationContext> {
    const [enemies, tables, currencies, managed] = await Promise.all([
      deps.enemies.definitions(tx),
      tx.select({ id: rewardTables.tableId, enabled: rewardTables.enabled }).from(rewardTables).where(eq(rewardTables.kind, 'expedition')),
      tx.select({ key: progressionCurrencies.currencyKey, enabled: progressionCurrencies.enabled }).from(progressionCurrencies),
      tx.select({ category: artworkAssets.category, hash: artworkAssets.contentHash }).from(artworkAssets).where(eq(artworkAssets.status, 'active')),
    ]);
    const assetsDir = deps.assetsDir;
    return {
      enemies: new Map(enemies.map((e) => [e.key, { enabled: e.enabled }])),
      rewardTables: new Map(tables.map((t) => [t.id, { enabled: t.enabled }])),
      currencies: new Map(currencies.map((c) => [c.key, { enabled: c.enabled }])),
      regions: new Map(deps.getRegions().map((r) => [r.id, { enabled: r.enabled }])),
      managedArtwork: new Set(managed.map((m) => `${m.category}:${m.hash}`)),
      shippedArtworkExists: assetsDir
        ? (relative) => {
            const root = path.resolve(assetsDir);
            const file = path.resolve(root, relative);
            return file.startsWith(`${root}${path.sep}`) && fs.existsSync(file);
          }
        : undefined,
    };
  }

  async function audit(
    tx: DbOrTx,
    dungeonKey: string,
    action: DungeonContentEventAction,
    actor: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(dungeonContentEvents).values({ dungeonKey, action, actor, details });
  }

  async function publishedInfo(tx: DbOrTx, row: DungeonDefinitionRow): Promise<DungeonRevisionRow | null> {
    if (row.publishedRevisionId == null) return null;
    const [revision] = await tx.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, row.publishedRevisionId));
    return revision ?? null;
  }

  function summaryOf(row: DungeonDefinitionRow, published: DungeonRevisionRow | null): DungeonSummary {
    const draft = row.draft as { name?: unknown; rooms?: unknown };
    return {
      key: row.dungeonKey,
      name: typeof draft.name === 'string' ? draft.name : row.dungeonKey,
      enabled: row.enabled,
      position: row.position,
      roomCount: Array.isArray(draft.rooms) ? draft.rooms.length : 0,
      draftRevision: row.draftRevision,
      draftHash: row.draftHash,
      published: published && {
        revisionId: published.id,
        number: published.number,
        contentHash: published.contentHash,
        publishedAt: published.publishedAt,
        publishedBy: published.publishedBy,
      },
      draftDiffers: published == null || published.contentHash !== row.draftHash,
      open: row.enabled && published != null,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async function detailOf(tx: DbOrTx, row: DungeonDefinitionRow): Promise<DungeonDetail> {
    const published = await publishedInfo(tx, row);
    const draft = parseStoredDefinition(row.dungeonKey, row.draft);
    const { issues } = validateDungeonDefinition(draft, await validationContext(tx));
    return { ...summaryOf(row, published), draft, layout: parseStoredLayout(row.layout), issues };
  }

  async function lockRow(tx: DbOrTx, key: string): Promise<DungeonDefinitionRow> {
    const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key)).for('update');
    if (!row) throw new DungeonNotFoundError(key);
    return row;
  }

  function requireShape(raw: unknown): DungeonDefinition {
    const { definition, issues } = validateDungeonDefinition(raw);
    if (!definition) throw new DungeonInvalidError(issues);
    return definition;
  }

  function requireLayout(raw: unknown, definition: DungeonDefinition): DungeonLayout {
    const parsed = DungeonLayoutSchema.safeParse(raw ?? EMPTY_DUNGEON_LAYOUT);
    if (!parsed.success) {
      throw new DungeonInvalidError(
        parsed.error.issues.map((i) => ({ code: 'schema', severity: 'error' as const, path: `layout.${i.path.join('.')}`, message: i.message })),
      );
    }
    return pruneDungeonLayout(parsed.data, definition.rooms.map((r) => r.id));
  }

  async function activeRunCounts(tx: DbOrTx, key: string): Promise<Map<number, number>> {
    const rows = await tx
      .select({ revisionId: dungeonRuns.revisionId, n: count() })
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.dungeonKey, key), eq(dungeonRuns.status, 'active')))
      .groupBy(dungeonRuns.revisionId);
    return new Map(rows.map((r) => [r.revisionId, Number(r.n)]));
  }

  function revisionSummary(revision: DungeonRevisionRow, currentId: number | null, active: Map<number, number>): DungeonRevisionSummary {
    return {
      revisionId: revision.id,
      number: revision.number,
      contentHash: revision.contentHash,
      source: revision.source,
      draftRevision: revision.draftRevision,
      publishedAt: revision.publishedAt,
      publishedBy: revision.publishedBy,
      current: revision.id === currentId,
      activeRuns: active.get(revision.id) ?? 0,
    };
  }

  const service: DungeonContentService = {
    validationContext,

    async list() {
      const rows = await db.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
      const revisions = await db.select().from(dungeonRevisions);
      const byId = new Map(revisions.map((r) => [r.id, r]));
      return rows.map((row) => summaryOf(row, row.publishedRevisionId == null ? null : (byId.get(row.publishedRevisionId) ?? null)));
    },

    async get(key) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      return row ? detailOf(db, row) : null;
    },

    async reference() {
      const [enemies, tables, currencies] = await Promise.all([
        deps.enemies.definitions(db),
        db.select({ id: rewardTables.tableId, enabled: rewardTables.enabled }).from(rewardTables).where(eq(rewardTables.kind, 'expedition')).orderBy(asc(rewardTables.position), asc(rewardTables.tableId)),
        db.select().from(progressionCurrencies).orderBy(asc(progressionCurrencies.currencyKey)),
      ]);
      return {
        actionTypes: DUNGEON_ACTION_TYPES,
        reservedActionTypes: RESERVED_ACTION_TYPES,
        enemies: enemies.map((e) => ({ key: e.key, name: e.name, enabled: e.enabled, attack: e.attack, defense: e.defense, hp: e.hp })),
        rewardTables: tables,
        currencies: currencies.map((c) => ({ key: c.currencyKey, singularName: c.singularName, pluralName: c.pluralName, enabled: c.enabled })),
        regions: deps.getRegions().map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
      };
    },

    async validate(raw) {
      const { definition, issues } = validateDungeonDefinition(raw, await validationContext());
      return {
        definition,
        contentHash: definition ? dungeonContentHash(definition) : null,
        issues,
        publishable: definition != null && !hasErrors(issues),
      };
    },

    async create(input, actor) {
      const definition = requireShape(input.definition);
      if (RESERVED_DUNGEON_KEYS.has(definition.key)) {
        throw new DungeonInvalidError([{ code: 'schema', severity: 'error', path: 'key', message: `"${definition.key}" is reserved and cannot be a dungeon key` }]);
      }
      const layout = requireLayout(input.layout, definition);
      try {
        return await db.transaction(async (tx) => {
          const [{ next } = { next: 0 }] = await tx.select({ next: count() }).from(dungeonDefinitions);
          const [row] = await tx
            .insert(dungeonDefinitions)
            .values({
              dungeonKey: definition.key,
              draft: definition as unknown as Record<string, unknown>,
              layout: layout as unknown as Record<string, unknown>,
              draftHash: dungeonContentHash(definition),
              position: Number(next),
              updatedBy: actor,
            })
            .returning();
          await audit(tx, definition.key, 'created', actor, { draftRevision: 1, contentHash: row!.draftHash });
          return detailOf(tx, row!);
        });
      } catch (err) {
        if (uniqueViolationConstraint(err) != null) throw new DungeonKeyTakenError(definition.key);
        throw err;
      }
    },

    async saveDraft(key, input, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        if (row.draftRevision !== input.expectedRevision) {
          throw new DungeonDraftStaleError(key, input.expectedRevision, row.draftRevision, row.updatedBy, row.updatedAt);
        }
        const definition = input.definition === undefined ? parseStoredDefinition(key, row.draft) : requireShape(input.definition);
        if (definition.key !== key) {
          throw new DungeonInvalidError([{ code: 'schema', severity: 'error', path: 'key', message: `a dungeon's key cannot change ("${key}" → "${definition.key}")` }]);
        }
        const layout = requireLayout(input.layout === undefined ? row.layout : input.layout, definition);
        const draftHash = dungeonContentHash(definition);
        const contentChanged = draftHash !== row.draftHash;
        const layoutChanged = JSON.stringify(layout) !== JSON.stringify(parseStoredLayout(row.layout));
        // Saving what is already stored is not a new revision.
        if (!contentChanged && !layoutChanged) return detailOf(tx, row);
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({
            draft: definition as unknown as Record<string, unknown>,
            layout: layout as unknown as Record<string, unknown>,
            draftHash,
            draftRevision: row.draftRevision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'draft_saved', actor, {
          draftRevision: updated!.draftRevision,
          contentHash: draftHash,
          previousContentHash: row.draftHash,
          contentChanged,
          layoutChanged,
        });
        return detailOf(tx, updated!);
      });
    },

    async publish(key, input, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        if (row.draftRevision !== input.expectedRevision) {
          throw new DungeonDraftStaleError(key, input.expectedRevision, row.draftRevision, row.updatedBy, row.updatedAt);
        }
        const { definition, issues } = validateDungeonDefinition(row.draft, await validationContext(tx));
        if (!definition || hasErrors(issues)) throw new DungeonInvalidError(issues);

        const current = await publishedInfo(tx, row);
        const active = await activeRunCounts(tx, key);
        const contentHash = dungeonContentHash(definition);
        if (current && current.contentHash === contentHash) {
          return { dungeon: await detailOf(tx, row), revision: revisionSummary(current, current.id, active), unchanged: true };
        }

        // The definition row is locked, so the next number cannot be raced.
        const [latest] = await tx
          .select({ number: dungeonRevisions.number })
          .from(dungeonRevisions)
          .where(eq(dungeonRevisions.dungeonKey, key))
          .orderBy(desc(dungeonRevisions.number))
          .limit(1);
        const [revision] = await tx
          .insert(dungeonRevisions)
          .values({
            dungeonKey: key,
            number: (latest?.number ?? 0) + 1,
            content: definition as unknown as Record<string, unknown>,
            contentHash,
            layout: row.layout,
            source: 'editor',
            draftRevision: row.draftRevision,
            publishedBy: actor,
          })
          .returning();
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({ publishedRevisionId: revision!.id })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'published', actor, {
          revision: revision!.number,
          revisionId: revision!.id,
          contentHash,
          draftRevision: row.draftRevision,
          previousRevision: current?.number ?? null,
          warnings: issues.filter((i) => i.severity === 'warning').length,
        });
        deps.logger?.info({ tag: 'dungeons/published', dungeonKey: key, revision: revision!.number, contentHash, actor }, 'dungeon published');
        return { dungeon: await detailOf(tx, updated!), revision: revisionSummary(revision!, revision!.id, active), unchanged: false };
      });
    },

    async rollback(key, input, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        const [target] = await tx
          .select()
          .from(dungeonRevisions)
          .where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, input.revision)));
        if (!target) throw new DungeonRevisionNotFoundError(key, input.revision);
        const active = await activeRunCounts(tx, key);
        const current = await publishedInfo(tx, row);
        if (current?.id === target.id) {
          return { dungeon: await detailOf(tx, row), revision: revisionSummary(target, target.id, active), unchanged: true };
        }
        // What an old revision names may be gone by now; a rollback must not
        // put a dungeon live that this server can no longer run.
        const { issues } = validateDungeonDefinition(target.content, await validationContext(tx));
        if (hasErrors(issues)) throw new DungeonInvalidError(issues);
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({ publishedRevisionId: target.id })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'rolled_back', actor, {
          revision: target.number,
          revisionId: target.id,
          contentHash: target.contentHash,
          previousRevision: current?.number ?? null,
        });
        deps.logger?.info({ tag: 'dungeons/rolled-back', dungeonKey: key, revision: target.number, from: current?.number ?? null, actor }, 'dungeon rolled back');
        return { dungeon: await detailOf(tx, updated!), revision: revisionSummary(target, target.id, active), unchanged: false };
      });
    },

    async setEnabled(key, enabled, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        if (row.enabled === enabled) return detailOf(tx, row);
        const [updated] = await tx.update(dungeonDefinitions).set({ enabled }).where(eq(dungeonDefinitions.dungeonKey, key)).returning();
        await audit(tx, key, enabled ? 'enabled' : 'disabled', actor, {});
        return detailOf(tx, updated!);
      });
    },

    async revisions(key) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return null;
      const rows = await db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key)).orderBy(desc(dungeonRevisions.number));
      const active = await activeRunCounts(db, key);
      return rows.map((r) => revisionSummary(r, row.publishedRevisionId, active));
    },

    async revision(key, number) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return null;
      const [revision] = await db
        .select()
        .from(dungeonRevisions)
        .where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, number)));
      if (!revision) return null;
      return {
        ...revisionSummary(revision, row.publishedRevisionId, await activeRunCounts(db, key)),
        content: parseStoredDefinition(key, revision.content),
        layout: parseStoredLayout(revision.layout),
      };
    },

    async history(key, limit = 100) {
      const rows = await db
        .select()
        .from(dungeonContentEvents)
        .where(eq(dungeonContentEvents.dungeonKey, key))
        .orderBy(desc(dungeonContentEvents.id))
        .limit(Math.min(Math.max(1, limit), 500));
      return rows.map((r) => ({ id: r.id, dungeonKey: r.dungeonKey, action: r.action, actor: r.actor, details: r.details, createdAt: r.createdAt }));
    },

    async exportPackage(key, origin, actor) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) throw new DungeonNotFoundError(key);
      const published = await publishedInfo(db, row);
      let definition: DungeonDefinition;
      let layout: DungeonLayout;
      let revisionNumber: number | null = published?.number ?? null;
      if (origin === 'draft') {
        definition = parseStoredDefinition(key, row.draft);
        layout = parseStoredLayout(row.layout);
      } else {
        const wanted = origin === 'published' ? published?.number : origin.revision;
        const [revision] =
          wanted == null
            ? []
            : await db.select().from(dungeonRevisions).where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, wanted)));
        if (!revision) throw new DungeonRevisionNotFoundError(key, wanted ?? 0);
        definition = parseStoredDefinition(key, revision.content);
        layout = parseStoredLayout(revision.layout);
        revisionNumber = revision.number;
      }
      const enemies = new Map((await deps.enemies.definitions(db)).map((e) => [e.key, e]));
      const pkg = buildDungeonPackage({
        definition,
        layout,
        enemies,
        source: {
          environment: deps.environment ?? 'development',
          origin: origin === 'draft' ? 'draft' : 'revision',
          draftRevision: origin === 'draft' ? row.draftRevision : null,
          publishedRevision: origin === 'draft' ? (published?.number ?? null) : revisionNumber,
        },
      });
      await audit(db, key, 'exported', actor, { packageId: pkg.packageId, contentHash: pkg.contentHash, origin: pkg.source.origin, revision: pkg.source.publishedRevision });
      return pkg;
    },

    async openDungeons(tx = db) {
      const rows = await tx
        .select({ row: dungeonDefinitions, revision: dungeonRevisions })
        .from(dungeonDefinitions)
        .innerJoin(dungeonRevisions, eq(dungeonRevisions.id, dungeonDefinitions.publishedRevisionId))
        .where(eq(dungeonDefinitions.enabled, true))
        .orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
      const out: PublishedDungeon[] = [];
      for (const { row, revision } of rows) {
        try {
          out.push({ row, revision, definition: parseStoredDefinition(row.dungeonKey, revision.content) });
        } catch (err) {
          deps.logger?.error({ err, tag: 'dungeons/unreadable-revision', dungeonKey: row.dungeonKey, revision: revision.number }, 'published dungeon revision could not be read — hidden');
        }
      }
      return out;
    },

    async published(tx, key) {
      const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return 'missing';
      if (!row.enabled) return 'disabled';
      const revision = await publishedInfo(tx, row);
      if (!revision) return 'unpublished';
      return { row, revision, definition: parseStoredDefinition(key, revision.content) };
    },

    async revisionById(tx, revisionId) {
      const [revision] = await tx.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, revisionId));
      return revision ? { revision, definition: parseStoredDefinition(revision.dungeonKey, revision.content) } : null;
    },
  };
  return service;
}

/**
 * Every stored dungeon document — each draft, and each revision that is
 * currently published or still has a run on it — for where-used lookups
 * (enemies, managed artwork). Unreadable documents are skipped.
 */
export async function readDungeonContentDocuments(
  tx: DbOrTx,
): Promise<{ dungeonKey: string; name: string; source: 'draft' | 'published'; definition: DungeonDefinition }[]> {
  const out: { dungeonKey: string; name: string; source: 'draft' | 'published'; definition: DungeonDefinition }[] = [];
  const rows = await tx.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
  for (const row of rows) {
    const draft = DungeonDefinitionSchema.safeParse(row.draft);
    if (draft.success) out.push({ dungeonKey: row.dungeonKey, name: draft.data.name, source: 'draft', definition: draft.data });
  }
  const current = await tx
    .select({ revision: dungeonRevisions })
    .from(dungeonRevisions)
    .innerJoin(dungeonDefinitions, eq(dungeonDefinitions.publishedRevisionId, dungeonRevisions.id));
  // A superseded revision is still being played while a run on it is active.
  const inPlay = await tx
    .selectDistinct({ revisionId: dungeonRuns.revisionId })
    .from(dungeonRuns)
    .where(eq(dungeonRuns.status, 'active'));
  const seen = new Set(current.map((c) => c.revision.id));
  const extraIds = inPlay.map((r) => r.revisionId).filter((id) => !seen.has(id));
  const extra = extraIds.length ? await tx.select({ revision: dungeonRevisions }).from(dungeonRevisions).where(inArray(dungeonRevisions.id, extraIds)) : [];
  for (const { revision } of [...current, ...extra]) {
    const parsed = DungeonDefinitionSchema.safeParse(revision.content);
    if (parsed.success) out.push({ dungeonKey: revision.dungeonKey, name: parsed.data.name, source: 'published', definition: parsed.data });
  }
  return out;
}
