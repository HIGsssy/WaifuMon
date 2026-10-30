/**
 * The journal that makes an artwork-carrying import recoverable (Content
 * Portability CP-3, shared with CP-4B dungeon bundles).
 *
 * Artwork files and PostgreSQL rows cannot commit together, so every import
 * that writes files follows one order, whatever it imports:
 *
 *   1. {@link openImportJournal} commits a `staged` row naming the storage key
 *      of every file the import is about to write — before any is written;
 *   2. the import writes those files under ids it generated itself;
 *   3. its one transaction inserts the asset rows and its content, and sets
 *      the row `applied` with the result (the receipt a retry replays);
 *   4. {@link failImportJournal}, on a caught failure, removes the staged files
 *      no asset row names and marks the row `failed`;
 *   5. {@link recoverInterruptedImports}, after a crash between 2 and 3,
 *      removes the files of `staged` rows old enough that no live import owns
 *      them, and marks them `abandoned`.
 *
 * One table (`enemy_package_imports`, which predates the second kind) and one
 * recovery pass serve every kind, so a crash in either importer is cleaned up
 * by the same startup recovery. Reused assets are never named in a journal and
 * a file some row names is never removed.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { enemyPackageImports, type ImportJournalKind } from '../../../db/schema';
import type { ArtworkStorage } from '../artworkStorage';
import { removeUnclaimedStagedFiles } from './artworkBundle';

export type ImportJournalRow = typeof enemyPackageImports.$inferSelect;

/** A `staged` journal row older than this belongs to no live import. */
export const IMPORT_RECOVERY_AGE_MS = 10 * 60 * 1000;

export async function findImportReceipt(db: Db, requestId: string): Promise<ImportJournalRow | null> {
  const [row] = await db.select().from(enemyPackageImports).where(eq(enemyPackageImports.requestId, requestId));
  return row ?? null;
}

/**
 * Commit the `staged` row, or reclaim a failed/abandoned attempt of the very
 * same request. Anything else holding the id is a conflict; `inProgress` says
 * the same request is still staged (running, or awaiting recovery).
 */
export async function openImportJournal(
  db: Db,
  input: {
    kind: ImportJournalKind;
    requestId: string;
    requestHash: string;
    packageHash: string;
    planHash: string;
    keys: string[];
    actor: string | null;
  },
  now: Date,
): Promise<{ row: ImportJournalRow } | { conflict: { inProgress: boolean } }> {
  const [inserted] = await db
    .insert(enemyPackageImports)
    .values({
      kind: input.kind,
      requestId: input.requestId,
      requestHash: input.requestHash,
      packageHash: input.packageHash,
      planHash: input.planHash,
      status: 'staged',
      stagedStorageKeys: input.keys,
      actor: input.actor,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted };
  const [reclaimed] = await db
    .update(enemyPackageImports)
    .set({ status: 'staged', stagedStorageKeys: input.keys, planHash: input.planHash, createdAt: now, finishedAt: null, error: null })
    .where(
      and(
        eq(enemyPackageImports.requestId, input.requestId),
        eq(enemyPackageImports.requestHash, input.requestHash),
        eq(enemyPackageImports.kind, input.kind),
        inArray(enemyPackageImports.status, ['failed', 'abandoned']),
      ),
    )
    .returning();
  if (reclaimed) return { row: reclaimed };
  const existing = await findImportReceipt(db, input.requestId);
  return { conflict: { inProgress: existing?.requestHash === input.requestHash && existing.kind === input.kind && existing.status === 'staged' } };
}

/** The `applied` update, run inside the import's own transaction. */
export function markImportApplied(
  tx: Pick<Db, 'update'>,
  row: ImportJournalRow,
  result: Record<string, unknown>,
  now: Date,
) {
  return tx
    .update(enemyPackageImports)
    .set({ status: 'applied', result, finishedAt: now })
    .where(eq(enemyPackageImports.id, row.id));
}

/** After a caught failure: remove what was staged and no row claims, mark `failed`. Never throws. */
export async function failImportJournal(
  db: Db,
  storage: Pick<ArtworkStorage, 'delete'>,
  row: ImportJournalRow,
  err: unknown,
  now: Date,
  onCleanupError: (err: unknown) => void,
): Promise<void> {
  try {
    await removeUnclaimedStagedFiles(db, storage, row.stagedStorageKeys);
    await db
      .update(enemyPackageImports)
      .set({ status: 'failed', finishedAt: now, error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) })
      .where(and(eq(enemyPackageImports.id, row.id), eq(enemyPackageImports.status, 'staged')));
  } catch (cleanupErr) {
    // The row stays `staged`; recovery removes the files later.
    onCleanupError(cleanupErr);
  }
}

/** Remove files staged by imports of any kind that never finished. Safe to run any time. */
export async function recoverInterruptedImports(
  db: Db,
  storage: Pick<ArtworkStorage, 'delete'>,
  opts: { now: Date; olderThanMs?: number | undefined },
): Promise<{ abandoned: number; removedFiles: number }> {
  const cutoff = new Date(opts.now.getTime() - (opts.olderThanMs ?? IMPORT_RECOVERY_AGE_MS));
  const stale = await db
    .select()
    .from(enemyPackageImports)
    .where(and(eq(enemyPackageImports.status, 'staged'), lt(enemyPackageImports.createdAt, cutoff)));
  let removedFiles = 0;
  let abandoned = 0;
  for (const row of stale) {
    const removed = await removeUnclaimedStagedFiles(db, storage, row.stagedStorageKeys);
    removedFiles += removed.length;
    const [marked] = await db
      .update(enemyPackageImports)
      .set({ status: 'abandoned', finishedAt: opts.now, error: `interrupted; ${removed.length} staged file(s) removed` })
      .where(and(eq(enemyPackageImports.id, row.id), eq(enemyPackageImports.status, 'staged')))
      .returning({ id: enemyPackageImports.id });
    if (marked) abandoned += 1;
  }
  return { abandoned, removedFiles };
}
