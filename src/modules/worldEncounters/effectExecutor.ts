/**
 * Effect executor — applies a list of {@link Effect}s in the caller's
 * transaction, delegating every mutation to the domain services that already
 * own that concept.
 *
 * The executor never opens its own transaction: the encounter engine wraps
 * an entire resolution (choice → check → effects → history + cooldown) in
 * one `db.transaction()`, and any failure here rolls back everything the
 * player has been shown to earn. That is the invariant that stops a
 * double-click from paying twice: the second call sees a `resolved` row and
 * exits before the executor runs.
 *
 * "Trigger" effects (chained encounters, waifumon encounter, vendor) are
 * recorded in the applied list but not executed here — the Discord layer
 * reads the resolution and drives the follow-up flow. That keeps a
 * Discord-independent engine possible and lets non-Discord callers (admin
 * simulation) skip the follow-ups cleanly.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { items, playerCurrencies } from '../../db/schema';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionService } from '../progression/progressionService';
import type { CollectionService } from '../collection/collectionService';
import { InsufficientFundsError, InsufficientItemsError } from '../../shared/errors';
import type { Effect } from './types';

export interface EffectExecutorDeps {
  currency: CurrencyService;
  inventory: InventoryService;
  progression: ProgressionService;
  collection: CollectionService;
}

export interface EffectContext {
  playerId: number;
  /** Buddy waifu id — required for buddy_xp; effects skip if null. */
  buddyWaifuId: number | null;
  /** Encounter refId used on progression audit rows. */
  encounterId: number;
}

/**
 * A single applied effect. Emitted for every effect run, including "no-op"
 * ones (a percent loss capped to 0). The engine writes this list onto the
 * history row so the audit trail carries the concrete numbers rather than a
 * template of intent.
 */
export interface AppliedEffect {
  /** Original effect input, preserved so a caller can render it. */
  effect: Effect;
  /** True when the mutation actually altered something. */
  applied: boolean;
  /** Concrete amount actually applied, when meaningful. */
  amount?: number;
  /** Reason a soft-fail effect declined (e.g. insufficient funds on loss). */
  reason?: string;
}

/**
 * Some effects are handled at the surface layer: chained encounters need a
 * new Discord flow, and the vendor placeholder cannot open a shop from a
 * transaction. The executor tags them so the caller can pick them up.
 */
export interface FollowUp {
  kind: 'trigger_encounter' | 'trigger_waifumon_encounter' | 'open_vendor';
  payload: Record<string, unknown>;
}

export interface EffectApplication {
  applied: AppliedEffect[];
  followUps: FollowUp[];
}

