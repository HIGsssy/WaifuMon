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
import {
  createEssenceAwardService,
  type EssenceAwardService,
} from '../currency/essenceAwardService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionService } from '../progression/progressionService';
import type { CollectionService } from '../collection/collectionService';
import { InsufficientFundsError, InsufficientItemsError } from '../../shared/errors';
import type { AppliedBuddyBonus } from '../buddyBonus/buddyBonusEffects';
import type { Effect } from './types';

export interface EffectExecutorDeps {
  currency: CurrencyService;
  inventory: InventoryService;
  progression: ProgressionService;
  collection: CollectionService;
  /**
   * The shared gameplay Essence award path, so an `essence_gain` effect pays
   * the same `essence_gain` Buddy Bonus a hunt find and a duplicate conversion
   * do. Optional only so hand-built unit fixtures keep working: when omitted
   * one is constructed from `currency`, which yields an unbonused award —
   * identical to the behaviour those fixtures already assert.
   */
  essenceAward?: EssenceAwardService | undefined;
}

export interface EffectContext {
  playerId: number;
  /** Buddy waifu id — required for buddy_xp; effects skip if null. */
  buddyWaifuId: number | null;
  /**
   * Species name of the active Buddy, for the audit row's own readability.
   * A nickname on the copy wins over it — see the `affection_gain` handler.
   * Null when there is no Buddy, which is also when nothing reads it.
   */
  buddySpeciesName: string | null;
  /** Encounter refId used on progression audit rows. */
  encounterId: number;
}

/**
 * A single applied effect. Emitted for every effect run, including "no-op"
 * ones (a percent loss capped to 0). The engine writes this list onto the
 * history row so the audit trail carries the concrete numbers rather than a
 * template of intent.
 */
/**
 * What an `affection_gain` effect actually paid, carried on the applied entry.
 *
 * Exists because the award is the one effect whose *reported* number can
 * differ from its authored one: the `affection_gain` Buddy Bonus scales it.
 * Every figure here comes straight off the `BuddyAwardResult` that
 * `awardBuddyAffection` returned, so the presentation layer prints values the
 * domain computed rather than re-deriving a percentage — which is exactly the
 * duplication this whole shape exists to prevent.
 *
 * It is persisted with the rest of `effects_applied_json`, so the history row
 * records who was paid and why the number was what it was.
 */
export interface AppliedAffectionDetail {
  /** The copy that received it. */
  waifuId: number;
  /** Her nickname, else her species name — resolved once, here. */
  waifuName: string;
  /** The authored award, before any bonus. */
  baseAmount: number;
  /** What actually landed. Equal to `baseAmount` when no bonus applied. */
  finalAmount: number;
  /** Her Affection after the award. */
  affectionAfter: number;
  /** Set only when the bonus actually raised the award. */
  bonus: AppliedBuddyBonus | null;
}

/**
 * What an `essence_gain` effect actually paid.
 *
 * The Essence twin of {@link AppliedAffectionDetail}, and it exists for the
 * same reason: the `essence_gain` Buddy Bonus means the number a player
 * receives can differ from the number an author wrote, and a result screen
 * must be able to say so without recomputing a percentage. Every figure comes
 * straight off the `EssenceAwardResult` that `awardEssence` returned.
 *
 * Persisted with the rest of `effects_applied_json`, so the history row
 * records the authored award, what landed, and why they differ.
 */
export interface AppliedEssenceDetail {
  /** The authored award, before any bonus. */
  baseAmount: number;
  /** What actually landed. Equal to `baseAmount` when no bonus applied. */
  finalAmount: number;
  /** The player's Essence balance after the grant. */
  essenceAfter: number;
  /** Set only when the bonus actually raised the award. */
  bonus: AppliedBuddyBonus | null;
}

/**
 * What a `buddy_xp` effect actually paid, and to whom.
 *
 * Same contract as its Essence and Affection siblings — the `buddy_xp_gain`
 * Buddy Bonus scales the authored amount, so the applied entry carries base,
 * final and the bonus rather than leaving a presenter to work it out.
 */
export interface AppliedBuddyXpDetail {
  /** The copy that received it — the Buddy equipped at resolution time. */
  waifuId: number;
  /** Her nickname, else her species name — resolved once, here. */
  waifuName: string;
  /** The authored award, before any bonus. */
  baseAmount: number;
  /** What actually landed. Equal to `baseAmount` when no bonus applied. */
  finalAmount: number;
  /** Set only when the bonus actually raised the award. */
  bonus: AppliedBuddyBonus | null;
}

