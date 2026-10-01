/**
 * Where live reward tables are read from, and how shipped tables reach the
 * database.
 *
 * ## Reading
 *
 * Bosses and expeditions read a table through a {@link RewardTableSource},
 * inside the transaction that snapshots it (a boss spawn, a mission deploy).
 * Production wires {@link databaseRewardTableSource}: the `reward_tables` row
 * is authoritative. {@link contentRewardTableSource} reads the loaded content
 * files instead — the behaviour before migration 0047, kept for fixtures and
 * tools that run without a seeded database.
 *
 * ## Seeding
 *
 * `content/bossRewards.json` and `content/expeditionRewards.json` stay the
 * shipped defaults. {@link seedRewardTables} runs at startup and, per shipped
 * table:
 *
 *   - no row → insert it;
 *   - row untouched since its last seed (`content_hash = seed_hash`) → update
 *     it to the shipped table if that changed;
 *   - row edited by an admin (`content_hash ≠ seed_hash`) → leave it, and
 *     report the divergence — unless the shipped table now *equals* the row
 *     (the edit was exported and committed), in which case the row is adopted
 *     as shipped again.
 *
 * The decision is made on hashes, not on `updated_by`: an admin who saves a
 * table back to exactly its shipped contents has not diverged, and a seed
 * cannot mistake a renamed actor for an untouched row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { rewardTables, type RewardTableRow } from '../../db/schema';
import { ContentValidationError } from '../../shared/errors';
import {
  BossRewardsFileSchema,
  ExpeditionRewardsFileSchema,
  type BossRewardTable,
  type ExpeditionRewardTable,
  type LoadedContent,
} from '../content/schemas';
import {
  REWARD_TABLE_KINDS,
  rewardTableFile,
  rewardTableHash,
  rewardTableSchema,
  type AnyRewardTable,
  type RewardTableKind,
} from './rewardTableCore';

// ── reading ─────────────────────────────────────────────────────────────────

export interface RewardTableSource {
  /** A boss table by id, enabled or not; undefined when there is none. */
  bossTable(tx: DbOrTx, id: string): Promise<BossRewardTable | undefined>;
  /** An expedition table by id, enabled or not; undefined when there is none. */
  expeditionTable(tx: DbOrTx, id: string): Promise<ExpeditionRewardTable | undefined>;
}

