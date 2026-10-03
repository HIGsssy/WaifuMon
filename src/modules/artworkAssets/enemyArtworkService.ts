/**
 * Managed artwork for combat enemies.
 *
 * Enemies are file content (`content/combat/enemies.json`); their shipped
 * `artworkPath`, `spriteArtworkPath` and `spritePlacement` stay the defaults.
 * This service is the overlay an admin edits in the Portal — one
 * `combat_enemy_artwork` row per enemy key holding:
 *
 *   - `artworkAssetId`  full artwork (replaces the shipped `artworkPath`);
 *   - `spriteAssetId`   a transparent sprite for composed scenes (replaces the
 *                       shipped `spriteArtworkPath`);
 *   - `spritePlacement` where the sprite stands (replaces the shipped default).
 *
 * Each is independent and nullable; null means "use the shipped value".
 * {@link resolveEnemyVisual} is the one statement of that precedence.
 *
 * Saves are optimistic (`expectedRevision`, 0 for an enemy with no row yet),
 * validated (the enemy exists; every asset exists and is not deleted) and
 * audited through the asset service's reference trail.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { combatEnemyArtwork, type CombatEnemyArtworkRow } from '../../db/schema';
import { AppError, EnemyArtworkStaleError } from '../../shared/errors';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { ArtworkAssetService } from './artworkAssetService';
import { DEFAULT_SPRITE_PLACEMENT, SpritePlacementSchema, type SpritePlacement } from './scenePlacement';

export interface EnemyArtworkOverride {
  enemyKey: string;
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  spritePlacement: SpritePlacement | null;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Everything a screen needs to draw an enemy, managed and shipped together. */
export interface EnemyVisual {
  artworkAssetId: string | null;
  artworkPath: string | null;
  spriteAssetId: string | null;
  spriteArtworkPath: string | null;
  spritePlacement: SpritePlacement;
}

export interface EnemyArtworkEntry {
  key: string;
  name: string;
  enabled: boolean;
  /** The shipped (Git) values. */
  artworkPath: string | null;
  spriteArtworkPath: string | null;
  shippedPlacement: SpritePlacement | null;
  /** The Portal override; null when none has been saved. */
  managed: EnemyArtworkOverride | null;
  /** What is in effect: managed where set, shipped otherwise. */
  visual: EnemyVisual;
}

export interface EnemyArtworkInput {
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  spritePlacement: SpritePlacement | null;
  /** The revision edited; 0 when the enemy had no override. */
  expectedRevision: number;
}

export interface EnemyArtworkService {
  list(): Promise<EnemyArtworkEntry[]>;
  get(enemyKey: string): Promise<EnemyArtworkEntry | null>;
  /** Null when `enemyKey` names no enemy. */
  save(enemyKey: string, input: EnemyArtworkInput, actor: string | null): Promise<EnemyArtworkEntry | null>;
  /** Overrides for the given enemies, for a run snapshot. */
  getMany(enemyKeys: readonly string[], tx?: DbOrTx): Promise<Record<string, EnemyArtworkOverride>>;
}

export interface EnemyArtworkServiceDeps {
  db: Db;
  getEnemies: () => readonly CombatEnemyDefinition[];
  assets: Pick<ArtworkAssetService, 'getMany' | 'recordReferenceChanges'>;
}

type ShippedEnemyVisual = Pick<CombatEnemyDefinition, 'artworkPath'> &
  Partial<Pick<CombatEnemyDefinition, 'spriteArtworkPath' | 'spritePlacement'>>;

/** Managed where set, shipped otherwise. Tolerates an enemy snapshotted before sprites existed. */
export function resolveEnemyVisual(
  enemy: ShippedEnemyVisual,
  managed: Pick<EnemyArtworkOverride, 'artworkAssetId' | 'spriteAssetId' | 'spritePlacement'> | null | undefined,
): EnemyVisual {
  return {
    artworkAssetId: managed?.artworkAssetId ?? null,
    artworkPath: enemy.artworkPath ?? null,
    spriteAssetId: managed?.spriteAssetId ?? null,
    spriteArtworkPath: enemy.spriteArtworkPath ?? null,
    spritePlacement: managed?.spritePlacement ?? enemy.spritePlacement ?? DEFAULT_SPRITE_PLACEMENT,
  };
}

