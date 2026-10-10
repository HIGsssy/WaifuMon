/**
 * Boss definitions: what a boss *is*, where the runtime reads it from, and how
 * the shipped bosses reach the database.
 *
 * `boss_definitions` is authoritative (migration 0057). `content/bosses.json`
 * is bootstrap data: {@link bootstrapBossDefinitions} inserts a shipped boss
 * whose key has no row and does nothing else — it never updates, re-enables or
 * re-orders a row that exists, so a deploy cannot undo an admin's edit.
 *
 * The spawner reads definitions through a {@link BossDefinitionSource}, inside
 * the transaction that draws the boss. Production wires
 * {@link createDatabaseBossDefinitionSource}; {@link contentBossDefinitionSource}
 * reads the loaded content file instead — the behaviour before 0057, kept for
 * fixtures and tools that run without a bootstrapped table (the same split
 * `rewardTableStore.ts` makes for reward tables).
 */
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../db/client';
import {
  AFFINITIES,
  BOSS_DEFINITION_STATUSES,
  bossDefinitionEvents,
  bossDefinitions,
  type BossDefinitionEventAction,
  type BossDefinitionRow,
  type BossDefinitionSource as BossDefinitionOrigin,
} from '../../db/schema';
import { ContentValidationError } from '../../shared/errors';
import { relativeAssetPath, type BossContent, type LoadedContent } from '../content/schemas';
import { ALWAYS_AVAILABLE, BossScheduleSchema, type BossSchedule } from './bossSchedule';
import { REGIONS } from './regions';

export const BOSS_BOOTSTRAP_ACTOR = 'bootstrap';
export const BOSS_KEY_PATTERN = /^[a-z0-9_]+$/;
export const BOSS_KEY_MAX_LENGTH = 64;
export const BOSS_NAME_MAX_LENGTH = 100;
const PROSE_MAX_LENGTH = 2000;

export const BOSS_DEFINITION_FILE_FORMAT = 'waifumon-boss-definitions';
export const BOSS_DEFINITION_FILE_VERSION = 1;

const prose = z.string().trim().max(PROSE_MAX_LENGTH).default('');

/**
 * One boss, as stored and as exported.
 *
 * Deliberately lenient about *completeness*: a draft may have no prose and no
 * reward table yet. What an **active** boss additionally needs is checked by
 * the service before activation (`bossDefinitionService.ts`), because it
 * depends on this server's reward tables and on the clock.
 */
export const BossDefinitionSchema = z
  .object({
    /** Stable identity. Snapshotted onto every encounter row, so never reused or renamed. */
    id: z
      .string()
      .min(1, 'an id is required')
      .max(BOSS_KEY_MAX_LENGTH)
      .regex(BOSS_KEY_PATTERN, 'must be lowercase snake_case (letters, digits, underscores)'),
    name: z.string().trim().min(1, 'a name is required').max(BOSS_NAME_MAX_LENGTH),
    affinity: z.enum(AFFINITIES),
    /** Regions whose guilds may draw this boss. */
    regions: z.array(z.enum(REGIONS)).default([]),
    status: z.enum(BOSS_DEFINITION_STATUSES).default('draft'),
    /** Shipped artwork: a path under the assets root. The fallback when `artworkAssetId` is unset or unusable. */
    artwork: relativeAssetPath.nullable().default(null),
    /**
     * Managed artwork uploaded through the Portal (an `artwork_assets` id).
     * Wins over `artwork` while the asset is active. Ids belong to one
     * environment: an export carries them, another server will not know them.
     */
    artworkAssetId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .nullable()
      .default(null),
    rewardTable: z.string().trim().max(200).default(''),
    scoutingText: prose,
    repelledText: prose,
    unchallengedText: prose,
    description: prose,
    schedule: BossScheduleSchema.default(ALWAYS_AVAILABLE),
  })
  .strict();

export type BossDefinition = z.infer<typeof BossDefinitionSchema>;

/** The prose an encounter freezes at spawn (`boss_encounters.boss_snapshot`). */
export interface BossEncounterSnapshot {
  scoutingText: string;
  repelledText: string;
  unchallengedText: string;
  description: string;
  /** The definition revision the encounter was drawn from; null for a content-sourced boss. */
  definitionRevision: number | null;
}

