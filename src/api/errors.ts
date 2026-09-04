/**
 * Platform API error contract (plan §8.2, §8.3).
 *
 * The service layer already owns a machine-readable vocabulary: every
 * `AppError` carries a stable `code` plus a `userMessage` that is safe to
 * render. This module is the single place that decides which HTTP status each
 * of those codes maps to, and the single place that shapes the error body:
 *
 *   { "error": { "code", "message", "details"? }, "requestId": "…" }
 *
 * `message` is always `userMessage` — never `err.message`, which may name
 * internal ids or table rows. Unknown codes deliberately fall through to 500:
 * a code the API has not classified is a bug to fix, not a status to guess.
 */
import { AppError } from '../shared/errors';

/** Missing or invalid bearer token (plan §9). */
export class UnauthorizedError extends AppError {
  constructor() {
    super('UNAUTHORIZED', 'Missing or invalid bearer token', 'Unauthorized.');
  }
}

/** No route (or no resource) at the requested path. */
export class ApiNotFoundError extends AppError {
  constructor(detail: string) {
    super('NOT_FOUND', detail, 'Not found.');
  }
}

/** Request failed Zod validation — malformed shape, not a rule violation. */
export class ApiValidationError extends AppError {
  constructor(detail: string) {
    super('VALIDATION_ERROR', detail, 'The request was not valid.');
  }
}

/**
 * Resource-specific 404s raised by the API layer.
 *
 * The service layer's own `PlayerNotFoundError` exists but carries the default
 * "Something went wrong" user message — right for an ephemeral Discord reply,
 * wrong for an HTTP client that needs to know the id was simply unknown. These
 * reuse the same `code` values so the machine-readable contract is identical.
 */
export class ApiPlayerNotFoundError extends AppError {
  /** `identifier` may be an internal id or a "guild/user" pair from lookup. */
  constructor(identifier: number | string) {
    super('PLAYER_NOT_FOUND', `Player ${identifier} not found`, 'No player with that id.');
  }
}

export class ApiGuildNotFoundError extends AppError {
  constructor(discordGuildId: string) {
    super('GUILD_NOT_FOUND', `Guild ${discordGuildId} not found`, 'No guild with that id.');
  }
}

export class ApiSpeciesNotFoundError extends AppError {
  constructor(slug: string) {
    super('SPECIES_NOT_FOUND', `Species "${slug}" not found`, 'No species with that slug.');
  }
}

/**
 * Artwork was requested for a species this player has not discovered.
 *
 * Raised only for **player-scoped** callers (a Portal browser session). The
 * shared bearer token is the bot and the operator tooling, which legitimately
 * render every species; a player's browser gets the dex rule instead, so a
 * silhouette in the UI cannot be walked around by opening the image URL.
 *
 * 403 rather than 404: the species genuinely exists and the content endpoints
 * already say so, so pretending otherwise would buy no secrecy and would make
 * a real typo indistinguishable from a locked entry in the logs.
 */
export class ApiSpeciesNotDiscoveredError extends AppError {
  constructor(slug: string) {
    super(
      'SPECIES_NOT_DISCOVERED',
      `Species "${slug}" has not been discovered by this player`,
      'You have not discovered this species yet.',
    );
  }
}

/**
 * A card was requested at a level the game cannot reach. The ceiling comes
 * from `tables.waifuProgression.maxLevel`, so the API and the game can never
 * disagree about what a valid level is.
 */
export class ApiCardLevelError extends AppError {
  constructor(level: number, maxLevel: number) {
    super(
      'VALIDATION_ERROR',
      `Level ${level} is above the maximum of ${maxLevel}`,
      `Level must be between 1 and ${maxLevel}.`,
    );
  }
}

export class ApiTableNotFoundError extends AppError {
  constructor(key: string) {
    super('TABLE_NOT_FOUND', `Tuning table "${key}" not found`, 'No tuning table with that key.');
  }
}

export class ApiSessionNotFoundError extends AppError {
  constructor(channelId: string) {
    super(
      'SESSION_NOT_FOUND',
      `No session for channel ${channelId}`,
      'No session in that channel yet.',
    );
  }
}

/** The player currently has no active encounter / no buddy / no active buff. */
export class ApiNoActiveResourceError extends AppError {
  constructor(code: 'ENCOUNTER_NOT_FOUND' | 'BUDDY_NOT_SET', detail: string, userMessage: string) {
    super(code, detail, userMessage);
  }
}

