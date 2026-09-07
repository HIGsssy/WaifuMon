/**
 * Locations & Travel.
 *
 * Four responsibilities behind one factory, deliberately kept in one module
 * because they share a single content projection and a single transaction
 * discipline:
 *
 *   - **regions** — read where a player is; list what they can see and do.
 *   - **passes** — buy the Caravan Pass (and the destination it stamps).
 *   - **routes** — add a later destination to a pass already owned.
 *   - **travel** — actually move, for 1 Hunt Energy, subject to the
 *     active-encounter, Care Mode and Energy blocks.
 *
 * Every money path follows the Shop's transaction shape exactly: lock the
 * currency row first (which serializes this player's concurrent clicks),
 * validate *before* charging, deduct conditionally, grant, audit — all inside
 * one `db.transaction`. The grant tables' primary keys are the backstop under
 * that: a duplicate that somehow wins every application-level race still dies
 * on a unique violation, and the whole transaction — including the deduction —
 * rolls back. A player therefore cannot be charged twice for one entitlement
 * even in principle.
 *
 * What this module deliberately does **not** do: touch capture, rarity,
 * cooldowns, gifts or boss participation. Region reaches exactly one gameplay
 * decision — which species the hunt may draw — and that decision is made in
 * `huntService`, not here.
 *
 * It *does* touch Energy and Care Mode, in exactly one place: `travel()`. That
 * is a deliberate later addition, not a leak of hunt concerns into the map.
 * Travel can roll a World Encounter, and a World Encounter pays out — so a move
 * that costs nothing is an unbounded reward loop for anyone willing to walk
 * back and forth. `TRAVEL_ENERGY_COST` is what prices it, and it is charged
 * here rather than in the Discord handler so that the Portal, the Platform API
 * and any future client are gated by construction rather than by remembering.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  encounters,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  travelTransactions,
  type PlayerTravelPassRow,
  type PlayerUnlockedRouteRow,
} from '../../db/schema';
import {
  AlreadyInRegionError,
  InsufficientEnergyError,
  isUniqueViolation,
  RegionLockedError,
  RegionNotFoundError,
  RouteAlreadyUnlockedError,
  TravelBlockedByCareModeError,
  TravelBlockedByEncounterError,
  TravelDisabledError,
  TravelLevelRequiredError,
  TravelPassAlreadyOwnedError,
  TravelPassRequiredError,
} from '../../shared/errors';
import type { Region } from '../locations/regions';
import type { LoadedContent } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import {
  buildTravelCatalog,
  toRegion,
  type DestinationDefinition,
  type TravelCatalog,
} from './travelCatalog';

/**
 * Hunt Energy charged for one successful journey.
 *
 * One, flat, and not content-tunable on purpose. The number is not a balance
 * dial — it is the thing that makes travel *finite*, so it belongs next to the
 * code that enforces it rather than in a table an admin can quietly set to
 * zero and reopen the farm. Exported so the UI and the tests name the cost
 * once instead of each hard-coding a `1`.
 *
 * Charged once per journey, at the moment the destination is committed. The
 * World Encounter that a journey may roll is downstream of that commit and
 * costs nothing further — see the note on the roll in `travel()`.
 */
export const TRAVEL_ENERGY_COST = 1;

/**
 * How a destination renders on the Locations screen.
 *
 * The five states are the whole UI contract, so they are computed once here
 * rather than re-derived per screen:
 *
 *   `current`    — where the player is standing. Marked; travel disabled.
 *   `unlocked`   — reachable. Travel action.
 *   `purchasable`— eligible and locked. Price + buy action.
 *   `ineligible` — released and locked, but a requirement is unmet. Shows the
 *                  requirement and offers no action.
 *
 * "Unreleased" is not in the list on purpose: a disabled region never reaches
 * this layer at all (see `buildTravelCatalog`), which is what makes "hidden"
 * structural rather than a `if (!visible) continue` somebody can forget.
 */
export type DestinationState = 'current' | 'unlocked' | 'purchasable' | 'ineligible';

