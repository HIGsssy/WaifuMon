/**
 * Row → resource mappers.
 *
 * These exist for one reason: Drizzle types the enum-ish columns as plain
 * `text`, because Postgres enforces them with CHECK constraints rather than an
 * enum type. The API's schemas *do* declare them as enums — that is most of
 * the documentation value in the OpenAPI spec — so something has to narrow the
 * two together. Doing it here, once, keeps the casts visible and auditable
 * instead of scattering them through route handlers.
 *
 * The casts are sound: `species_rarity_check`, `species_affinity_check`,
 * `species_content_rating_check`, `items_category_check`,
 * `items_price_currency_check` and `encounters_state_check` are all enforced
 * by the database, so a value outside the union cannot be stored.
 *
 * Everything *not* listed in a schema is dropped by the Zod serializer, so
 * these mappers deliberately do not re-list pass-through fields — a new
 * column cannot leak, and a renamed one fails the typecheck.
 */
import type {
  Affinity,
  ContentRating,
  EncounterRow,
  GuildRow,
  ItemRow,
  PlayerRow,
  PlayerWaifuRow,
  Rarity,
  SpeciesRow,
} from '../db/schema';
import type {
  AppearanceSpecies,
  ResolvedAppearance,
} from '../modules/appearance/appearanceContent';
import type { SpeciesContent } from '../modules/content/schemas';
import type { ENCOUNTER_STATES } from './schemas/encounter';
import type { ITEM_CATEGORIES } from './schemas/content';
import type { PlayerIdentity } from './identity';

type EncounterState = (typeof ENCOUNTER_STATES)[number];
type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Authored catalog metadata for one appearance — no per-player state.
 *
 * `assetId` is the *only* asset reference: no path, URL, or extension crosses
 * this boundary. `imagePath` exists on the row and is deliberately dropped —
 * it is the content loader's private pre-flight probe, not an addressable
 * location, and surfacing it would couple every client to one storage layout.
 */
export function toAppearanceCatalogResource(appearance: ResolvedAppearance) {
  return {
    id: appearance.id,
    name: appearance.name,
    description: appearance.description,
    flavorText: appearance.flavorText,
    cosmeticRarity: appearance.cosmeticRarity,
    introducedVersion: appearance.introducedVersion,
    assetId: appearance.assetId,
    unlock: appearance.unlock,
    unlockLabel: appearance.unlockLabel,
  };
}

/** Catalog metadata plus one owned copy's state. */
export function toAppearanceResource(
  appearance: ResolvedAppearance,
  state: { isUnlocked: boolean; isSelected: boolean },
) {
  return { ...toAppearanceCatalogResource(appearance), ...state };
}

/**
 * A seeded species row.
 *
 * `appearances` is threaded in rather than read off the row because the
 * catalog is *content*, not database state — the row carries only what the
 * seeder mirrors. Callers pass the resolved catalog (via
 * `appearanceService.catalogFor`) so a species resource is complete from one
 * call. Omitting it is allowed for the handful of embeds where the catalog is
 * genuinely irrelevant, and yields an empty array rather than a missing field.
 */
export function toSpeciesResource(
  row: SpeciesRow,
  appearances: readonly ResolvedAppearance[] = [],
) {
  const { imagePath: _imagePath, ...rest } = row;
  return {
    ...rest,
    rarity: row.rarity as Rarity,
    affinity: row.affinity as Affinity,
    contentRating: row.contentRating as ContentRating,
    appearances: appearances.map(toAppearanceCatalogResource),
  };
}

/** The authored content snapshot's species, same treatment as the row. */
export function toContentSpeciesResource(
  species: SpeciesContent,
  appearances: readonly ResolvedAppearance[],
) {
  const { imagePath: _imagePath, appearances: _authored, ...rest } = species;
  return { ...rest, appearances: appearances.map(toAppearanceCatalogResource) };
}

/**
 * An owned copy with its current artwork embedded.
 *
 * `selectedAppearance` is resolved from `variant` against the species catalog,
 * falling back to the default when the stored id names artwork that has since
 * been removed — a copy must always render.
 */
export function toOwnedWaifuResource(
  waifu: PlayerWaifuRow,
  species: SpeciesRow | AppearanceSpecies,
  appearance: {
    currentAppearance(
      species: SpeciesRow | AppearanceSpecies,
      variant: string | null | undefined,
    ): ResolvedAppearance;
  },
) {
  const current = appearance.currentAppearance(species, waifu.variant);
  return {
    ...waifu,
    // Unlocked by construction: it is what she is wearing. `seenAppearances`
    // is notification bookkeeping and is dropped by the schema, not here.
    selectedAppearance: toAppearanceResource(current, {
      isUnlocked: true,
      isSelected: true,
    }),
  };
}

export function toItemResource(row: ItemRow) {
  return {
    ...row,
    category: row.category as ItemCategory,
    priceCurrency: row.priceCurrency as 'waifubux' | 'essence',
  };
}

export function toEncounterResource(
  encounter: EncounterRow,
  species: SpeciesRow,
  appearances: readonly ResolvedAppearance[] = [],
) {
  return {
    ...encounter,
    state: encounter.state as EncounterState,
    species: toSpeciesResource(species, appearances),
  };
}

export function toGuildResource(row: GuildRow) {
  return { ...row, hereThresholdRarity: row.hereThresholdRarity as Rarity };
}

/**
 * The one genuine shape change: flat care columns → a nested summary.
 *
 * `identity` is not a column — it is presentation data resolved outside the
 * service layer (`src/api/identity.ts`) and is always nullable. It is attached
 * here so the two player routes cannot disagree about the resource's shape.
 */
export function toPlayerResource(player: PlayerRow, identity: PlayerIdentity | null = null) {
  return {
    identity,
    id: player.id,
    guildId: player.guildId,
    discordUserId: player.discordUserId,
    level: player.level,
    xp: player.xp,
    buddyWaifuId: player.buddyWaifuId,
    lastHuntAt: player.lastHuntAt,
    careMode: {
      active: player.careModeStartedAt !== null,
      waifuId: player.careModeWaifuId,
      startedAt: player.careModeStartedAt,
    },
    createdAt: player.createdAt,
  };
}
