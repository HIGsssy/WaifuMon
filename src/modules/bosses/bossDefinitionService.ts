/**
 * Boss Management: authoring boss definitions in Portal Admin.
 *
 * `boss_definitions` is authoritative; this service is the only thing that
 * writes it after the startup bootstrap. The spawner reads the same rows
 * through `BossDefinitionSource` and never through here.
 *
 *   - **authoring** — list, get, validate, create, update, lifecycle
 *     (Draft / Active / Disabled), duplicate, delete, export, import. Every
 *     write is optimistic (`expectedRevision`), validated, and recorded in
 *     `boss_definition_events`.
 *   - **lifecycle** — a Draft may be incomplete. A boss is checked in full
 *     before it becomes (or is saved as) Active: prose, a region, a reward
 *     table that exists, and a schedule that can still produce a window.
 *   - **editing never reaches a live encounter** — an encounter freezes the
 *     boss onto its own row at spawn, so nothing here can change one.
 *
 * Disable, don't delete. Delete exists for a mistake that never spawned, and
 * is refused for a boss with encounter history or one that ships in Git (the
 * bootstrap would only re-insert it).
 */
import { count, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../db/client';
import type { ArtworkAssetService } from '../artworkAssets/artworkAssetService';
import {
  artworkAssets,
  bossDefinitionEvents,
  bossDefinitions,
  bossEncounters,
  type BossDefinitionEventAction,
  type BossDefinitionEventRow,
  type BossDefinitionRow,
  type BossDefinitionSource as BossDefinitionOrigin,
  type BossDefinitionStatus,
} from '../../db/schema';
import {
  BossDefinitionInUseError,
  BossDefinitionInvalidError,
  BossDefinitionKeyTakenError,
  BossDefinitionStaleError,
  type BossDefinitionIssueDetail,
} from '../../shared/errors';
import {
  BOSS_DEFINITION_FILE_FORMAT,
  BOSS_DEFINITION_FILE_VERSION,
  BossDefinitionSchema,
  bossColumnsOf,
  bossDefinitionOf,
  insertBossDefinitionRow,
  readBossDefinitionRow,
  readBossDefinitionRows,
  recordBossEvent,
  type BossDefinition,
} from './bossDefinitions';
import {
  describeBossSchedule,
  evaluateBossSchedule,
  validateBossSchedule,
  type BossAvailability,
} from './bossSchedule';

export type BossDefinitionIssue = BossDefinitionIssueDetail;

/**
 * Ids a new boss may not take: they are path segments of the admin routes and
 * of the Portal's pages, so a boss named one of them could not be opened.
 */
export const RESERVED_BOSS_KEYS: ReadonlySet<string> = new Set([
  'new',
  'export',
  'import',
  'validate',
  'reference',
  'activity',
  'artwork',
  'diagnostics',
  'events',
  'schedule',
  'encounters',
]);

export interface BossDefinitionSummary extends BossDefinition {
  revision: number;
  /** How the row came to exist: the startup bootstrap, the Portal, or an import. */
  source: BossDefinitionOrigin;
  /** Whether this build's `bosses.json` ships a boss of this id. */
  shipped: boolean;
  /** Encounters ever recorded for this boss, in every guild. */
  encounterCount: number;
  lastEncounterAt: Date | null;
  /** The schedule in words. */
  scheduleSummary: string;
  /** Where the schedule stands right now. Status and cooldown are separate questions. */
  availability: BossAvailability;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface BossDefinitionDetail extends BossDefinitionSummary {
  /** Problems with the stored boss against this server right now. */
  issues: BossDefinitionIssue[];
}

export interface BossSchedulePreview {
  issues: BossDefinitionIssue[];
  summary: string | null;
  availability: BossAvailability | null;
}

export interface BossDefinitionExport {
  /** A suggested file name for the download. */
  file: string;
  document: {
    format: typeof BOSS_DEFINITION_FILE_FORMAT;
    version: typeof BOSS_DEFINITION_FILE_VERSION;
    bosses: BossDefinition[];
  };
}

export type BossImportAction =
  /** No boss of that id exists; applying inserts it. */
  | 'create'
  /** A boss of that id exists and differs. Applied only when the admin chose to overwrite. */
  | 'conflict'
  | 'unchanged'
  | 'invalid';

export interface BossImportPlanEntry {
  id: string;
  name: string | null;
  action: BossImportAction;
  /** The existing row's revision; null when there is none. */
  currentRevision: number | null;
  /** Which fields differ from the existing boss, for a conflict. */
  changedFields: string[];
  issues: BossDefinitionIssue[];
}

export interface BossImportPlan {
  entries: BossImportPlanEntry[];
  /** Problems with the package as a whole. */
  issues: BossDefinitionIssue[];
  /** False while the package or any boss in it has an error. */
  canApply: boolean;
}

export type BossImportConflictMode =
  /** Leave every existing boss exactly as it is; only new ids are inserted. */
  | 'skip'
  /** Replace the existing bosses the plan listed as conflicts. */
  | 'overwrite';

export interface BossImportResult {
  created: string[];
  overwritten: string[];
  skipped: string[];
  unchanged: string[];
}

export interface BossEventView {
  id: number;
  bossKey: string;
  action: BossDefinitionEventAction;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface BossDefinitionService {
  list(now?: Date): Promise<BossDefinitionSummary[]>;
  get(key: string, now?: Date): Promise<BossDefinitionDetail | null>;
  /** Dry run: every issue creating (`creating`) or saving this boss would raise. Writes nothing. */
  validate(input: { id: string; boss: unknown; creating: boolean }, now?: Date): Promise<BossDefinitionIssue[]>;
  /** Check a schedule on its own and say where it stands now. Writes nothing. */
  previewSchedule(schedule: unknown, now?: Date): BossSchedulePreview;
  /** @throws {BossDefinitionInvalidError | BossDefinitionKeyTakenError} */
  create(id: string, input: unknown, actor: string | null, now?: Date): Promise<BossDefinitionDetail>;
  /** Null for an unknown id. @throws {BossDefinitionInvalidError | BossDefinitionStaleError} */
  update(
    key: string,
    input: { boss: unknown; expectedRevision: number },
    actor: string | null,
    now?: Date,
  ): Promise<BossDefinitionDetail | null>;
  /**
   * Move a boss between Draft, Active and Disabled. Activating validates the
   * whole boss; leaving Active never does, so a broken boss can always be
   * switched off.
   */
  setStatus(
    key: string,
    input: { status: BossDefinitionStatus; expectedRevision: number },
    actor: string | null,
    now?: Date,
  ): Promise<BossDefinitionDetail | null>;
  /** A copy under a new id. It starts as a **Draft**. Null for an unknown source. */
  duplicate(
    sourceKey: string,
    input: { id: string; name?: string | undefined },
    actor: string | null,
    now?: Date,
  ): Promise<BossDefinitionDetail | null>;
  /**
   * Hard delete, for a boss with no encounter history that Git does not ship.
   * @returns false for an unknown id.
   * @throws {BossDefinitionInUseError | BossDefinitionStaleError}
   */
  delete(key: string, input: { expectedRevision: number }, actor: string | null): Promise<boolean>;
  export(): Promise<BossDefinitionExport>;
  planImport(document: unknown, now?: Date): Promise<BossImportPlan>;
  /**
   * Apply a reviewed import. Existing bosses are never replaced unless
   * `conflicts` is `overwrite`, and then only at the revision the plan showed
   * (`expectedRevisions`) — a boss edited since makes the import stale.
   * @throws {BossDefinitionInvalidError | BossDefinitionStaleError}
   */
  applyImport(
    document: unknown,
    input: { conflicts: BossImportConflictMode; expectedRevisions?: Record<string, number> | undefined },
    actor: string | null,
    now?: Date,
  ): Promise<BossImportResult>;
  /** The boss reward tables an editor may pick from, in their own order. */
  rewardTableOptions(): Promise<{ id: string; enabled: boolean }[]>;
  /**
   * Whether the shipped roster made it into the database: how many definitions
   * exist, which shipped bosses have no row (a failed or not-yet-run
   * bootstrap), and what this process's last bootstrap reported.
   */
  bootstrapState(): Promise<{ definitions: number; missingShipped: string[]; lastRun: BossBootstrapReport | null }>;
  /** Record the outcome of a startup bootstrap, so diagnostics can show it. */
  noteBootstrap(report: BossBootstrapReport): void;
  /** The audit trail, newest first; for one boss when `bossKey` is given. */
  events(opts?: { bossKey?: string | undefined; limit?: number | undefined }): Promise<BossEventView[]>;
  /** Record an operator action on a live encounter (manual spawn, schedule override, manual end). */
  recordOperatorAction(event: {
    bossKey: string;
    action: Extract<BossDefinitionEventAction, 'manual_spawn' | 'schedule_override' | 'manual_end'>;
    actor: string | null;
    details: Record<string, unknown>;
  }): Promise<void>;
  /**
   * The definitions as of the last read or write through this service, without
   * a query — for callers that only need "which bosses name this reward table".
   */
  cached(): readonly BossDefinition[];
  /** Re-read {@link cached}. Called at startup, after the bootstrap. */
  refresh(): Promise<void>;
}

/** A boss reward table an editor may pick, and whether it can currently pay. */
export interface BossRewardTableOption {
  id: string;
  enabled: boolean;
}

/** What the last startup bootstrap in this process did, for diagnostics. */
export interface BossBootstrapReport {
  at: Date;
  /** Null when it succeeded. */
  error: string | null;
  created: string[];
  heldBack: string[];
}

export interface BossDefinitionServiceDeps {
  db: Db;
  /**
   * The boss reward tables that exist on this server, in display order, read
   * through `tx`. Injected because where reward tables live is not this
   * module's business (the `reward_tables` rows, or the content file).
   */
  listRewardTables: (tx: DbOrTx) => Promise<BossRewardTableOption[]>;
  /** Ids of the bosses this build's `bosses.json` ships. */
  getShippedIds: () => readonly string[];
  /** Regions the scheduler runs in (`bossEncounters.regions`). */
  getEnabledRegions: () => readonly string[];
  /** Whether a relative artwork path resolves to a file. Absent: artwork is not checked. */
  artworkExists?: ((relativePath: string) => boolean) | undefined;
  /**
   * Managed artwork. With it, a boss's `artworkAssetId` is checked against the
   * assets that exist and every change of it lands in the asset's own audit
   * trail. Absent (a server without managed artwork): a boss cannot name one.
   */
  assets?: Pick<ArtworkAssetService, 'getMany' | 'recordReferenceChanges'> | undefined;
}

const BossInputSchema = BossDefinitionSchema.omit({ id: true });

/** JSON with object keys in a fixed order, so two equal values always compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const zodPath = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');

const error = (path: string, message: string): BossDefinitionIssue => ({ path, message, severity: 'error' });
const warning = (path: string, message: string): BossDefinitionIssue => ({ path, message, severity: 'warning' });
const hasErrors = (issues: readonly BossDefinitionIssue[]) => issues.some((i) => i.severity === 'error');

const PROSE_FIELDS = [
  ['description', 'a description'],
  ['scoutingText', 'the scouting text shown while the window is open'],
  ['repelledText', 'the text shown when the boss is repelled'],
  ['unchallengedText', 'the text shown when nobody commits'],
] as const;

const COMPARED_FIELDS = [
  'name',
  'affinity',
  'regions',
  'status',
  'artwork',
  'artworkAssetId',
  'rewardTable',
  'scoutingText',
  'repelledText',
  'unchallengedText',
  'description',
  'schedule',
] as const;

export function createBossDefinitionService(deps: BossDefinitionServiceDeps): BossDefinitionService {
  const { db } = deps;
  let cache: BossDefinition[] = [];
  let lastBootstrap: BossBootstrapReport | null = null;

  async function refresh(tx: DbOrTx = db): Promise<void> {
    cache = (await readBossDefinitionRows(tx)).map(bossDefinitionOf);
  }

  /** Encounter count and last appearance per boss id, in one query. */
  async function encounterUsage(tx: DbOrTx): Promise<Map<string, { total: number; last: Date | null }>> {
    const rows = await tx
      .select({ bossId: bossEncounters.bossId, total: count(), last: max(bossEncounters.scheduledAt) })
      .from(bossEncounters)
      .groupBy(bossEncounters.bossId);
    return new Map(rows.map((r) => [r.bossId, { total: Number(r.total), last: r.last }]));
  }

  function summaryOf(
    row: BossDefinitionRow,
    usage: { total: number; last: Date | null } | undefined,
    now: Date,
  ): BossDefinitionSummary {
    const definition = bossDefinitionOf(row);
    return {
      ...definition,
      revision: row.revision,
      source: row.source,
      shipped: deps.getShippedIds().includes(row.bossKey),
      encounterCount: usage?.total ?? 0,
      lastEncounterAt: usage?.last ?? null,
      scheduleSummary: describeBossSchedule(definition.schedule),
      availability: evaluateBossSchedule(definition.schedule, now),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /**
   * Everything wrong with a parsed definition on this server. What must hold
   * for a boss to spawn is an error only when the boss is Active; on a Draft
   * or Disabled boss the same gap is a warning, so unfinished work can be saved.
   */
  async function serverIssues(tx: DbOrTx, definition: BossDefinition, now: Date): Promise<BossDefinitionIssue[]> {
    const issues: BossDefinitionIssue[] = [];
    const active = definition.status === 'active';
    const required = (path: string, message: string) => issues.push(active ? error(path, message) : warning(path, message));

    for (const [field, what] of PROSE_FIELDS) {
      if (definition[field].length === 0) required(field, `An active boss needs ${what}.`);
    }

    if (new Set(definition.regions).size !== definition.regions.length) {
      issues.push(error('regions', 'the same region is listed twice'));
    }
    if (definition.regions.length === 0) {
      required('regions', 'An active boss needs at least one region.');
    } else if (!definition.regions.some((r) => deps.getEnabledRegions().includes(r))) {
      issues.push(warning('regions', 'Boss encounters are not enabled in any of these regions, so this boss cannot spawn.'));
    }

    if (definition.rewardTable.length === 0) {
      required('rewardTable', 'An active boss needs a reward table.');
    } else {
      const table = (await deps.listRewardTables(tx)).find((t) => t.id === definition.rewardTable);
      if (!table) {
        required('rewardTable', `Boss reward table "${definition.rewardTable}" does not exist.`);
      } else if (!table.enabled) {
        issues.push(
          warning('rewardTable', `Reward table "${definition.rewardTable}" is disabled, so this boss will not spawn until it is enabled.`),
        );
      }
    }

    if (definition.artwork && deps.artworkExists && !deps.artworkExists(definition.artwork)) {
      issues.push(
        warning(
          'artwork',
          definition.artworkAssetId
            ? `No file at "${definition.artwork}" — there is no shipped fallback behind the uploaded artwork.`
            : `No file at "${definition.artwork}" — the encounter will render without artwork.`,
        ),
      );
    }
    if (definition.artworkAssetId) {
      const asset = deps.assets
        ? (await deps.assets.getMany([definition.artworkAssetId], tx)).get(definition.artworkAssetId)
        : undefined;
      if (!asset || asset.status === 'deleted') {
        // An id from another environment (an import) or a removed upload.
        issues.push(
          error('artworkAssetId', 'That uploaded artwork does not exist on this server — choose another image or clear it.'),
        );
      } else if (asset.status === 'disabled') {
        issues.push(
          warning(
            'artworkAssetId',
            `The uploaded artwork "${asset.name}" is disabled, so the encounter falls back to ${
              definition.artwork ? 'the shipped file' : 'no picture'
            }.`,
          ),
        );
      }
    }

    const schedule = validateBossSchedule(definition.schedule);
    for (const issue of schedule.issues) issues.push({ ...issue, path: `schedule.${issue.path}` });
    if (schedule.schedule) {
      const availability = evaluateBossSchedule(schedule.schedule, now);
      if (!availability.availableNow && !availability.nextWindow) {
        required('schedule', availability.unavailableReason ?? 'This schedule can never make the boss available.');
      }
    }
    return issues;
  }

  /**
   * Hold the managed artwork a write is about to name until that write
   * commits. Deleting an asset locks its row and then looks for references, so
   * whichever of the two goes first, the other sees it: the delete finds this
   * boss, or this save finds the asset gone. Without it both could pass.
   */
  async function holdArtwork(tx: DbOrTx, assetId: string | null): Promise<void> {
    if (!assetId || !deps.assets) return;
    await tx.select({ id: artworkAssets.id }).from(artworkAssets).where(eq(artworkAssets.id, assetId)).for('share');
  }

  /** Parse an input into a definition. Collects, never throws. */
  function parse(id: string, input: unknown, creating: boolean): { definition: BossDefinition | null; issues: BossDefinitionIssue[] } {
    const issues: BossDefinitionIssue[] = [];
    const parsedId = BossDefinitionSchema.shape.id.safeParse(id);
    if (!parsedId.success) {
      for (const issue of parsedId.error.issues) issues.push(error('id', issue.message));
    } else if (creating && RESERVED_BOSS_KEYS.has(id)) {
      issues.push(error('id', `"${id}" is reserved — choose another id`));
    }
    const parsed = BossInputSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push(error(zodPath(issue.path), issue.message));
      return { definition: null, issues };
    }
    if (hasErrors(issues)) return { definition: null, issues };
    return { definition: { id, ...parsed.data }, issues };
  }

  async function assertWritable(
    tx: DbOrTx,
    id: string,
    input: unknown,
    creating: boolean,
    now: Date,
  ): Promise<BossDefinition> {
    const { definition, issues } = parse(id, input, creating);
    if (definition) {
      await holdArtwork(tx, definition.artworkAssetId);
      issues.push(...(await serverIssues(tx, definition, now)));
    }
    if (!definition || hasErrors(issues)) throw new BossDefinitionInvalidError(issues);
    return definition;
  }

  function assertRevision(row: BossDefinitionRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new BossDefinitionStaleError(row.bossKey, expectedRevision, row.revision, row.updatedBy, row.updatedAt);
    }
  }

  /** A boss's managed-artwork reference, as the asset audit trail records it. */
  async function recordArtworkReference(
    tx: DbOrTx,
    key: string,
    before: string | null,
    after: string | null,
    actor: string | null,
  ): Promise<void> {
    if (before === after) return;
    await deps.assets?.recordReferenceChanges(
      tx,
      {
        entity: `boss:${key}`,
        before: [{ field: 'artworkAssetId', assetId: before }],
        after: [{ field: 'artworkAssetId', assetId: after }],
      },
      actor,
    );
  }

  const changedFieldsOf = (before: BossDefinition, after: BossDefinition): string[] =>
    COMPARED_FIELDS.filter((field) => stableJson(before[field]) !== stableJson(after[field]));

  /** The conditional write every edit goes through. */
  async function writeRow(
    tx: DbOrTx,
    row: BossDefinitionRow,
    definition: BossDefinition,
    actor: string | null,
  ): Promise<BossDefinitionRow> {
    const [updated] = await tx
      .update(bossDefinitions)
      .set({
        ...bossColumnsOf(definition),
        revision: sql`${bossDefinitions.revision} + 1`,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(bossDefinitions.bossKey, row.bossKey))
      .returning();
    return updated!;
  }

  async function detailOf(tx: DbOrTx, row: BossDefinitionRow, now: Date): Promise<BossDefinitionDetail> {
    const usage = (await encounterUsage(tx)).get(row.bossKey);
    const summary = summaryOf(row, usage, now);
    return { ...summary, issues: await serverIssues(tx, bossDefinitionOf(row), now) };
  }

  /** The bosses in an import package, however it was wrapped. */
  function bossesOf(document: unknown): { bosses: unknown[] | null; issues: BossDefinitionIssue[] } {
    if (Array.isArray(document)) return { bosses: document, issues: [] };
    const wrapper = z
      .object({ format: z.literal(BOSS_DEFINITION_FILE_FORMAT), version: z.number().int(), bosses: z.array(z.unknown()) })
      .safeParse(document);
    if (!wrapper.success) {
      return {
        bosses: null,
        issues: [
          error('document', `expected a "${BOSS_DEFINITION_FILE_FORMAT}" document (as exported from Boss Management), or an array of bosses`),
        ],
      };
    }
    if (wrapper.data.version > BOSS_DEFINITION_FILE_VERSION) {
      return {
        bosses: null,
        issues: [error('document.version', `version ${wrapper.data.version} is newer than this server understands (${BOSS_DEFINITION_FILE_VERSION})`)],
      };
    }
    return { bosses: wrapper.data.bosses, issues: [] };
  }

  async function planWith(
    tx: DbOrTx,
    document: unknown,
    now: Date,
    lock = false,
  ): Promise<{ plan: BossImportPlan; definitions: (BossDefinition | null)[] }> {
    const { bosses, issues } = bossesOf(document);
    if (!bosses) return { plan: { entries: [], issues, canApply: false }, definitions: [] };
    if (bosses.length === 0) issues.push(error('document.bosses', 'the package contains no bosses'));
    const seen = new Set<string>();
    const entries: BossImportPlanEntry[] = [];
    const definitions: (BossDefinition | null)[] = [];
    for (const [index, input] of bosses.entries()) {
      const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : `#${index}`;
      if (seen.has(id)) issues.push(error(`bosses[${index}].id`, `"${id}" appears twice in the package`));
      seen.add(id);
      const { id: _id, ...rest } = raw;
      const row = typeof raw.id === 'string' ? await readBossDefinitionRow(tx, id, lock) : undefined;
      const { definition, issues: entryIssues } = parse(id, rest, !row);
      if (typeof raw.id !== 'string') entryIssues.push(error('id', 'every boss needs an id'));
      if (definition) {
        // Only an import being applied holds anything; a plan is a dry run.
        if (lock) await holdArtwork(tx, definition.artworkAssetId);
        entryIssues.push(...(await serverIssues(tx, definition, now)));
      }
      const changedFields = definition && row ? changedFieldsOf(bossDefinitionOf(row), definition) : [];
      const action: BossImportAction =
        !definition || hasErrors(entryIssues)
          ? 'invalid'
          : !row
            ? 'create'
            : changedFields.length === 0
              ? 'unchanged'
              : 'conflict';
      entries.push({
        id,
        name: typeof raw.name === 'string' ? raw.name : null,
        action,
        currentRevision: row?.revision ?? null,
        changedFields,
        issues: entryIssues,
      });
      definitions.push(action === 'invalid' ? null : definition);
    }
    const canApply = !hasErrors(issues) && entries.every((e) => e.action !== 'invalid');
    return { plan: { entries, issues, canApply }, definitions };
  }

  return {
    async list(now = new Date()) {
      const rows = await readBossDefinitionRows(db);
      cache = rows.map(bossDefinitionOf);
      const usage = await encounterUsage(db);
      return rows.map((row) => summaryOf(row, usage.get(row.bossKey), now));
    },

    async get(key, now = new Date()) {
      const row = await readBossDefinitionRow(db, key);
      return row ? detailOf(db, row, now) : null;
    },

    async validate({ id, boss, creating }, now = new Date()) {
      const { definition, issues } = parse(id, boss, creating);
      if (creating && !issues.some((i) => i.path === 'id') && (await readBossDefinitionRow(db, id))) {
        issues.push(error('id', 'another boss already uses that id'));
      }
      if (definition) issues.push(...(await serverIssues(db, definition, now)));
      return issues;
    },

    previewSchedule(input, now = new Date()) {
      const { schedule, issues } = validateBossSchedule(input);
      if (!schedule) return { issues, summary: null, availability: null };
      const availability = evaluateBossSchedule(schedule, now);
      if (!availability.availableNow && !availability.nextWindow && availability.unavailableReason) {
        issues.push(warning('', availability.unavailableReason));
      }
      return { issues, summary: describeBossSchedule(schedule), availability };
    },

    async create(id, input, actor, now = new Date()) {
      const detail = await db.transaction(async (tx) => {
        const definition = await assertWritable(tx, id, input, true, now);
        const inserted = await insertBossDefinitionRow(tx, definition, { source: 'portal', actor });
        if (!inserted) throw new BossDefinitionKeyTakenError(id);
        await recordBossEvent(tx, { bossKey: id, action: 'create', actor, details: { status: definition.status } });
        await recordArtworkReference(tx, id, null, definition.artworkAssetId, actor);
        return detailOf(tx, inserted, now);
      });
      await refresh();
      return detail;
    },

    async update(key, { boss: input, expectedRevision }, actor, now = new Date()) {
      const detail = await db.transaction(async (tx) => {
        const row = await readBossDefinitionRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const before = bossDefinitionOf(row);
        const definition = await assertWritable(tx, key, input, false, now);
        const updated = await writeRow(tx, row, definition, actor);
        const changed = changedFieldsOf(before, definition);
        await recordBossEvent(tx, {
          bossKey: key,
          action: 'update',
          actor,
          details: { revision: updated.revision, changed },
        });
        await recordArtworkReference(tx, key, before.artworkAssetId, definition.artworkAssetId, actor);
        // A status change made through a full save is still a lifecycle change.
        if (before.status !== definition.status) {
          await recordBossEvent(tx, {
            bossKey: key,
            action: 'status',
            actor,
            details: { from: before.status, to: definition.status, revision: updated.revision },
          });
        }
        return detailOf(tx, updated, now);
      });
      await refresh();
      return detail;
    },

    async setStatus(key, { status, expectedRevision }, actor, now = new Date()) {
      const detail = await db.transaction(async (tx) => {
        const row = await readBossDefinitionRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const before = bossDefinitionOf(row);
        const definition = { ...before, status };
        // Only activation is validated: switching a boss off must work even
        // when its reward table has since been deleted.
        if (status === 'active') {
          const issues = await serverIssues(tx, definition, now);
          if (hasErrors(issues)) throw new BossDefinitionInvalidError(issues);
        }
        const updated = await writeRow(tx, row, definition, actor);
        await recordBossEvent(tx, {
          bossKey: key,
          action: 'status',
          actor,
          details: { from: before.status, to: status, revision: updated.revision },
        });
        return detailOf(tx, updated, now);
      });
      await refresh();
      return detail;
    },

    async duplicate(sourceKey, input, actor, now = new Date()) {
      const detail = await db.transaction(async (tx) => {
        const source = await readBossDefinitionRow(tx, sourceKey);
        if (!source) return null;
        const { id: _id, ...from } = bossDefinitionOf(source);
        const definition = await assertWritable(
          tx,
          input.id,
          // A draft until someone has looked at it: a copy must not start spawning.
          { ...from, name: input.name ?? `${from.name} (copy)`.slice(0, 100), status: 'draft' },
          true,
          now,
        );
        const inserted = await insertBossDefinitionRow(tx, definition, { source: 'portal', actor });
        if (!inserted) throw new BossDefinitionKeyTakenError(input.id);
        await recordBossEvent(tx, { bossKey: input.id, action: 'duplicate', actor, details: { from: sourceKey } });
        await recordArtworkReference(tx, input.id, null, definition.artworkAssetId, actor);
        return detailOf(tx, inserted, now);
      });
      await refresh();
      return detail;
    },

    async delete(key, { expectedRevision }, actor) {
      const deleted = await db.transaction(async (tx) => {
        const row = await readBossDefinitionRow(tx, key, true);
        if (!row) return false;
        assertRevision(row, expectedRevision);
        const encounters = (await encounterUsage(tx)).get(key)?.total ?? 0;
        // A shipped boss would simply be re-inserted by the next bootstrap.
        const shipped = deps.getShippedIds().includes(key);
        if (encounters > 0 || shipped) throw new BossDefinitionInUseError(key, encounters, shipped);
        await tx.delete(bossDefinitions).where(eq(bossDefinitions.bossKey, key));
        await recordBossEvent(tx, {
          bossKey: key,
          action: 'delete',
          actor,
          details: { name: row.name, status: row.status, revision: row.revision },
        });
        await recordArtworkReference(tx, key, row.artworkAssetId, null, actor);
        return true;
      });
      await refresh();
      return deleted;
    },

    async export() {
      const rows = await readBossDefinitionRows(db);
      return {
        file: 'boss-definitions.json',
        document: {
          format: BOSS_DEFINITION_FILE_FORMAT,
          version: BOSS_DEFINITION_FILE_VERSION,
          bosses: rows.map(bossDefinitionOf),
        },
      };
    },

    async planImport(document, now = new Date()) {
      return (await planWith(db, document, now)).plan;
    },

    async applyImport(document, { conflicts, expectedRevisions = {} }, actor, now = new Date()) {
      const result = await db.transaction(async (tx) => {
        const { plan, definitions } = await planWith(tx, document, now, true);
        if (!plan.canApply) {
          throw new BossDefinitionInvalidError([
            ...plan.issues,
            ...plan.entries.flatMap((e) => e.issues.map((i) => ({ ...i, path: `${e.id}.${i.path}` }))),
          ]);
        }
        const out: BossImportResult = { created: [], overwritten: [], skipped: [], unchanged: [] };
        for (const [index, entry] of plan.entries.entries()) {
          const definition = definitions[index]!;
          if (entry.action === 'unchanged') {
            out.unchanged.push(entry.id);
            continue;
          }
          if (entry.action === 'create') {
            const inserted = await insertBossDefinitionRow(tx, definition, { source: 'import', actor });
            if (!inserted) throw new BossDefinitionKeyTakenError(entry.id);
            await recordBossEvent(tx, { bossKey: entry.id, action: 'import', actor, details: { result: 'created' } });
            await recordArtworkReference(tx, entry.id, null, definition.artworkAssetId, actor);
            out.created.push(entry.id);
            continue;
          }
          // A conflict: an existing boss that differs. Never replaced unless asked.
          if (conflicts !== 'overwrite') {
            out.skipped.push(entry.id);
            continue;
          }
          const row = (await readBossDefinitionRow(tx, entry.id, true))!;
          const expected = Object.prototype.hasOwnProperty.call(expectedRevisions, entry.id)
            ? expectedRevisions[entry.id]
            : undefined;
          // The plan the admin reviewed must be the plan being applied.
          if (expected === undefined || expected !== row.revision) {
            throw new BossDefinitionStaleError(entry.id, expected ?? -1, row.revision, row.updatedBy, row.updatedAt);
          }
          const updated = await writeRow(tx, row, definition, actor);
          await recordArtworkReference(tx, entry.id, row.artworkAssetId, definition.artworkAssetId, actor);
          await recordBossEvent(tx, {
            bossKey: entry.id,
            action: 'import',
            actor,
            details: { result: 'overwritten', revision: updated.revision, changed: entry.changedFields },
          });
          out.overwritten.push(entry.id);
        }
        return out;
      });
      await refresh();
      return result;
    },

    async rewardTableOptions() {
      return deps.listRewardTables(db);
    },

    async bootstrapState() {
      const present = new Set((await readBossDefinitionRows(db)).map((row) => row.bossKey));
      return {
        definitions: present.size,
        missingShipped: deps.getShippedIds().filter((id) => !present.has(id)),
        lastRun: lastBootstrap,
      };
    },

    noteBootstrap(report) {
      lastBootstrap = report;
    },

    async events({ bossKey, limit = 50 } = {}) {
      const query = db.select().from(bossDefinitionEvents);
      const rows: BossDefinitionEventRow[] = await (bossKey === undefined
        ? query
        : query.where(eq(bossDefinitionEvents.bossKey, bossKey))
      )
        .orderBy(desc(bossDefinitionEvents.id))
        .limit(Math.max(1, Math.min(200, limit)));
      return rows.map((row) => ({
        id: row.id,
        bossKey: row.bossKey,
        action: row.action,
        actor: row.actor,
        details: row.details,
        createdAt: row.createdAt,
      }));
    },

    async recordOperatorAction(event) {
      await recordBossEvent(db, event);
    },

    cached: () => cache,
    refresh: () => refresh(),
  };
}