export interface DestinationView {
  regionId: string;
  name: string;
  description: string;
  emoji: string | null;
  flavor: string[];
  state: DestinationState;
  /** Cost to unlock, in `currency`. Zero when already unlocked or current. */
  price: number;
  currency: 'waifubux' | 'essence';
  requiredLevel: number;
  /** Human-readable reasons this destination is not yet purchasable. */
  requirements: string[];
  /** Whether the pass this route stamps onto is already owned. */
  passOwned: boolean;
  passName: string | null;
  /** True when buying grants the pass itself (the first purchase). */
  purchaseGrantsPass: boolean;
  /** Number of items this region's shop stocks. Zero hides the shop entry. */
  /**
   * Relative path (under `assetsDir`) to the region's shallow/wide banner, if
   * one is authored. The UI layer is responsible for resolving to a file and
   * degrading to text when the file is missing.
   */
  bannerImagePath: string | null;
}

/**
 * Why travel is refused right now, independent of any one destination.
 *
 * Destination-shaped refusals (locked route, missing pass, level gate, already
 * here) are *not* in this list — they belong to {@link DestinationState}, which
 * varies per row on the Locations list. These three are player-shaped: they
 * refuse every destination at once, which is why they are computed once and
 * hang off {@link TravelStatus} rather than off each {@link DestinationView}.
 */
export type TravelBlockReason = 'active_encounter' | 'care_mode' | 'insufficient_energy';

/** The player-side facts a travel-readiness decision reads. */
export interface TravelReadinessContext {
  /** An encounter that is open *and* unexpired, or null. */
  activeEncounterId: number | null;
  careModeActive: boolean;
  huntEnergy: number;
}

export interface TravelReadiness {
  canTravel: boolean;
  blockedBy: TravelBlockReason | null;
  /**
   * A few words, for a button label or a list row — the examples in the UX
   * spec: `💤 Resting in Care Mode`, `⚡ Not enough Energy`.
   */
  shortReason: string | null;
  /** A sentence, for the banner at the top of the Locations screen. */
  detail: string | null;
}

/**
 * Care Mode's "is it running?" test, over the three columns that carry it.
 *
 * The same predicate `careService` applies internally, restated here over a
 * projected row rather than delegated. Calling the care service for this would
 * mean either `applyPendingTicks` — a *write*, on read paths and on a travel
 * path that may still refuse — or adding a read-only entry point that exists
 * for one boolean. Both `travel()` and `getStatus()` call this, so the map
 * screen and the move cannot disagree about whether the player is resting.
 *
 * Read-only by construction: nothing here exits Care Mode. Looking at the map
 * must never end someone's rest.
 */
function isCareModeActive(player: {
  careModeStartedAt: Date | null;
  careModeLastTickAt: Date | null;
  careModeWaifuId: number | null;
}): boolean {
  return (
    player.careModeStartedAt != null &&
    player.careModeLastTickAt != null &&
    player.careModeWaifuId != null
  );
}

/**
 * The pure travel-readiness rule — the single source of truth for both the
 * screen and the move, exactly as {@link evaluateDestination} is for the
 * screen and the purchase.
 *
 * The Locations screen must grey out Travel for precisely the reasons
 * `travel()` will refuse for, and in the same priority order. The only way to
 * guarantee that stays true through later edits is for both to call this, so
 * `travel()` derives its thrown error from this function's verdict rather than
 * running its own parallel sequence of `if`s.
 *
 * A free function with no database and no service, for the same reason
 * `evaluateDestination` is one: it is the piece worth unit-testing directly,
 * and a closure over `db` would have made that impossible without a container.
 *
 * Order matters and is asserted by tests. Care Mode outranks Energy because a
 * resting player is nearly always also out of Energy, and "leave Care Mode" is
 * the instruction that actually moves them forward — telling them to claim a
 * daily is advice for a problem they are already solving.
 */
