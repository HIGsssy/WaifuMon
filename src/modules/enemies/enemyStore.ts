/**
 * How combat enemies are stored, and how shipped enemies reach the database.
 *
 * The same arrangement as reward tables and dungeon zones
 * (`rewardTableStore.ts`, `dungeonZoneStore.ts`):
 * `content/combat/enemies.json` holds the shipped defaults, the
 * `combat_enemies` row is authoritative once it exists, and
 * {@link seedCombatEnemies} runs at startup. Per shipped enemy:
 *
 *   - no row → insert it;
 *   - row untouched since its last seed (`content_hash = seed_hash`) → update
 *     it to the shipped enemy if that changed;
 *   - row edited by an admin (`content_hash ≠ seed_hash`) → leave it and
 *     report the divergence — unless the shipped enemy now *equals* the row
 *     (the edit was exported and committed), in which case the row is adopted
 *     as shipped again.
 *
 * An enemy that exists only in the database is never touched by the seed, and
 * neither is a row whose enemy was later removed from the file: removing an
 * enemy from Git does not delete it here (content may still name it).
 *
 * The hash covers the **portable** definition — exactly what the JSON file
 * can say. The managed artwork ids on the row are local to one environment
 * and are left out, so attaching an uploaded image does not turn a shipped
 * enemy into an edited one, and a seed update never clears them.
 *
 * {@link mergeLegacyEnemyArtwork} is the one-time move of the old
 * `combat_enemy_artwork` overlay onto the enemy rows. It runs after the seed.
 */
import { createHash } from 'node:crypto';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { combatEnemies, combatEnemyArtwork, type CombatEnemyRow } from '../../db/schema';
import { ContentValidationError } from '../../shared/errors';
import { SpritePlacementSchema, type SpritePlacement } from '../artworkAssets/scenePlacement';
import { CombatEnemyDefinitionSchema, type CombatEnemyDefinition } from '../combat/enemyDefinitions';
import { canonicalJson } from '../rewardTables/rewardTableCore';

export const ENEMY_SEED_ACTOR = 'seed';

/** One enemy as shipped in Git. */
export interface ShippedCombatEnemy {
  key: string;
  definition: CombatEnemyDefinition;
  hash: string;
  /** Its index in the file: the list order. */
  position: number;
}

