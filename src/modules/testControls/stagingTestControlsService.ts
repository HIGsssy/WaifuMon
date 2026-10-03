/**
 * Staging Test Controls — put a tester's account into a known state without
 * grinding: set Trainer Level, move WaifuBux, set Energy, grant or take the
 * Transporter Beacon, grant ordinary travel access, and reset the Assteroid
 * Belt unlock so it can be played through again.
 *
 * **Test tooling, not gameplay.** Nothing here is reachable from Discord or
 * from any player-facing route, and nothing here changes a gameplay rule.
 *
 * ## Three independent locks
 *
 *  1. Startup: `ENABLE_TEST_ADMIN_CONTROLS=true` with `DEPLOYMENT_ENV`
 *     resolving to `production` refuses to boot (`loadConfig`).
 *  2. Construction: this factory throws unless {@link testAdminControlsAllowed}
 *     says yes, so a production process cannot even hold one.
 *  3. Every operation re-checks the same rule before touching the database.
 *
 * The Portal route and the `players.testcontrols` permission sit on top of
 * those; none of the three depends on them.
 *
 * ## Transactions and locking
 *
 * Every operation is one `db.transaction` that takes the target's currency row
 * and then the player row `FOR UPDATE` — the order gameplay already uses (a
 * hunt spends Energy, then `grantXp` locks the player) — so two admin clicks on
 * one account serialize rather than interleave, and never deadlock against a
 * live hunt. The audit row is written in that same transaction: an action is
 * recorded exactly when it lands.
 *
 * Writes reuse the owning services wherever one exists — `currency` for
 * WaifuBux and Energy (conditional spends, so a balance can never go
 * negative), `inventory.addItem` for the Beacon (its `max_owned` upsert is the
 * one-beacon backstop), and `travel`'s admin helpers for passes, routes and the
 * safe Belt revoke (which sends a player standing in the Belt home). Only the
 * Trainer Level has no service write path — `grantXp` adds XP, and a level set
 * must not be faked with repeated grants — so it is written here, keeping
 * `level` and `xp` consistent through the same curve `grantXp` uses.
 */
import { and, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  items,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  worldEncounterChoices,
  worldEncounterCooldowns,
  worldEncounters,
  type PlayerRow,
} from '../../db/schema';
import {
  testAdminControlsAllowed,
  type TestAdminControlsConfig,
} from '../../config/config';
import {
  AppError,
  ItemOwnershipLimitError,
  PlayerNotFoundError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { ADMIN_ACTION_EVENT } from '../admin/adminActionAudit';
import type { LoadedContent } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionService } from '../progression/progressionService';
import type { TravelService } from '../travel/travelService';
import type { Region } from '../locations/regions';
import type { EquipmentService } from '../equipment/equipmentService';
import type { EquipmentSlot } from '../equipment/vocabulary';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { EquipmentOnboardingService } from '../onboarding/equipmentOnboardingService';
import { STARTER_SLOTS, storedOnboardingGrantKey } from '../onboarding/vocabulary';
import type { DungeonAllowanceService } from '../dungeons/dungeonAllowanceService';

/** The key-item destination the Belt controls are about. */
export const BELT_REGION: Region = 'assteroid-belt';

/** What "Prepare Player for Current Content" does. First version, per spec. */
export const STAGING_BOOST = { level: 40, waifubux: 10_000 } as const;

/**
 * Per-click WaifuBux ceiling. Generous for test prep, low enough that a
 * fat-fingered extra digit is refused rather than executed.
 */
export const TEST_MAX_WAIFUBUX_PER_ACTION = 1_000_000;

/** `player_currencies.waifubux` is int4; stay well clear of the wrap. */
const WAIFUBUX_CEILING = 2_000_000_000;

/** `metadata.action` values this module writes — one per control. */
export const TEST_CONTROL_ACTIONS = [
  'test_set_player_level',
  'test_add_waifubux',
  'test_remove_waifubux',
  'test_set_energy',
  'test_grant_transporter_beacon',
  'test_revoke_transporter_beacon',
  'test_grant_travel_access',
  'test_staging_boost',
  'test_reset_assteroid_belt',
  'test_reset_equipment_onboarding',
  'test_reset_delve_usage',
] as const;
export type TestControlAction = (typeof TEST_CONTROL_ACTIONS)[number];

/** Refused because this deployment does not allow test controls. */
export class TestControlsDisabledError extends AppError {
  constructor() {
    super(
      'TEST_CONTROLS_DISABLED',
      'Staging test controls are disabled on this deployment',
      'Staging test controls are not available on this server.',
    );
  }
}

/** A request value the control will not accept (level out of range, …). */
export class TestControlsInvalidError extends AppError {
  constructor(message: string) {
    super('TEST_CONTROLS_INVALID', message, message);
  }
}