export function evaluateTravelReadiness(ctx: TravelReadinessContext): TravelReadiness {
  if (ctx.activeEncounterId !== null) {
    return {
      canTravel: false,
      blockedBy: 'active_encounter',
      shortReason: '⏳ Encounter in progress',
      detail:
        "Someone's still waiting on you — finish or release your encounter before travelling.",
    };
  }
  if (ctx.careModeActive) {
    return {
      canTravel: false,
      blockedBy: 'care_mode',
      shortReason: '💤 Resting in Care Mode',
      detail:
        "You're resting in Care Mode. Leave it and recover some Hunt Energy before you set out.",
    };
  }
  if (ctx.huntEnergy < TRAVEL_ENERGY_COST) {
    return {
      canTravel: false,
      blockedBy: 'insufficient_energy',
      shortReason: '⚡ Not enough Energy',
      detail: `Travelling costs **${TRAVEL_ENERGY_COST}** Hunt Energy and you have **${ctx.huntEnergy}**.`,
    };
  }
  return { canTravel: true, blockedBy: null, shortReason: null, detail: null };
}

export interface TravelStatus {
  enabled: boolean;
  currentRegion: Region;
  currentRegionName: string;
  level: number;
  waifubux: number;
  essence: number;
  /** Blocked-by-encounter is surfaced here so the list can explain itself. */
  activeEncounterId: number | null;
  /** Hunt Energy on hand. One journey costs {@link TRAVEL_ENERGY_COST}. */
  huntEnergy: number;
  /**
   * True while the player is resting. Read-only here — no screen may exit Care
   * Mode as a side effect of looking at the map; that is a decision the player
   * makes on the Care screen.
   */
  careModeActive: boolean;
  /**
   * Whether travel is possible at all right now, and why not. Computed by
   * {@link evaluateTravelReadiness}, the same function `travel()` enforces
   * with, so the greyed-out button and the refusal can never disagree.
   */
  readiness: TravelReadiness;
  destinations: DestinationView[];
}

export interface PurchaseOutcome {
  regionId: string;
  regionName: string;
  passId: string;
  passName: string;
  /** True when this purchase also granted the pass (the first purchase). */
  grantedPass: boolean;
  amount: number;
  currency: 'waifubux' | 'essence';
  balanceAfter: number;
}

export interface TravelOutcome {
  fromRegion: Region;
  toRegion: Region;
  toRegionName: string;
  /** Hunt Energy this journey consumed. Always {@link TRAVEL_ENERGY_COST}. */
  energySpent: number;
  /** Hunt Energy left after the charge, so the UI need not re-read it. */
  energyRemaining: number;
}

export interface TravelService {
  /** The catalog for the current content snapshot. Rebuilt on content reload. */
  catalog(): TravelCatalog;
  /**
   * Everything the Locations screen needs, in one read.
   *
   * Includes {@link TravelStatus.readiness}, so the screen can grey out Travel
   * with the reason *before* the click rather than surfacing it as an error
   * after. Purely a read — it never applies Care Mode ticks and never exits
   * Care Mode. `now` is injectable so encounter expiry is testable.
   */
  getStatus(playerId: number, now?: Date): Promise<TravelStatus>;
  /** One destination's view, or null when it is unreleased/unknown. */
  getDestination(playerId: number, regionId: string): Promise<DestinationView | null>;
  /** The player's current region, defaulted if the column holds anything odd. */
  getCurrentRegion(playerId: number): Promise<Region>;
  /**
   * Buy access to `regionId`. Routes granted by the pass purchase buy the pass
   * *and* the route atomically; every other route is stamped onto a pass the
   * player must already own. One entry point so the UI never has to know which
   * kind it is looking at.
   */
  purchaseDestination(playerId: number, regionId: string): Promise<PurchaseOutcome>;
  /**
   * Move. Immediate, and refused while an encounter is open, while the player
   * is in Care Mode, or below {@link TRAVEL_ENERGY_COST} Hunt Energy.
   *
   * Costs exactly {@link TRAVEL_ENERGY_COST} Energy, deducted atomically with
   * the destination update: a journey that throws for any reason consumes
   * nothing. WaifuBux, passes and routes are unaffected — travel has never
   * charged money and still does not.
   */
  travel(playerId: number, regionId: string, now?: Date): Promise<TravelOutcome>;
  /** Admin: grant a pass (and its routes) with no charge. Idempotent. */
  grantPass(playerId: number, passId: string): Promise<void>;
  /** Admin: grant one route with no charge and no pass check. Idempotent. */
  grantRoute(playerId: number, regionId: string): Promise<void>;
  /** Admin: revoke a pass. Leaves route rows alone — see the implementation. */
  revokePass(playerId: number, passId: string): Promise<void>;
  /** Admin: revoke one route, sending the player home if they are standing in it. */
  revokeRoute(playerId: number, regionId: string): Promise<void>;
}