export interface AppliedEffect {
  /** Original effect input, preserved so a caller can render it. */
  effect: Effect;
  /** True when the mutation actually altered something. */
  applied: boolean;
  /** Concrete amount actually applied, when meaningful. */
  amount?: number;
  /** Reason a soft-fail effect declined (e.g. insufficient funds on loss). */
  reason?: string;
  /** Present only on an applied `affection_gain`. */
  affection?: AppliedAffectionDetail;
  /** Present only on an applied `essence_gain`. */
  essence?: AppliedEssenceDetail;
  /** Present only on an applied `buddy_xp`. */
  buddyXp?: AppliedBuddyXpDetail;
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
  const essenceAward = deps.essenceAward ?? createEssenceAwardService({ currency });

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
          // Delegated wholesale, the same way `affection_gain` below is:
          // `awardEssence` resolves the Buddy, applies `essence_gain` and
          // writes the balance. This handler contributes no arithmetic, which
          // is the point — an encounter payout and a hunt find must be the
          // same award.
          const award = await essenceAward.awardEssence(tx, ctx.playerId, effect.amount);
          record({
            // `amount` stays what actually landed, which is what every
            // existing reader of the applied list already expects.
            amount: award.essenceGranted,
            essence: {
              baseAmount: award.baseAmount,
              finalAmount: award.essenceGranted,
              essenceAfter: award.essenceAfter,
              bonus: award.bonus,
            },
          });
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
          // `awardBuddyXp`, not `awardWaifuXp`: this award is aimed at the
          // *live* Buddy, which is exactly the population `buddy_xp_gain` is
          // defined over. `awardWaifuXp` names a specific copy and stays
          // bonus-free for the Boss Encounter case, which pays a snapshotted
          // participant already scaled by `boss_reward_gain`.
          //
          // The `ctx.buddyWaifuId != null` guard above is kept as-is so the
          // `no_buddy_or_zero` reason string on the history row is unchanged;
          // `awardBuddyXp` re-resolves the Buddy itself and returns null if
          // she was released in between, which is the `buddy_missing` branch.
          const result = await collection.awardBuddyXp(tx, ctx.playerId, effect.amount);
          const granted = result?.xpGranted ?? 0;
          if (result == null) {
            record({ amount: 0, reason: 'buddy_missing' });
          } else {
            record({
              amount: granted,
              buddyXp: {
                waifuId: result.waifu.id,
                // Same resolution the `affection_gain` handler uses: the
                // nickname is on the row the award returned, the species name
                // is context the caller already holds.
                waifuName:
                  result.waifu.nickname?.trim() || ctx.buddySpeciesName || 'Your Buddy',
                baseAmount: effect.amount,
                finalAmount: granted,
                bonus: result.xpBonus,
              },
            });
          }
          break;
        }
        case 'affection_gain': {
          // Delegated wholesale. `awardBuddyAffection` resolves the Buddy,
          // applies the `affection_gain` Buddy Bonus and writes the row; this
          // handler contributes no arithmetic of its own, which is the point —
          // an encounter award and an item award must be the same award.
          const result = await collection.awardBuddyAffection(
            tx,
            ctx.playerId,
            effect.amount,
          );

          // No Buddy: skip, do not fail.
          //
          // This is the deliberate difference from the `buddy_affection_gain`
          // *item*, which refuses so the item is not spent for nothing. An
          // encounter has already been resolved by the time effects run — the
          // check was rolled, the outcome was decided, and the other effects
          // on this choice are legitimately earned. Throwing here would roll
          // the whole resolution back and turn "you have no Buddy" into "your
          // encounter failed", which is a worse answer to a smaller problem.
          //
          // Recorded as `applied: false` with a reason rather than dropped, so
          // the history row still shows the effect fired and why it paid
          // nothing. Same shape `buddy_xp` uses above.
          if (result == null) {
            applied.push({ effect, applied: false, amount: 0, reason: 'no_buddy' });
            break;
          }

          record({
            amount: result.affectionGranted,
            affection: {
              waifuId: result.waifu.id,
              // The nickname is on the row the award returned; the species
              // name is context the caller already resolved. Neither is looked
              // up again here.
              waifuName:
                result.waifu.nickname?.trim() || ctx.buddySpeciesName || 'Your Buddy',
              baseAmount: effect.amount,
              finalAmount: result.affectionGranted,
              affectionAfter: result.waifu.affection,
              bonus: result.affectionBonus,
            },
          });
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
