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
  Rarity,
  SpeciesRow,
} from '../db/schema';
import type { ENCOUNTER_STATES } from './schemas/encounter';
import type { ITEM_CATEGORIES } from './schemas/content';

type EncounterState = (typeof ENCOUNTER_STATES)[number];
type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export function toSpeciesResource(row: SpeciesRow) {
  return {
    ...row,
    rarity: row.rarity as Rarity,
    affinity: row.affinity as Affinity,
    contentRating: row.contentRating as ContentRating,
  };
}

export function toItemResource(row: ItemRow) {
  return {
    ...row,
    category: row.category as ItemCategory,
    priceCurrency: row.priceCurrency as 'waifubux' | 'essence',
  };
}

export function toEncounterResource(encounter: EncounterRow, species: SpeciesRow) {
  return {
    ...encounter,
    state: encounter.state as EncounterState,
    species: toSpeciesResource(species),
  };
}

export function toGuildResource(row: GuildRow) {
  return { ...row, hereThresholdRarity: row.hereThresholdRarity as Rarity };
}

/** The one genuine shape change: flat care columns → a nested summary. */
export function toPlayerResource(player: PlayerRow) {
  return {
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