/** A shipped `bosses.json` entry as a definition: `enabled` becomes the status, the schedule is "always". */
export function bossDefinitionFromContent(boss: BossContent): BossDefinition {
  return {
    id: boss.id,
    name: boss.name,
    affinity: boss.affinity,
    regions: [boss.region],
    status: boss.enabled ? 'active' : 'disabled',
    artwork: boss.artwork,
    artworkAssetId: null,
    rewardTable: boss.rewardTable,
    scoutingText: boss.scoutingText,
    repelledText: boss.repelledText,
    unchallengedText: boss.unchallengedText,
    description: boss.description,
    schedule: ALWAYS_AVAILABLE,
  };
}

/** A definition in the shape the presenters and the Discord layer already read. */
export function bossContentFromDefinition(definition: BossDefinition): BossContent {
  return {
    id: definition.id,
    name: definition.name,
    affinity: definition.affinity,
    region: definition.regions[0] ?? REGIONS[0],
    enabled: definition.status === 'active',
    artwork: definition.artwork,
    rewardTable: definition.rewardTable,
    scoutingText: definition.scoutingText,
    repelledText: definition.repelledText,
    unchallengedText: definition.unchallengedText,
    description: definition.description,
  };
}

/** The validated definition a row holds. A row this build cannot read is loud, never coerced. */
export function bossDefinitionOf(row: BossDefinitionRow): BossDefinition {
  const parsed = BossDefinitionSchema.safeParse({
    id: row.bossKey,
    name: row.name,
    affinity: row.affinity,
    regions: row.regions,
    status: row.status,
    artwork: row.artwork,
    artworkAssetId: row.artworkAssetId,
    rewardTable: row.rewardTable,
    scoutingText: row.scoutingText,
    repelledText: row.repelledText,
    unchallengedText: row.unchallengedText,
    description: row.description,
    schedule: row.schedule,
  });
  if (!parsed.success) {
    throw new ContentValidationError(
      `boss "${row.bossKey}" in the database does not parse: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** Every column a definition owns. The key, revision and bookkeeping are not among them. */
export function bossColumnsOf(definition: BossDefinition) {
  return {
    name: definition.name,
    affinity: definition.affinity,
    regions: [...definition.regions] as string[],
    status: definition.status,
    artwork: definition.artwork,
    artworkAssetId: definition.artworkAssetId,
    rewardTable: definition.rewardTable,
    scoutingText: definition.scoutingText,
    repelledText: definition.repelledText,
    unchallengedText: definition.unchallengedText,
    description: definition.description,
    schedule: definition.schedule as unknown as Record<string, unknown>,
  };
}

export async function readBossDefinitionRow(
  tx: DbOrTx,
  key: string,
  lock = false,
): Promise<BossDefinitionRow | undefined> {
  const query = tx.select().from(bossDefinitions).where(eq(bossDefinitions.bossKey, key));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** Every definition row, in list order. */
export async function readBossDefinitionRows(tx: DbOrTx): Promise<BossDefinitionRow[]> {
  return tx.select().from(bossDefinitions).orderBy(asc(bossDefinitions.position), asc(bossDefinitions.bossKey));
}

/** Append one row to the Boss Management audit trail, in the caller's transaction. */
export async function recordBossEvent(
  tx: DbOrTx,
  event: { bossKey: string; action: BossDefinitionEventAction; actor: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(bossDefinitionEvents).values({
    bossKey: event.bossKey,
    action: event.action,
    actor: event.actor,
    details: event.details ?? {},
  });
}

/** Insert a definition row. Returns undefined when the key is already taken. */
export async function insertBossDefinitionRow(
  tx: DbOrTx,
  definition: BossDefinition,
  meta: { source: BossDefinitionOrigin; actor: string | null; position?: number },
): Promise<BossDefinitionRow | undefined> {
  let position = meta.position;
  if (position === undefined) {
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${bossDefinitions.position}), -1) + 1` })
      .from(bossDefinitions);
    position = Number(next);
  }
  const [inserted] = await tx
    .insert(bossDefinitions)
    .values({
      bossKey: definition.id,
      ...bossColumnsOf(definition),
      source: meta.source,
      position,
      updatedBy: meta.actor,
    })
    .onConflictDoNothing()
    .returning();
  return inserted;
}

export interface BossBootstrapResult {
  /** Shipped bosses that had no row and were inserted. */
  created: string[];
  /**
   * Of `created`, those the file marks enabled but which were inserted
   * **Disabled**, because the table already held definitions (see below).
   */
  heldBack: string[];
  /** Shipped bosses that already had a row — left exactly as they were. */
  existing: number;
  /** True when the table was empty: this was the one-time migration of the shipped roster. */
  initial: boolean;
}