/**
 * Status per `AppError.code`. Grouped by the §8.2 conventions:
 *   404 unknown resource · 409 state conflict · 422 valid shape, rule refused
 *   500 internal · 503 dependency unavailable
 *
 * Phase 4 audits this table against every service the API touches; any code
 * missing here surfaces as a 500 and is treated as a defect.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // --- Request-level (raised by this layer) -------------------------------
  UNAUTHORIZED: 401,
  PORTAL_FORBIDDEN: 403,
  PORTAL_CSRF_INVALID: 403,
  PORTAL_GUILD_FORBIDDEN: 403,
  PORTAL_PERMISSION_DENIED: 403,
  /**
   * A player's browser asked for artwork of a species they have not caught.
   * The Portal silhouettes those entries; this is the same rule enforced at
   * the only place that can actually withhold the bytes.
   */
  SPECIES_NOT_DISCOVERED: 403,
  OAUTH_STATE_INVALID: 400,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
  /**
   * An appearance id the species does not have — a stale gallery or a
   * hand-typed value, i.e. a malformed request rather than a missing resource.
   * 400 keeps it distinct from `WAIFU_NOT_OWNED`, which is a genuine 404.
   */
  APPEARANCE_NOT_FOUND: 400,

  /** A card width outside the supported buckets — a malformed request. */
  CARD_OUTPUT_WIDTH_INVALID: 400,

  // --- Infrastructure -----------------------------------------------------
  CONFIG_INVALID: 500,
  CONTENT_INVALID: 500,
  DB_UNAVAILABLE: 503,
  /**
   * The card SVG kit is missing a file, or the base template is not the shape
   * the composer expects. A broken deploy, never caller-triggerable — 500, and
   * the operator gets the path in the log while the client gets nothing.
   */
  CARD_ASSET_MISSING: 500,
  CARD_TEMPLATE_INVALID: 500,

  // --- Unknown resource ---------------------------------------------------
  PLAYER_NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  ENCOUNTER_NOT_FOUND: 404,
  WAIFU_NOT_OWNED: 404,
  GUILD_NOT_FOUND: 404,
  SPECIES_NOT_FOUND: 404,
  TABLE_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  BUDDY_NOT_SET: 404,
  /**
   * A boss button naming an encounter that does not exist, or that belongs to
   * another guild. 404 rather than 403: the two are indistinguishable to a
   * caller by design, so a copied custom id learns nothing from the response.
   */
  BOSS_ENCOUNTER_NOT_FOUND: 404,
  /** No boss channel configured for the guild — the feature is simply off. */
  BOSS_CHANNEL_NOT_CONFIGURED: 404,
  /** No unclaimed gift on that copy — the resource genuinely is not there. */
  GIFT_NOT_FOUND: 404,
  /** A charm-exchange custom id naming a recipe that no longer exists. */
  CHARM_RECIPE_NOT_FOUND: 404,
  /**
   * The species/appearance exists but its artwork file does not. A content
   * gap, not a server fault — the resource genuinely is not there, so 404
   * rather than the 500 an unhandled renderer throw would produce.
   */
  CARD_ARTWORK_MISSING: 404,

  // --- State conflict -----------------------------------------------------
  ACTIVE_ENCOUNTER: 409,
  DAILY_ALREADY_CLAIMED: 409,
  HUNT_COOLDOWN: 409,
  ENCOUNTER_EXPIRED: 409,
  ENCOUNTER_ALREADY_RESOLVED: 409,
  NO_ATTEMPTS_REMAINING: 409,
  WAIFU_ALREADY_RELEASED: 409,
  WAIFU_IS_FAVORITE: 409,
  WAIFU_IS_BUDDY: 409,
  CARE_MODE_DISABLED: 409,
  /** The appearance exists but this copy has not earned it — a state conflict. */
  APPEARANCE_LOCKED: 409,
  /**
   * The interaction was rendered against an older encounter state (an attempt
   * has resolved since). The encounter is still live, so this is a conflict to
   * refresh past — not a 404, and emphatically not a retryable 500.
   */
  ENCOUNTER_STALE: 409,
  /**
   * A claim that lost the race. Idempotent from the player's point of view —
   * the reward already landed — so it reads as a conflict, not a failure.
   */
  GIFT_ALREADY_CLAIMED: 409,

  // --- Valid shape, business rule refused ---------------------------------
  INSUFFICIENT_FUNDS: 422,
  INSUFFICIENT_ESSENCE: 422,
  INSUFFICIENT_ITEMS: 422,
  /** Not enough of the input charm to run even one 10:1 exchange conversion. */
  INSUFFICIENT_CHARMS: 422,
  INSUFFICIENT_ENERGY: 422,
  INVENTORY_CAPACITY: 422,
  ENERGY_ALREADY_FULL: 422,
  ITEM_NOT_PURCHASABLE: 422,
  ITEM_NOT_USABLE: 422,
  ITEM_HAS_NO_EFFECT: 422,
  NOT_A_DUPLICATE: 422,
  WAIFU_NICKNAME_TOO_EARLY: 422,
  /** Mirrors ENERGY_ALREADY_FULL: the request is well-formed, but there is
   *  nothing left to gain, so spending is refused rather than wasted. */
  WAIFU_AT_MAX_LEVEL: 422,
  CARE_TARGET_REQUIRED: 422,
  /** Well-formed, but this item may not be committed against this rarity. */
  CAPTURE_ITEM_NOT_ELIGIBLE: 422,
  /** Mirrors ENERGY_ALREADY_FULL: nothing to gain, so nothing is spent. */
  EFFECT_ALREADY_AT_MAX_CHARGES: 422,
  /** Capture was requested with nothing selected for the encounter. */
  NO_CAPTURE_ITEM_SELECTED: 422,
  /**
   * The boss encounter is no longer taking commitments — resolved, cancelled,
   * or past its deadline. A conflict with server state rather than a bad
   * request, and the same class as ACTIVE_ENCOUNTER above.
   */
  BOSS_ENCOUNTER_NOT_OPEN: 409,
  /** One buddy per confrontation; this player already has one committed. */
  BOSS_ALREADY_COMMITTED: 409,
  /** Well-formed, but there is no active buddy to send. */
  BOSS_NO_ACTIVE_BUDDY: 422,
  /**
   * The configured channel exists but the bot cannot run an encounter in it.
   * An operator-facing misconfiguration, not a caller error — 422 says the
   * request was fine and the server's world is not.
   */
  BOSS_CHANNEL_UNUSABLE: 422,

  // --- Locations & Travel -------------------------------------------------
  /** No enabled region by that id — indistinguishable from a typo, so 404. */
  REGION_NOT_FOUND: 404,
  /**
   * The region exists and the request is well-formed; the player simply has
   * not unlocked the road. 422 rather than 403, matching every other
   * "you have not earned this yet" refusal in this table.
   */
  REGION_LOCKED: 422,
  /** A route unlock without the pass it stamps onto. Same class as above. */
  TRAVEL_PASS_REQUIRED: 422,
  /** Below the configured trainer-level gate. */
  TRAVEL_LEVEL_REQUIRED: 422,
  /**
   * Already owned. Idempotent from the player's point of view — the
   * entitlement is there — so a conflict to refresh past, not a failure. Also
   * the shape the losing half of a concurrent purchase takes.
   */
  TRAVEL_PASS_ALREADY_OWNED: 409,
  ROUTE_ALREADY_UNLOCKED: 409,
  /** Travelling to where you already are. */
  ALREADY_IN_REGION: 409,
  /** An open encounter holds the player in place until it resolves. */
  TRAVEL_BLOCKED_BY_ENCOUNTER: 409,
  /** The whole feature is switched off in content. */
  TRAVEL_DISABLED: 422,
  /**
   * Regionally-stocked item bought from the wrong region. Well-formed request,
   * business rule refused — the same class as ITEM_NOT_PURCHASABLE above.
   */
  ITEM_NOT_SOLD_HERE: 422,
};

/** Every code this layer knows how to classify — used by the contract test. */
export const MAPPED_ERROR_CODES: readonly string[] = Object.keys(STATUS_BY_CODE);

export function mapAppErrorToStatus(err: AppError): number {
  return STATUS_BY_CODE[err.code] ?? 500;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

/**
 * Builds the wire body. A 500 never echoes the underlying message — the
 * `requestId` is the client's handle for asking an operator to grep the log.
 */
export function toErrorBody(
  err: AppError,
  status: number,
  requestId: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return {
    error: {
      code: status === 500 ? 'INTERNAL_ERROR' : err.code,
      message: status === 500 ? 'Internal error.' : err.userMessage,
      ...(details && status !== 500 ? { details } : {}),
    },
    requestId,
  };
}
