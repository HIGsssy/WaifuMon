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

/**
 * The item exists and the player owns it, but nobody will buy it. Distinct
 * from `ItemNotFoundError` (no such item) and from `ItemNotPurchasableError`
 * (its mirror on the buying side) — the player is holding something real and
 * the refusal is about the item's configuration, not their inventory.
 */
export class ItemNotSellableError extends AppError {
  constructor(slug: string, name?: string) {
    super(
      'ITEM_NOT_SELLABLE',
      `Item "${slug}" is not sellable`,
      name ? `Nobody will buy your ${name}.` : "Nobody will buy that.",
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

/**
 * Release refused because the copy is protected — a favourite, the active
 * buddy, or both.
 *
 * Distinct from {@link WaifuIsFavoriteError}, which is the *convert* path's
 * "press confirm again" prompt. Release has no such second chance: a
 * protected copy cannot be released at all until the player unfavourites her
 * or changes buddy, so this error is a refusal rather than a challenge, and
 * `reasons` lets one message name both causes at once.
 */
export class WaifuReleaseBlockedError extends AppError {
  readonly reasons: readonly ('favorite' | 'buddy' | 'on_expedition')[];

  constructor(reasons: readonly ('favorite' | 'buddy' | 'on_expedition')[]) {
    // Normalised rather than trusted: this is the one AppError whose
    // constructor reads its argument's shape, and the API's error sweep
    // instantiates every subclass generically.
    const list = Array.isArray(reasons) ? reasons : [];
    const isFav = list.includes('favorite');
    const isBuddy = list.includes('buddy');
    // Being away outranks the other two in the message: unfavouriting her or
    // switching Buddy would not help while she is on the other side of the
    // map, so leading with that is the only advice that actually unblocks.
    const isAway = list.includes('on_expedition');
    const userMessage = isAway
      ? 'She is away on an expedition — collect her first.'
      : isFav && isBuddy
        ? 'She is a ★ favourite **and** your active buddy — unfavourite her and switch buddies first.'
        : isFav
          ? 'Favourite Waifumon cannot be released — unfavourite her first.'
          : isBuddy
            ? 'Your active Buddy cannot be released — switch or clear your Buddy first.'
            : 'She cannot be released right now.';
    super(
      'WAIFU_RELEASE_BLOCKED',
      `Cannot release waifu: ${list.join('+') || 'unspecified'}`,
      userMessage,
    );
    this.reasons = list;
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

/**
 * An Affection consumable used with no Buddy equipped.
 *
 * A refusal rather than a no-op, and deliberately raised *before* the item is
 * consumed: the whole item is "give this to your Buddy", so with nobody
 * equipped there is no sensible partial outcome — spending it would destroy
 * the item for nothing.
 *
 * Distinct from {@link BossNoActiveBuddyError}, which refuses a boss
 * commitment: same missing pointer, different instruction, and a caller that
 * conflated them would tell an item user to go fight something.
 */
export class NoActiveBuddyError extends AppError {
  constructor(itemName?: string) {
    super(
      'NO_ACTIVE_BUDDY',
      'Player has no active buddy to receive affection',
      `${itemName ? `**${itemName}** is a gift for your Buddy` : 'That is a gift for your Buddy'}, ` +
        'but you have no one equipped~ Pick a Buddy with `/wm buddy <name>` and try again — ' +
        'nothing was used.',
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

/**
 * Travel to a destination gated by a key item the player does not hold — the
 * Assteroid Belt without a Transporter Beacon. The Locations detail screen is
 * where the recipe progress lives, so the message sends the player there.
 */
export class KeyItemRequiredError extends AppError {
  readonly regionId: string;

  constructor(regionId: string, regionLabel: string, itemName: string) {
    super(
      'KEY_ITEM_REQUIRED',
      `Player does not hold the key item required for region ${regionId}`,
      `You need a **${itemName}** to reach **${regionLabel}**. Open it in **Locations** to see what it takes to build one.`,
    );
    this.regionId = regionId;
  }
}

/** A grant would take a capped item (`items.max_owned`) past its cap. */
export class ItemOwnershipLimitError extends AppError {
  constructor(itemId: number, itemName: string, maxOwned: number) {
    super(
      'ITEM_OWNERSHIP_LIMIT',
      `Item ${itemId} is capped at ${maxOwned} per player`,
      `You already hold the most **${itemName}** you can carry (${maxOwned}).`,
    );
  }
}

/** No enabled key-item recipe by that id. */
export class KeyItemRecipeNotFoundError extends AppError {
  constructor(recipeId: string) {
    super(
      'KEY_ITEM_RECIPE_NOT_FOUND',
      `Key item recipe "${recipeId}" not found`,
      "That construction plan isn't available.",
    );
  }
}

/** The recipe's output is already held. Also the losing half of a double-click. */
export class KeyItemAlreadyOwnedError extends AppError {
  constructor(recipeId: string, itemName: string) {
    super(
      'KEY_ITEM_ALREADY_OWNED',
      `Player already holds the output of recipe ${recipeId}`,
      `You already have a **${itemName}** — nothing was spent.`,
    );
  }
}

/** One or more recipe components are short. Nothing is consumed. */
export class KeyItemComponentsMissingError extends AppError {
  constructor(recipeId: string, itemName: string, missing: string) {
    super(
      'KEY_ITEM_COMPONENTS_MISSING',
      `Recipe ${recipeId} is missing components: ${missing}`,
      `You're still missing parts for the **${itemName}**: ${missing}. Nothing was spent.`,
    );
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
 * Travel refused because the player is resting in Care Mode.
 *
 * Checked *before* the Energy balance, and that ordering is the whole point of
 * having a separate error. Care Mode is the recovery state: a player sitting in
 * it is usually at or near zero Energy, and telling them "you're out of Energy,
 * claim your daily" would be advice for a problem they are already solving. The
 * actionable instruction is "leave Care Mode" — so that is what this says.
 *
 * A hard block rather than an implicit exit, which is where travel deliberately
 * parts company with the hunt. `huntService` calls `care.applyAndExit` and
 * charges on: a hunt is the thing a rested player came back to do. Travel is
 * not — it is a movement that happens to roll a World Encounter, so silently
 * ending someone's rest to let them wander is both surprising and the exact
 * shape of the farming loop this gate exists to close.
 */
export class TravelBlockedByCareModeError extends AppError {
  constructor() {
    super(
      'TRAVEL_BLOCKED_BY_CARE_MODE',
      'Cannot travel while in Care Mode',
      "You're resting right now~ Leave Care Mode and recover some Hunt Energy before you set out.",
    );
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

/* ───────────────────────────── Equipment ─────────────────────────────
 *
 * Every constructor here tolerates junk arguments, like the expedition errors
 * below: `tests/unit/api/errors.test.ts` instantiates each exported subclass
 * with throwaway values to prove its code is mapped to an HTTP status.
 */

/** One path-addressed problem with authored equipment content. */
export interface EquipmentIssue {
  path: string;
  message: string;
}

/**
 * Equipment content (a definition, a package entry) failed validation. Loud by
 * design — content is refused with every problem named, never half-applied.
 */
export class EquipmentValidationError extends AppError {
  readonly issues: EquipmentIssue[];
  constructor(issues: readonly EquipmentIssue[]) {
    const list = Array.isArray(issues) ? issues : [];
    const summary = list.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    super(
      'EQUIPMENT_INVALID',
      `Invalid equipment content: ${summary || 'unknown problem'}`,
      summary || 'That equipment content is not valid.',
    );
    this.issues = [...list];
  }
}

export class EquipmentDefinitionNotFoundError extends AppError {
  constructor(key: string) {
    super(
      'EQUIPMENT_DEFINITION_NOT_FOUND',
      `Equipment definition "${String(key)}" not found`,
      "That equipment doesn't exist.",
    );
  }
}

/** A grant named a disabled definition — disabled means "stops being acquired". */
/**
 * A random grant needs an affix from the definition's pool (`slot.rarity`) and
 * that pool has no enabled affix — or the definition's rarity has no pool at
 * all. A content/configuration error: the grant is refused rather than handing
 * out an unaffixed item or borrowing from another pool.
 */
export class EquipmentAffixPoolEmptyError extends AppError {
  readonly pool: string;
  readonly definitionKey: string;
  constructor(definitionKey: string, pool: string, reason: 'empty' | 'unsupported') {
    super(
      'EQUIPMENT_AFFIX_POOL_EMPTY',
      reason === 'unsupported'
        ? `Equipment definition "${definitionKey}" derives affix pool "${pool}", which is not a supported pool`
        : `Affix pool "${pool}" (for equipment definition "${definitionKey}") has no enabled affixes`,
      'That equipment cannot be generated right now.',
    );
    this.pool = pool;
    this.definitionKey = definitionKey;
  }
}

export class EquipmentDefinitionDisabledError extends AppError {
  constructor(key: string) {
    super(
      'EQUIPMENT_DEFINITION_DISABLED',
      `Equipment definition "${String(key)}" is disabled and cannot be granted`,
      'That equipment is not currently obtainable.',
    );
  }
}

/**
 * An authored Equipment reward selector (a World Encounter effect, a boss or
 * expedition reward entry) names nothing that can be granted: a missing,
 * disabled or mismatched explicit definition, or a slot/rarity with no enabled
 * definition at all. A content error — never answered with another slot,
 * another rarity or a starter item.
 */
export class EquipmentRewardConfigError extends AppError {
  readonly issues: EquipmentIssue[];
  constructor(issues: readonly EquipmentIssue[]) {
    const list = Array.isArray(issues) ? issues : [];
    const summary = list.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    super(
      'EQUIPMENT_REWARD_INVALID',
      `Invalid equipment reward: ${summary || 'unknown problem'}`,
      'That reward is misconfigured, so nothing was granted. Please tell an admin.',
    );
    this.issues = [...list];
  }
}

export class EquipmentKeyTakenError extends AppError {
  constructor(key: string) {
    super(
      'EQUIPMENT_KEY_TAKEN',
      `An equipment definition with key "${String(key)}" already exists`,
      'Another equipment definition already uses that key.',
    );
  }
}

/**
 * An import lost a race: another import (or an admin create) added a
 * definition this package was about to create, between this import planning
 * it and writing it. Nothing from the package was applied — the import is one
 * transaction — so the caller should preview again and retry against the
 * server as it now is.
 */
export class EquipmentImportConflictError extends AppError {
  readonly key: string | null;
  constructor(key: string | null) {
    const named = typeof key === 'string' && key !== '' ? key : null;
    super(
      'EQUIPMENT_IMPORT_CONFLICT',
      `Equipment import conflicted with a concurrent change${named ? ` to "${named}"` : ''}; nothing was applied`,
      'The equipment catalogue changed while this package was being imported. Nothing was ' +
        'applied — preview the package again and retry.',
    );
    this.key = named;
  }
}

/** Deleting a definition that owned instances still reference — disable it instead. */
export class EquipmentDefinitionReferencedError extends AppError {
  readonly instanceCount: number;
  constructor(key: string, instanceCount: number) {
    const count = Number.isInteger(instanceCount) ? instanceCount : 0;
    super(
      'EQUIPMENT_DEFINITION_IN_USE',
      `Equipment definition "${String(key)}" is referenced by ${count} owned instance(s)`,
      'Players own this equipment, so it cannot be deleted. Disable it instead.',
    );
    this.instanceCount = count;
  }
}

/** Changing the slot of a definition that owned instances already copied. */
export class EquipmentSlotLockedError extends AppError {
  constructor(key: string) {
    super(
      'EQUIPMENT_SLOT_LOCKED',
      `The slot of equipment definition "${String(key)}" cannot change once players own it`,
      'Players own this equipment, so its slot can no longer change.',
    );
  }
}

/**
 * The instance does not exist, belongs to someone else, or has been removed.
 * Deliberately one error for all three, so a guessed id learns nothing.
 */
export class EquipmentNotOwnedError extends AppError {
  constructor(equipmentId: number) {
    super(
      'EQUIPMENT_NOT_OWNED',
      `Equipment ${String(equipmentId)} is not owned by this player`,
      "That equipment isn't in your gear bag.",
    );
  }
}

export class EquipmentSlotMismatchError extends AppError {
  constructor(equipmentId: number, expected: string, actual: string) {
    super(
      'EQUIPMENT_SLOT_MISMATCH',
      `Equipment ${String(equipmentId)} fills the ${String(actual)} slot, not ${String(expected)}`,
      "That equipment doesn't fit that slot.",
    );
  }
}

/** A locked instance was targeted by an action that respects the lock. */
export class EquipmentLockedError extends AppError {
  constructor(equipmentId: number) {
    super(
      'EQUIPMENT_LOCKED',
      `Equipment ${String(equipmentId)} is locked`,
      'That equipment is locked.',
    );
  }
}

/** The caller's view of a slot is stale — someone changed it in between. */
export class LoadoutConflictError extends AppError {
  constructor(slot: string) {
    super(
      'LOADOUT_CONFLICT',
      `The ${String(slot)} slot changed since it was last read`,
      'Your equipment changed in the meantime — take another look.',
    );
  }
}

/** The player has not unlocked this account feature yet. */
export class FeatureLockedError extends AppError {
  readonly featureKey: string;
  constructor(featureKey: string) {
    super(
      'FEATURE_LOCKED',
      `Feature "${String(featureKey)}" is not unlocked for this player`,
      "You haven't unlocked that yet.",
    );
    this.featureKey = String(featureKey);
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

/**
 * The name of the unique constraint a Postgres error violated, or null when
 * the error is not a unique violation. For a table with more than one unique
 * rule, where the caller has to know *which* rule refused it.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === '23505') return typeof e.constraint === 'string' ? e.constraint : null;
    if (e.cause) return uniqueViolationConstraint(e.cause);
  }
  return null;
}

/**
 * Expedition refusals.
 *
 * Every constructor here tolerates being called with junk arguments, because
 * `tests/unit/api/errors.test.ts` sweeps every exported `AppError` subclass
 * and instantiates it generically to prove its code is mapped to a status.
 * That sweep passes three `Date`s, so nothing below may assume the shape of
 * what it is handed — the same defensive normalisation
 * `WaifuReleaseBlockedError` already does for its `reasons` array.
 */

/**
 * A region's mission pool cannot fill one slot on every duration tier.
 *
 * Raised by `buildBoard` rather than quietly returning a short board. The
 * board promises one mission per tier — that is the whole point of the
 * stratified draw — and a board silently missing the overnight row is
 * indistinguishable, to a player, from "there is no overnight mission
 * tonight". Failing loudly turns an authoring gap into a boot-time error
 * instead of a mystery nobody reports.
 *
 * `validateExpeditionContent` refuses the same condition at load, so in a
 * correctly-built deployment this is unreachable: it is the assertion that
 * keeps it that way, not a path players can reach.
 */
export class IncompleteExpeditionPoolError extends AppError {
  readonly regionId: string;
  readonly missingDurations: number[];

  constructor(regionId: unknown, missingDurations: unknown) {
    const missing = Array.isArray(missingDurations)
      ? missingDurations.map((m) => Number(m)).filter((m) => Number.isFinite(m))
      : [];
    super(
      'EXPEDITION_POOL_INCOMPLETE',
      `Region "${String(regionId)}" has expeditions but none on duration tier(s): ` +
        `${missing.join(', ') || 'unknown'}. Every participating region must author at ` +
        'least one enabled mission per configured tier.',
      'The expedition board is being reorganised — check back shortly~',
    );
    this.regionId = String(regionId);
    this.missingDurations = missing;
  }
}

/** The key named no mission in the current content snapshot. */
export class ExpeditionNotFoundError extends AppError {
  constructor(key: unknown) {
    super(
      'EXPEDITION_NOT_FOUND',
      `Expedition "${String(key)}" not found`,
      'That expedition is no longer on the board~',
    );
  }
}

/** Deployment refused because the feature itself is switched off in content. */
export class ExpeditionsDisabledError extends AppError {
  constructor() {
    super(
      'EXPEDITIONS_DISABLED',
      'Expeditions are disabled in content',
      'Expeditions are closed for now — check back soon~',
    );
  }
}

/**
 * The player already has a mission running in this region.
 *
 * The regional-concurrency refusal. It names the region and the WaifuMon
 * rather than a slot count, because with capacity derived from the region set
 * "3/3 slots busy" is no longer a thing a player can act on — "Waifu Valley is
 * busy, go somewhere else" is.
 *
 * A *resolved but uncollected* mission holds its region too. That is service
 * policy rather than an index: it stops a player stacking a second mission on
 * top of a payout they have not looked at and losing track of it.
 */
export class ExpeditionRegionBusyError extends AppError {
  readonly regionId: string;

  constructor(regionId: unknown, waifuName?: unknown) {
    const region = typeof regionId === 'string' && regionId.trim() ? regionId.trim() : 'unknown';
    const who = typeof waifuName === 'string' && waifuName.trim() ? waifuName.trim() : null;
    super(
      'EXPEDITION_REGION_BUSY',
      `Player already has an open expedition in region "${region}"`,
      who
        ? `**${who}** is already working this region — collect her first, or try another region.`
        : 'You already have an expedition running here — collect it first, or try another region.',
    );
    this.regionId = region;
  }
}

/**
 * The player is not standing in the region the mission belongs to.
 *
 * Location is a **deployment** requirement and nothing else: once a mission is
 * running it is inspected, resolved, collected and recalled from anywhere, so
 * this is the only place in the feature that asks where the player is.
 */
export class ExpeditionWrongRegionError extends AppError {
  readonly regionId: string;
  readonly currentRegionId: string;

  constructor(regionId: unknown, currentRegionId: unknown) {
    const target = typeof regionId === 'string' && regionId.trim() ? regionId.trim() : 'unknown';
    const here =
      typeof currentRegionId === 'string' && currentRegionId.trim()
        ? currentRegionId.trim()
        : 'unknown';
    super(
      'EXPEDITION_WRONG_REGION',
      `Expedition belongs to region "${target}" but the player is in "${here}"`,
      'You have to be there to take that job — travel to the region first~',
    );
    this.regionId = target;
    this.currentRegionId = here;
  }
}

/**
 * The chosen copy cannot be sent, and the reasons say why.
 *
 * Carries the canonical {@link WaifuUnavailabilityReason} list rather than a
 * bespoke enum, so a future unavailable state surfaces through this error with
 * no change here.
 */
export class WaifuUnavailableError extends AppError {
  readonly reasons: readonly string[];

  constructor(reasons: unknown, name?: unknown) {
    const list = Array.isArray(reasons) ? reasons.map(String) : [];
    const who = typeof name === 'string' && name.trim() ? name.trim() : 'She';
    const explanation =
      list.includes('on_expedition')
        ? `${who} is already away on an expedition.`
        : list.includes('buddy')
          ? `${who} is your active Buddy — switch Buddies first.`
          : list.includes('care_target')
            ? `${who} is the focus of Care Mode — leave Care Mode first.`
            : list.includes('released')
              ? `${who} has already been released.`
              : `${who} is not available right now.`;
    super(
      'WAIFU_UNAVAILABLE',
      `Waifu unavailable: ${list.join('+') || 'unspecified'}`,
      explanation,
    );
    this.reasons = list;
  }
}

/** No active or resolved expedition in the slot the caller named. */
export class ExpeditionNotActiveError extends AppError {
  constructor() {
    super(
      'EXPEDITION_NOT_ACTIVE',
      'No active expedition',
      'You have nobody out on an expedition right now.',
    );
  }
}

/**
 * Collect pressed on a mission that has not finished.
 *
 * A refusal rather than a silent no-op, because a button that does nothing
 * reads as broken. The remaining time is on the error so a caller can say how
 * long is left without a second query.
 */
export class ExpeditionNotCompleteError extends AppError {
  readonly secondsRemaining: number;

  constructor(secondsRemaining: unknown) {
    const seconds =
      typeof secondsRemaining === 'number' && Number.isFinite(secondsRemaining)
        ? Math.max(0, Math.ceil(secondsRemaining))
        : 0;
    super(
      'EXPEDITION_NOT_COMPLETE',
      `Expedition not complete (${seconds}s remaining)`,
      'She is still out there — give her a little longer~',
    );
    this.secondsRemaining = seconds;
  }
}

/**
 * The rewards were already collected.
 *
 * The *expected* outcome of a double-clicked Collect, not an exceptional one:
 * the claim is a conditional UPDATE and exactly one caller wins it. The loser
 * lands here having granted nothing.
 */
export class ExpeditionAlreadyClaimedError extends AppError {
  constructor() {
    super(
      'EXPEDITION_ALREADY_CLAIMED',
      'Expedition rewards already claimed',
      'You already collected that one~',
    );
  }
}

/** Cancel pressed on a mission that has already finished or been cancelled. */
export class ExpeditionNotCancellableError extends AppError {
  constructor(status: unknown) {
    super(
      'EXPEDITION_NOT_CANCELLABLE',
      `Expedition cannot be cancelled from status "${String(status)}"`,
      'That expedition is already over — collect it instead.',
    );
  }
}

/**
 * The content set cannot supply something deployment needs — a reward table
 * that is missing or disabled, a duration that is not on the ladder.
 *
 * Refused at *deploy* rather than discovered at resolution, which is the whole
 * benefit of snapshotting: a broken mission fails at the moment somebody
 * presses the button, with nothing committed, rather than twelve hours later.
 */
export class ExpeditionContentError extends AppError {
  constructor(detail: unknown) {
    super(
      'EXPEDITION_CONTENT_INVALID',
      `Expedition content problem: ${String(detail)}`,
      'That expedition is misconfigured and cannot be started — this has been logged.',
    );
  }
}

/* ─────────────────────── Reward tables (admin) ─────────────────────── */

/** One problem with a submitted reward table, by path. */
export interface RewardTableIssueDetail {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** A boss or expedition reward table failed authoring validation; nothing was written. */
export class RewardTableInvalidError extends AppError {
  readonly issues: RewardTableIssueDetail[];
  constructor(issues: readonly RewardTableIssueDetail[]) {
    const list = Array.isArray(issues) ? issues : [];
    const errors = list.filter((i) => i.severity === 'error');
    const summary = errors.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(
      'REWARD_TABLE_INVALID',
      `Invalid reward table: ${summary || 'unknown problem'}`,
      summary || 'That reward table is not valid.',
    );
    this.issues = [...list];
  }
}

/**
 * A save named a revision that is no longer current — someone else saved the
 * table first. Nothing was written; the editor reloads rather than overwriting.
 */
export class RewardTableStaleError extends AppError {
  constructor(
    readonly kind: string,
    readonly tableId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
    readonly updatedBy: string | null,
    readonly updatedAt: Date,
  ) {
    super(
      'REWARD_TABLE_STALE',
      `Reward table ${kind}/"${tableId}" is at revision ${currentRevision}, not ${expectedRevision}`,
      'This reward table was changed by someone else since you opened it. Reload to see their changes.',
    );
  }
}

export class RewardTableIdTakenError extends AppError {
  constructor(kind: string, tableId: string) {
    super(
      'REWARD_TABLE_ID_TAKEN',
      `A ${kind} reward table "${tableId}" already exists`,
      'Another reward table already uses that id.',
    );
  }
}

/**
 * Deleting a reward table that content pays from, or that ships in Git (the
 * next startup would only seed it back). Disable it instead.
 */
export class RewardTableDeleteRefusedError extends AppError {
  constructor(kind: string, tableId: string, reason: string) {
    super(
      'REWARD_TABLE_DELETE_REFUSED',
      `Reward table ${kind}/"${tableId}" cannot be deleted: ${reason}`,
      `This reward table cannot be deleted: ${reason}. Disable it instead.`,
    );
  }
}

/**
 * Why the combat engine refused a submitted action. Stable codes, so an
 * interactive surface (a Discord button, a dungeon client) can tell "not your
 * turn" from "the fight is over" without parsing the message.
 */
export type CombatActionRejection =
  | 'combat_finished'
  | 'not_actor_turn'
  | 'unknown_actor'
  | 'unsupported_action';

/** The combat engine refused one submitted action. The state is unchanged. */
export class CombatActionRejectedError extends AppError {
  readonly reason: CombatActionRejection;
  constructor(reason: CombatActionRejection, message: string) {
    super('COMBAT_ACTION_REJECTED', message, "That move isn't available right now.");
    this.reason = reason;
  }
}

/**
 * A combat state or combatant that breaks the engine's invariants — negative
 * or fractional stats, HP above max, an unknown turn or status. A programming
 * or persistence error, never a player mistake.
 */
export class CombatStateInvalidError extends AppError {
  constructor(message: string) {
    super('COMBAT_STATE_INVALID', message);
  }
}

/**
 * A Combat Trial that cannot be fought: unknown, disabled, or its enemy is
 * missing or disabled. Nothing is fought, recorded or paid.
 */
export class CombatTrialUnavailableError extends AppError {
  readonly trialKey: string;
  readonly reason: string;
  constructor(trialKey: string, reason: string) {
    super(
      'COMBAT_TRIAL_UNAVAILABLE',
      `Combat Trial "${String(trialKey)}" is unavailable (${String(reason)})`,
      "That Trial isn't available right now.",
    );
    this.trialKey = String(trialKey);
    this.reason = String(reason);
  }
}

/** Combat needs an active Buddy, and none is set. Another copy is never chosen silently. */
export class CombatBuddyRequiredError extends AppError {
  constructor() {
    super('COMBAT_BUDDY_REQUIRED', 'Combat requires an active Buddy', 'Choose an active Buddy before fighting.');
  }
}

/**
 * The player's combat stats are incomplete (an empty Attack, Defense or
 * Health slot), so there is no ATK / DEF / HP to fight with.
 */
export class CombatLoadoutIncompleteError extends AppError {
  constructor() {
    super(
      'COMBAT_LOADOUT_INCOMPLETE',
      'Combat requires ATK, DEF and HP (incomplete loadout)',
      'Equip Attack, Defense and Health gear before fighting.',
    );
  }
}

/**
 * A Fight request key that already resolved a *different* Trial — a forged or
 * corrupted button. The original attempt is untouched.
 */
export class CombatTrialRequestConflictError extends AppError {
  constructor(requestKey: string) {
    super(
      'COMBAT_TRIAL_REQUEST_CONFLICT',
      `Combat Trial request "${String(requestKey)}" was already used for another Trial`,
      'That button no longer works — reopen Combat Trials.',
    );
  }
}

/* ─────────────────────── Patch's Workshop ───────────────────────
 *
 * Constructors tolerate junk arguments, as above: `tests/unit/api/errors.test.ts`
 * instantiates every subclass generically.
 */

export class InsufficientComponentsError extends AppError {
  constructor(required: number, balance: number) {
    super(
      'INSUFFICIENT_COMPONENTS',
      `Needs ${String(required)} Salvaged Components, has ${String(balance)}`,
      `You need ${String(required)} Salvaged Components but only have ${String(balance)}.`,
    );
  }
}

/** Why one selected copy cannot be dismantled. */
export type DismantleProblemReason =
  | 'not_owned'
  | 'duplicate'
  | 'equipped'
  | 'favorite'
  | 'locked'
  | 'unsupported_rarity';

export interface DismantleProblem {
  equipmentId: number;
  reason: DismantleProblemReason;
}

const DISMANTLE_REASON_TEXT: Readonly<Record<DismantleProblemReason, string>> = {
  not_owned: 'is no longer in your Gear Bag',
  duplicate: 'was selected twice',
  equipped: 'is equipped — unequip it first',
  favorite: 'is a favourite — unfavourite it first',
  locked: 'is locked — unlock it first',
  unsupported_rarity: "is a rarity Patch can't salvage yet",
};

/**
 * A dismantle selection that cannot go through as a whole. All-or-nothing: one
 * protected or invalid copy refuses the batch, nothing is destroyed and
 * nothing is credited. `problems` names every offending copy.
 */
export class EquipmentDismantleRefusedError extends AppError {
  readonly problems: DismantleProblem[];
  constructor(problems: readonly DismantleProblem[]) {
    const list = Array.isArray(problems) ? [...problems] : [];
    const first = list[0];
    const more = list.length > 1 ? ` (and ${list.length - 1} more)` : '';
    super(
      'EQUIPMENT_DISMANTLE_REFUSED',
      `Dismantle refused: ${list.map((p) => `${p.equipmentId}:${p.reason}`).join(', ') || 'no problems listed'}`,
      first
        ? `Nothing was dismantled: one selected item ${(DISMANTLE_REASON_TEXT as Record<string, string>)[String(first.reason)] ?? 'cannot be dismantled'}${more}.`
        : 'Nothing was dismantled.',
    );
    this.problems = list;
  }
}

/** A dismantle request that selects nothing, or more than one batch may hold. */
export class EquipmentDismantleSelectionError extends AppError {
  constructor(message: string) {
    super('EQUIPMENT_DISMANTLE_SELECTION_INVALID', String(message), String(message));
  }
}

/** Unknown or disabled fabrication recipe. */
export class WorkshopRecipeUnavailableError extends AppError {
  constructor(recipeKey: string) {
    super(
      'WORKSHOP_RECIPE_UNAVAILABLE',
      `Workshop recipe "${String(recipeKey)}" is unknown or disabled`,
      "Patch isn't taking that order right now.",
    );
  }
}

/** No enabled base definition matches the recipe's rarity and the chosen slot. */
export class WorkshopNoEligibleEquipmentError extends AppError {
  constructor(rarity: string, slot: string) {
    const what = slot === 'any' ? `${String(rarity)} Equipment` : `${String(rarity)} ${String(slot)} Equipment`;
    super(
      'WORKSHOP_NO_ELIGIBLE_EQUIPMENT',
      `No eligible definition for ${what}`,
      `Patch has no blueprints for ${what} yet. Nothing was charged.`,
    );
  }
}

/** A request key already spent on a different Workshop request. */
export class WorkshopRequestConflictError extends AppError {
  constructor(requestKey: string) {
    super(
      'WORKSHOP_REQUEST_CONFLICT',
      `Workshop request "${String(requestKey)}" was already used for a different request`,
      'That confirmation was already used — reopen the Workshop.',
    );
  }
}

/** The dismantle the player confirmed no longer matches what they reviewed. */
export class WorkshopPreviewStaleError extends AppError {
  constructor(expected: number, actual: number) {
    super(
      'WORKSHOP_PREVIEW_STALE',
      `Dismantle preview expected ${String(expected)} components, would pay ${String(actual)}`,
      'Salvage values changed since you reviewed this. Nothing was dismantled — review it again.',
    );
  }
}

/* ───────────────────────────── Dungeons ───────────────────────────── */

/** Why the dungeon generator could not produce a run. */
export interface DungeonGenerationDiagnostics {
  zoneKey: string;
  seed: number;
  /** Attempts made before giving up. */
  attempts: number;
  /** How many attempts failed for each reason. */
  failures: Record<string, number>;
  /** The reason the last attempt failed. */
  lastFailure: string;
}

/**
 * The authored rules of a zone could not produce a legal run for this seed
 * within the retry bound. Never a partial dungeon: nothing was generated.
 */
export class DungeonGenerationError extends AppError {
  constructor(readonly diagnostics: DungeonGenerationDiagnostics) {
    super(
      'DUNGEON_GENERATION_FAILED',
      `Dungeon zone "${diagnostics.zoneKey}" could not generate a run for seed ${diagnostics.seed} ` +
        `in ${diagnostics.attempts} attempts: ${diagnostics.lastFailure}`,
      `This dungeon could not be generated: ${diagnostics.lastFailure}.`,
    );
  }
}

/** One problem with a submitted dungeon zone, by path. */
export interface DungeonZoneIssueDetail {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** A dungeon zone failed authoring validation; nothing was written. */
export class DungeonZoneInvalidError extends AppError {
  readonly issues: DungeonZoneIssueDetail[];
  constructor(issues: readonly DungeonZoneIssueDetail[]) {
    const list = Array.isArray(issues) ? issues : [];
    const summary = list
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    super(
      'DUNGEON_ZONE_INVALID',
      `Invalid dungeon zone: ${summary || 'unknown problem'}`,
      summary || 'That dungeon zone is not valid.',
    );
    this.issues = [...list];
  }
}

/** A save named a revision someone else has since replaced. Nothing was written. */
export class DungeonZoneStaleError extends AppError {
  constructor(
    readonly zoneKey: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
    readonly updatedBy: string | null,
    readonly updatedAt: Date,
  ) {
    super(
      'DUNGEON_ZONE_STALE',
      `Dungeon zone "${zoneKey}" is at revision ${currentRevision}, not ${expectedRevision}`,
      'This dungeon zone was changed by someone else since you opened it. Reload to see their changes.',
    );
  }
}

export class DungeonZoneKeyTakenError extends AppError {
  constructor(zoneKey: string) {
    super(
      'DUNGEON_ZONE_KEY_TAKEN',
      `A dungeon zone "${zoneKey}" already exists`,
      'Another dungeon zone already uses that key.',
    );
  }
}

/** A run was asked for in a zone that does not exist or is switched off. */
export class DungeonZoneUnavailableError extends AppError {
  /**
   * `region`: the zone exists and is enabled, but cannot be started from where
   * the player is standing. `regionName` is that place, for the message.
   */
  constructor(
    zoneKey: string,
    readonly reason: 'missing' | 'disabled' | 'region',
    regionName?: string,
  ) {
    super(
      'DUNGEON_ZONE_UNAVAILABLE',
      reason === 'region'
        ? `Dungeon zone "${zoneKey}" is not available in the player's current region`
        : `Dungeon zone "${zoneKey}" is ${reason}`,
      reason === 'region'
        ? `That Delve isn’t available in ${typeof regionName === 'string' && regionName ? regionName : 'this region'}.`
        : 'That dungeon is not open right now.',
    );
  }
}

/** One active run per player. */
export class DungeonRunActiveError extends AppError {
  constructor(playerId: number) {
    super(
      'DUNGEON_RUN_ACTIVE',
      `Player ${playerId} already has an active dungeon run`,
      'You are already in a dungeon. Finish or abandon that run first.',
    );
  }
}

/** Every Delve run of the current game day has been started. Resets with the day. */
export class DungeonDailyLimitError extends AppError {
  constructor(
    playerId: number,
    readonly limit: number,
    readonly used: number,
    readonly periodKey: string,
  ) {
    super(
      'DUNGEON_DAILY_LIMIT',
      `Player ${playerId} has started ${used} of ${limit} dungeon runs for ${periodKey}`,
      limit > 0
        ? 'You’ve used all of today’s Delve runs. They come back at the daily reset.'
        : 'Delve is closed to new runs right now.',
    );
  }
}

/** A Delve setting outside its bounds. */
export class DungeonSettingsInvalidError extends AppError {
  readonly issues: string[];
  constructor(issues: string[]) {
    const list = Array.isArray(issues) ? issues : [];
    super('DUNGEON_SETTINGS_INVALID', `Dungeon settings invalid: ${list.join(' ')}`, list.join(' ') || 'Invalid Delve settings.');
    this.issues = list;
  }
}

/** The run does not exist, or belongs to another player. One error for both. */
export class DungeonRunNotFoundError extends AppError {
  constructor(runId: number) {
    super('DUNGEON_RUN_NOT_FOUND', `Dungeon run ${String(runId)} not found for this player`, 'That run could not be found.');
  }
}

/** The run was generated without a fighter snapshot, so there is nothing to play it with. */
export class DungeonRunUnplayableError extends AppError {
  constructor(runId: number) {
    super(
      'DUNGEON_RUN_UNPLAYABLE',
      `Dungeon run ${String(runId)} has no fighter snapshot`,
      'That run cannot be played. Abandon it and start a new one.',
    );
  }
}

/* ─────────────────────── Progression currency ─────────────────────── */

export class ProgressionCurrencyNotFoundError extends AppError {
  constructor(currencyKey: string) {
    super(
      'PROGRESSION_CURRENCY_NOT_FOUND',
      `Progression currency "${currencyKey}" not found`,
      'That currency does not exist.',
    );
  }
}

/** A grant was asked for in a currency that is switched off. */
export class ProgressionCurrencyDisabledError extends AppError {
  constructor(currencyKey: string) {
    super(
      'PROGRESSION_CURRENCY_DISABLED',
      `Progression currency "${currencyKey}" is disabled`,
      'That currency is not available right now.',
    );
  }
}

export class ProgressionCurrencyInvalidError extends AppError {
  readonly issues: { path: string; message: string }[];
  constructor(issues: readonly { path: string; message: string }[]) {
    const list = Array.isArray(issues) ? issues : [];
    const summary = list.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(
      'PROGRESSION_CURRENCY_INVALID',
      `Invalid currency metadata: ${summary || 'unknown problem'}`,
      summary || 'That currency metadata is not valid.',
    );
    this.issues = [...list];
  }
}

export class ProgressionCurrencyStaleError extends AppError {
  constructor(
    readonly currencyKey: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      'PROGRESSION_CURRENCY_STALE',
      `Progression currency "${currencyKey}" is at revision ${currentRevision}, not ${expectedRevision}`,
      'This currency was changed by someone else since you opened it. Reload to see their changes.',
    );
  }
}

/** A spend the balance cannot cover. `name` is the currency's display name. */
export class InsufficientProgressionCurrencyError extends AppError {
  constructor(
    readonly currencyKey: string,
    required: number,
    balance: number,
    name: string,
  ) {
    super(
      'INSUFFICIENT_PROGRESSION_CURRENCY',
      `Needs ${required} ${currencyKey}, has ${balance}`,
      `You need ${required} ${name} but only have ${balance}.`,
    );
  }
}

/** A request key already spent on a different change to the same balance. */
export class ProgressionCurrencyRequestConflictError extends AppError {
  constructor(requestKey: string) {
    super(
      'PROGRESSION_CURRENCY_REQUEST_CONFLICT',
      `Progression currency request "${String(requestKey)}" was already used for a different change`,
      'That request was already used.',
    );
  }
}
