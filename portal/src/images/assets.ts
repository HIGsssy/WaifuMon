/**
 * Domain resource → `AssetId`.
 *
 * The only place the Portal turns a game object into an asset identifier. Pages
 * call these instead of writing `{ kind: 'species', slug: … }` inline, so the
 * mapping stays in one file when a new asset kind or variant convention lands.
 */
import type { AppearanceCatalogEntry, AssetIdResource, ContentSpecies, OwnedWaifu, Species } from '@/api/types';
import type { AssetId } from './types';

/**
 * Art for a species. An owned copy may carry a `variant` (`standard`, `holo`,
 * …); pass it so the resolver can serve the matching art.
 */
export function speciesAsset(
  species: Species | ContentSpecies,
  waifu?: Pick<OwnedWaifu, 'variant'>,
): AssetId {
  return {
    kind: 'species',
    slug: species.slug,
    ...(waifu?.variant ? { variant: waifu.variant } : {}),
  };
}

/**
 * Art named by the Platform API's own `assetId`.
 *
 * The API's shape and the Portal's `AssetId` are structurally identical by
 * design, so this is a pass-through rather than a translation — it exists so
 * call sites read `appearanceAsset(appearance)` instead of spreading a
 * response field, and so a future divergence has exactly one place to land.
 */
export function appearanceAsset(
  appearance: Pick<AppearanceCatalogEntry, 'assetId'> | { assetId: AssetIdResource },
): AssetId {
  const { kind, slug, variant } = appearance.assetId;
  return { kind, slug, variant };
}

/** Art for an item. No provider serves these yet — see docs/portal.md. */
export function itemAsset(slug: string): AssetId {
  return { kind: 'item', slug };
}

/**
 * A trainer avatar. `href` carries the absolute URL the Platform API returned
 * (`player.identity.avatarUrl`); when it is null the chain falls through to the
 * silhouette, keyed by player so the placeholder is stable per trainer.
 */
export function avatarAsset(playerId: number, avatarUrl: string | null): AssetId {
  return { kind: 'avatar', slug: `player_${playerId}`, href: avatarUrl };
}
