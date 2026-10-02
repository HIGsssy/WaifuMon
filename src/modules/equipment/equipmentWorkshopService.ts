/**
 * Patch's Workshop — the Equipment economy loop, for every surface.
 *
 *   find gear → keep the good rolls → dismantle the rest with Patch
 *     → Salvaged Components → spend Components + WaifuBux
 *     → Patch fabricates a new randomized piece
 *
 * One neutral application service. Discord and the Portal both call it and
 * neither contains a cost, a yield or a rule: the read models here carry
 * everything a screen shows, and every action is decided here.
 *
 * ## What it owns, and what it delegates
 *
 *  - Configuration: salvage yields and recipes, from deployed content
 *    (`workshopConfig.ts`), read live.
 *  - Dismantling: the checks and the soft-removal are
 *    `equipmentService.dismantle` (the only writer of owned gear); this
 *    service credits the Components in the same transaction.
 *  - Fabrication: the instance comes from the shared random-reward path —
 *    `equipmentRewards.grantRandomEquipmentReward` with a `{ rarity, slot? }`
 *    selector, so the base definition is uniform among eligible definitions
 *    and the multiplier and affix are the normal roll. Nothing here rolls.
 *  - Balances: `currencyService` — conditional spends, `>= 0` CHECKs.
 *  - The `equipment_workshop_operations` row: idempotency and audit, written
 *    here and nowhere else (`equipmentBoundary.test.ts`).
 *
 * ## Gate
 *
 * Every read and every action requires the permanent `equipment` unlock. The
 * onboarding (which grants it) never goes through here.
 *
 * ## Transactions
 *
 * Each action is one transaction, serialised per player by a `FOR UPDATE` lock
 * on the player row (the Combat Trials pattern), then:
 *
 *   1. unlock check;
 *   2. idempotency — an operation with this `requestKey` exists → return what
 *      it did (`replayed: true`); a key reused for a different request is a
 *      `WorkshopRequestConflictError`;
 *   3. validation and every check that can refuse — before anything moves;
 *   4. the writes; 5. the operation row.
 *
 * Any failure rolls back everything: no gear is destroyed, no balance moves,
 * nothing is granted. Lock order is player → loadouts → instances →
 * currencies, compatible with equip (loadout → instance), admin removal and
 * Combat Trials (player → currencies).
 */
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { RARITIES, equipmentWorkshopOperations, players, type EquipmentWorkshopOperationRow } from '../../db/schema';
import {
  EquipmentDismantleRefusedError,
  FeatureLockedError,
  InsufficientComponentsError,
  InsufficientFundsError,
  PlayerNotFoundError,
  WorkshopNoEligibleEquipmentError,
  WorkshopPreviewStaleError,
  WorkshopRecipeUnavailableError,
  WorkshopRequestConflictError,
  type DismantleProblemReason,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import { affixPoolOf, type EquipmentAffixCatalogue } from './affixCatalogue';
import { listRewardableDefinitions, type EquipmentRewardService } from './equipmentRewardService';
import type { EquipmentInstanceView } from './equipmentQueries';
import { equipmentDisplayName } from './equipmentRoll';
import type { DismantleCopy, EquipmentService } from './equipmentService';
import { paginate, type Page } from './gearBag';
import {
  eligibleRewardDefinitions,
  equipmentSelectorIssues,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from './rewardSelector';
import {
  salvageYieldList,
  salvageYieldOf,
  type WorkshopConfig,
  type WorkshopRecipe,
} from './workshopConfig';
import {
  WORKSHOP_SLOT_CHOICES,
  isWorkshopSlotChoice,
  type EquipmentSlot,
  type WorkshopSlotChoice,
} from './vocabulary';

/** The feature the Workshop belongs to. */
const WORKSHOP_FEATURE = 'equipment' as const;

/**
 * A caller's idempotency key: one per confirmation (a rendered Discord button,
 * a Portal dialog). Opaque to this service; bounded and plain so it is safe to
 * store and to embed in a grant key.
 */
export const WORKSHOP_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,100}$/;

/** Discord's dismantle list page size — fits one select menu and one custom id. */
export const DISMANTLE_PAGE_SIZE = 10;

/** Most owned copies the Discord dismantle list reads. A safety bound, not a limit players meet. */
const DISMANTLE_LIST_MAX = 2_000;

// ── Read models ────────────────────────────────────────────────────────────

export interface WorkshopBalances {
  components: number;
  waifubux: number;
}

export interface WorkshopSlotAvailability {
  choice: WorkshopSlotChoice;
  /** Enabled base definitions this recipe could make for the choice. */
  eligibleCount: number;
  /** False when nothing can be made for it: the action is refused before any charge. */
  available: boolean;
}

export interface WorkshopRecipeView {
  key: string;
  name: string;
  description: string | null;
  rarity: string;
  componentCost: number;
  waifubuxCost: number;
  /** Attack, Defense, Health, Any — always all four, in that order. */
  slots: WorkshopSlotAvailability[];
  /** At least one slot choice is available. */
  available: boolean;
  /** How far short the player is right now; zeros when affordable. */
  shortfall: WorkshopBalances;
  affordable: boolean;
}

export interface WorkshopOverview {
  balances: WorkshopBalances;
  /** Salvageable rarities in ladder order. */
  salvageYields: { rarity: string; components: number }[];
  /** Enabled recipes, in content order. */
  recipes: WorkshopRecipeView[];
}

/** Why a copy cannot be dismantled right now, or null when it can. */
export type DismantleBlocker = Exclude<DismantleProblemReason, 'not_owned' | 'duplicate'>;

export interface DismantleCandidate {
  item: EquipmentInstanceView;
  /** What dismantling it would pay; null for an unsalvageable rarity. */
  components: number | null;
  blockedBy: DismantleBlocker | null;
}

export interface DismantleRarityLine {
  rarity: string;
  count: number;
  components: number;
}

/** One dismantled (or to-be-dismantled) copy, as a summary shows it. No keys. */
export interface DismantleLine {
  equipmentId: number;
  displayName: string;
  rarity: string;
  slot: EquipmentSlot;
  rolledMultiplierBp: number;
  components: number;
}

export interface DismantlePreview {
  count: number;
  byRarity: DismantleRarityLine[];
  totalComponents: number;
  items: DismantleLine[];
  balances: WorkshopBalances;
  /** Components after the dismantle. */
  componentsAfter: number;
}

export interface DismantleOutcome {
  /** True when this request key had already been applied: nothing new happened. */
  replayed: boolean;
  count: number;
  byRarity: DismantleRarityLine[];
  totalComponents: number;
  items: DismantleLine[];
  balances: WorkshopBalances;
}

export interface FabricatedItem {
  equipmentId: number;
  /** Base name plus affix suffix. */
  displayName: string;
  name: string;
  slot: EquipmentSlot;
  rarity: string;
  rolledMultiplierBp: number;
  /** The affix's display text ("of Poor Planning"), never its key. */
  affixSuffix: string | null;
}

export interface FabricationOutcome {
  replayed: boolean;
  recipe: { key: string; name: string; rarity: string };
  slotChoice: WorkshopSlotChoice;
  cost: { components: number; waifubux: number };
  item: FabricatedItem;
  balances: WorkshopBalances;
}

export interface DismantleRequest {
  equipmentIds: readonly number[];
  requestKey: string;
  /**
   * The total the player reviewed. When given and the batch would now pay
   * anything else (the yields were retuned in between), nothing happens.
   */
  expectedComponents?: number | null;
  actorDiscordId?: string | null;
}

export interface FabricationRequest {
  recipeKey: string;
  slot: WorkshopSlotChoice;
  requestKey: string;
  actorDiscordId?: string | null;
}

export interface EquipmentWorkshopService {
  /** Whether the Workshop is open to this player (the `equipment` unlock). Never throws. */
  isAvailable(playerId: number): Promise<boolean>;
  overview(playerId: number): Promise<WorkshopOverview>;
  /** One page of the player's gear with dismantle eligibility — Discord's selection list. */
  dismantleCandidates(playerId: number, page: number, pageSize?: number): Promise<Page<DismantleCandidate>>;
  /** What a dismantle would do. Throws `EquipmentDismantleRefusedError` exactly when `dismantle` would. */
  previewDismantle(playerId: number, equipmentIds: readonly number[]): Promise<DismantlePreview>;
  dismantle(playerId: number, request: DismantleRequest): Promise<DismantleOutcome>;
  fabricate(playerId: number, request: FabricationRequest): Promise<FabricationOutcome>;
  /** Components a copy of this rarity dismantles for; null when it cannot be. Pure config read. */
  salvageValue(rarity: string): number | null;
}

export interface EquipmentWorkshopDeps {
  db: Db;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  equipment: Pick<EquipmentService, 'assessDismantle' | 'dismantle' | 'findByGrantKeys' | 'listEquipment'>;
  equipmentRewards: Pick<EquipmentRewardService, 'grantRandomEquipmentReward'>;
  currency: Pick<
    CurrencyService,
    'getBalances' | 'lockCurrencies' | 'grantSalvagedComponents' | 'spendSalvagedComponents' | 'spendWaifubux'
  >;
  getAffixes(): EquipmentAffixCatalogue;
  /** The live Workshop configuration; null when content ships none. */
  getConfig(): WorkshopConfig | null;
}

// ── Pure rules ─────────────────────────────────────────────────────────────

/**
 * Why this copy cannot be dismantled, or null. The same order
 * `equipmentService.dismantle` checks in, so a list and a refusal never
 * disagree. Exported for the Portal's Gear Bag projection.
 */
export function dismantleBlocker(
  item: Pick<EquipmentInstanceView, 'equipped' | 'isFavorite' | 'isLocked'> & { definition: { rarity: string } },
  config: WorkshopConfig | null,
): DismantleBlocker | null {
  if (item.equipped) return 'equipped';
  if (item.isFavorite) return 'favorite';
  if (item.isLocked) return 'locked';
  if (salvageYieldOf(config, item.definition.rarity) == null) return 'unsupported_rarity';
  return null;
}

/** `{ rarity, slot? }` — the selector a fabrication hands the shared reward path. */
export function fabricationSelector(rarity: string, choice: WorkshopSlotChoice): EquipmentRewardSelector {
  return (choice === 'any' ? { rarity } : { rarity, slot: choice }) as EquipmentRewardSelector;
}

/**
 * The definitions a fabrication of `rarity` / `choice` could make — exactly
 * what the reward path would draw from — or empty when it could make nothing,
 * including when any eligible definition's affix pool has no enabled affix
 * (the random roll would refuse it, so the choice is honestly unavailable).
 */
export function fabricationPool(
  rarity: string,
  choice: WorkshopSlotChoice,
  definitions: readonly RewardableDefinition[],
  affixes: EquipmentAffixCatalogue,
): RewardableDefinition[] {
  const selector = fabricationSelector(rarity, choice);
  if (equipmentSelectorIssues(selector, definitions).length > 0) return [];
  const pool = eligibleRewardDefinitions(selector, definitions);
  return pool.every((d) => affixes.rollable(affixPoolOf(d)).length > 0) ? pool : [];
}

function summarise(copies: readonly DismantleCopy[]): { byRarity: DismantleRarityLine[]; items: DismantleLine[] } {
  const counts = new Map<string, DismantleRarityLine>();
  for (const c of copies) {
    const line = counts.get(c.definition.rarity) ?? { rarity: c.definition.rarity, count: 0, components: 0 };
    line.count += 1;
    line.components += c.components;
    counts.set(c.definition.rarity, line);
  }
  const byRarity = RARITIES.flatMap((r) => (counts.has(r) ? [counts.get(r)!] : []));
  const items = copies.map((c) => ({
    equipmentId: c.equipmentId,
    displayName: c.displayName,
    rarity: c.definition.rarity,
    slot: c.slot,
    rolledMultiplierBp: c.rolledMultiplierBp,
    components: c.components,
  }));
  return { byRarity, items };
}

const rarityRank = (rarity: string) => (RARITIES as readonly string[]).indexOf(rarity);

/** The grant key a fabrication's instance is stored under (copy `:0`). Player-scoped: grant keys are global. */
export function fabricationGrantKey(playerId: number, requestKey: string): string {
  return `workshop:${playerId}:${requestKey}`;
}

// ── Service ────────────────────────────────────────────────────────────────

export function createEquipmentWorkshopService(deps: EquipmentWorkshopDeps): EquipmentWorkshopService {
  const { db } = deps;

  async function requireUnlocked(playerId: number, tx: DbOrTx = db): Promise<void> {
    if (!(await deps.featureUnlocks.isUnlocked(playerId, WORKSHOP_FEATURE, tx))) {
      throw new FeatureLockedError(WORKSHOP_FEATURE);
    }
  }

  function assertRequestKey(requestKey: unknown): asserts requestKey is string {
    if (typeof requestKey !== 'string' || !WORKSHOP_REQUEST_KEY_PATTERN.test(requestKey)) {
      throw new RangeError('A Workshop action needs a request key of 8–100 plain characters');
    }
  }

  async function lockPlayer(tx: DbOrTx, playerId: number): Promise<void> {
    const [row] = await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId)).for('update');
    if (!row) throw new PlayerNotFoundError(playerId);
  }

  async function findOperation(
    tx: DbOrTx,
    playerId: number,
    requestKey: string,
  ): Promise<EquipmentWorkshopOperationRow | null> {
    const [row] = await tx
      .select()
      .from(equipmentWorkshopOperations)
      .where(and(eq(equipmentWorkshopOperations.playerId, playerId), eq(equipmentWorkshopOperations.requestKey, requestKey)));
    return row ?? null;
  }

  function enabledRecipes(): WorkshopRecipe[] {
    return (deps.getConfig()?.recipes ?? []).filter((r) => r.enabled);
  }

  const yieldOf = (rarity: string) => salvageYieldOf(deps.getConfig(), rarity);

  function balancesOf(row: { salvagedComponents: number; waifubux: number }): WorkshopBalances {
    return { components: row.salvagedComponents, waifubux: row.waifubux };
  }

  function dismantleFingerprint(ids: readonly number[]): string {
    return `dismantle:${[...ids].sort((a, b) => a - b).join(',')}`;
  }

  function fabricationFingerprint(recipeKey: string, slot: string): string {
    return `fabricate:${recipeKey}:${slot}`;
  }

  async function fabricatedItem(tx: DbOrTx, playerId: number, row: EquipmentWorkshopOperationRow): Promise<FabricatedItem> {
    const stored = `${fabricationGrantKey(playerId, row.requestKey)}:0`;
    const record = (await deps.equipment.findByGrantKeys(tx, playerId, [stored])).get(stored);
    if (!record) throw new Error(`workshop operation ${row.id} names no fabricated instance`);
    const affixes = deps.getAffixes();
    const affix = record.affixKey ? affixes.resolveOwned(record.affixKey) : undefined;
    return {
      equipmentId: record.equipmentId,
      displayName: equipmentDisplayName(record.definition.name, record.affixKey, affixes),
      name: record.definition.name,
      slot: record.slot,
      rarity: record.definition.rarity,
      rolledMultiplierBp: record.rolledMultiplierBp,
      affixSuffix: affix?.suffix ?? null,
    };
  }

  return {
    async isAvailable(playerId) {
      return deps.featureUnlocks.isUnlocked(playerId, WORKSHOP_FEATURE);
    },

    salvageValue: yieldOf,

    async overview(playerId) {
      await requireUnlocked(playerId);
      const [currencies, definitions] = await Promise.all([
        deps.currency.getBalances(playerId),
        listRewardableDefinitions(db),
      ]);
      const balances = balancesOf(currencies);
      const affixes = deps.getAffixes();
      const recipes = enabledRecipes().map((recipe): WorkshopRecipeView => {
        const slots = WORKSHOP_SLOT_CHOICES.map((choice) => {
          const eligibleCount = fabricationPool(recipe.rarity, choice, definitions, affixes).length;
          return { choice, eligibleCount, available: eligibleCount > 0 };
        });
        const shortfall = {
          components: Math.max(0, recipe.componentCost - balances.components),
          waifubux: Math.max(0, recipe.waifubuxCost - balances.waifubux),
        };
        return {
          key: recipe.key,
          name: recipe.name,
          description: recipe.description ?? null,
          rarity: recipe.rarity,
          componentCost: recipe.componentCost,
          waifubuxCost: recipe.waifubuxCost,
          slots,
          available: slots.some((s) => s.available),
          shortfall,
          affordable: shortfall.components === 0 && shortfall.waifubux === 0,
        };
      });
      return { balances, salvageYields: salvageYieldList(deps.getConfig()), recipes };
    },

    async dismantleCandidates(playerId, page, pageSize = DISMANTLE_PAGE_SIZE) {
      await requireUnlocked(playerId);
      const owned: EquipmentInstanceView[] = [];
      let cursor: string | null = null;
      do {
        const next = await deps.equipment.listEquipment(playerId, { sort: 'oldest', cursor, limit: 100 });
        owned.push(...next.items);
        cursor = next.nextCursor;
      } while (cursor && owned.length < DISMANTLE_LIST_MAX);
      const config = deps.getConfig();
      // Cheapest to lose first: lowest rarity, then the weakest roll.
      owned.sort(
        (a, b) =>
          rarityRank(a.definition.rarity) - rarityRank(b.definition.rarity) ||
          a.rolledMultiplierBp - b.rolledMultiplierBp ||
          a.id - b.id,
      );
      return paginate(
        owned.map((item) => ({
          item,
          components: salvageYieldOf(config, item.definition.rarity),
          blockedBy: dismantleBlocker(item, config),
        })),
        page,
        pageSize,
      );
    },

    async previewDismantle(playerId, equipmentIds) {
      await requireUnlocked(playerId);
      const assessment = await deps.equipment.assessDismantle(db, { playerId, equipmentIds, yieldOf });
      if (assessment.problems.length > 0) throw new EquipmentDismantleRefusedError(assessment.problems);
      const balances = balancesOf(await deps.currency.getBalances(playerId));
      const { byRarity, items } = summarise(assessment.copies);
      return {
        count: items.length,
        byRarity,
        totalComponents: assessment.totalComponents,
        items,
        balances,
        componentsAfter: balances.components + assessment.totalComponents,
      };
    },

    async dismantle(playerId, request) {
      assertRequestKey(request.requestKey);
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        await lockPlayer(tx, playerId);

        const fingerprint = dismantleFingerprint(request.equipmentIds ?? []);
        const existing = await findOperation(tx, playerId, request.requestKey);
        if (existing) {
          if (existing.kind !== 'dismantle' || existing.fingerprint !== fingerprint) {
            throw new WorkshopRequestConflictError(request.requestKey);
          }
          const meta = existing.metadata as { byRarity?: DismantleRarityLine[]; items?: DismantleLine[] };
          return {
            replayed: true,
            count: existing.equipmentIds.length,
            byRarity: meta.byRarity ?? [],
            totalComponents: existing.componentsDelta,
            items: meta.items ?? [],
            balances: balancesOf(await deps.currency.lockCurrencies(tx, playerId)),
          };
        }

        const result = await deps.equipment.dismantle(tx, {
          playerId,
          equipmentIds: request.equipmentIds,
          yieldOf,
          actorDiscordId: request.actorDiscordId ?? null,
          metadata: { source: 'workshop', requestKey: request.requestKey },
        });
        if (request.expectedComponents != null && request.expectedComponents !== result.totalComponents) {
          // Throwing rolls the soft-removal back: nothing is destroyed.
          throw new WorkshopPreviewStaleError(request.expectedComponents, result.totalComponents);
        }
        const after = await deps.currency.grantSalvagedComponents(tx, playerId, result.totalComponents);
        const { byRarity, items } = summarise(result.copies);
        await tx.insert(equipmentWorkshopOperations).values({
          playerId,
          requestKey: request.requestKey,
          kind: 'dismantle',
          fingerprint,
          componentsDelta: result.totalComponents,
          waifubuxDelta: 0,
          componentsAfter: after.salvagedComponents,
          waifubuxAfter: after.waifubux,
          equipmentIds: items.map((i) => i.equipmentId),
          metadata: { byRarity, items },
        });
        return {
          replayed: false,
          count: items.length,
          byRarity,
          totalComponents: result.totalComponents,
          items,
          balances: balancesOf(after),
        };
      });
    },

    async fabricate(playerId, request) {
      assertRequestKey(request.requestKey);
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        await lockPlayer(tx, playerId);

        const fingerprint = fabricationFingerprint(String(request.recipeKey), String(request.slot));
        const existing = await findOperation(tx, playerId, request.requestKey);
        if (existing) {
          if (existing.kind !== 'fabricate' || existing.fingerprint !== fingerprint) {
            throw new WorkshopRequestConflictError(request.requestKey);
          }
          const meta = existing.metadata as { recipeName?: string };
          return {
            replayed: true,
            recipe: {
              key: existing.recipeKey!,
              name: meta.recipeName ?? existing.recipeKey!,
              rarity: existing.rarity ?? '',
            },
            slotChoice: existing.slotChoice as WorkshopSlotChoice,
            cost: { components: -existing.componentsDelta, waifubux: -existing.waifubuxDelta },
            item: await fabricatedItem(tx, playerId, existing),
            balances: balancesOf(await deps.currency.lockCurrencies(tx, playerId)),
          };
        }

        const recipe = enabledRecipes().find((r) => r.key === request.recipeKey);
        if (!recipe) throw new WorkshopRecipeUnavailableError(request.recipeKey);
        if (!isWorkshopSlotChoice(request.slot)) throw new WorkshopNoEligibleEquipmentError(recipe.rarity, String(request.slot));
        const pool = fabricationPool(recipe.rarity, request.slot, await listRewardableDefinitions(tx), deps.getAffixes());
        if (pool.length === 0) throw new WorkshopNoEligibleEquipmentError(recipe.rarity, request.slot);

        // Both balances checked before either moves, so the refusal names the
        // one that is short. The spends below are conditional regardless.
        const current = await deps.currency.lockCurrencies(tx, playerId);
        if (current.salvagedComponents < recipe.componentCost) {
          throw new InsufficientComponentsError(recipe.componentCost, current.salvagedComponents);
        }
        if (current.waifubux < recipe.waifubuxCost) {
          throw new InsufficientFundsError(recipe.waifubuxCost, current.waifubux);
        }
        let after = await deps.currency.spendSalvagedComponents(tx, playerId, recipe.componentCost);
        if (recipe.waifubuxCost > 0) after = await deps.currency.spendWaifubux(tx, playerId, recipe.waifubuxCost);

        const grant = await deps.equipmentRewards.grantRandomEquipmentReward(tx, {
          playerId,
          selector: fabricationSelector(recipe.rarity, request.slot),
          source: { type: 'fabrication', key: recipe.key },
          grantKey: fabricationGrantKey(playerId, request.requestKey),
          actorDiscordId: request.actorDiscordId ?? null,
        });
        if (grant.alreadyGranted) {
          // The grant key is derived from this request key, which had no
          // operation row: only a hand-made grant could collide. Refuse.
          throw new WorkshopRequestConflictError(request.requestKey);
        }

        const [row] = await tx
          .insert(equipmentWorkshopOperations)
          .values({
            playerId,
            requestKey: request.requestKey,
            kind: 'fabricate',
            fingerprint,
            recipeKey: recipe.key,
            rarity: recipe.rarity,
            slotChoice: request.slot,
            componentsDelta: -recipe.componentCost,
            waifubuxDelta: -recipe.waifubuxCost,
            componentsAfter: after.salvagedComponents,
            waifubuxAfter: after.waifubux,
            equipmentIds: [grant.equipmentId],
            // Audit only — the instance row is authoritative.
            metadata: {
              recipeName: recipe.name,
              definitionKey: grant.definitionKey,
              eligibleDefinitions: pool.length,
              rolledMultiplierBp: grant.rolledMultiplierBp,
              affixKey: grant.affixKey,
            },
          })
          .returning();

        return {
          replayed: false,
          recipe: { key: recipe.key, name: recipe.name, rarity: recipe.rarity },
          slotChoice: request.slot,
          cost: { components: recipe.componentCost, waifubux: recipe.waifubuxCost },
          item: await fabricatedItem(tx, playerId, row!),
          balances: balancesOf(after),
        };
      });
    },
  };
}