function toOverride(row: CombatEnemyArtworkRow): EnemyArtworkOverride {
  const placement = row.spritePlacement ? SpritePlacementSchema.safeParse(row.spritePlacement) : null;
  return {
    enemyKey: row.enemyKey,
    artworkAssetId: row.artworkAssetId,
    spriteAssetId: row.spriteAssetId,
    spritePlacement: placement?.success ? placement.data : null,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function createEnemyArtworkService(deps: EnemyArtworkServiceDeps): EnemyArtworkService {
  const { db } = deps;

  const entryOf = (enemy: CombatEnemyDefinition, managed: EnemyArtworkOverride | null): EnemyArtworkEntry => ({
    key: enemy.key,
    name: enemy.name,
    enabled: enemy.enabled,
    artworkPath: enemy.artworkPath,
    spriteArtworkPath: enemy.spriteArtworkPath ?? null,
    shippedPlacement: enemy.spritePlacement ?? null,
    managed,
    visual: resolveEnemyVisual(enemy, managed),
  });

  async function getMany(keys: readonly string[], tx: DbOrTx = db): Promise<Record<string, EnemyArtworkOverride>> {
    if (keys.length === 0) return {};
    const rows = await tx.select().from(combatEnemyArtwork).where(inArray(combatEnemyArtwork.enemyKey, [...new Set(keys)]));
    return Object.fromEntries(rows.map((row) => [row.enemyKey, toOverride(row)]));
  }

  return {
    getMany,

    async list() {
      const enemies = deps.getEnemies();
      const managed = await getMany(enemies.map((e) => e.key));
      return enemies.map((enemy) => entryOf(enemy, managed[enemy.key] ?? null));
    },

    async get(enemyKey) {
      const enemy = deps.getEnemies().find((e) => e.key === enemyKey);
      if (!enemy) return null;
      return entryOf(enemy, (await getMany([enemyKey]))[enemyKey] ?? null);
    },

    async save(enemyKey, input, actor) {
      const enemy = deps.getEnemies().find((e) => e.key === enemyKey);
      if (!enemy) return null;
      const placement = input.spritePlacement === null ? null : SpritePlacementSchema.parse(input.spritePlacement);

      return db.transaction(async (tx) => {
        const ids = [input.artworkAssetId, input.spriteAssetId].filter((v): v is string => v !== null);
        const assets = await deps.assets.getMany(ids, tx);
        for (const [field, id] of [['artworkAssetId', input.artworkAssetId], ['spriteAssetId', input.spriteAssetId]] as const) {
          if (id === null) continue;
          const asset = assets.get(id.toLowerCase());
          if (!asset || asset.status === 'deleted') {
            throw new AppError('VALIDATION_ERROR', `${field}: artwork asset ${id} does not exist`, 'That artwork no longer exists — choose another.');
          }
        }

        const [row] = await tx.select().from(combatEnemyArtwork).where(eq(combatEnemyArtwork.enemyKey, enemyKey)).for('update');
        const currentRevision = row?.revision ?? 0;
        if (currentRevision !== input.expectedRevision) {
          throw new EnemyArtworkStaleError(enemyKey, input.expectedRevision, currentRevision);
        }
        const values = {
          artworkAssetId: input.artworkAssetId?.toLowerCase() ?? null,
          spriteAssetId: input.spriteAssetId?.toLowerCase() ?? null,
          spritePlacement: placement as Record<string, unknown> | null,
          updatedAt: new Date(),
          updatedBy: actor,
        };
        const [saved] = row
          ? await tx
              .update(combatEnemyArtwork)
              .set({ ...values, revision: sql`${combatEnemyArtwork.revision} + 1` })
              .where(eq(combatEnemyArtwork.enemyKey, enemyKey))
              .returning()
          : await tx.insert(combatEnemyArtwork).values({ enemyKey, ...values }).returning();

        await deps.assets.recordReferenceChanges(
          tx,
          {
            entity: `combat_enemy:${enemyKey}`,
            before: [
              { field: 'artworkAssetId', assetId: row?.artworkAssetId ?? null },
              { field: 'spriteAssetId', assetId: row?.spriteAssetId ?? null },
            ],
            after: [
              { field: 'artworkAssetId', assetId: values.artworkAssetId },
              { field: 'spriteAssetId', assetId: values.spriteAssetId },
            ],
          },
          actor,
        );
        return entryOf(enemy, toOverride(saved!));
      });
    },
  };
}