/** Who pressed the button. Never a token — identifiers only. */
export interface TestControlsActor {
  discordUserId: string;
  /** The Portal session's selected guild. */
  discordGuildId: string | null;
}

/** One field that moved (or was asked to and was already there). */
export interface TestControlChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface TestControlsPlayerState {
  playerId: number;
  discordUserId: string;
  level: number;
  xp: number;
  maxLevel: number;
  waifubux: number;
  energy: number;
  maxEnergy: number;
  currentRegion: string;
  currentRegionName: string;
  /**
   * The Belt's gate. `requiredLevel` is the gate's own level requirement, null
   * when it has none — the Beacon alone is the entitlement.
   */
  beacon: { slug: string; name: string; owned: boolean; requiredLevel: number | null } | null;
  beltComponents: { slug: string; name: string; owned: number; required: number }[];
  /** Whether a pre-beacon `player_unlocked_routes` row for the Belt exists. */
  legacyBeltRoute: boolean;
  /** Active cooldowns on encounters that award a Belt component. */
  beltEncounterCooldowns: number;
  passes: { id: string; name: string; owned: boolean }[];
  /** `requiredLevel` is null for a destination with no level requirement. */
  routes: { regionId: string; name: string; unlocked: boolean; requiredLevel: number | null }[];
  /**
   * Equipment onboarding progress, derived exactly as the game derives it.
   * Null when this deployment was built without the onboarding service.
   */
  equipmentOnboarding: {
    phase: string;
    nextStep: string | null;
    unlocked: boolean;
    starters: { slot: EquipmentSlot; definitionKey: string; granted: boolean; removed: boolean }[];
  } | null;
  /**
   * Today's Delve allowance, as the game computes it. Null when this
   * deployment was built without the dungeon allowance service.
   */
  delve: { limit: number; used: number; remaining: number; periodKey: string } | null;
}

export interface TestControlResult {
  action: TestControlAction;
  /** False when the request was a no-op (already owned, already absent, …). */
  changed: boolean;
  /** One line for the admin, e.g. "Beacon already owned — nothing to do." */
  message: string;
  changes: TestControlChange[];
  state: TestControlsPlayerState;
}

export interface TestControlsDescription {
  deploymentEnv: TestAdminControlsConfig['deploymentEnv'];
  stagingBoost: { level: number; waifubux: number };
  maxWaifubuxPerAction: number;
}