/** The hash of an enemy's portable definition. Managed artwork ids are not part of it. */
export function combatEnemyHash(enemy: unknown): string {
  const parsed = CombatEnemyDefinitionSchema.parse(enemy);
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

/** The loaded shipped file, hashed. `enemies` is `LoadedContent.combatEnemies`. */
export function shippedCombatEnemies(enemies: readonly CombatEnemyDefinition[] | undefined): ShippedCombatEnemy[] {
  return (enemies ?? []).map((definition, position) => ({
    key: definition.key,
    definition,
    hash: combatEnemyHash(definition),
    position,
  }));
}

function placementOf(row: Pick<CombatEnemyRow, 'spritePlacement'>): SpritePlacement | null {
  if (!row.spritePlacement) return null;
  const parsed = SpritePlacementSchema.safeParse(row.spritePlacement);
  return parsed.success ? parsed.data : null;
}

/**
 * The validated definition a row holds — what the combat engine, a run
 * snapshot and an export all see. A row this build cannot read is loud.
 */
export function enemyDefinitionOf(row: CombatEnemyRow): CombatEnemyDefinition {
  const parsed = CombatEnemyDefinitionSchema.safeParse({
    key: row.enemyKey,
    name: row.name,
    description: row.description,
    attack: row.attack,
    defense: row.defense,
    hp: row.hp,
    artworkPath: row.artworkPath,
    spriteArtworkPath: row.spriteArtworkPath,
    spritePlacement: placementOf(row),
    enabled: row.enabled,
    tags: row.tags,
  });
  if (!parsed.success) {
    throw new ContentValidationError(
      `enemy "${row.enemyKey}" in the database does not parse: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** The portable columns of a definition. The managed artwork ids are not among them. */
export function enemyColumnsOf(definition: CombatEnemyDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    enabled: definition.enabled,
    attack: definition.attack,
    defense: definition.defense,
    hp: definition.hp,
    tags: [...definition.tags],
    artworkPath: definition.artworkPath,
    spriteArtworkPath: definition.spriteArtworkPath,
    spritePlacement: definition.spritePlacement as Record<string, unknown> | null,
  };
}

export async function readCombatEnemyRow(tx: DbOrTx, key: string, lock = false): Promise<CombatEnemyRow | undefined> {
  const query = tx.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, key));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** Every enemy row, in list order. */
export async function readCombatEnemyRows(tx: DbOrTx): Promise<CombatEnemyRow[]> {
  return tx.select().from(combatEnemies).orderBy(asc(combatEnemies.position), asc(combatEnemies.enemyKey));
}

export interface CombatEnemyDivergence {
  key: string;
  /** True when Git changed the enemy since it was last seeded — that change was not applied. */
  shippedChanged: boolean;
  updatedBy: string | null;
  revision: number;
}

export interface CombatEnemySeedResult {
  created: string[];
  updated: string[];
  /** Edited rows the shipped file has caught up with; now count as shipped again. */
  adopted: string[];
  diverged: CombatEnemyDivergence[];
  unchanged: number;
}

/**
 * Bring the database up to the shipped enemies without overwriting an admin
 * edit. Idempotent; each enemy is its own transaction with its row locked, so
 * a save racing the seed either lands first (and is then preserved) or waits.
 */
export async function seedCombatEnemies(
  db: Db,
  shipped: readonly ShippedCombatEnemy[],
): Promise<CombatEnemySeedResult> {
  const result: CombatEnemySeedResult = { created: [], updated: [], adopted: [], diverged: [], unchanged: 0 };
  for (const enemy of shipped) {
    const values = {
      ...enemyColumnsOf(enemy.definition),
      contentHash: enemy.hash,
      seedHash: enemy.hash,
      position: enemy.position,
      updatedBy: ENEMY_SEED_ACTOR,
    };
    await db.transaction(async (tx) => {
      const row = await readCombatEnemyRow(tx, enemy.key, true);
      if (!row) {
        const inserted = await tx
          .insert(combatEnemies)
          .values({ enemyKey: enemy.key, ...values })
          .onConflictDoNothing()
          .returning({ key: combatEnemies.enemyKey });
        if (inserted.length > 0) result.created.push(enemy.key);
        else result.unchanged += 1;
        return;
      }
      if (row.contentHash === row.seedHash) {
        if (row.contentHash === enemy.hash) {
          result.unchanged += 1;
          return;
        }
        // The managed artwork ids are not in `values`: a shipped change never clears them.
        await tx
          .update(combatEnemies)
          .set({ ...values, revision: sql`${combatEnemies.revision} + 1`, updatedAt: new Date() })
          .where(eq(combatEnemies.enemyKey, enemy.key));
        result.updated.push(enemy.key);
        return;
      }
      if (row.contentHash === enemy.hash) {
        // The admin edit was promoted back into Git: the row is shipped again.
        // Nothing about the enemy changes, so neither does its revision.
        await tx.update(combatEnemies).set({ seedHash: enemy.hash }).where(eq(combatEnemies.enemyKey, enemy.key));
        result.adopted.push(enemy.key);
        return;
      }
      result.diverged.push({
        key: enemy.key,
        shippedChanged: row.seedHash !== enemy.hash,
        updatedBy: row.updatedBy,
        revision: row.revision,
      });
    });
  }
  return result;
}

export interface LegacyEnemyArtworkMergeResult {
  /** Overlay rows copied onto their enemy. */
  merged: { key: string; artwork: boolean; sprite: boolean; placement: boolean }[];
  /** Overlay rows whose enemy does not exist; left unmerged, and reported. */
  orphaned: string[];
}

/**
 * The one-time move of managed enemy artwork from the old overlay table
 * (`combat_enemy_artwork`, migration 0054) onto the enemy rows.
 *
 * Per overlay row not yet stamped `merged_at`:
 *
 *   - its `artwork_asset_id` / `sprite_asset_id` fill the enemy's, where the
 *     enemy has none yet (an id set on the enemy since is never replaced);
 *   - its `sprite_placement`, when it set one, becomes the enemy's placement.
 *     That is a real difference from the shipped file, so the enemy then
 *     reads as *edited* — which is what it was;
 *   - the overlay row is stamped and kept. Nothing is deleted.
 *
 * An overlay row for a key with no enemy (the enemy was removed from Git) is
 * left unstamped: it merges if that enemy ever comes back. Idempotent; safe
 * to run on every start, and a no-op once every row is stamped.
 */
export async function mergeLegacyEnemyArtwork(db: Db): Promise<LegacyEnemyArtworkMergeResult> {
  const result: LegacyEnemyArtworkMergeResult = { merged: [], orphaned: [] };
  const pending = await db
    .select({ key: combatEnemyArtwork.enemyKey })
    .from(combatEnemyArtwork)
    .where(isNull(combatEnemyArtwork.mergedAt))
    .orderBy(asc(combatEnemyArtwork.enemyKey));

  for (const { key } of pending) {
    await db.transaction(async (tx) => {
      const [overlay] = await tx
        .select()
        .from(combatEnemyArtwork)
        .where(eq(combatEnemyArtwork.enemyKey, key))
        .for('update');
      if (!overlay || overlay.mergedAt !== null) return;
      const row = await readCombatEnemyRow(tx, key, true);
      if (!row) {
        result.orphaned.push(key);
        return;
      }
      const placement = overlay.spritePlacement ? SpritePlacementSchema.safeParse(overlay.spritePlacement) : null;
      const artworkAssetId = row.artworkAssetId ?? overlay.artworkAssetId;
      const spriteAssetId = row.spriteAssetId ?? overlay.spriteAssetId;
      const moved = placement?.success ? placement.data : null;
      const definition = enemyDefinitionOf(
        moved ? { ...row, spritePlacement: moved as Record<string, unknown> } : row,
      );
      const contentHash = combatEnemyHash(definition);
      const changed =
        artworkAssetId !== row.artworkAssetId || spriteAssetId !== row.spriteAssetId || contentHash !== row.contentHash;
      if (changed) {
        await tx
          .update(combatEnemies)
          .set({
            artworkAssetId,
            spriteAssetId,
            spritePlacement: definition.spritePlacement as Record<string, unknown> | null,
            contentHash,
            revision: sql`${combatEnemies.revision} + 1`,
            // Who last authored it: the admin who saved the overlay.
            updatedAt: overlay.updatedAt,
            updatedBy: overlay.updatedBy,
          })
          .where(eq(combatEnemies.enemyKey, key));
      }
      await tx.update(combatEnemyArtwork).set({ mergedAt: new Date() }).where(eq(combatEnemyArtwork.enemyKey, key));
      result.merged.push({
        key,
        artwork: artworkAssetId !== row.artworkAssetId,
        sprite: spriteAssetId !== row.spriteAssetId,
        placement: contentHash !== row.contentHash,
      });
    });
  }
  return result;
}

interface SeedLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Say, at startup, what the seed and the artwork merge did. Silent about unchanged enemies. */
export function reportCombatEnemySeed(
  logger: SeedLogger,
  seed: CombatEnemySeedResult,
  merge?: LegacyEnemyArtworkMergeResult,
): void {
  if (seed.created.length > 0 || seed.updated.length > 0 || seed.adopted.length > 0) {
    logger.info(
      {
        tag: 'combat-enemies/seed',
        created: seed.created,
        updated: seed.updated,
        adopted: seed.adopted,
        unchanged: seed.unchanged,
      },
      `seeded combat enemies from shipped content: ${seed.created.length} inserted, ` +
        `${seed.updated.length} updated from Git, ${seed.adopted.length} adopted as shipped again`,
    );
  }
  for (const d of seed.diverged) {
    const fields = { tag: 'combat-enemies/diverged', ...d };
    if (d.shippedChanged) {
      logger.warn(
        fields,
        `enemy ${d.key} was edited in Portal Admin and Git has also changed it — ` +
          'the shipped change was NOT applied. Export the live enemies to reconcile.',
      );
    } else {
      logger.info(fields, `enemy ${d.key} keeps its Portal Admin edit (differs from Git)`);
    }
  }
  if (merge && merge.merged.length > 0) {
    logger.info(
      { tag: 'combat-enemies/artwork-merged', merged: merge.merged },
      `moved managed artwork for ${merge.merged.length} enemies from combat_enemy_artwork onto the enemy catalogue`,
    );
  }
  if (merge && merge.orphaned.length > 0) {
    logger.warn(
      { tag: 'combat-enemies/artwork-orphaned', keys: merge.orphaned },
      `combat_enemy_artwork has rows for enemies that do not exist (${merge.orphaned.join(', ')}) — left as they are`,
    );
  }
}
