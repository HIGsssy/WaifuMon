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
 *   - **travel** — actually move, subject to the active-encounter block.
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
 * What this module deliberately does **not** do: touch capture, rarity, energy,
 * cooldowns, care, gifts or boss participation. Region reaches exactly one
 * gameplay decision — which species the hunt may draw — and that decision is
 * made in `huntService`, not here.
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
  isUniqueViolation,
  RegionLockedError,
  RegionNotFoundError,
  RouteAlreadyUnlockedError,
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
  shopItemCount: number;
  /**
   * Relative path (under `assetsDir`) to the region's shallow/wide banner, if
   * one is authored. The UI layer is responsible for resolving to a file and
   * degrading to text when the file is missing.
   */
  bannerImagePath: string | null;
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
}

export interface TravelService {
  /** The catalog for the current content snapshot. Rebuilt on content reload. */
  catalog(): TravelCatalog;
  /** Everything the Locations screen needs, in one read. */
  getStatus(playerId: number): Promise<TravelStatus>;
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
  /** Move. Free, immediate, and refused while an encounter is open. */
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
    // Shop membership lives on the item now, so a region's stock count is
    // derived: enabled, priced items that name the region. Zero hides the shop
    // entry on the Locations detail.
    const shopCountByRegion = new Map<string, number>();
    for (const item of deps.getContent().items) {
      if (!item.enabled || item.buyPrice == null) continue;
      for (const regionId of item.shopRegions) {
        shopCountByRegion.set(regionId, (shopCountByRegion.get(regionId) ?? 0) + 1);
      }
    }
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
        shopItemCount: shopCountByRegion.get(destination.region.id) ?? 0,
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

    async getStatus(playerId) {
      const cat = catalog();
      const [[player], balances] = await Promise.all([
        db
          .select({ level: players.level, currentRegion: players.currentRegion })
          .from(players)
          .where(eq(players.id, playerId)),
        currency.getBalances(playerId),
      ]);
      const currentRegion = toRegion(player?.currentRegion);
      const level = player?.level ?? 1;
      const [active] = await db
        .select({ id: encounters.id })
        .from(encounters)
        .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
        .limit(1);
      return {
        enabled: cat.enabled,
        currentRegion,
        currentRegionName: cat.label(currentRegion),
        level,
        waifubux: balances.waifubux,
        essence: balances.essence,
        activeEncounterId: active?.id ?? null,
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
      const destination = requireDestination(regionId);

      return db.transaction(async (tx) => {
        const [player] = await tx
          .select({ currentRegion: players.currentRegion })
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new RegionNotFoundError(regionId);
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

        // The active-encounter block. Read under the same transaction that
        // writes `current_region`, and expiry is honoured the way the hunt
        // honours it — an encounter whose window has closed is not a reason to
        // keep someone standing still.
        const [active] = await tx
          .select({ id: encounters.id, expiresAt: encounters.expiresAt })
          .from(encounters)
          .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')))
          .for('update');
        if (active && active.expiresAt.getTime() > now.getTime()) {
          throw new TravelBlockedByEncounterError(active.id);
        }

        await tx
          .update(players)
          .set({ currentRegion: regionId })
          .where(eq(players.id, playerId));

        return {
          fromRegion,
          toRegion: regionId as Region,
          toRegionName: destination.region.name,
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