/** Parse a stored row. A row this build cannot read is loud, never coerced. */
export function parseRewardTableRow(row: Pick<RewardTableRow, 'kind' | 'tableId' | 'definition'>): AnyRewardTable {
  const kind = row.kind as RewardTableKind;
  const parsed = rewardTableSchema(kind).safeParse(row.definition);
  if (!parsed.success) {
    throw new ContentValidationError(
      `reward table ${kind}/"${row.tableId}" in the database does not parse: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

async function readRow(tx: DbOrTx, kind: RewardTableKind, id: string): Promise<RewardTableRow | undefined> {
  const [row] = await tx
    .select()
    .from(rewardTables)
    .where(and(eq(rewardTables.kind, kind), eq(rewardTables.tableId, id)));
  return row;
}

/** The live tables: the `reward_tables` rows. */
export const databaseRewardTableSource: RewardTableSource = {
  async bossTable(tx, id) {
    const row = await readRow(tx, 'boss', id);
    return row ? (parseRewardTableRow(row) as BossRewardTable) : undefined;
  },
  async expeditionTable(tx, id) {
    const row = await readRow(tx, 'expedition', id);
    return row ? (parseRewardTableRow(row) as ExpeditionRewardTable) : undefined;
  },
};

/** The loaded content files — pre-0047 behaviour, for fixtures and tools. */
export function contentRewardTableSource(getContent: () => LoadedContent): RewardTableSource {
  return {
    async bossTable(_tx, id) {
      return getContent().bossRewards.find((t) => t.id === id);
    },
    async expeditionTable(_tx, id) {
      return getContent().expeditionRewards.find((t) => t.id === id);
    },
  };
}

// ── shipped tables ──────────────────────────────────────────────────────────

/** One table as shipped in Git. */
export interface ShippedRewardTable {
  kind: RewardTableKind;
  id: string;
  /** Exactly as the file writes it — what the row stores and export writes back. */
  definition: Record<string, unknown>;
  hash: string;
  /** Index in its file. */
  position: number;
}

/**
 * Read both shipped files as authored. Each is validated with the same file
 * schema the content loader uses, so a file the loader would refuse is
 * refused here too; the *raw* objects are kept, so a seeded row exports back
 * to the bytes-for-meaning file it came from.
 */
export function loadShippedRewardTables(contentDir: string): ShippedRewardTable[] {
  const out: ShippedRewardTable[] = [];
  for (const kind of REWARD_TABLE_KINDS) {
    const file = path.join(contentDir, rewardTableFile(kind));
    if (!fs.existsSync(file)) continue;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    (kind === 'boss' ? BossRewardsFileSchema : ExpeditionRewardsFileSchema).parse(raw);
    out.push(...shippedFrom(kind, raw as Record<string, unknown>[]));
  }
  return out;
}

/** Shipped tables from already-loaded content (tests, tools). */
export function shippedRewardTablesFromContent(content: Pick<LoadedContent, 'bossRewards' | 'expeditionRewards'>) {
  return [
    ...shippedFrom('boss', content.bossRewards as unknown as Record<string, unknown>[]),
    ...shippedFrom('expedition', content.expeditionRewards as unknown as Record<string, unknown>[]),
  ];
}

function shippedFrom(kind: RewardTableKind, tables: readonly Record<string, unknown>[]): ShippedRewardTable[] {
  return tables.map((definition, position) => ({
    kind,
    id: String(definition.id),
    definition,
    hash: rewardTableHash(kind, definition),
    position,
  }));
}

// ── seeding ─────────────────────────────────────────────────────────────────

export interface RewardTableDivergence {
  kind: RewardTableKind;
  id: string;
  /** True when Git changed the table since it was last seeded — that change was not applied. */
  shippedChanged: boolean;
  updatedBy: string | null;
  revision: number;
}

export interface RewardTableSeedResult {
  created: string[];
  updated: string[];
  /** Edited rows the shipped file has caught up with; now count as shipped again. */
  adopted: string[];
  diverged: RewardTableDivergence[];
  unchanged: number;
}

export const SEED_ACTOR = 'seed';

/**
 * Bring the database up to the shipped tables without overwriting an admin
 * edit. Idempotent; each table is its own transaction with its row locked, so
 * a save racing the seed either lands first (and is then preserved) or waits.
 */
export async function seedRewardTables(
  db: Db,
  shipped: readonly ShippedRewardTable[],
): Promise<RewardTableSeedResult> {
  const result: RewardTableSeedResult = { created: [], updated: [], adopted: [], diverged: [], unchanged: 0 };
  for (const table of shipped) {
    const label = `${table.kind}/${table.id}`;
    const enabled = table.definition.enabled !== false;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(rewardTables)
        .where(and(eq(rewardTables.kind, table.kind), eq(rewardTables.tableId, table.id)))
        .for('update');

      if (!row) {
        const inserted = await tx
          .insert(rewardTables)
          .values({
            kind: table.kind,
            tableId: table.id,
            enabled,
            definition: table.definition,
            contentHash: table.hash,
            seedHash: table.hash,
            position: table.position,
            updatedBy: SEED_ACTOR,
          })
          .onConflictDoNothing()
          .returning({ id: rewardTables.tableId });
        if (inserted.length > 0) result.created.push(label);
        else result.unchanged += 1;
        return;
      }

      if (row.contentHash === row.seedHash) {
        if (row.contentHash === table.hash) {
          result.unchanged += 1;
          return;
        }
        await tx
          .update(rewardTables)
          .set({
            enabled,
            definition: table.definition,
            contentHash: table.hash,
            seedHash: table.hash,
            position: table.position,
            revision: sql`${rewardTables.revision} + 1`,
            updatedAt: new Date(),
            updatedBy: SEED_ACTOR,
          })
          .where(and(eq(rewardTables.kind, table.kind), eq(rewardTables.tableId, table.id)));
        result.updated.push(label);
        return;
      }

      if (row.contentHash === table.hash) {
        // The admin edit was promoted back into Git: the row is shipped again.
        // Nothing about the table changes, so neither does its revision.
        await tx
          .update(rewardTables)
          .set({ seedHash: table.hash, position: table.position })
          .where(and(eq(rewardTables.kind, table.kind), eq(rewardTables.tableId, table.id)));
        result.adopted.push(label);
        return;
      }

      result.diverged.push({
        kind: table.kind,
        id: table.id,
        shippedChanged: row.seedHash !== table.hash,
        updatedBy: row.updatedBy,
        revision: row.revision,
      });
    });
  }
  return result;
}