export interface TravelServiceDeps {
  db: Db;
  currency: CurrencyService;
  /**
   * Read through a closure, matching the appearance/boss services: the admin
   * panel's Reload Content republishes the snapshot, and a service that
   * destructured it at wiring time would keep selling yesterday's prices.
   */
  getContent: () => LoadedContent;
}

/** The player-side facts an eligibility decision reads. */
export interface EligibilityContext {
  level: number;
  currentRegion: string;
  /** Pass ids the player owns. */
  passIds: Set<string>;
  /** Region ids the player has route rows for. */
  unlocked: Set<string>;
}

/**
 * The pure eligibility rule — the single source of truth for both the screen
 * and the purchase path.
 *
 * Deliberately a free function with no database and no service: the Locations
 * list must render exactly the reasons `purchaseDestination` will refuse for,
 * and the only way to guarantee that stays true is for both to call this. It
 * is also the piece worth unit-testing directly, which a closure over `db`
 * would have made impossible without a container.
 */
export function evaluateDestination(
  destination: DestinationDefinition,
  ctx: EligibilityContext,
): { state: DestinationState; requirements: string[] } {
  const regionId = destination.region.id;
  if (ctx.currentRegion === regionId) return { state: 'current', requirements: [] };
  // The starting region is reachable by rule, not by a row — see the note on
  // `player_unlocked_routes` in the schema.
  if (destination.access === 'starting' || ctx.unlocked.has(regionId)) {
    return { state: 'unlocked', requirements: [] };
  }

  const requirements: string[] = [];
  if (!destination.route || !destination.pass) {
    // Released, enabled, but content never priced it. Visible and inert
    // rather than crashing a screen over an authoring gap.
    requirements.push('No route to this destination has opened yet.');
    return { state: 'ineligible', requirements };
  }
  if (ctx.level < destination.requiredLevel) {
    requirements.push(`Trainer Level ${destination.requiredLevel} (you are ${ctx.level})`);
  }
  // A later destination cannot be bought before the pass it stamps onto.
  if (!destination.grantedByPassPurchase && !ctx.passIds.has(destination.pass.id)) {
    requirements.push(`${destination.pass.name} (buy it first)`);
  }
  return requirements.length > 0
    ? { state: 'ineligible', requirements }
    : { state: 'purchasable', requirements: [] };
}

