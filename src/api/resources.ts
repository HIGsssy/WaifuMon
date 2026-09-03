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
import { seductivePowerView } from '../modules/power/seductivePower';
import { buddyBonusView, type BuddyBonus } from '../modules/buddyBonus/buddyBonusEffects';
import { resolveRace } from '../modules/cards/race';
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
 *
 * **`assetId` is `null` unless the caller has established the artwork may be
 * seen.** An `AssetId` resolves deterministically to a picture on every
 * consumer, so emitting one for artwork a player has not earned publishes the
 * reward. `revealArtwork` defaults to `false`, which is what makes the default
 * safe: a new call site that forgets to think about unlock state withholds the
 * identifier rather than leaking it.
 *
 * The species catalog has **no player in scope**, so it can only justify the
 * one entry that is unlocked for everybody who owns her — the `owned` default.
 * Level-gated entries appear there as slots with their `unlockLabel` and no
 * artwork, which is enough for an encyclopedia to say "there is more at Level
 * 20" without saying what it looks like.
 */
export function toAppearanceCatalogResource(
  appearance: ResolvedAppearance,
  { revealArtwork = false }: { revealArtwork?: boolean } = {},
) {
  return {
    id: appearance.id,
    name: appearance.name,
    description: appearance.description,
    flavorText: appearance.flavorText,
    cosmeticRarity: appearance.cosmeticRarity,
    introducedVersion: appearance.introducedVersion,
    assetId: revealArtwork ? appearance.assetId : null,
    unlock: appearance.unlock,
    unlockLabel: appearance.unlockLabel,
  };
}

/**
 * Whether an appearance is unlocked for *anyone* who owns the species.
 *
 * The `owned` entry is: owning her is the only requirement, and every response
 * carrying a catalog is already about a species the caller can see. Everything
 * else is earned per copy and is decided by the collection gallery, which has
 * the level to decide it with.
 */
function isUngated(appearance: ResolvedAppearance): boolean {
  return appearance.unlock.type === 'owned';
}

/** A species catalog, with artwork revealed only for the ungated default. */
export function toAppearanceCatalogResources(appearances: readonly ResolvedAppearance[]) {
  return appearances.map((a) => toAppearanceCatalogResource(a, { revealArtwork: isUngated(a) }));
}

/**
 * Catalog metadata plus one owned copy's state.
 *
 * `isUnlocked` is the reveal decision — the two travel together so a caller
 * cannot set one without the other.
 */
export function toAppearanceResource(
  appearance: ResolvedAppearance,
  state: { isUnlocked: boolean; isSelected: boolean },
) {
  return {
    ...toAppearanceCatalogResource(appearance, { revealArtwork: state.isUnlocked }),
    ...state,
  };
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
    race: resolveRace(row),
    rarity: row.rarity as Rarity,
    affinity: row.affinity as Affinity,
    contentRating: row.contentRating as ContentRating,
    appearances: toAppearanceCatalogResources(appearances),
  };
}

/**
 * A species' Buddy Bonus, with its display strings already resolved.
 *
 * `targetLabel` and `effectSummary` come from `buddyBonusView` — the one
 * registry the bot itself prints from — rather than being re-phrased here or,
 * worse, by each client. That is the whole point: a client renders the sentence
 * it is handed, so adding an effect id changes exactly one switch statement and
 * every surface follows.
 */
export function toBuddyBonusResource(bonus: BuddyBonus) {
  const { name, flavorText, effectId, value, target, targetLabel, effectSummary } =
    buddyBonusView(bonus);
  return { name, flavorText, effectId, value, target, targetLabel, effectSummary };
}

/**
 * The authored content snapshot's species, same treatment as the row.
 *
 * `buddyBonus` is mapped rather than passed through: the authored shape carries
 * only the rule, and the resource carries the rule *and* the resolved copy.
 * A species with no authored bonus omits the key entirely — there is no such
 * thing as an empty Buddy Bonus, and a null would invite a client to render one.
 */
export function toContentSpeciesResource(
  species: SpeciesContent,
  appearances: readonly ResolvedAppearance[],
) {
  const {
    imagePath: _imagePath,
    appearances: _authored,
    buddyBonus,
    ...rest
  } = species;
  return {
    ...rest,
    race: resolveRace(species),
    appearances: toAppearanceCatalogResources(appearances),
    ...(buddyBonus ? { buddyBonus: toBuddyBonusResource(buddyBonus) } : {}),
  };
}

/**
 * An owned copy with its current artwork embedded.
 *
 * `selectedAppearance` is resolved from `variant` against the species catalog,
 * falling back to the default when the stored id names artwork that has since
 * been removed **or that this copy no longer qualifies for** — a rolled-back
 * level or a raised `unlock.atLevel` can strand a `variant` on a look that is
 * locked again, and the embedded appearance is what every client draws from.
 * Passing the copy's level makes that fallback automatic, so the resource can
 * never carry an `assetId` for artwork this copy has not earned.
 */
export function toOwnedWaifuResource(
  waifu: PlayerWaifuRow,
  species: SpeciesRow | AppearanceSpecies,
  appearance: {
    currentAppearance(
      species: SpeciesRow | AppearanceSpecies,
      variant: string | null | undefined,
      unlockCtx?: { level: number } | undefined,
    ): ResolvedAppearance;
  },
) {
  const current = appearance.currentAppearance(species, waifu.variant, {
    level: waifu.level,
  });
  return {
    ...waifu,
    // Current SP is computed here rather than stored, through the one domain
    // function every other surface calls — so the API and the inspect embed
    // cannot round the same copy differently.
    seductivePower: seductivePowerView(waifu.baseSp, waifu.level),
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