export interface StagingTestControlsService {
  /** Static facts for the Portal page header. Refuses when disallowed, like everything else. */
  describe(): TestControlsDescription;
  getState(playerId: number): Promise<TestControlsPlayerState>;
  setLevel(actor: TestControlsActor, playerId: number, level: number): Promise<TestControlResult>;
  addWaifubux(actor: TestControlsActor, playerId: number, amount: number): Promise<TestControlResult>;
  removeWaifubux(actor: TestControlsActor, playerId: number, amount: number): Promise<TestControlResult>;
  setEnergy(actor: TestControlsActor, playerId: number, energy: number): Promise<TestControlResult>;
  grantBeacon(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  revokeBeacon(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  grantStandardTravel(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  stagingBoost(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  resetAssteroidBelt(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  /**
   * Return a player to the start of the Equipment onboarding: revoke the
   * `equipment` unlock, remove the three onboarding starters (clearing them
   * from every loadout) and release their grant keys so a replay grants fresh
   * copies. Every other piece of equipment is left untouched.
   */
  resetEquipmentOnboarding(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
  /**
   * Forget the Delve runs the player has started today, restoring the full
   * daily allowance. Touches only today's usage row: runs, rewards and any
   * active run are left exactly as they are.
   */
  resetDelveUsage(actor: TestControlsActor, playerId: number): Promise<TestControlResult>;
}

export interface StagingTestControlsDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  travel: TravelService;
  progression: ProgressionService;
  getContent: () => LoadedContent;
  logger: Logger;
  /** Checked at construction and on every operation. */
  config: TestAdminControlsConfig;
  /** Equipment onboarding reset. Optional so a deployment without it still builds the rest. */
  equipment?: Pick<EquipmentService, 'findByGrantKeys' | 'adminRemove' | 'adminReleaseGrantKeys'> | undefined;
  featureUnlocks?: Pick<FeatureUnlockService, 'isUnlocked' | 'revoke'> | undefined;
  equipmentOnboarding?: Pick<EquipmentOnboardingService, 'getState'> | undefined;
  /** Daily Delve usage reset. Optional for the same reason. */
  dungeonAllowance?: Pick<DungeonAllowanceService, 'status' | 'resetUsage'> | undefined;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface StepOutcome {
  changes: TestControlChange[];
  /** Net XP moved, for the audit row's `xp_delta`. */
  xpDelta?: number;
}

function assertInt(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TestControlsInvalidError(`${label} must be a whole number from ${min} to ${max}.`);
  }
}

export function createStagingTestControlsService(
  deps: StagingTestControlsDeps,
): StagingTestControlsService {
  const { db, currency, inventory, travel, progression, logger } = deps;

  function assertAllowed(): void {
    if (!testAdminControlsAllowed(deps.config)) throw new TestControlsDisabledError();
  }
  // Lock 2 — a production process cannot construct one at all.
  assertAllowed();

  // ── content lookups ─────────────────────────────────────────────────────

  function itemName(slug: string): string {
    return deps.getContent().items.find((i) => i.slug === slug)?.name ?? slug;
  }

  /** The Belt's key item and recipe, from content. Null if the Belt is not released. */
  function beltGate(): {
    beaconSlug: string;
    beaconName: string;
    requiredLevel: number | null;
    components: { slug: string; quantity: number }[];
  } | null {
    const destination = travel.catalog().get(BELT_REGION);
    if (!destination?.keyItem) return null;
    return {
      beaconSlug: destination.keyItem.gate.keyItem,
      beaconName: destination.keyItem.name,
      requiredLevel: destination.requiredLevel,
      components: (destination.keyItem.recipe?.inputs ?? []).map((i) => ({
        slug: i.item,
        quantity: i.quantity,
      })),
    };
  }

  function requireBeltGate(): NonNullable<ReturnType<typeof beltGate>> {
    const gate = beltGate();
    if (!gate) {
      throw new TestControlsInvalidError(
        'The Assteroid Belt is not a released key-item destination in the current content.',
      );
    }
    return gate;
  }

  // ── row helpers ─────────────────────────────────────────────────────────

  /**
   * Currency row, then player row, both `FOR UPDATE`. Returns the locked
   * player and balances. Throws PlayerNotFoundError for an unknown id.
   */
  async function lockTarget(tx: Tx, playerId: number) {
    const balances = await currency.lockCurrencies(tx, playerId);
    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new PlayerNotFoundError(playerId);
    return { player, balances };
  }

  async function itemIds(executor: DbOrTx, slugs: string[]): Promise<Map<string, number>> {
    if (slugs.length === 0) return new Map();
    const rows = await executor
      .select({ id: items.id, slug: items.slug })
      .from(items)
      .where(inArray(items.slug, slugs));
    return new Map(rows.map((r) => [r.slug, r.id]));
  }

  async function quantities(
    executor: DbOrTx,
    playerId: number,
    slugs: string[],
  ): Promise<Map<string, number>> {
    if (slugs.length === 0) return new Map();
    const rows = await executor
      .select({ slug: items.slug, quantity: playerInventory.quantity })
      .from(playerInventory)
      .innerJoin(items, eq(items.id, playerInventory.itemId))
      .where(and(eq(playerInventory.playerId, playerId), inArray(items.slug, slugs)));
    return new Map(rows.map((r) => [r.slug, r.quantity]));
  }

  async function hasLegacyBeltRoute(executor: DbOrTx, playerId: number): Promise<boolean> {
    const [row] = await executor
      .select({ regionId: playerUnlockedRoutes.regionId })
      .from(playerUnlockedRoutes)
      .where(
        and(
          eq(playerUnlockedRoutes.playerId, playerId),
          eq(playerUnlockedRoutes.regionId, BELT_REGION),
        ),
      );
    return row !== undefined;
  }

  /**
   * World encounters whose choices award a Belt component. None ships today —
   * the Cracked Teleport Core moved to expeditions and the Teleporter Wreck
   * was retired (migration 0044) — but a live server keeps that disabled row,
   * and a designer may author another. Found by effect rather than by slug,
   * so whatever awards a component is what gets reset, and nothing else is.
   */
  async function componentEncounterIds(executor: DbOrTx, slugs: string[]): Promise<number[]> {
    if (slugs.length === 0) return [];
    const conditions: SQL[] = slugs.flatMap((slug) => {
      const pattern = JSON.stringify([{ type: 'give_item', slug }]);
      return [
        sql`${worldEncounterChoices.successEffectsJson} @> ${pattern}::jsonb`,
        sql`${worldEncounterChoices.failureEffectsJson} @> ${pattern}::jsonb`,
      ];
    });
    const rows = await executor
      .selectDistinct({ encounterId: worldEncounterChoices.encounterId })
      .from(worldEncounterChoices)
      .where(or(...conditions));
    return rows.map((r) => r.encounterId);
  }

  async function activeCooldownCount(
    executor: DbOrTx,
    playerId: number,
    encounterIds: number[],
  ): Promise<number> {
    if (encounterIds.length === 0) return 0;
    const [row] = await executor
      .select({ n: sql<number>`count(*)::int` })
      .from(worldEncounterCooldowns)
      .where(
        and(
          eq(worldEncounterCooldowns.playerId, playerId),
          inArray(worldEncounterCooldowns.encounterId, encounterIds),
          gt(worldEncounterCooldowns.expiresAt, sql`now()`),
        ),
      );
    return row?.n ?? 0;
  }

  async function ownedPassIds(executor: DbOrTx, playerId: number): Promise<Set<string>> {
    const rows = await executor
      .select({ passId: playerTravelPasses.passId })
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    return new Set(rows.map((r) => r.passId));
  }

  async function unlockedRouteIds(executor: DbOrTx, playerId: number): Promise<Set<string>> {
    const rows = await executor
      .select({ regionId: playerUnlockedRoutes.regionId })
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    return new Set(rows.map((r) => r.regionId));
  }

  /** Pass/route destinations — the "traditional" travel unlocks. Never key-item ones. */
  function standardDestinations() {
    return travel
      .catalog()
      .destinations.filter((d) => d.access === 'route' && d.route !== null && d.pass !== null);
  }

  // ── audit ───────────────────────────────────────────────────────────────

  async function audit(
    tx: Tx,
    input: {
      actor: TestControlsActor;
      player: PlayerRow;
      action: TestControlAction;
      changed: boolean;
      changes: TestControlChange[];
      xpDelta?: number | undefined;
      detail?: Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    const before = Object.fromEntries(input.changes.map((c) => [c.field, c.before]));
    const after = Object.fromEntries(input.changes.map((c) => [c.field, c.after]));
    const metadata = {
      action: input.action,
      source: 'portal_test_controls',
      deploymentEnv: deps.config.deploymentEnv,
      adminDiscordId: input.actor.discordUserId,
      guildId: input.actor.discordGuildId,
      targetDiscordId: input.player.discordUserId,
      changed: input.changed,
      before,
      after,
      ...(input.detail ?? {}),
    };
    await tx.insert(playerProgressionEvents).values({
      playerId: input.player.id,
      eventType: ADMIN_ACTION_EVENT,
      // The real XP movement, so the ledger still reconciles against
      // `players.xp` after a level set. Zero for every other action.
      xpDelta: input.xpDelta ?? 0,
      metadata,
    });
    logger.warn(
      { tag: 'admin/test-controls', playerId: input.player.id, ...metadata },
      'staging test control adjusted a player account',
    );
  }

  // ── steps: each runs inside a caller's locked transaction ───────────────

  async function stepSetLevel(
    tx: Tx,
    player: PlayerRow,
    energy: number,
    level: number,
  ): Promise<{ changes: TestControlChange[]; player: PlayerRow; energy: number; xpDelta: number }> {
    const maxLevel = progression.maxLevel();
    assertInt(level, 'Level', 1, maxLevel);
    if (player.level === level) return { changes: [], player, energy, xpDelta: 0 };

    // Level is stored *and* derived from XP (`levelFromXp`). Writing both from
    // the curve keeps them agreeing: the player sits at the very start of the
    // requested level, exactly where a real level-up would leave them.
    const xp = progression.cumulativeXpForLevel(level);
    const [updated] = await tx
      .update(players)
      .set({ level, xp })
      .where(eq(players.id, player.id))
      .returning();
    if (!updated) throw new PlayerNotFoundError(player.id);

    const changes: TestControlChange[] = [
      { field: 'level', before: player.level, after: level },
      { field: 'xp', before: player.xp, after: xp },
    ];
    // Lowering a level can lower max Energy. There is no legitimate over-cap
    // Energy in this game, so the tank is trimmed to the new maximum.
    let nextEnergy = energy;
    const maxEnergy = progression.computeMaxEnergy(level);
    if (energy > maxEnergy) {
      await currency.setHuntEnergy(tx, player.id, maxEnergy);
      changes.push({ field: 'energy', before: energy, after: maxEnergy });
      nextEnergy = maxEnergy;
    }
    return { changes, player: updated, energy: nextEnergy, xpDelta: xp - player.xp };
  }

  async function stepAddWaifubux(tx: Tx, playerId: number, before: number, amount: number) {
    assertInt(amount, 'Amount', 1, TEST_MAX_WAIFUBUX_PER_ACTION);
    if (before + amount > WAIFUBUX_CEILING) {
      throw new TestControlsInvalidError(
        `That would put the balance above ${WAIFUBUX_CEILING.toLocaleString('en-US')} WaifuBux.`,
      );
    }
    const row = await currency.grantWaifubux(tx, playerId, amount);
    return [{ field: 'waifubux', before, after: row.waifubux }];
  }

  async function stepSetEnergy(tx: Tx, player: PlayerRow, before: number, value: number) {
    const maxEnergy = progression.computeMaxEnergy(player.level);
    assertInt(value, 'Energy', 0, maxEnergy);
    if (before === value) return [];
    await currency.setHuntEnergy(tx, player.id, value);
    return [{ field: 'energy', before, after: value }];
  }

  async function stepGrantStandardTravel(tx: Tx, playerId: number): Promise<StepOutcome> {
    const cat = travel.catalog();
    if (!cat.enabled) throw new TestControlsInvalidError('Travel is disabled in the current content.');
    const passesBefore = await ownedPassIds(tx, playerId);
    const routesBefore = await unlockedRouteIds(tx, playerId);

    // Idempotent all the way down: both helpers insert ON CONFLICT DO NOTHING,
    // so a repeat press writes no duplicate rows. Key-item destinations are
    // excluded by `standardDestinations`, so this never grants the Beacon.
    for (const pass of cat.passes) await travel.grantPass(playerId, pass.id, tx);
    for (const destination of standardDestinations()) {
      await travel.grantRoute(playerId, destination.region.id, tx);
    }

    const passesAfter = await ownedPassIds(tx, playerId);
    const routesAfter = await unlockedRouteIds(tx, playerId);
    const newPasses = [...passesAfter].filter((p) => !passesBefore.has(p)).sort();
    const newRoutes = [...routesAfter].filter((r) => !routesBefore.has(r)).sort();
    const changes: TestControlChange[] = [];
    if (newPasses.length > 0) {
      changes.push({ field: 'passes', before: [...passesBefore].sort(), after: [...passesAfter].sort() });
    }
    if (newRoutes.length > 0) {
      changes.push({ field: 'routes', before: [...routesBefore].sort(), after: [...routesAfter].sort() });
    }
    return { changes };
  }

  // ── wrapper: lock, run, audit, then read back fresh state ───────────────

  async function run(
    actor: TestControlsActor,
    playerId: number,
    action: TestControlAction,
    body: (tx: Tx, target: Awaited<ReturnType<typeof lockTarget>>) => Promise<{
      changes: TestControlChange[];
      message: string;
      xpDelta?: number;
      detail?: Record<string, unknown>;
    }>,
  ): Promise<TestControlResult> {
    assertAllowed(); // Lock 3 — every call, before any write.
    const outcome = await db.transaction(async (tx) => {
      const target = await lockTarget(tx, playerId);
      const result = await body(tx, target);
      await audit(tx, {
        actor,
        player: target.player,
        action,
        changed: result.changes.length > 0,
        changes: result.changes,
        xpDelta: result.xpDelta,
        detail: result.detail,
      });
      return result;
    });
    return {
      action,
      changed: outcome.changes.length > 0,
      message: outcome.message,
      changes: outcome.changes,
      state: await getState(playerId),
    };
  }

  async function getState(playerId: number): Promise<TestControlsPlayerState> {
    assertAllowed();
    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    if (!player) throw new PlayerNotFoundError(playerId);
    const [balances] = await db
      .select()
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    const cat = travel.catalog();
    const gate = beltGate();
    const slugs = gate ? [gate.beaconSlug, ...gate.components.map((c) => c.slug)] : [];
    const held = await quantities(db, playerId, slugs);
    const encounterIds = gate ? await componentEncounterIds(db, gate.components.map((c) => c.slug)) : [];
    const [passIds, routeIds, legacy, cooldowns, onboarding, delve] = await Promise.all([
      ownedPassIds(db, playerId),
      unlockedRouteIds(db, playerId),
      hasLegacyBeltRoute(db, playerId),
      activeCooldownCount(db, playerId, encounterIds),
      deps.equipmentOnboarding?.getState(playerId) ?? null,
      deps.dungeonAllowance?.status(playerId) ?? null,
    ]);
    return {
      playerId: player.id,
      discordUserId: player.discordUserId,
      level: player.level,
      xp: player.xp,
      maxLevel: progression.maxLevel(),
      waifubux: balances?.waifubux ?? 0,
      energy: balances?.huntEnergy ?? 0,
      maxEnergy: progression.computeMaxEnergy(player.level),
      currentRegion: player.currentRegion,
      currentRegionName: cat.label(player.currentRegion),
      beacon: gate
        ? {
            slug: gate.beaconSlug,
            name: gate.beaconName,
            owned: (held.get(gate.beaconSlug) ?? 0) > 0,
            requiredLevel: gate.requiredLevel,
          }
        : null,
      beltComponents: (gate?.components ?? []).map((c) => ({
        slug: c.slug,
        name: itemName(c.slug),
        owned: held.get(c.slug) ?? 0,
        required: c.quantity,
      })),
      legacyBeltRoute: legacy,
      beltEncounterCooldowns: cooldowns,
      passes: cat.passes.map((p) => ({ id: p.id, name: p.name, owned: passIds.has(p.id) })),
      routes: standardDestinations().map((d) => ({
        regionId: d.region.id,
        name: d.region.name,
        unlocked: routeIds.has(d.region.id),
        requiredLevel: d.requiredLevel,
      })),
      equipmentOnboarding: onboarding
        ? {
            phase: onboarding.state.phase,
            nextStep: onboarding.state.nextStep,
            unlocked: onboarding.unlocked,
            starters: STARTER_SLOTS.map((slot) => {
              const record = onboarding.starters[slot];
              return {
                slot,
                definitionKey: record?.definition.key ?? '',
                granted: record != null,
                removed: record?.removed ?? false,
              };
            }),
          }
        : null,
      delve: delve && { limit: delve.limit, used: delve.used, remaining: delve.remaining, periodKey: delve.periodKey },
    };
  }

  return {
    describe() {
      assertAllowed();
      return {
        deploymentEnv: deps.config.deploymentEnv,
        stagingBoost: { ...STAGING_BOOST },
        maxWaifubuxPerAction: TEST_MAX_WAIFUBUX_PER_ACTION,
      };
    },

    getState,

    setLevel(actor, playerId, level) {
      return run(actor, playerId, 'test_set_player_level', async (tx, { player, balances }) => {
        const step = await stepSetLevel(tx, player, balances.huntEnergy, level);
        return {
          changes: step.changes,
          xpDelta: step.xpDelta,
          message:
            step.changes.length === 0
              ? `Already level ${level} — nothing to do.`
              : `Level ${player.level} → ${level}.`,
        };
      });
    },

    addWaifubux(actor, playerId, amount) {
      return run(actor, playerId, 'test_add_waifubux', async (tx, { player, balances }) => {
        const changes = await stepAddWaifubux(tx, player.id, balances.waifubux, amount);
        return {
          changes,
          detail: { amount },
          message: `Added ${amount.toLocaleString('en-US')} WaifuBux.`,
        };
      });
    },

    removeWaifubux(actor, playerId, amount) {
      return run(actor, playerId, 'test_remove_waifubux', async (tx, { player, balances }) => {
        assertInt(amount, 'Amount', 1, TEST_MAX_WAIFUBUX_PER_ACTION);
        // Conditional spend (`WHERE waifubux >= amount`): throws
        // InsufficientFundsError rather than ever writing a negative balance,
        // even if two removals race.
        const row = await currency.spendWaifubux(tx, player.id, amount);
        return {
          changes: [{ field: 'waifubux', before: balances.waifubux, after: row.waifubux }],
          detail: { amount },
          message: `Removed ${amount.toLocaleString('en-US')} WaifuBux.`,
        };
      });
    },

    setEnergy(actor, playerId, energy) {
      return run(actor, playerId, 'test_set_energy', async (tx, { player, balances }) => {
        const changes = await stepSetEnergy(tx, player, balances.huntEnergy, energy);
        return {
          changes,
          detail: { maxEnergy: progression.computeMaxEnergy(player.level) },
          message: changes.length === 0 ? `Energy already ${energy}.` : `Energy set to ${energy}.`,
        };
      });
    },

    grantBeacon(actor, playerId) {
      return run(actor, playerId, 'test_grant_transporter_beacon', async (tx, { player }) => {
        const gate = requireBeltGate();
        const ids = await itemIds(tx, [gate.beaconSlug]);
        const beaconId = ids.get(gate.beaconSlug);
        if (beaconId == null) {
          throw new TestControlsInvalidError(`${gate.beaconName} is not in the current item set.`);
        }
        const before = (await quantities(tx, player.id, [gate.beaconSlug])).get(gate.beaconSlug) ?? 0;
        if (before > 0) {
          return { changes: [], message: `Already owns a ${gate.beaconName} — nothing to do.` };
        }
        try {
          // `max_owned: 1` is enforced inside this upsert, so even a grant
          // that raced past the player lock cannot mint a second beacon.
          const after = await inventory.addItem(tx, player.id, beaconId, 1);
          return {
            changes: [{ field: gate.beaconSlug, before, after }],
            message: `Granted ${gate.beaconName}.`,
          };
        } catch (err) {
          if (!(err instanceof ItemOwnershipLimitError)) throw err;
          return { changes: [], message: `Already owns a ${gate.beaconName} — nothing to do.` };
        }
      });
    },

    revokeBeacon(actor, playerId) {
      return run(actor, playerId, 'test_revoke_transporter_beacon', async (tx, { player }) => {
        const gate = requireBeltGate();
        const before = (await quantities(tx, player.id, [gate.beaconSlug])).get(gate.beaconSlug) ?? 0;
        const legacy = await hasLegacyBeltRoute(tx, player.id);
        const inBelt = player.currentRegion === BELT_REGION;
        if (before === 0 && !legacy && !inBelt) {
          return { changes: [], message: `Does not own a ${gate.beaconName} — nothing to do.` };
        }
        // `revokeRoute` is the existing safe revoke for a key-item destination:
        // it takes the key, drops any leftover route row, and sends a player
        // standing in the Belt back to the starting region — one transaction.
        await travel.revokeRoute(player.id, BELT_REGION, tx);
        const changes: TestControlChange[] = [];
        if (before > 0) changes.push({ field: gate.beaconSlug, before, after: 0 });
        if (legacy) changes.push({ field: 'legacyBeltRoute', before: true, after: false });
        if (inBelt) {
          changes.push({
            field: 'currentRegion',
            before: player.currentRegion,
            after: travel.catalog().startingRegion,
          });
        }
        return {
          changes,
          message: inBelt
            ? `Revoked ${gate.beaconName} and returned the player to ${travel.catalog().label(travel.catalog().startingRegion)}.`
            : `Revoked ${gate.beaconName}.`,
        };
      });
    },

    grantStandardTravel(actor, playerId) {
      return run(actor, playerId, 'test_grant_travel_access', async (tx, { player }) => {
        const step = await stepGrantStandardTravel(tx, player.id);
        return {
          changes: step.changes,
          message:
            step.changes.length === 0
              ? 'Already holds every standard pass and route — nothing to do.'
              : 'Granted all standard passes and routes (Transporter Beacon not included).',
        };
      });
    },

    stagingBoost(actor, playerId) {
      return run(actor, playerId, 'test_staging_boost', async (tx, { player, balances }) => {
        if (STAGING_BOOST.level > progression.maxLevel()) {
          throw new TestControlsInvalidError(
            `Staging Boost targets level ${STAGING_BOOST.level}, above the level cap (${progression.maxLevel()}).`,
          );
        }
        // Order matters only for Energy: the refill targets the maximum *at*
        // the boosted level, so it runs after the level step.
        const level = await stepSetLevel(tx, player, balances.huntEnergy, STAGING_BOOST.level);
        const bux = await stepAddWaifubux(tx, player.id, balances.waifubux, STAGING_BOOST.waifubux);
        const maxEnergy = progression.computeMaxEnergy(level.player.level);
        await stepSetEnergy(tx, level.player, level.energy, maxEnergy);
        const travelStep = await stepGrantStandardTravel(tx, player.id);

        // The level step may already have trimmed Energy; report one net
        // Energy change rather than two.
        const levelChanges = level.changes.filter((c) => c.field !== 'energy');
        const energyBefore = balances.huntEnergy;
        const energyChanges: TestControlChange[] =
          energyBefore === maxEnergy ? [] : [{ field: 'energy', before: energyBefore, after: maxEnergy }];
        const changes = [...levelChanges, ...bux, ...energyChanges, ...travelStep.changes];
        return {
          changes,
          xpDelta: level.xpDelta,
          detail: {
            steps: {
              level: { target: STAGING_BOOST.level, changes: levelChanges },
              waifubux: { added: STAGING_BOOST.waifubux, changes: bux },
              energy: { target: maxEnergy, changes: energyChanges },
              travel: { changes: travelStep.changes },
            },
          },
          message: `Staging Boost applied: level ${STAGING_BOOST.level}, +${STAGING_BOOST.waifubux.toLocaleString('en-US')} WaifuBux, Energy ${maxEnergy}/${maxEnergy}, standard travel unlocked.`,
        };
      });
    },

    resetAssteroidBelt(actor, playerId) {
      return run(actor, playerId, 'test_reset_assteroid_belt', async (tx, { player }) => {
        const gate = requireBeltGate();
        const componentSlugs = gate.components.map((c) => c.slug);
        const slugs = [gate.beaconSlug, ...componentSlugs];
        const held = await quantities(tx, player.id, slugs);
        const legacy = await hasLegacyBeltRoute(tx, player.id);
        const encounterIds = await componentEncounterIds(tx, componentSlugs);
        const changes: TestControlChange[] = [];

        // 1. Out of the Belt first, so access is never revoked from under a
        //    player standing in it. `revokeRoute` below would do this too; it
        //    is explicit here so the report says so.
        const home = travel.catalog().startingRegion;
        if (player.currentRegion === BELT_REGION) {
          await tx
            .update(players)
            .set({ currentRegion: home })
            .where(and(eq(players.id, player.id), eq(players.currentRegion, BELT_REGION)));
          changes.push({ field: 'currentRegion', before: player.currentRegion, after: home });
        }

        // 2. The Beacon and any legacy route row — the existing safe revoke.
        await travel.revokeRoute(player.id, BELT_REGION, tx);
        const beaconBefore = held.get(gate.beaconSlug) ?? 0;
        if (beaconBefore > 0) changes.push({ field: gate.beaconSlug, before: beaconBefore, after: 0 });
        if (legacy) changes.push({ field: 'legacyBeltRoute', before: true, after: false });

        // 3. The recipe's components, and nothing else in the inventory.
        const componentIds = [...(await itemIds(tx, componentSlugs)).values()];
        if (componentIds.length > 0) {
          await tx
            .update(playerInventory)
            .set({ quantity: 0 })
            .where(
              and(
                eq(playerInventory.playerId, player.id),
                inArray(playerInventory.itemId, componentIds),
                gt(playerInventory.quantity, 0),
              ),
            );
        }
        for (const slug of componentSlugs) {
          const before = held.get(slug) ?? 0;
          if (before > 0) changes.push({ field: slug, before, after: 0 });
        }

        // 4. Cooldowns on the component-awarding encounters only.
        let clearedEncounters: string[] = [];
        if (encounterIds.length > 0) {
          const cleared = await tx
            .delete(worldEncounterCooldowns)
            .where(
              and(
                eq(worldEncounterCooldowns.playerId, player.id),
                inArray(worldEncounterCooldowns.encounterId, encounterIds),
              ),
            )
            .returning({ encounterId: worldEncounterCooldowns.encounterId });
          if (cleared.length > 0) {
            const rows = await tx
              .select({ slug: worldEncounters.slug })
              .from(worldEncounters)
              .where(inArray(worldEncounters.id, cleared.map((c) => c.encounterId)));
            clearedEncounters = rows.map((r) => r.slug).sort();
            changes.push({ field: 'encounterCooldowns', before: clearedEncounters, after: [] });
          }
        }

        return {
          changes,
          detail: { componentSlugs, clearedEncounters },
          message:
            changes.length === 0
              ? 'Belt unlock state was already clean — nothing to reset.'
              : 'Assteroid Belt unlock state reset. The Beacon can be built again from scratch.',
        };
      });
    },

    resetEquipmentOnboarding(actor, playerId) {
      return run(actor, playerId, 'test_reset_equipment_onboarding', async (tx, { player }) => {
        const { equipment, featureUnlocks } = deps;
        if (!equipment || !featureUnlocks) {
          throw new TestControlsInvalidError('Equipment is not available on this deployment.');
        }
        const reason = 'staging test control: reset equipment onboarding';
        const changes: TestControlChange[] = [];

        // 1. The unlock. Revoke is audited by the feature service itself, so it
        //    only runs when there is an unlock to revoke — a no-op reset writes
        //    only its own control row.
        if (await featureUnlocks.isUnlocked(player.id, 'equipment', tx)) {
          const { revoked } = await featureUnlocks.revoke(tx, {
            playerId: player.id,
            featureKey: 'equipment',
            actorDiscordId: actor.discordUserId,
            reason,
          });
          if (revoked) changes.push({ field: 'equipmentUnlocked', before: true, after: false });
        }

        // 2. The onboarding's own three instances, found by their fixed keys —
        //    never any other gear. `adminRemove` clears them from every loadout.
        const keys = STARTER_SLOTS.map((slot) => storedOnboardingGrantKey(player.id, slot));
        const starters = await equipment.findByGrantKeys(tx, player.id, keys);
        const removed: string[] = [];
        for (const record of starters.values()) {
          if (record.removed) continue;
          await equipment.adminRemove(tx, {
            playerId: player.id,
            equipmentId: record.equipmentId,
            reason,
            actorDiscordId: actor.discordUserId,
            overrideLock: true,
          });
          removed.push(record.definition.key);
        }
        if (removed.length > 0) changes.push({ field: 'onboardingStarters', before: removed.sort(), after: [] });

        // 3. Release the keys (removed instances only), so the replay's grants
        //    create fresh copies instead of finding these.
        const { released } = await equipment.adminReleaseGrantKeys(tx, {
          playerId: player.id,
          grantKeys: keys,
          actorDiscordId: actor.discordUserId,
          reason,
        });
        if (released.length > 0) {
          changes.push({ field: 'onboardingGrantKeys', before: released.map((r) => r.grantKey).sort(), after: [] });
        }

        return {
          changes,
          detail: { removedStarters: removed, releasedGrantKeys: released.map((r) => r.grantKey) },
          message:
            changes.length === 0
              ? 'Equipment onboarding was already clean — nothing to reset.'
              : 'Equipment onboarding reset. The player can replay it from the start.',
        };
      });
    },

    resetDelveUsage(actor, playerId) {
      return run(actor, playerId, 'test_reset_delve_usage', async (tx, { player }) => {
        const allowance = deps.dungeonAllowance;
        if (!allowance) throw new TestControlsInvalidError('Delve is not available on this deployment.');
        const { periodKey, cleared } = await allowance.resetUsage(tx, player.id);
        return {
          changes: cleared > 0 ? [{ field: 'delveRunsStarted', before: cleared, after: 0 }] : [],
          detail: { periodKey, cleared },
          message:
            cleared > 0
              ? `Today's Delve usage reset (${cleared} run${cleared === 1 ? '' : 's'} forgotten). The full daily allowance is available again.`
              : 'No Delve runs started today — nothing to reset.',
        };
      });
    },
  };
}
