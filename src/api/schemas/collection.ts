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
import { calendarDay, isoDateTime, nullableIsoDateTime } from './common';
import { speciesSchema } from './content';

export const waifuProgressSchema = z.object({
  level: z.number().int(),
  xp: z.number().int(),
  xpIntoLevel: z.number().int(),
  xpToNext: z.number().int(),
  atMaxLevel: z.boolean(),
});

/**
 * Seductive Power for one owned copy.
 *
 * `current` is the player-facing number and the one every surface shows;
 * `base` is the permanent Level 1 roll, exposed because an API consumer
 * building a detail view legitimately wants it. `formulaVersion` lets a client
 * tell a re-tune from a re-model without diffing numbers.
 *
 * Derived, never stored beyond `base` — see `modules/power/seductivePower.ts`.
 */
export const seductivePowerSchema = z.object({
  base: z.number().int().describe('Permanent Level 1 roll, fixed at capture.'),
  current: z.number().int().describe('Base scaled to the copy’s current level.'),
  formulaVersion: z.number().int(),
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
  /** Permanent per-copy Base SP, plus the level-scaled Current SP. */
  seductivePower: seductivePowerSchema,
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

// ── The public-within-guild view of somebody else's collection ──────────────

/**
 * One copy of another player's collection, as their guild-mates may see it.
 *
 * Like `directoryPlayerSchema`, this is an **allowlist written out in full**
 * rather than `ownedWaifuSchema.omit(...)`. The difference matters: an omit
 * list stays silent when a new column is added to the owned resource, and this
 * is precisely the resource where a silently-inherited field is a disclosure.
 * A field appears here because somebody decided it should.
 *
 * Present, and why:
 *
 *   `id`, `playerId`  addressing. There is no separate public handle for a
 *                     copy or a player — the public profile route already takes
 *                     the internal player id (documented in `schemas/players`),
 *                     and inventing a second identity system was explicitly out
 *                     of scope. These are the same two ids already in the URL.
 *   `level`           the headline public stat, and what the grid sorts by.
 *   `nickname`        the copy's public name; the whole grid is titled by it.
 *   `isFavorite`      a public-facing badge, shown as a star on the card.
 *   `variant` /
 *   `selectedAppearance`  which look she is wearing — this is the artwork.
 *   `caughtAt`        a coarse date, and the "Recently caught" sort's key. Not
 *                     capture *history*: no attempt log, no odds, no charms
 *                     spent, no failures — none of which this resource can
 *                     reach.
 *
 * Absent, and why:
 *
 *   `xp`              an exact progression value. `level` is its public form.
 *   `affection`       a Buddy intimacy stat. Withheld until somebody decides
 *                     it is public — the default is closed.
 *   `seductivePower`  a raw gameplay statistic.
 *   `speciesId`       redundant with the embedded species, which carries the
 *                     slug every client actually addresses artwork by.
 *   `cosmetics`       unused inventory-shaped state.
 *   `releasedAt`      release state. These endpoints serve active copies only,
 *                     so the field could only ever be null here — and shipping
 *                     a null invites a client to render a release affordance.
 *
 * `progress` is likewise absent from the entry below: it is the XP curve, and
 * publishing "280 of 650 XP into Level 12" is publishing the XP.
 */
export const publicOwnedWaifuSchema = z.object({
  id: z.number().int().describe('Internal copy id — also the public detail route identifier.'),
  playerId: z.number().int().describe('The owner. Same id the public profile route takes.'),
  level: z.number().int(),
  nickname: z.string().nullable(),
  isFavorite: z.boolean(),
  variant: z.string(),
  selectedAppearance: appearanceSchema,
  /**
   * The calendar day this copy was caught — `2026-09-07`, never a timestamp.
   *
   * The self resource sends the full instant (`ownedWaifuSchema.caughtAt`, ISO
   * 8601 with milliseconds) and continues to; this is the one field where the
   * public view is deliberately *less* precise than the row behind it.
   *
   * The reason is not the capture: it is the clock. A millisecond-accurate
   * capture time is a record of when somebody was at their keyboard, and a
   * page of them is an activity timeline for another player — a behavioural
   * side channel with no counterpart in what the UI does with the value. The
   * Portal renders it through `formatDate` (day granularity) and
   * `formatRelative` (coarsest unit of a day or more), so nothing on screen
   * loses a pixel to this.
   *
   * **Truncation is a serialization concern and lives only here.**
   * `player_waifus.caught_at` is untouched, and `sort=newest` still orders by
   * the real column — so the server's ordering keeps full precision even
   * though the wire does not. Same-day copies therefore arrive already in the
   * server's order, which is what the client's "Recently caught" sort falls
   * back to for ties (see `sortEntries`).
   */
  caughtAt: calendarDay.describe('Calendar day the copy was caught, YYYY-MM-DD.'),
});

export const publicOwnedEntrySchema = z.object({
  waifu: publicOwnedWaifuSchema,
  /**
   * The same species resource every other endpoint serves. Species are
   * authored content, already public through `/content/species` to any
   * authenticated session, so embedding it here discloses nothing new — and
   * sharing the shape is what lets one Collection renderer draw both views.
   */
  species: speciesSchema,
  isBuddy: z
    .boolean()
    .describe("Whether this copy is the owner's active buddy. Resolved on the same query."),
});
