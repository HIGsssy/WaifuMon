/**
 * Equipment definition seeding.
 *
 * The seed catalogue is **defaults for missing content**, not an enforced
 * definition — the `worldEncounters/seed.ts` model. The database is
 * authoritative for any definition that already exists: startup inserts a key
 * only when it is absent and never reads or writes one that is present, so an
 * admin's edits survive restarts and deploys. Moving changed content onto a
 * live server is the job of export/import (`equipmentImportService.ts`).
 *
 * The catalogue is read from `content/equipment/equipment.seed.json`, written
 * in the package format, so the same file can also be imported by hand. It is
 * validated exactly like any package: an invalid seed file fails loudly.
 *
 * Retiring a seeded definition on live servers needs a migration that sets
 * `enabled = false` (the 0044 precedent) — removing it from the file only stops
 * a *fresh* database gaining it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { equipmentDefinitions } from '../../db/schema';
import { definitionColumnValues, type EquipmentDefinitionInput } from './definitionSchema';
import { assertSlotChangeAllowed } from './equipmentDefinitionService';
import { parseEquipmentPackage } from './equipmentPackage';

/** Relative to the content directory. */
export const EQUIPMENT_SEED_FILE = path.join('equipment', 'equipment.seed.json');

/**
 * How a seed treats a key that already exists.
 *
 *  - `insert-missing` — production/bootstrap. An existing row is never read
 *    beyond the conflict and never written.
 *  - `reset` — destructive, tests only. Overwrites existing rows from the
 *    catalogue (still refusing a slot change on a referenced definition).
 */
export type EquipmentSeedMode = 'insert-missing' | 'reset';

export interface EquipmentSeedResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Read and validate the seed catalogue. A missing file is an empty catalogue;
 * a present but invalid one throws `EquipmentValidationError`.
 */
export function loadEquipmentSeedCatalogue(contentDir: string): EquipmentDefinitionInput[] {
  const file = path.join(contentDir, EQUIPMENT_SEED_FILE);
  if (!fs.existsSync(file)) return [];
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parseEquipmentPackage(raw).definitions;
}

/** Seed the catalogue, per key. Never touches a key the catalogue does not name. */
export async function seedEquipmentDefinitions(
  db: Db,
  opts: { mode?: EquipmentSeedMode; catalogue: readonly EquipmentDefinitionInput[] },
): Promise<EquipmentSeedResult> {
  const mode = opts.mode ?? 'insert-missing';
  const result: EquipmentSeedResult = { created: [], updated: [], skipped: [] };

  for (const input of opts.catalogue) {
    if (mode === 'insert-missing') {
      const inserted = await db
        .insert(equipmentDefinitions)
        .values(definitionColumnValues(input))
        .onConflictDoNothing({ target: equipmentDefinitions.key })
        .returning({ key: equipmentDefinitions.key });
      (inserted.length > 0 ? result.created : result.skipped).push(input.key);
      continue;
    }

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(equipmentDefinitions)
        .where(eq(equipmentDefinitions.key, input.key))
        .for('update');
      if (!existing) {
        await tx.insert(equipmentDefinitions).values(definitionColumnValues(input));
        result.created.push(input.key);
        return;
      }
      await assertSlotChangeAllowed(tx, existing, input.slot);
      await tx
        .update(equipmentDefinitions)
        .set({ ...definitionColumnValues(input), updatedAt: sql`now()`, updatedBy: null })
        .where(eq(equipmentDefinitions.id, existing.id));
      result.updated.push(input.key);
    });
  }
  return result;
}
