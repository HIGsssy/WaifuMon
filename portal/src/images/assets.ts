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
  // Both of these carry an `assetId` in practice — `selectedAppearance` is
  // what she is wearing (unlocked by construction, and unlock-aware on the
  // server so a stale `variant` degrades to the default), and the `owned`
  // catalog entry is ungated. The `??` chain is for the shapes the type still
  // permits, and falls through to the bare species identity rather than
  // guessing a variant filename.
  const worn = waifu?.selectedAppearance ? appearanceAsset(waifu.selectedAppearance) : null;
  if (worn) return worn;

  const fallback = defaultAppearanceOf(species);
  const fallbackAsset = fallback ? appearanceAsset(fallback) : null;
  if (fallbackAsset) return fallbackAsset;

  return {
    kind: 'species',
    slug: species.slug,
    ...(waifu?.variant ? { variant: waifu.variant } : {}),
  };
}

/**
 * Art named by the Platform API's own `assetId`, or `null` when the API
 * withheld it.
 *
 * The API's shape and the Portal's `AssetId` are structurally identical by
 * design, so this is a pass-through rather than a translation — it exists so
 * call sites read `appearanceAsset(appearance)` instead of spreading a
 * response field, and so a future divergence has exactly one place to land.
 *
 * **`null` in means `null` out, and that is the point.** A locked appearance
 * arrives with no `assetId` (see `AppearanceCatalogEntry.assetId`), and the
 * Portal must not invent one — deriving `<slug>/<variant>.png` from the
 * appearance's id would reconstruct exactly the artwork the server declined to
 * name, turning a server-side access control back into a client-side one.
 * `Artwork` renders a `null` asset as the silhouette.
 */
export function appearanceAsset(
  appearance:
    | Pick<AppearanceCatalogEntry, 'assetId'>
    | { assetId: AssetIdResource | null },
): AssetId | null {
  if (!appearance.assetId) return null;
  const { kind, slug, variant } = appearance.assetId;
  return { kind, slug, variant };
}

/**
 * The **rendered card** for a species — frame, rarity overlay, race and
 * affinity icons, card text — as opposed to {@link speciesAsset}, which is the
 * raw character artwork.
 *
 * A preview: the server renders it at level 1 wearing the species' default
 * appearance, which is what an encyclopedia-style view should show. For a copy
 * somebody owns, use {@link ownedCardAsset} instead — it carries her real level
 * and equipped look.
 *
 * Like every other helper here this returns identity only. Which route serves
 * it, and at what width, is the `cardApi` provider's business.
 */
export function speciesCardAsset(
  species: Pick<Species | ContentSpecies, 'slug' | 'appearances'>,
  appearance?: Pick<AppearanceCatalogEntry, 'assetId'> | undefined,
): AssetId {
  const chosen = appearance ?? defaultAppearanceOf(species as Species | ContentSpecies);
  // No `assetId` means the API withheld the artwork — omit `variant` so the
  // card route renders her default rather than being asked for a locked look
  // it would refuse with 409 anyway.
  const variant = chosen?.assetId?.variant;
  return {
    kind: 'card',
    slug: species.slug,
    ...(variant ? { variant } : {}),
  };
}

/**
 * The rendered card for one **owned copy**.
 *
 * Deliberately carries only ids. The card shows her level and her equipped
 * appearance, and the API already knows both — sending them as query
 * parameters would mean the Portal reconstructing gameplay state it does not
 * own, and getting it stale the moment she levels up mid-session.
 *
 * `variant` is still recorded because it is what makes the resolver's memo key
 * change when she is redressed; the server does not read it.
 */
export function ownedCardAsset(
  playerId: number,
  entry: { waifu: Pick<OwnedWaifu, 'id' | 'selectedAppearance'>; species: Pick<Species, 'slug'> },
): AssetId {
  const variant = entry.waifu.selectedAppearance?.assetId?.variant;
  return {
    kind: 'card',
    slug: entry.species.slug,
    ...(variant ? { variant } : {}),
    owned: { playerId, waifuId: entry.waifu.id },
  };
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
