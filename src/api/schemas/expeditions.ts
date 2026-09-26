/**
 * Expeditions — the read-only Portal view.
 *
 * Every object here is `.strict()`: the resources are built by *naming* fields,
 * and a strict schema turns any field that slips in later — a row id, the
 * mission key, a reward-table id, the hidden success chance, a resolved outcome
 * — into a failed response rather than a quiet leak.
 *
 * Deliberately absent, and the reason for each:
 *
 *   - `successChance` / `exceptionalChance` / `resolutionRoll` — never shown on
 *     any surface; the player reads match quality instead.
 *   - `outcome` / `rewards` — Discord withholds the result until the player
 *     collects, and the Portal must not spoil it.
 *   - `id` / `expeditionKey` / `slotIndex` / `waifuId` — implementation
 *     identifiers the Portal has no action to spend them on.
 *   - reward tables, `baseSuccessChance`, `enabled`, `teamSize` — content
 *     internals, not planning information.
 */
import { z } from 'zod';
import { EXPEDITION_REWARD_PREVIEWS, EXPEDITION_TYPES, MATCH_QUALITIES } from '../../modules/content/schemas';
import { RACE_CODES } from '../../modules/cards/race';
import { affinitySchema, isoDateTime } from './common';
import { ownedWaifuSchema } from './collection';
import { speciesSchema } from './content';

const rewardPreviewSchema = z
  .array(z.enum(EXPEDITION_REWARD_PREVIEWS))
  .describe('Broad categories of what might come back — a promise about the kind, not a manifest.');

export const activeExpeditionSchema = z
  .object({
    region: z.string(),
    regionName: z.string(),
    name: z.string().describe('Frozen at deployment.'),
    emoji: z.string().nullable(),
    description: z.string(),
    type: z.enum(EXPEDITION_TYPES).nullable(),
    durationMinutes: z.number().int(),
    recommendedLevel: z.number().int().nullable(),
    rewardPreview: rewardPreviewSchema,
    match: z
      .enum(MATCH_QUALITIES)
      .nullable()
      .describe('The match quality shown at deployment; null for legacy rows.'),
    status: z
      .enum(['active', 'resolved'])
      .describe('Canonical row status. Reading never resolves, so a due mission stays `active`.'),
    isDue: z.boolean().describe('`active` and past `completesAt`.'),
    readyToClaim: z
      .boolean()
      .describe('Finished — resolved, or due. Claimed through Discord; the result is not shown here.'),
    startedAt: isoDateTime,
    completesAt: isoDateTime,
    secondsRemaining: z.number().int().describe('0 once due. Count down from `completesAt`.'),
    waifuName: z.string(),
    waifu: z
      .object({ waifu: ownedWaifuSchema, species: speciesSchema })
      .nullable()
      .describe('The deployed copy with her current appearance; null if she can no longer be read.'),
  })
  .strict();

export const expeditionOfferSchema = z
  .object({
    name: z.string(),
    emoji: z.string().nullable(),
    description: z.string(),
    type: z.enum(EXPEDITION_TYPES),
    durationMinutes: z.number().int(),
    recommendedLevel: z.number().int(),
    preferredAffinities: z.array(affinitySchema),
    preferredRaces: z.array(z.enum(RACE_CODES)),
    rewardPreview: rewardPreviewSchema,
  })
  .strict();

export const expeditionRegionSchema = z
  .object({
    regionId: z.string(),
    name: z.string(),
    emoji: z.string().nullable(),
    isCurrent: z
      .boolean()
      .describe('Where the player is standing — the only region a mission can be started in.'),
    occupied: z
      .boolean()
      .describe('An open mission (running or awaiting collection) holds this region.'),
    offers: z.array(expeditionOfferSchema).describe("This rotation window's board, shortest first."),
  })
  .strict();

export const expeditionOverviewSchema = z
  .object({
    enabled: z.boolean().describe('False when new deployments are switched off.'),
    currentRegion: z.string(),
    rotatesAt: isoDateTime.describe('When every board is next replaced.'),
    active: z.array(activeExpeditionSchema),
    regions: z
      .array(expeditionRegionSchema)
      .describe('Current and unlocked regions, current first, then in travel order.'),
  })
  .strict();