export function createTravelService(deps: TravelServiceDeps): TravelService {
  const { db, currency } = deps;

  const catalog = (): TravelCatalog => buildTravelCatalog(deps.getContent());

  /** Resolves a destination or refuses. Unreleased and unknown are one case. */
  function requireDestination(regionId: string): DestinationDefinition {
    const cat = catalog();
    if (!cat.enabled) throw new TravelDisabledError();
    const found = cat.get(regionId);
    if (!found) throw new RegionNotFoundError(regionId);
    return found;
  }

  async function ownedPassIds(playerId: number): Promise<Set<string>> {
    const rows = await db
      .select({ passId: playerTravelPasses.passId })
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    return new Set(rows.map((r) => r.passId));
  }

  async function unlockedRegionIds(playerId: number): Promise<Set<string>> {
    const rows = await db
      .select({ regionId: playerUnlockedRoutes.regionId })
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    return new Set(rows.map((r) => r.regionId));
  }

  async function buildViews(
    playerId: number,
    level: number,
    currentRegion: string,
  ): Promise<DestinationView[]> {
    const cat = catalog();
    const [passIds, unlocked] = await Promise.all([
      ownedPassIds(playerId),
      unlockedRegionIds(playerId),
    ]);
    return cat.destinations.map((destination) => {
      const { state, requirements } = evaluateDestination(destination, {
        level,
        currentRegion,
        passIds,
        unlocked,
      });
      const passOwned = destination.pass ? passIds.has(destination.pass.id) : false;
      return {
        regionId: destination.region.id,
        name: destination.region.name,
        description: destination.region.description,
        emoji: destination.region.emoji,
        flavor: destination.region.flavor,
        state,
        price: state === 'unlocked' || state === 'current' ? 0 : destination.price,
        currency: destination.currency,
        requiredLevel: destination.requiredLevel,
        requirements,
        passOwned,
        passName: destination.pass?.name ?? null,
        purchaseGrantsPass: destination.grantedByPassPurchase && !passOwned,
        bannerImagePath: destination.region.bannerImagePath ?? null,
      };
    });
  }

  return {
    catalog,

    async getCurrentRegion(playerId) {
      const [row] = await db
        .select({ currentRegion: players.currentRegion })
        .from(players)
        .where(eq(players.id, playerId));
      return toRegion(row?.currentRegion);
    },

    async getStatus(playerId, now = new Date()) {
      const cat = catalog();
      const [[player], balances] = await Promise.all([
        db
          .select({
            level: players.level,
            currentRegion: players.currentRegion,
            careModeStartedAt: players.careModeStartedAt,
            careModeLastTickAt: players.careModeLastTickAt,
            careModeWaifuId: players.careModeWaifuId,
          })
          .from(players)
          .where(eq(players.id, playerId)),
        currency.getBalances(playerId),
      ]);
      const currentRegion = toRegion(player?.currentRegion);
      const level = player?.level ?? 1;
      // Expiry is honoured here exactly as `travel()` honours it, and for the
      // same reason: an encounter whose window has closed is not a reason to
      // grey out the button, and a screen that disagreed with the move would
      // strand the player behind a block the service would have let through.
      const [active] = await db
        .select({ id: encounters.id, expiresAt: encounters.expiresAt })
        .from(encounters)
        .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
        .limit(1);
      const blockingEncounterId =
        active && active.expiresAt.getTime() > now.getTime() ? active.id : null;
      const careModeActive = player != null && isCareModeActive(player);
      return {
        enabled: cat.enabled,
        currentRegion,
        currentRegionName: cat.label(currentRegion),
        level,
        waifubux: balances.waifubux,
        essence: balances.essence,
        activeEncounterId: blockingEncounterId,
        huntEnergy: balances.huntEnergy,
        careModeActive,
        readiness: evaluateTravelReadiness({
          activeEncounterId: blockingEncounterId,
          careModeActive,
          huntEnergy: balances.huntEnergy,
        }),
        destinations: cat.enabled ? await buildViews(playerId, level, currentRegion) : [],
      };
    },

    async getDestination(playerId, regionId) {
      const cat = catalog();
      if (!cat.enabled || !cat.get(regionId)) return null;
      const [player] = await db
        .select({ level: players.level, currentRegion: players.currentRegion })
        .from(players)
        .where(eq(players.id, playerId));
      const views = await buildViews(
        playerId,
        player?.level ?? 1,
        toRegion(player?.currentRegion),
      );
      return views.find((v) => v.regionId === regionId) ?? null;
    },

    async purchaseDestination(playerId, regionId) {
      const destination = requireDestination(regionId);
      if (destination.access === 'starting') {
        throw new RouteAlreadyUnlockedError(regionId, destination.region.name);
      }
      const { route, pass } = destination;
      if (!route || !pass) throw new RegionNotFoundError(regionId);

      return db.transaction(async (tx) => {
        // Lock the currency row first, exactly as the Shop does. This is what
        // serializes this player's concurrent purchase clicks, so every check
        // below reads state nobody else can change underneath it.
        await currency.lockCurrencies(tx, playerId);

        const [player] = await tx
          .select({ level: players.level })
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new RegionNotFoundError(regionId);

        const [existingRoute] = await tx
          .select()
          .from(playerUnlockedRoutes)
          .where(
            and(
              eq(playerUnlockedRoutes.playerId, playerId),
              eq(playerUnlockedRoutes.regionId, regionId),
            ),
          );
        if (existingRoute) throw new RouteAlreadyUnlockedError(regionId, destination.region.name);

        const [existingPass] = await tx
          .select()
          .from(playerTravelPasses)
          .where(
            and(
              eq(playerTravelPasses.playerId, playerId),
              eq(playerTravelPasses.passId, pass.id),
            ),
          );

        // Two shapes of purchase, one entry point:
        //   - the *initial* pass purchase, which grants the pass and every
        //     route the pass stamps for, atomically, for the pass price;
        //   - a *later* route unlock against a pass already owned, for the
        //     route's own fee.
        const grantingPass = destination.grantedByPassPurchase && !existingPass;
        if (destination.grantedByPassPurchase && existingPass) {
          // The pass is owned but the route it grants is not — only reachable
          // if a route row was revoked by an admin. Re-stamp it for free
          // rather than re-selling a pass they already hold.
          //
          // Guarded like every other grant in this method: the currency lock
          // above should already have serialized a double-click, but this file
          // 's whole premise is that the database has the last word, and an
          // insert that can raise a unique violation must translate it rather
          // than surface raw Postgres to a player.
          try {
            await tx
              .insert(playerUnlockedRoutes)
              .values({ playerId, regionId, source: 'purchase' });
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw new RouteAlreadyUnlockedError(regionId, destination.region.name);
            }
            throw err;
          }
          const balances = await currency.lockCurrencies(tx, playerId);
          return {
            regionId,
            regionName: destination.region.name,
            passId: pass.id,
            passName: pass.name,
            grantedPass: false,
            amount: 0,
            currency: destination.currency,
            balanceAfter:
              destination.currency === 'essence' ? balances.essence : balances.waifubux,
          } satisfies PurchaseOutcome;
        }
        if (!grantingPass && !existingPass) {
          throw new TravelPassRequiredError(pass.id, pass.name);
        }

        const requiredLevel = grantingPass
          ? Math.max(pass.requiredLevel, route.requiredLevel)
          : route.requiredLevel;
        if (player.level < requiredLevel) {
          throw new TravelLevelRequiredError(requiredLevel, player.level);
        }

        const amount = grantingPass ? pass.price : route.price;
        const priceCurrency = grantingPass ? pass.currency : route.currency;

        // Conditional deduct: insufficient funds throws with the transaction
        // rolled back, so nothing is ever partially granted. A zero-price
        // route skips the spend entirely rather than deducting nothing.
        let balanceAfter: number;
        if (amount > 0) {
          const balance =
            priceCurrency === 'essence'
              ? await currency.spendEssence(tx, playerId, amount)
              : await currency.spendWaifubux(tx, playerId, amount);
          balanceAfter = priceCurrency === 'essence' ? balance.essence : balance.waifubux;
        } else {
          const balance = await currency.lockCurrencies(tx, playerId);
          balanceAfter = priceCurrency === 'essence' ? balance.essence : balance.waifubux;
        }

        try {
          if (grantingPass) {
            await tx
              .insert(playerTravelPasses)
              .values({ playerId, passId: pass.id, source: 'purchase' });
            // Every route the pass stamps for, not just the one clicked: the
            // pass is the container, and buying it opens everything it covers.
            for (const granted of pass.grantsRoutes) {
              await tx
                .insert(playerUnlockedRoutes)
                .values({ playerId, regionId: granted, source: 'purchase' })
                .onConflictDoNothing();
            }
          } else {
            await tx
              .insert(playerUnlockedRoutes)
              .values({ playerId, regionId, source: 'purchase' });
          }
        } catch (err) {
          // The database had the last word on a race the locks should already
          // have prevented. Translate it into the same message the pre-checks
          // produce, so a double-click reads identically however it lost.
          if (isUniqueViolation(err)) {
            throw grantingPass
              ? new TravelPassAlreadyOwnedError(pass.id, pass.name)
              : new RouteAlreadyUnlockedError(regionId, destination.region.name);
          }
          throw err;
        }

        await tx.insert(travelTransactions).values({
          playerId,
          kind: grantingPass ? 'pass' : 'route',
          passId: pass.id,
          regionId,
          amount,
          currency: priceCurrency,
          balanceAfter,
        });

        return {
          regionId,
          regionName: destination.region.name,
          passId: pass.id,
          passName: pass.name,
          grantedPass: grantingPass,
          amount,
          currency: priceCurrency,
          balanceAfter,
        } satisfies PurchaseOutcome;
      });
    },

    async travel(playerId, regionId, now = new Date()) {
      // Content gate first, and outside the transaction: a disabled travel
      // system or an unknown region is a fact about the catalog, not about
      // this player, so it needs no locks and no rollback.
      const destination = requireDestination(regionId);

      return db.transaction(async (tx) => {
        // Both rows are locked up front, before any decision reads them.
        //
        // The currency lock is what serializes this player's concurrent travel
        // clicks — the same role it plays in `purchaseDestination` and in the
        // Shop. Without it, two clicks could both read 1 Energy and both
        // commit; `spendHuntEnergy`'s conditional `WHERE` would still stop the
        // second from going negative, but the lock is what makes the *ordering*
        // deterministic rather than leaning on the backstop.
        const [player] = await tx
          .select({
            currentRegion: players.currentRegion,
            careModeStartedAt: players.careModeStartedAt,
            careModeLastTickAt: players.careModeLastTickAt,
            careModeWaifuId: players.careModeWaifuId,
          })
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new RegionNotFoundError(regionId);
        const currencies = await currency.lockCurrencies(tx, playerId);

        // ── Validation order ──────────────────────────────────────────────
        //
        // Everything below this line runs before a single write, so the "a
        // failed travel costs nothing" guarantee does not actually depend on
        // the ordering — the deduction is last, and any throw rolls the whole
        // transaction back regardless. What the ordering buys is the *right
        // message* when more than one rule is unmet, cheapest and most
        // specific first:
        //
        //   1. already here          — nothing to do at all
        //   2. route locked          — a trip they could never take
        //   ── then `evaluateTravelReadiness`, which owns these three ──
        //   3. encounter open        — someone is waiting on them
        //   4. Care Mode             — they are deliberately resting
        //   5. Energy                — the trip is real, the tank is empty
        //
        // The destination checks stay here because they are per-row: the
        // Locations list shows them as each destination's own state. The
        // player-shaped three are hoisted into the shared helper because they
        // refuse *every* destination at once, which is exactly the thing the
        // screen wants to say once at the top rather than on every line.
        //
        // They sit below the destination checks so a player is never told to
        // go recover for a journey that was refused for an unrelated reason.
        const fromRegion = toRegion(player.currentRegion);
        if (fromRegion === regionId) {
          throw new AlreadyInRegionError(regionId, destination.region.name);
        }

        if (destination.access !== 'starting') {
          const [route] = await tx
            .select()
            .from(playerUnlockedRoutes)
            .where(
              and(
                eq(playerUnlockedRoutes.playerId, playerId),
                eq(playerUnlockedRoutes.regionId, regionId),
              ),
            );
          if (!route) throw new RegionLockedError(regionId, destination.region.name);
        }

        // The active-encounter read. Taken under the same transaction that
        // writes `current_region`, and expiry is honoured the way the hunt
        // honours it — an encounter whose window has closed is not a reason to
        // keep someone standing still.
        const [active] = await tx
          .select({ id: encounters.id, expiresAt: encounters.expiresAt })
          .from(encounters)
          .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
          .for('update');

        // The three player-shaped blocks — encounter, Care Mode, Energy — are
        // decided by `evaluateTravelReadiness`, not re-implemented here. That
        // is what keeps the greyed-out Travel button on the Locations screen
        // and this refusal in permanent agreement: one function owns both the
        // rules and their priority order, and this call site owns only the
        // translation from verdict to thrown error.
        const readiness = evaluateTravelReadiness({
          activeEncounterId:
            active && active.expiresAt.getTime() > now.getTime() ? active.id : null,
          careModeActive: isCareModeActive(player),
          huntEnergy: currencies.huntEnergy,
        });
        if (!readiness.canTravel) {
          switch (readiness.blockedBy) {
            case 'active_encounter':
              throw new TravelBlockedByEncounterError(active!.id);
            case 'care_mode':
              throw new TravelBlockedByCareModeError();
            case 'insufficient_energy':
              throw new InsufficientEnergyError();
          }
        }

        // Energy. The readiness check above already refused an empty tank, so
        // this is the atomic backstop rather than the decision: `spendHuntEnergy`
        // deducts under `WHERE hunt_energy >= cost` and throws the same
        // `InsufficientEnergyError` if a concurrent spend beat us to the last
        // point between the read and the write. The currency row is locked, so
        // that should be unreachable — but the balance is the one thing here
        // another transaction could legitimately be moving, and a conditional
        // write costs nothing to keep.
        const spent = await currency.spendHuntEnergy(tx, playerId, TRAVEL_ENERGY_COST);

        // Destination last. Same transaction as the deduction, so the two
        // commit together or not at all: no journey without a charge, and no
        // charge without a journey.
        await tx
          .update(players)
          .set({ currentRegion: regionId })
          .where(eq(players.id, playerId));

        // The World Encounter roll is deliberately NOT here. It fires after
        // this transaction commits (see `handleLocationTravel`), against a
        // destination that is already the player's real position — which is
        // what makes the encounter, its resolution, any chained continuation
        // and the "Continue Journey" button all pure downstream navigation
        // with nothing left to charge. Travel is billed once, here, whether or
        // not anything comes of the trip.
        return {
          fromRegion,
          toRegion: regionId as Region,
          toRegionName: destination.region.name,
          energySpent: TRAVEL_ENERGY_COST,
          energyRemaining: spent.huntEnergy,
        } satisfies TravelOutcome;
      });
    },

    // ── Admin helpers ────────────────────────────────────────────────────
    //
    // Thin on purpose: they insert and delete the same rows a purchase would,
    // with `source: 'admin'` and no currency involvement, and write no audit
    // row because nothing was bought. All four are idempotent so a repeated
    // command is never an error. No admin UI is wired to them in this pass.

    async grantPass(playerId, passId) {
      const pass = catalog().getPass(passId);
      if (!pass) throw new RegionNotFoundError(passId);
      await db.transaction(async (tx) => {
        await tx
          .insert(playerTravelPasses)
          .values({ playerId, passId, source: 'admin' })
          .onConflictDoNothing();
        for (const regionId of pass.grantsRoutes) {
          await tx
            .insert(playerUnlockedRoutes)
            .values({ playerId, regionId, source: 'admin' })
            .onConflictDoNothing();
        }
      });
    },

    async grantRoute(playerId, regionId) {
      const destination = requireDestination(regionId);
      if (destination.access === 'starting') return;
      await db
        .insert(playerUnlockedRoutes)
        .values({ playerId, regionId, source: 'admin' })
        .onConflictDoNothing();
    },

    async revokePass(playerId, passId) {
      // Routes are deliberately left in place. A pass and a route are
      // independent facts (that is why they are separate tables), and
      // cascading here would make "take back the pass" silently strand a
      // player in a region they still have a row for. Revoke routes
      // explicitly when that is what is meant.
      await db
        .delete(playerTravelPasses)
        .where(
          and(eq(playerTravelPasses.playerId, playerId), eq(playerTravelPasses.passId, passId)),
        );
    },

    async revokeRoute(playerId, regionId) {
      await db.transaction(async (tx) => {
        await tx
          .delete(playerUnlockedRoutes)
          .where(
            and(
              eq(playerUnlockedRoutes.playerId, playerId),
              eq(playerUnlockedRoutes.regionId, regionId),
            ),
          );
        // Never strand a player somewhere they can no longer reach: revoking
        // the route they are standing in sends them home. The starting region
        // is always reachable, so this is always a legal destination.
        await tx
          .update(players)
          .set({ currentRegion: catalog().startingRegion })
          .where(and(eq(players.id, playerId), eq(players.currentRegion, regionId)));
      });
    },
  };
}

/** Row types re-exported so tests can assert on grants without a schema import. */
export type { PlayerTravelPassRow, PlayerUnlockedRouteRow };