export function createEffectExecutor(deps: EffectExecutorDeps) {
  const { currency, inventory, progression, collection } = deps;

  async function resolveItemId(tx: DbOrTx, slug: string): Promise<number | null> {
    const [row] = await tx
      .select({ id: items.id })
      .from(items)
      .where(eq(items.slug, slug));
    return row?.id ?? null;
  }

  /**
   * Apply the list. Returns what was applied and any surface-layer follow-ups.
   * The caller passes a locked player row context (via `tx`); currency/
   * inventory rows are locked lazily by each sub-service the same way they
   * are during a hunt.
   */
  async function apply(
    tx: DbOrTx,
    ctx: EffectContext,
    effects: readonly Effect[],
  ): Promise<EffectApplication> {
    const applied: AppliedEffect[] = [];
    const followUps: FollowUp[] = [];

    for (const effect of effects) {
      const record = (patch: Partial<AppliedEffect>): void => {
        applied.push({ effect, applied: true, ...patch });
      };

      switch (effect.type) {
        case 'waifubux_gain': {
          await currency.grantWaifubux(tx, ctx.playerId, effect.amount);
          record({ amount: effect.amount });
          break;
        }
        case 'waifubux_loss': {
          const taken = await softSpendWaifubux(tx, ctx.playerId, effect.amount);
          const capped = taken < effect.amount;
          record(capped ? { amount: taken, reason: 'capped_at_balance' } : { amount: taken });
          break;
        }
        case 'waifubux_loss_percent': {
          const [row] = await tx
            .select({ waifubux: playerCurrencies.waifubux })
            .from(playerCurrencies)
            .where(eq(playerCurrencies.playerId, ctx.playerId));
          const balance = row?.waifubux ?? 0;
          let amount = Math.floor(balance * effect.percent);
          if (effect.maxAmount != null) amount = Math.min(amount, effect.maxAmount);
          if (amount <= 0) {
            applied.push({ effect, applied: false, amount: 0, reason: 'no_balance' });
            break;
          }
          const taken = await softSpendWaifubux(tx, ctx.playerId, amount);
          record({ amount: taken });
          break;
        }
        case 'essence_gain': {
          await currency.grantEssence(tx, ctx.playerId, effect.amount);
          record({ amount: effect.amount });
          break;
        }
        case 'essence_loss': {
          const taken = await softSpendEssence(tx, ctx.playerId, effect.amount);
          const capped = taken < effect.amount;
          record(capped ? { amount: taken, reason: 'capped_at_balance' } : { amount: taken });
          break;
        }
        case 'energy_gain': {
          const [row] = await tx
            .select({ huntEnergy: playerCurrencies.huntEnergy })
            .from(playerCurrencies)
            .where(eq(playerCurrencies.playerId, ctx.playerId));
          const current = row?.huntEnergy ?? 0;
          await currency.setHuntEnergy(tx, ctx.playerId, current + effect.amount);
          record({ amount: effect.amount });
          break;
        }
        case 'energy_loss': {
          const [row] = await tx
            .select({ huntEnergy: playerCurrencies.huntEnergy })
            .from(playerCurrencies)
            .where(eq(playerCurrencies.playerId, ctx.playerId));
          const current = row?.huntEnergy ?? 0;
          const taken = Math.min(current, effect.amount);
          await currency.setHuntEnergy(tx, ctx.playerId, current - taken);
          const capped = taken < effect.amount;
          record(capped ? { amount: taken, reason: 'capped_at_zero' } : { amount: taken });
          break;
        }
        case 'player_xp': {
          if (effect.amount === 0) {
            applied.push({ effect, applied: false, amount: 0, reason: 'zero' });
            break;
          }
          await progression.grantXp(tx, ctx.playerId, {
            eventType: 'world_encounter',
            xpDelta: effect.amount,
            refId: ctx.encounterId,
            metadata: { source: 'world_encounter' },
          });
          record({ amount: effect.amount });
          break;
        }
        case 'buddy_xp': {
          if (ctx.buddyWaifuId == null || effect.amount === 0) {
            applied.push({ effect, applied: false, amount: 0, reason: 'no_buddy_or_zero' });
            break;
          }
          const result = await collection.awardWaifuXp(
            tx,
            ctx.playerId,
            ctx.buddyWaifuId,
            effect.amount,
          );
          const granted = result?.xpGranted ?? 0;
          if (result == null) {
            record({ amount: 0, reason: 'buddy_missing' });
          } else {
            record({ amount: granted });
          }
          break;
        }
        case 'give_item': {
          const itemId = await resolveItemId(tx, effect.slug);
          if (itemId == null) {
            applied.push({ effect, applied: false, reason: 'unknown_item' });
            break;
          }
          await inventory.addItem(tx, ctx.playerId, itemId, effect.quantity);
          record({ amount: effect.quantity });
          break;
        }
        case 'consume_item': {
          const itemId = await resolveItemId(tx, effect.slug);
          if (itemId == null) {
            applied.push({ effect, applied: false, reason: 'unknown_item' });
            break;
          }
          try {
            await inventory.consumeItem(tx, ctx.playerId, itemId, effect.quantity);
            record({ amount: effect.quantity });
          } catch (err) {
            if (err instanceof InsufficientItemsError) {
              applied.push({ effect, applied: false, reason: 'insufficient_items' });
            } else {
              throw err;
            }
          }
          break;
        }
        case 'trigger_encounter': {
          followUps.push({
            kind: 'trigger_encounter',
            payload: { encounterSlug: effect.encounterSlug },
          });
          record({});
          break;
        }
        case 'trigger_waifumon_encounter': {
          followUps.push({
            kind: 'trigger_waifumon_encounter',
            payload: effect.speciesSlug ? { speciesSlug: effect.speciesSlug } : {},
          });
          record({});
          break;
        }
        case 'open_vendor': {
          followUps.push({ kind: 'open_vendor', payload: { vendorKey: effect.vendorKey } });
          record({});
          break;
        }
        case 'temp_buff': {
          // Placeholder: no buff subsystem yet. Recorded so a later feature
          // can back-fill without changing this signature. The row lands in
          // history with { key, durationSeconds, payload } so nothing is lost.
          record({});
          break;
        }
      }
    }

    return { applied, followUps };
  }

  /**
   * Spend at most `amount`, clamping to the player's balance. Currency
   * losses on an encounter must never fail with an insufficient-funds error
   * (a player at 0 Waifubux still loses… nothing), which is why this bypasses
   * the strict `spendWaifubux` helper.
   */
  async function softSpendWaifubux(
    tx: DbOrTx,
    playerId: number,
    amount: number,
  ): Promise<number> {
    if (amount <= 0) return 0;
    const [row] = await tx
      .select({ waifubux: playerCurrencies.waifubux })
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    const balance = row?.waifubux ?? 0;
    const take = Math.min(balance, amount);
    if (take === 0) return 0;
    try {
      await currency.spendWaifubux(tx, playerId, take);
    } catch (err) {
      if (err instanceof InsufficientFundsError) return 0;
      throw err;
    }
    return take;
  }

  async function softSpendEssence(
    tx: DbOrTx,
    playerId: number,
    amount: number,
  ): Promise<number> {
    if (amount <= 0) return 0;
    const [row] = await tx
      .select({ essence: playerCurrencies.essence })
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    const balance = row?.essence ?? 0;
    const take = Math.min(balance, amount);
    if (take === 0) return 0;
    try {
      await currency.spendEssence(tx, playerId, take);
    } catch (err) {
      if (err instanceof InsufficientFundsError) return 0;
      throw err;
    }
    return take;
  }

  return { apply };
}

export type EffectExecutor = ReturnType<typeof createEffectExecutor>;
