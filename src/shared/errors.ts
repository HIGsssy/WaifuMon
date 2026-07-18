/**
 * Application error types. Every error that can surface to a Discord user
 * carries a `userMessage` that is safe (and friendly) to show ephemerally.
 */

export class AppError extends Error {
  readonly code: string;
  readonly userMessage: string;

  constructor(code: string, message: string, userMessage?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage ?? 'Something went wrong, nothing was consumed.';
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

export class ContentValidationError extends AppError {
  constructor(message: string) {
    super('CONTENT_INVALID', message);
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor(message: string) {
    super('DB_UNAVAILABLE', message, 'The game is napping, try again shortly~');
  }
}

export class PlayerNotFoundError extends AppError {
  constructor(playerId: number) {
    super('PLAYER_NOT_FOUND', `Player ${playerId} not found`);
  }
}

export class ItemNotFoundError extends AppError {
  constructor(slug: string) {
    super('ITEM_NOT_FOUND', `Item "${slug}" not found`, "That item doesn't exist.");
  }
}

export class ItemNotPurchasableError extends AppError {
  constructor(slug: string) {
    super(
      'ITEM_NOT_PURCHASABLE',
      `Item "${slug}" is not purchasable`,
      "That item isn't for sale.",
    );
  }
}

export class InsufficientFundsError extends AppError {
  constructor(required: number, balance: number) {
    super(
      'INSUFFICIENT_FUNDS',
      `Needs ${required} WaifuBux, has ${balance}`,
      `You need ${required} WaifuBux but only have ${balance}.`,
    );
  }
}

export class InsufficientEssenceError extends AppError {
  constructor(required: number, balance: number) {
    super(
      'INSUFFICIENT_ESSENCE',
      `Needs ${required} Essence, has ${balance}`,
      `You need ${required} Essence but only have ${balance}.`,
    );
  }
}

export class InsufficientItemsError extends AppError {
  constructor(itemId: number, requested: number) {
    super(
      'INSUFFICIENT_ITEMS',
      `Not enough of item ${itemId} to consume ${requested}`,
      "You don't have enough of that item.",
    );
  }
}

export class InventoryCapacityError extends AppError {
  constructor(capacity: number) {
    super(
      'INVENTORY_CAPACITY',
      `Purchase would exceed capture-item capacity of ${capacity}`,
      `That would put you over your capture-item capacity (${capacity}). Nothing was charged.`,
    );
  }
}

export class AlreadyClaimedError extends AppError {
  readonly nextResetAt: Date;

  constructor(nextResetAt: Date) {
    super(
      'DAILY_ALREADY_CLAIMED',
      'Daily reward already claimed today',
      `You already claimed today! Next reset <t:${Math.floor(nextResetAt.getTime() / 1000)}:R>.`,
    );
    this.nextResetAt = nextResetAt;
  }
}

export class InsufficientEnergyError extends AppError {
  constructor() {
    super(
      'INSUFFICIENT_ENERGY',
      'Player is out of hunt energy',
      "You're out of Hunt Energy~ Claim your daily to refill.",
    );
  }
}

export class HuntCooldownError extends AppError {
  readonly retryAt: Date;

  constructor(retryAt: Date) {
    super(
      'HUNT_COOLDOWN',
      'Hunt cooldown active',
      `Slow down~ You can hunt again <t:${Math.floor(retryAt.getTime() / 1000)}:R>.`,
    );
    this.retryAt = retryAt;
  }
}

export class ActiveEncounterError extends AppError {
  readonly encounterId: number;

  constructor(encounterId: number) {
    super(
      'ACTIVE_ENCOUNTER',
      `Player already has active encounter ${encounterId}`,
      "You've already met someone~ Finish that encounter first.",
    );
    this.encounterId = encounterId;
  }
}

export class EncounterNotFoundError extends AppError {
  constructor() {
    super(
      'ENCOUNTER_NOT_FOUND',
      'Encounter not found or no longer active',
      "She's already gone~",
    );
  }
}

export class EncounterExpiredError extends AppError {
  constructor() {
    super(
      'ENCOUNTER_EXPIRED',
      'Encounter has expired',
      'She slipped away…',
    );
  }
}

export class EncounterAlreadyResolvedError extends AppError {
  constructor() {
    super(
      'ENCOUNTER_ALREADY_RESOLVED',
      'Encounter is no longer active',
      'That attempt already resolved~',
    );
  }
}

export class NoAttemptsRemainingError extends AppError {
  constructor() {
    super(
      'NO_ATTEMPTS_REMAINING',
      'Encounter has no remaining capture attempts',
      "She's already gone after 3 tries.",
    );
  }
}

export class ItemNotUsableError extends AppError {
  constructor(slug: string) {
    super(
      'ITEM_NOT_USABLE',
      `Item "${slug}" cannot be used to capture`,
      "You can't use that on a Waifumon.",
    );
  }
}

export class WaifuNotOwnedError extends AppError {
  constructor(waifuId: number) {
    super(
      'WAIFU_NOT_OWNED',
      `Waifu ${waifuId} is not owned by this player`,
      "That Waifumon isn't in your collection~",
    );
  }
}

export class WaifuAlreadyReleasedError extends AppError {
  constructor(waifuId: number) {
    super(
      'WAIFU_ALREADY_RELEASED',
      `Waifu ${waifuId} is already released`,
      'You already let her go~',
    );
  }
}

export class WaifuIsFavoriteError extends AppError {
  constructor() {
    super(
      'WAIFU_IS_FAVORITE',
      'Cannot release a favorited waifu without confirmation',
      "That's a ★ favorite — press confirm again to release her.",
    );
  }
}

export class NotADuplicateError extends AppError {
  constructor(waifuId: number) {
    super(
      'NOT_A_DUPLICATE',
      `Waifu ${waifuId} is the only active copy of its species`,
      "That's your only copy of her — release her instead if you want the Essence.",
    );
  }
}

export class WaifuIsBuddyError extends AppError {
  constructor() {
    super(
      'WAIFU_IS_BUDDY',
      'Cannot release/convert the active buddy',
      "That's your active buddy~ Switch buddies first.",
    );
  }
}

export class WaifuNicknameTooEarlyError extends AppError {
  constructor(minLevel: number) {
    super(
      'WAIFU_NICKNAME_TOO_EARLY',
      `Nicknames unlock at waifu level ${minLevel}`,
      `Nicknames unlock at level ${minLevel}~ Invest some Essence first.`,
    );
  }
}

/**
 * Care Mode was started without an explicit target and the player has no
 * buddy set — the UI is expected to prompt for a target.
 */
export class CareTargetRequiredError extends AppError {
  constructor() {
    super(
      'CARE_TARGET_REQUIRED',
      'Care Mode requires an explicit target when no buddy is set',
      'Choose which Waifumon to care for~',
    );
  }
}

export class CareModeDisabledError extends AppError {
  constructor() {
    super(
      'CARE_MODE_DISABLED',
      'Care Mode is disabled by server configuration',
      'Care Mode is turned off right now~',
    );
  }
}

/** Detects a Postgres unique-constraint violation (possibly wrapped by drizzle). */
export function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; cause?: unknown };
    if (e.code === '23505') return true;
    if (e.cause) return isUniqueViolation(e.cause);
  }
  return false;
}
