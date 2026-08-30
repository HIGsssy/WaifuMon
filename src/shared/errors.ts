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

export class InsufficientCharmsError extends AppError {
  constructor(charmName: string, needed: number) {
    super(
      'INSUFFICIENT_CHARMS',
      `Need ${needed} more ${charmName} to convert`,
      `You need ${needed} more ${charmName} to convert.`,
    );
  }
}

export class CharmRecipeNotFoundError extends AppError {
  constructor(recipeId: string) {
    super(
      'CHARM_RECIPE_NOT_FOUND',
      `Charm exchange recipe "${recipeId}" not found`,
      'That charm conversion is no longer available.',
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

/** The item exists but has no active effect — nothing to "use". */
export class ItemHasNoEffectError extends AppError {
  constructor(slug: string) {
    super(
      'ITEM_HAS_NO_EFFECT',
      `Item "${slug}" has no usable effect`,
      "That item isn't something you can use~",
    );
  }
}

/** Energy Drink used at full energy — refused so the item isn't wasted. */
export class EnergyAlreadyFullError extends AppError {
  constructor(current: number, max: number) {
    super(
      'ENERGY_ALREADY_FULL',
      `Hunt energy already at max (${current}/${max})`,
      `Your Hunt Energy is already full (${current}/${max}) — nothing was used.`,
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

/**
 * Essence investment on a copy that is already at the level cap. Spending
 * would still consume Essence for XP that can never become a level, so the
 * batch path refuses rather than quietly burning the balance.
 */
export class WaifuAtMaxLevelError extends AppError {
  constructor(maxLevel: number) {
    super(
      'WAIFU_AT_MAX_LEVEL',
      `Waifu is already at the level cap (${maxLevel})`,
      `She's already at Lv ${maxLevel} — save your Essence for someone else~`,
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
 * The species has no appearance with that id — a stale gallery, a hand-typed
 * id, or artwork that was removed from the content set. A client bug, not a
 * game state, hence 400 rather than 404 on the HTTP surface.
 */
export class AppearanceNotFoundError extends AppError {
  constructor(appearanceId: string, speciesSlug: string) {
    super(
      'APPEARANCE_NOT_FOUND',
      `Species "${speciesSlug}" has no appearance "${appearanceId}"`,
      "That look isn't available for her~",
    );
  }
}

/** The appearance exists but this copy has not earned it yet. */
export class AppearanceLockedError extends AppError {
  constructor(appearanceId: string, unlockLabel: string) {
    super(
      'APPEARANCE_LOCKED',
      `Appearance "${appearanceId}" is locked (${unlockLabel})`,
      `That look is still locked — ${unlockLabel}.`,
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

/**
 * The chosen capture item cannot be used against this encounter's rarity.
 * Content-driven (`items.capture_rarities`), never a slug check in code.
 */
export class CaptureItemNotEligibleError extends AppError {
  constructor(itemName: string, rarity: string) {
    super(
      'CAPTURE_ITEM_NOT_ELIGIBLE',
      `Item "${itemName}" is not eligible against ${rarity} encounters`,
      `**${itemName}** won't work on a ${rarity}~ Pick something else.`,
    );
  }
}

/** Capture was pressed with nothing selected for this encounter. */
export class NoCaptureItemSelectedError extends AppError {
  constructor() {
    super(
      'NO_CAPTURE_ITEM_SELECTED',
      'No capture item is selected for this encounter',
      'Pick an item first — tap **Use Item**~',
    );
  }
}

/**
 * The interaction was rendered against an older state of the encounter (an
 * attempt has resolved since). Distinct from "already resolved": the encounter
 * is still live, the *button* is stale — which is exactly the double-click
 * case, and it must never resolve a second attempt.
 */
export class EncounterStaleError extends AppError {
  constructor() {
    super(
      'ENCOUNTER_STALE',
      'Encounter has advanced since this interaction was rendered',
      'That button is out of date~ Your encounter has already moved on.',
    );
  }
}

/**
 * The buff this item grants is already at its full charge count, so using
 * another would consume it for nothing.
 *
 * Mirrors {@link EnergyAlreadyFullError}: the request is well-formed, but
 * there is nothing to gain, so the item is refused rather than burned. Scoped
 * to the **encounter** path — the inventory screen's refresh behaviour is
 * unchanged, because that is where a player deliberately tops a buff back up.
 */
export class EffectAlreadyAtMaxChargesError extends AppError {
  constructor(itemName: string, charges: number) {
    super(
      'EFFECT_ALREADY_AT_MAX_CHARGES',
      `${itemName} buff already has ${charges} charges`,
      `Your **${itemName}** is already at **${charges}** charges~ Save it for later.`,
    );
  }
}

/** No unclaimed gift exists for that owned copy (or it was already taken). */
export class GiftNotFoundError extends AppError {
  constructor() {
    super(
      'GIFT_NOT_FOUND',
      'No unclaimed affection gift for that Waifumon',
      'There is no gift waiting there~',
    );
  }
}

/**
 * A claim raced another and lost. The gift is *not* lost — the winning
 * transaction already added the item — so this is a refresh, not a failure.
 */
export class GiftAlreadyClaimedError extends AppError {
  constructor() {
    super(
      'GIFT_ALREADY_CLAIMED',
      'Affection gift was already claimed',
      'You already accepted that gift~ Check your inventory.',
    );
  }
}

// ── Boss Encounters (Stage 1) ───────────────────────────────────────────────

/**
 * The button belongs to an encounter that is no longer accepting commitments —
 * it resolved, it was cancelled, or the player is holding a message from a
 * previous appearance. Not a failure the player caused, so the copy points
 * forward rather than apologising.
 */
export class BossEncounterNotOpenError extends AppError {
  constructor() {
    super(
      'BOSS_ENCOUNTER_NOT_OPEN',
      'Boss encounter is not accepting commitments',
      'That confrontation is already over~ Watch for the next boss to arrive.',
    );
  }
}

/** The interaction named an encounter that does not exist, or belongs elsewhere. */
export class BossEncounterNotFoundError extends AppError {
  constructor() {
    super(
      'BOSS_ENCOUNTER_NOT_FOUND',
      'Boss encounter not found for this guild',
      'That boss is long gone~ Re-open the boss channel for the current one.',
    );
  }
}

/**
 * The player has already confirmed a buddy for this encounter. Reached by a
 * double-clicked Confirm, which the unique index turns into this rather than
 * into a second participation.
 */
export class BossAlreadyCommittedError extends AppError {
  constructor(waifuName: string) {
    super(
      'BOSS_ALREADY_COMMITTED',
      'Player already committed a buddy to this encounter',
      `**${waifuName}** is already committed to this battle~ One buddy per confrontation.`,
    );
  }
}

/** No active buddy to commit. The message explains how to get one. */
export class BossNoActiveBuddyError extends AppError {
  constructor() {
    super(
      'BOSS_NO_ACTIVE_BUDDY',
      'Player has no active buddy to commit',
      'You have no active buddy to send~ Pick one with `/wm buddy <name>`, then come back.',
    );
  }
}

/**
 * The guild has no boss channel configured, so nothing may be scheduled.
 * Surfaced to admins only — players never reach a path that can raise it.
 */
export class BossChannelNotConfiguredError extends AppError {
  constructor() {
    super(
      'BOSS_CHANNEL_NOT_CONFIGURED',
      'Guild has no boss encounter channel configured',
      'No Boss Encounter channel is set for this server yet.',
    );
  }
}

/**
 * The configured channel exists but the bot cannot run an encounter in it.
 * Carries the missing permissions so the admin reply can name them rather
 * than saying "check permissions".
 */
export class BossChannelUnusableError extends AppError {
  readonly missing: readonly string[];

  constructor(channelId: string, missing: readonly string[] = []) {
    // Defaulted so the constructor is total: the API's contract test builds
    // every AppError subclass with throwaway arguments, and an error type that
    // can only be constructed with exactly the right shape is one that will
    // eventually be constructed wrongly on a failure path.
    const list = missing.length > 0 ? missing.join(', ') : 'required permissions';
    super(
      'BOSS_CHANNEL_UNUSABLE',
      `Boss channel ${channelId} is unusable — missing: ${list}`,
      `I can't run boss encounters in <#${channelId}> — missing permission${missing.length === 1 ? '' : 's'}: ${list}.`,
    );
    this.missing = missing;
  }
}

/* ───────────────────────── Locations & Travel ───────────────────────── */

/** A region id that no enabled region file defines — a stale button, usually. */
export class RegionNotFoundError extends AppError {
  readonly regionId: string;

  constructor(regionId: string) {
    super(
      'REGION_NOT_FOUND',
      `Unknown or unreleased region: ${regionId}`,
      "There's nowhere by that name on the map~",
    );
    this.regionId = regionId;
  }
}

/** The player has no route to this destination yet. */
export class RegionLockedError extends AppError {
  readonly regionId: string;

  constructor(regionId: string, label: string) {
    super(
      'REGION_LOCKED',
      `Player has not unlocked region ${regionId}`,
      `You haven't unlocked the road to **${label}** yet~`,
    );
    this.regionId = regionId;
  }
}

/** A route unlock was attempted without owning the pass it stamps onto. */
export class TravelPassRequiredError extends AppError {
  readonly passId: string;

  constructor(passId: string, label: string) {
    super(
      'TRAVEL_PASS_REQUIRED',
      `Player does not own travel pass ${passId}`,
      `You'll need the **${label}** before you can add destinations to it~`,
    );
    this.passId = passId;
  }
}

/**
 * The pass is already owned.
 *
 * Also the shape a *lost* concurrent purchase takes: the duplicate-key
 * violation on `player_travel_passes` is caught and rethrown as this, so two
 * simultaneous clicks produce one purchase and one friendly "you already have
 * it" rather than one purchase and one raw Postgres error.
 */
export class TravelPassAlreadyOwnedError extends AppError {
  readonly passId: string;

  constructor(passId: string, label: string) {
    super(
      'TRAVEL_PASS_ALREADY_OWNED',
      `Player already owns travel pass ${passId}`,
      `You already have the **${label}**~`,
    );
    this.passId = passId;
  }
}

/** The destination is already unlocked. Same double-click role as above. */
export class RouteAlreadyUnlockedError extends AppError {
  readonly regionId: string;

  constructor(regionId: string, label: string) {
    super(
      'ROUTE_ALREADY_UNLOCKED',
      `Player already unlocked route to ${regionId}`,
      `The road to **${label}** is already open to you~`,
    );
    this.regionId = regionId;
  }
}

/** Trainer level is below the configured gate for a pass or route. */
export class TravelLevelRequiredError extends AppError {
  readonly requiredLevel: number;
  readonly currentLevel: number;

  constructor(requiredLevel: number, currentLevel: number) {
    super(
      'TRAVEL_LEVEL_REQUIRED',
      `Requires trainer level ${requiredLevel}, player is ${currentLevel}`,
      `You need to be **Trainer Level ${requiredLevel}** for that — you're ${currentLevel}.`,
    );
    this.requiredLevel = requiredLevel;
    this.currentLevel = currentLevel;
  }
}

/** Travel to the region the player is already standing in. */
export class AlreadyInRegionError extends AppError {
  readonly regionId: string;

  constructor(regionId: string, label: string) {
    super('ALREADY_IN_REGION', `Player already in region ${regionId}`, `You're already in **${label}**~`);
    this.regionId = regionId;
  }
}

/**
 * Travel refused because an encounter is still open.
 *
 * Deliberately a hard block rather than an auto-release: walking away from a
 * Waifumon should be a decision the player makes on her screen, not a side
 * effect of opening the map. It also keeps `encounters.region_id` honest —
 * an encounter cannot be rolled in one region and resolved after the player
 * has quietly been moved to another.
 */
export class TravelBlockedByEncounterError extends AppError {
  readonly encounterId: number;

  constructor(encounterId: number) {
    super(
      'TRAVEL_BLOCKED_BY_ENCOUNTER',
      `Cannot travel with active encounter ${encounterId}`,
      "You can't just walk off — someone's still waiting on you~ Finish or release your encounter first.",
    );
    this.encounterId = encounterId;
  }
}

/**
 * A regionally-stocked item bought from outside the regions that stock it.
 *
 * Distinct from {@link ItemNotPurchasableError}, which means "this is never
 * for sale". This one means "not *here*", which is a different instruction to
 * the player and a different fix. It exists because hiding regional stock from
 * the global catalog is only half the rule — the other half has to be enforced
 * where the currency is actually spent, since a `shop:buy` custom id is just a
 * string and a stale one outlives the screen that painted it.
 */
export class ItemNotSoldHereError extends AppError {
  readonly itemSlug: string;
  readonly soldIn: readonly string[];

  constructor(itemSlug: string, itemName: string, soldIn: readonly string[] = []) {
    const where = soldIn.length > 0 ? soldIn.join(', ') : 'another region';
    super(
      'ITEM_NOT_SOLD_HERE',
      `Item "${itemSlug}" is stocked only in: ${where}`,
      `**${itemName}** isn't stocked around here~ You'll need to travel to buy it.`,
    );
    this.itemSlug = itemSlug;
    this.soldIn = soldIn;
  }
}

/** Travel is switched off in content (`tables.travel.enabled = false`). */
export class TravelDisabledError extends AppError {
  constructor() {
    super('TRAVEL_DISABLED', 'Travel is disabled in content', 'The caravans are not running right now~');
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
