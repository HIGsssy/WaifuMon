/**
 * Appearance *content* resolution — pure, total, side-effect free.
 *
 * One job: turn whatever an author wrote (or did not write) in
 * `content/species/*.json` into the fully-populated appearance list every
 * consumer reads. Two defaults do the heavy lifting:
 *
 *   - **The implicit standard appearance.** A species with no `appearances`
 *     array — which is every species that predates this system — resolves to a
 *     single `standard` / `owned` entry pointing at
 *     `{ kind: 'waifumon', slug, variant: 'standard' }`. That is what makes the
 *     whole feature backward compatible: no content migration, no file rewrite,
 *     and `player_waifus.variant` already defaults to `'standard'`.
 *
 *   - **Field defaults.** `assetId` defaults to the species slug + the
 *     appearance id; `unlockLabel` is synthesized from `unlock`;
 *     `contentRating` falls back to the species'. So the resolved shape is
 *     total and no renderer needs an "if missing" branch.
 *
 * Nothing here touches the filesystem, the database, or the clock, so the
 * Platform API, the Discord bot, the loader, and unit tests all call it freely.
 *
 * **Cosmetic invariant:** every field this module produces is presentation.
 * It reads no stat, grants nothing, and is never consulted by battle, XP,
 * affection, evolution, or capture math.
 */
import {
  DEFAULT_APPEARANCE_ID,
  type AppearanceContent,
  type AppearanceUnlock,
  type AssetId,
  type CosmeticRarity,
  type SpeciesContent,
} from '../content/schemas';
import type { ContentRating } from '../../db/schema';

/** A species, as much of it as appearance resolution actually needs. */
export type AppearanceSpecies = Pick<
  SpeciesContent,
  'slug' | 'contentRating' | 'appearances'
>;

/** An appearance with every optional field filled in. */
export interface ResolvedAppearance {
  id: string;
  name: string;
  description: string | null;
  flavorText: string | null;
  cosmeticRarity: CosmeticRarity;
  introducedVersion: string | null;
  contentRating: ContentRating;
  sortOrder: number;
  tags: string[];
  assetId: AssetId;
  unlock: AppearanceUnlock;
  /** Always present — author-supplied or synthesized. Shown locked *and* unlocked. */
  unlockLabel: string;
}

/** `{ kind: 'waifumon', slug, variant }` — the system's only asset reference. */
export function defaultAssetId(speciesSlug: string, appearanceId: string): AssetId {
  return { kind: 'waifumon', slug: speciesSlug, variant: appearanceId };
}

/**
 * The on-disk layout an `AssetId` maps to: `<kind>/<slug>/<variant>.png`,
 * relative to the assets root.
 *
 * This one line is the *entire* coupling between artwork identity and artwork
 * storage, which is why it lives here — in the leaf module every consumer
 * already depends on — rather than being re-typed in the loader, the Discord
 * resolver, and whatever comes next. Changing the layout is changing this
 * function. Resolving it to an absolute path (and refusing to escape the assets
 * root) is a separate concern owned by `resolveAssetPath`.
 */
export function appearanceAssetRelativePath(assetId: AssetId): string {
  return `${assetId.kind}/${assetId.slug}/${assetId.variant}.png`;
}

/**
 * Requirement text when the author supplied none.
 *
 * These strings are the gallery's spine: every tile shows one whether it is
 * locked or not, which is what turns the gallery into a progression journal
 * rather than a lock icon. Future unlock types get a case here and nothing else
 * — hence the exhaustive-ish shape with a readable fallback.
 */
export function formatUnlockLabel(unlock: AppearanceUnlock): string {
  switch (unlock.type) {
    case 'owned':
      return 'Owned';
    case 'level':
      return `Reach Level ${unlock.atLevel}`;
    default: {
      const _never: never = unlock;
      void _never;
      return 'Locked';
    }
  }
}

/** The implicit entry synthesized for a species with no authored catalog. */
export function implicitStandardAppearance(species: AppearanceSpecies): ResolvedAppearance {
  return {
    id: DEFAULT_APPEARANCE_ID,
    name: 'Standard',
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    contentRating: species.contentRating,
    sortOrder: 0,
    tags: [],
    assetId: defaultAssetId(species.slug, DEFAULT_APPEARANCE_ID),
    unlock: { type: 'owned' },
    unlockLabel: 'Owned',
  };
}

/** Fill every optional field on one authored entry. */
export function resolveAppearance(
  species: AppearanceSpecies,
  appearance: AppearanceContent,
): ResolvedAppearance {
  return {
    id: appearance.id,
    name: appearance.name,
    description: appearance.description ?? null,
    flavorText: appearance.flavorText ?? null,
    cosmeticRarity: appearance.cosmeticRarity,
    introducedVersion: appearance.introducedVersion ?? null,
    contentRating: appearance.contentRating ?? species.contentRating,
    sortOrder: appearance.sortOrder,
    tags: appearance.tags,
    assetId: appearance.assetId ?? defaultAssetId(species.slug, appearance.id),
    unlock: appearance.unlock,
    unlockLabel: appearance.unlockLabel ?? formatUnlockLabel(appearance.unlock),
  };
}

/**
 * The species' full appearance catalog, ordered for display.
 *
 * Ordering is `sortOrder`, then id — deterministic so Discord's select menu,
 * the Portal grid, and a test snapshot never disagree. Idempotent: calling it
 * on a species whose catalog was already filtered by the loader returns the
 * same (filtered) list.
 */
export function resolveAppearances(species: AppearanceSpecies): ResolvedAppearance[] {
  const authored = species.appearances;
  if (!authored || authored.length === 0) return [implicitStandardAppearance(species)];
  return authored
    .map((a) => resolveAppearance(species, a))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** The `owned` entry — what a freshly-captured copy wears. Never undefined. */
export function defaultAppearance(species: AppearanceSpecies): ResolvedAppearance {
  const all = resolveAppearances(species);
  return (
    all.find((a) => a.unlock.type === 'owned') ??
    all[0] ??
    implicitStandardAppearance(species)
  );
}

/**
 * The appearance a copy is currently wearing, given its stored `variant`.
 *
 * Falls back to the species default when the stored id names an appearance
 * that no longer exists — an author can delete artwork, and a copy pointing at
 * a deleted entry must still render rather than 404. Deliberately read-only:
 * the fallback is a *display* decision and never writes `variant` back.
 */
export function appearanceForVariant(
  species: AppearanceSpecies,
  variant: string | null | undefined,
): ResolvedAppearance {
  if (!variant) return defaultAppearance(species);
  return (
    resolveAppearances(species).find((a) => a.id === variant) ?? defaultAppearance(species)
  );
}
