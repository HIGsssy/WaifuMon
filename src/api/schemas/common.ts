/**
 * Shared schema vocabulary (plan §4.7, §8.2).
 *
 * Two encoding rules the whole surface obeys:
 *   - instants are ISO 8601 UTC strings (`2026-08-05T14:22:31.512Z`)
 *   - calendar days are `YYYY-MM-DD`, matching how Postgres `date` columns
 *     come back and how the daily/quest reset is actually reckoned
 *
 * Drizzle hands handlers `Date` objects for `timestamp` columns, so these
 * helpers are `.transform()`s: the *input* is what a handler returns, the
 * *output* is what goes on the wire. That is also why a route never has to
 * remember to call `.toISOString()` — forgetting would be a serializer error,
 * not a silently wrong response.
 */
import { z } from 'zod';
import { AFFINITIES, CONTENT_RATINGS, RARITIES } from '../../db/schema';

// ── Encodings ───────────────────────────────────────────────────────────────

export const isoDateTime = z
  .date()
  .transform((d) => d.toISOString())
  .describe('ISO 8601 timestamp in UTC.');

export const nullableIsoDateTime = z
  .date()
  .nullable()
  .transform((d) => (d === null ? null : d.toISOString()))
  .describe('ISO 8601 timestamp in UTC, or null.');

/**
 * Postgres `date` columns arrive as `'YYYY-MM-DD'` strings through
 * node-postgres, but a driver or config change could make them `Date`s — the
 * session service already defends against exactly that, so this does too.
 */
export const calendarDay = z
  .preprocess(
    (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
    z.string(),
  )
  .transform((v) => v.slice(0, 10))
  .describe('Calendar day as YYYY-MM-DD, in the configured daily timezone.');

// ── Enumerations (mirrored from the DB check constraints) ───────────────────

export const raritySchema = z.enum(RARITIES);
export const affinitySchema = z.enum(AFFINITIES);
export const contentRatingSchema = z.enum(CONTENT_RATINGS);

// ── Path params ─────────────────────────────────────────────────────────────

/** Internal ids are positive integers; they arrive as strings in the path. */
export const idParam = z.coerce.number().int().positive();

export const playerIdParams = z.object({ playerId: idParam });

export const waifuIdParams = z.object({ playerId: idParam, waifuId: idParam });

/** Content is addressed by slug, never by internal id (plan §8.2). */
export const slugParam = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9_]+$/, 'Slugs are lowercase alphanumerics and underscores.');

/** A Discord snowflake, kept as an opaque string. */
export const snowflakeParam = z.string().min(1).max(32).regex(/^\d+$/, 'Expected a Discord id.');

// ── Pagination ──────────────────────────────────────────────────────────────

/**
 * `collectionService.listOwned` clamps `pageSize` to 25 (it was written for
 * Discord select menus, which cap at 25 options). The API validates to that
 * same ceiling rather than the envelope's general 100, so a client that asks
 * for 100 gets a clear 400 instead of a silently-25-item page. Raising it
 * would mean changing a gameplay service purely for the API's benefit, which
 * §5 asks us not to do. See docs note in `routes/v1/collection.ts`.
 */
export const COLLECTION_MAX_PAGE_SIZE = 25;

/**
 * `newest` exists because page 1 of the default order is the *rarest* copies,
 * which tells a client nothing about recent captures. Without it, "the five
 * most recent" costs a walk of every page.
 */
export const COLLECTION_SORTS = ['rarity', 'newest'] as const;

export const collectionPageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(COLLECTION_MAX_PAGE_SIZE).default(10),
  rarity: raritySchema.optional(),
  sort: z
    .enum(COLLECTION_SORTS)
    .default('rarity')
    .describe('`rarity` (default) is rarest-first; `newest` is most-recently-caught first.'),
});

// ── Error envelope (documented on every route) ──────────────────────────────

export const errorSchema = z.object({
  error: z.object({
    code: z.string().describe('Stable machine-readable code, e.g. PLAYER_NOT_FOUND.'),
    message: z.string().describe('Safe to render to an end user.'),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  requestId: z.string(),
});

/**
 * The error responses every authenticated route can produce. Spread into a
 * route's `response` map so the OpenAPI document is complete without each
 * route restating the contract.
 */
export const commonErrorResponses = {
  400: errorSchema.describe('Request failed schema validation.'),
  401: errorSchema.describe('Missing or invalid bearer token.'),
  500: errorSchema.describe('Unexpected internal error — quote `requestId` when reporting.'),
} as const;

export const notFoundResponse = {
  404: errorSchema.describe('No such resource.'),
} as const;
