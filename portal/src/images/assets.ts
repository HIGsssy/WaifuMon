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
 * The catalog entry a species renders in when nobody has chosen otherwise —
 * its `unlock.type: "owned"` entry.
 *
 * The API guarantees exactly one exists on every species: a species with no
 * authored catalog carries the implicit `standard` entry, and the content
 * schema rejects an explicit catalog that does not have exactly one `owned`
 * entry. The `?? catalog[0]` is for a client that is talking to an API newer
 * than itself — a future unlock type it cannot recognise must still render
 * *something* rather than fall through to a guessed filename.
 */
export function defaultAppearanceOf(
  species: Species | ContentSpecies,
): AppearanceCatalogEntry | undefined {
  const catalog = species.appearances;
  if (!catalog || catalog.length === 0) return undefined;
  return catalog.find((entry) => entry.unlock.type === 'owned') ?? catalog[0];
}

/**
 * Art for a species, optionally as one owned copy wears it.
 *
 * **The appearance id is read, never guessed.** Both sources here are the
 * API's own answer: `waifu.selectedAppearance` is the copy's current
 * appearance already resolved server-side (including the fallback for a
 * `variant` naming artwork the catalog no longer has), and
 * `defaultAppearanceOf` is the species' `owned` entry from the catalog the
 * same responses carry.
 *
 * Deriving it instead is what this function used to do, and it was wrong in a
 * way that looked like an unlock bug: with no `variant` — or with the literal
 * `'standard'` that `player_waifus.variant` defaults to on capture — the
 * resolver produced `<slug>/standard.png`. For a species whose `owned` entry
 * is authored under any other id that file does not exist, the load fails, and
 * `useImage` degrades to the silhouette. A freshly-captured Waifumon therefore
 * kept rendering as a silhouette even though the API had reported her unlocked
 * all along.
 *
 * The bare `{ kind: 'species' }` return is the last resort for a payload with
 * no catalog at all, which the current API never sends.
 */
export function speciesAsset(
  species: Species | ContentSpecies,
  waifu?: Pick<OwnedWaifu, 'variant' | 'selectedAppearance'>,
): AssetId {
  if (waifu?.selectedAppearance) return appearanceAsset(waifu.selectedAppearance);

  const fallback = defaultAppearanceOf(species);
  if (fallback) return appearanceAsset(fallback);

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
