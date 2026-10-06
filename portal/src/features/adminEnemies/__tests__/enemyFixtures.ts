import type { EnemyDefinition, EnemyDetail } from '@/api/adminEnemies';
import { enemyFixture } from '@/features/adminArtwork/__tests__/artworkFixtures';

/** The enemy as Git ships it: what `shipped` and an export carry. */
export function definitionOf(enemy: EnemyDetail): EnemyDefinition {
  return {
    key: enemy.key,
    name: enemy.name,
    description: enemy.description,
    attack: enemy.attack,
    defense: enemy.defense,
    hp: enemy.hp,
    artworkPath: enemy.artworkPath,
    spriteArtworkPath: enemy.spriteArtworkPath,
    spritePlacement: enemy.spritePlacement,
    enabled: enemy.enabled,
    tags: enemy.tags,
  };
}

/** One enemy as the catalogue's detail route returns it. A shipped, unused enemy unless told otherwise. */
export function enemyDetailFixture(
  over: Partial<EnemyDetail> & { key: string; name: string },
): EnemyDetail {
  const artworkPath =
    over.artworkPath === undefined ? `combat/enemies/${over.key}.webp` : over.artworkPath;
  const base: EnemyDetail = {
    ...enemyFixture(over),
    description: '',
    artworkPath,
    spriteArtworkPath: null,
    artworkAssetId: null,
    spriteAssetId: null,
    spritePlacement: null,
    revision: 3,
    origin: 'shipped',
    matchesShipped: true,
    usageCount: over.references?.length ?? 0,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    updatedBy: 'seed',
    references: [],
    issues: [],
    shipped: null,
    ...over,
  };
  return {
    ...base,
    // What is in effect follows the enemy's own fields unless a test says otherwise.
    visual: over.visual ?? {
      artworkAssetId: base.artworkAssetId,
      artworkPath: base.artworkPath,
      spriteAssetId: base.spriteAssetId,
      spriteArtworkPath: base.spriteArtworkPath,
      spritePlacement: base.spritePlacement ?? {
        anchor: 'bottom-right',
        scaleBasisPoints: 8500,
        offsetX: 0,
        offsetY: 0,
      },
    },
  };
}