/** Serialises concurrent bootstraps (two processes starting at once). Arbitrary, stable. */
const BOOTSTRAP_LOCK_KEY = 5_705_701;

/**
 * Insert every shipped boss that has no row yet. Idempotent, and the *only*
 * thing startup ever does to this table: an existing row is not read, compared
 * or written, whatever the file says now.
 *
 * Two cases, told apart by whether the table holds anything:
 *
 *   - **Empty table — the migration.** The shipped roster arrives exactly as
 *     the file has it: `enabled: true` is Active, `enabled: false` is Disabled.
 *     The pool the scheduler draws from is the one it drew from yesterday.
 *   - **Table already populated — a boss added to the file later.** It is
 *     inserted **Disabled**, whatever the file says. Once the database is the
 *     authority, a deploy must not be able to put a new boss into rotation; an
 *     admin activates it in Boss Management.
 *
 * One transaction, behind an advisory lock: the migration is all-or-nothing
 * (a crash halfway cannot leave a partial roster that the next start would
 * mistake for "already populated"), and two processes starting together
 * cannot both believe the table is empty.
 */
export async function bootstrapBossDefinitions(
  db: Db,
  shipped: readonly BossContent[],
): Promise<BossBootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    const [{ total } = { total: 0 }] = await tx.select({ total: sql<number>`count(*)` }).from(bossDefinitions);
    const initial = Number(total) === 0;
    const result: BossBootstrapResult = { created: [], heldBack: [], existing: 0, initial };
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${bossDefinitions.position}), -1) + 1` })
      .from(bossDefinitions);
    let appended = Number(next);
    for (const [index, boss] of shipped.entries()) {
      const fromFile = bossDefinitionFromContent(boss);
      const heldBack = !initial && fromFile.status === 'active';
      const inserted = await insertBossDefinitionRow(
        tx,
        heldBack ? { ...fromFile, status: 'disabled' } : fromFile,
        {
          source: 'bootstrap',
          actor: BOSS_BOOTSTRAP_ACTOR,
          // The migration keeps the file's order; a later arrival goes last.
          position: initial ? index : appended,
        },
      );
      if (!inserted) {
        result.existing += 1;
        continue;
      }
      if (!initial) appended += 1;
      await recordBossEvent(tx, {
        bossKey: boss.id,
        action: 'bootstrap',
        actor: BOSS_BOOTSTRAP_ACTOR,
        details: { status: inserted.status, initial, heldBack },
      });
      result.created.push(boss.id);
      if (heldBack) result.heldBack.push(boss.id);
    }
    return result;
  });
}

// ── runtime source ──────────────────────────────────────────────────────────

/** A definition with the revision it was read at (null when it did not come from a row). */
export interface SourcedBossDefinition {
  definition: BossDefinition;
  revision: number | null;
}

export interface BossDefinitionSource {
  /** Every definition, whatever its status, read through `tx`. */
  list(tx: DbOrTx): Promise<SourcedBossDefinition[]>;
  /**
   * The definition last seen for `id`, without a query. Used only to caption
   * an encounter spawned before prose was snapshotted onto it.
   */
  peek(id: string): BossDefinition | undefined;
}

/** `boss_definitions` — the production source. Remembers what it last read, for {@link BossDefinitionSource.peek}. */
export function createDatabaseBossDefinitionSource(): BossDefinitionSource {
  let lastSeen = new Map<string, BossDefinition>();
  return {
    async list(tx) {
      const rows = await readBossDefinitionRows(tx);
      const out = rows.map((row) => ({ definition: bossDefinitionOf(row), revision: row.revision }));
      lastSeen = new Map(out.map((entry) => [entry.definition.id, entry.definition]));
      return out;
    },
    peek: (id) => lastSeen.get(id),
  };
}

/** The loaded `bosses.json` — pre-0057 behaviour, for fixtures and tools. */
export function contentBossDefinitionSource(getContent: () => Pick<LoadedContent, 'bosses'>): BossDefinitionSource {
  return {
    async list() {
      return getContent().bosses.map((boss) => ({ definition: bossDefinitionFromContent(boss), revision: null }));
    },
    peek(id) {
      const boss = getContent().bosses.find((b) => b.id === id);
      return boss ? bossDefinitionFromContent(boss) : undefined;
    },
  };
}

export type { BossSchedule };
