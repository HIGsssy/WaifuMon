/**
 * Owned-Waifumon resources.
 *
 * An owned entry embeds the seeded species row rather than just its id, so a
 * client can render a collection page from one call. `progress` is derived by
 * `collectionService.waifuProgress` — pure arithmetic over the row already in
 * hand, no extra query.
 *
 * Released copies are soft-deleted (`releasedAt`) and are filtered out by the
 * service, so `releasedAt` is always null on anything these endpoints return.
 * It is still exposed: the field is part of the resource, and Phase 3's
 * release endpoint returns a populated one.
 */
import { z } from 'zod';
import { appearanceSchema } from './appearance';
import { isoDateTime, nullableIsoDateTime } from './common';
import { speciesSchema } from './content';

export const waifuProgressSchema = z.object({
  level: z.number().int(),
  xp: z.number().int(),
  xpIntoLevel: z.number().int(),
  xpToNext: z.number().int(),
  atMaxLevel: z.boolean(),
});

export const ownedWaifuSchema = z.object({
  id: z.number().int(),
  playerId: z.number().int(),
  speciesId: z.number().int(),
  level: z.number().int(),
  xp: z.number().int(),
  affection: z.number().int(),
  nickname: z.string().nullable(),
  isFavorite: z.boolean(),
  /**
   * The selected appearance's id. Retained as the wire format for selection
   * identity — `PUT …/appearance` takes the same value — so existing clients
   * keep working unchanged. `selectedAppearance` below is the resolved form.
   */
  variant: z.string(),
  cosmetics: z.array(z.string()),
  /**
   * The appearance this copy is currently wearing, resolved and embedded so a
   * client can render artwork from one call instead of joining the gallery.
   * Falls back to the species default when `variant` names artwork that has
   * since been removed from the content set — this field never 404s.
   */
  selectedAppearance: appearanceSchema,
  caughtAt: isoDateTime,
  releasedAt: nullableIsoDateTime,
});

export const ownedEntrySchema = z.object({
  waifu: ownedWaifuSchema,
  species: speciesSchema,
  progress: waifuProgressSchema,
});

export const dexStatsSchema = z.object({
  owned: z.number().int().describe('Active (non-released) owned Waifumon.'),
  distinctSpecies: z.number().int(),
  totalSpecies: z.number().int().describe('Enabled species in the content set — the denominator.'),
});
