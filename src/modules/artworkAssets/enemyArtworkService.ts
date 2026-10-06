/**
 * How an enemy's artwork is resolved — pure, shared by the Enemy Catalogue,
 * the dungeon run snapshot and the play service.
 *
 * An enemy (`combat_enemies`, see `modules/enemies`) carries:
 *
 *   - `artworkPath` / `spriteArtworkPath`  shipped files under `assets/`;
 *   - `artworkAssetId` / `spriteAssetId`   managed uploads, which win;
 *   - `spritePlacement`                    where the sprite stands.
 *
 * {@link resolveEnemyVisual} is the one statement of that precedence, and
 * {@link roomEnemyArtwork} lays an authored room's override on top.
 *
 * (Managed enemy artwork used to be a separate overlay table with its own
 * service here. The enemy row owns it now; only the resolution rules remain.)
 */
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import { DEFAULT_SPRITE_PLACEMENT, type SpritePlacement } from './scenePlacement';

/** The managed layer over an enemy's shipped artwork. Each field is independent; null means "not set". */
export interface ManagedEnemyArtwork {
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  /**
   * A placement that overrides the enemy's own. Null for every enemy today
   * (the placement is part of the definition); still set in dungeon runs
   * snapshotted before the catalogue existed, and by authored rooms.
   */
  spritePlacement: SpritePlacement | null;
}

/** Everything a screen needs to draw an enemy, managed and shipped together. */
export interface EnemyVisual {
  artworkAssetId: string | null;
  artworkPath: string | null;
  spriteAssetId: string | null;
  spriteArtworkPath: string | null;
  spritePlacement: SpritePlacement;
}

type ShippedEnemyVisual = Pick<CombatEnemyDefinition, 'artworkPath'> &
  Partial<Pick<CombatEnemyDefinition, 'spriteArtworkPath' | 'spritePlacement'>>;

/** Managed where set, shipped otherwise. Tolerates an enemy snapshotted before sprites existed. */
export function resolveEnemyVisual(
  enemy: ShippedEnemyVisual,
  managed: ManagedEnemyArtwork | null | undefined,
): EnemyVisual {
  return {
    artworkAssetId: managed?.artworkAssetId ?? null,
    artworkPath: enemy.artworkPath ?? null,
    spriteAssetId: managed?.spriteAssetId ?? null,
    spriteArtworkPath: enemy.spriteArtworkPath ?? null,
    spritePlacement: managed?.spritePlacement ?? enemy.spritePlacement ?? DEFAULT_SPRITE_PLACEMENT,
  };
}

/**
 * An authored room's override laid over the enemy's managed artwork, field by
 * field: the room's value where it set one, else the enemy's. The result goes
 * through {@link resolveEnemyVisual}, so the whole precedence reads
 *
 *     room override  →  enemy managed  →  enemy definition  →  system default
 */
export function roomEnemyArtwork(
  managed: ManagedEnemyArtwork | null | undefined,
  room: Partial<ManagedEnemyArtwork> | null | undefined,
): ManagedEnemyArtwork | null {
  if (!room) return managed ?? null;
  return {
    artworkAssetId: room.artworkAssetId ?? managed?.artworkAssetId ?? null,
    spriteAssetId: room.spriteAssetId ?? managed?.spriteAssetId ?? null,
    spritePlacement: room.spritePlacement ?? managed?.spritePlacement ?? null,
  };
}
