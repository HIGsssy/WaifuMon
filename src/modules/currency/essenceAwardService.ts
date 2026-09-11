/**
 * EssenceAwardService — the one gameplay path for awarding Essence.
 *
 * `currency.grantEssence` is a raw balance mutation and stays that way: admin
 * grants, compensation, migrations and refunds all need to move an exact
 * number of Essence, and a currency primitive that silently paid 30% more
 * than it was asked for would make every one of those unauditable. This
 * service is the layer above it, and it is where the `essence_gain` Buddy
 * Bonus lives.
 *
 * The rule the codebase now follows: **a reward calls `awardEssence`, a system
 * operation calls `currency.grantEssence`.** Anything a player earned by
 * playing goes through here — a hunt find, a duplicate conversion, a World
 * Encounter payout, a Daily Quest reward — so a new reward path is bonused by
 * construction rather than by whoever wrote it remembering to multiply.
 *
 * This mirrors what `ProgressionService.grantXp` already does for
 * `player_xp_gain` and what `CollectionService.awardBuddyAffection` does for
 * `affection_gain`: the modifier sits at the domain choke point, and no caller
 * anywhere contains a percentage.
 */
import type { DbOrTx } from '../../db/client';
import {
  appliedBuddyBonus,
  applyPercentModifierInt,
  buddyBonusPercent,
  type AppliedBuddyBonus,
} from '../buddyBonus/buddyBonusEffects';
import type { ActiveBuddyBonus, BuddyBonusService } from '../buddyBonus/buddyBonusService';
import type { CurrencyService } from './currencyService';

/**
 * What an Essence award actually paid, in enough detail for a result screen to
 * print `💎 +52 Essence · Base: 40 · ✨ Extra Serving: +30%` without doing any
 * arithmetic of its own.
 */
export interface EssenceAwardResult {
  /** The award before any Buddy Bonus — what content or the table authored. */
  baseAmount: number;
  /** What actually landed. Equal to `baseAmount` when no bonus applied. */
  essenceGranted: number;
  /** The player's Essence balance after the grant. */
  essenceAfter: number;
  /**
   * Set **only** when the bonus actually raised the award.
   *
   * That condition is the signal a presentation layer reads: a UI never
   * decides whether a bonus was relevant, and never recomputes a percentage to
   * find out. A 0% bonus, a different effect, or a percentage too small to
   * lift the award to the next integer all leave this null.
   */
  bonus: AppliedBuddyBonus | null;
}

/**
 * The same numbers, computed without writing anything.
 *
 * Exists for the pre-confirmation screens — the post-capture Keep/Convert
 * prompt, the Inspect Convert button, the Release and favourite-convert
 * confirmations — which have to show what the player will get *before* they
 * commit. They share {@link EssenceAwardService.awardEssence}'s modifier logic
 * exactly, so a preview and the payout that follows it cannot disagree about
 * what a percentage means.
 *
 * A preview is **not** authoritative: the player may equip a different Buddy
 * between seeing this number and pressing the button, and the award recomputes
 * from the live Buddy at that moment. That is the correct behaviour — the
 * preview describes the world as it is now, not a promise about the world
 * later.
 */
export interface EssencePreview {
  baseAmount: number;
  /** What the currently-equipped Buddy would make this award. */
  finalAmount: number;
  /** Set only when the current Buddy would raise it. */
  bonus: AppliedBuddyBonus | null;
}

export interface EssenceAwardService {
  /**
   * Grant `baseAmount` Essence to a player as a **gameplay reward**, scaled by
   * their active `essence_gain` Buddy Bonus, inside the caller's transaction.
   *
   * `baseAmount` must be a positive integer. A non-positive award is a
   * programming error rather than a no-op — every content schema that feeds
   * this already rejects zero — so it throws instead of quietly granting
   * nothing. Callers whose base can legitimately be zero (a rarity with no
   * conversion value) must check before calling, exactly as they did before
   * when they were calling `grantEssence` directly.
   */
  awardEssence(tx: DbOrTx, playerId: number, baseAmount: number): Promise<EssenceAwardResult>;
  /**
   * What {@link awardEssence} *would* pay right now, without writing anything.
   * `baseAmount` of 0 is legal here and returns 0 — a preview of "nothing" is
   * a real thing to display, unlike an award of nothing.
   */
  previewEssence(tx: DbOrTx, playerId: number, baseAmount: number): Promise<EssencePreview>;
  /**
   * {@link previewEssence} for several awards at once, resolving the player's
   * Buddy a single time instead of once per amount.
   *
   * Each amount is scaled and rounded **independently**, exactly as it would
   * be if it were the only award — which is the whole reason this exists as a
   * batch rather than a sum. Two 5-Essence rewards at +10% pay 6 and 6, for a
   * total of 12; previewing their combined base of 10 would quote 11, a number
   * the claim never produces. A screen that shows several awards together must
   * therefore preview them together *here*, not add them up first.
   *
   * Returns one preview per input, index-aligned.
   */
  previewEssenceMany(
    tx: DbOrTx,
    playerId: number,
    baseAmounts: readonly number[],
  ): Promise<EssencePreview[]>;
}

export interface EssenceAwardServiceDeps {
  currency: CurrencyService;
  /**
   * Optional, matching every other consumer of Buddy Bonuses: without it an
   * award is exactly what content configured. Older fixtures rely on that.
   */
  buddyBonus?: BuddyBonusService | undefined;
}

export function createEssenceAwardService(deps: EssenceAwardServiceDeps): EssenceAwardService {
  const { currency, buddyBonus } = deps;

  /**
   * The single arithmetic, shared by the award, the single preview and the
   * batch preview so none of the three can drift. Pure: the caller has already
   * done the one Buddy lookup, which is what lets a batch resolve once and
   * still round every amount on its own.
   *
   * `applyPercentModifierInt` is the same helper Hunt and Convert already
   * used — rounding is unchanged from what shipped.
   */
  function scale(
    active: ActiveBuddyBonus | null | undefined,
    baseAmount: number,
  ): { finalAmount: number; bonus: AppliedBuddyBonus | null } {
    const finalAmount = applyPercentModifierInt(
      baseAmount,
      buddyBonusPercent(active?.bonus, 'essence_gain'),
    );
    // Reported only when it moved the number, which is the same condition
    // Hunt and Convert used before this service existed.
    const bonus =
      active && finalAmount > baseAmount
        ? appliedBuddyBonus(active.bonus, { base: baseAmount, final: finalAmount })
        : null;
    return { finalAmount, bonus };
  }

  async function resolve(
    tx: DbOrTx,
    playerId: number,
    baseAmount: number,
  ): Promise<{ finalAmount: number; bonus: AppliedBuddyBonus | null }> {
    return scale(await buddyBonus?.getActiveBuddyBonus(tx, playerId), baseAmount);
  }

  function assertPreviewable(baseAmount: number): void {
    if (!Number.isInteger(baseAmount) || baseAmount < 0) {
      throw new RangeError(
        `previewEssence: baseAmount must be a non-negative integer, got ${baseAmount}`,
      );
    }
  }

  return {
    async awardEssence(tx, playerId, baseAmount) {
      if (!Number.isInteger(baseAmount) || baseAmount <= 0) {
        throw new RangeError(
          `awardEssence: baseAmount must be a positive integer, got ${baseAmount}`,
        );
      }
      const { finalAmount, bonus } = await resolve(tx, playerId, baseAmount);
      const row = await currency.grantEssence(tx, playerId, finalAmount);
      return {
        baseAmount,
        essenceGranted: finalAmount,
        essenceAfter: row.essence,
        bonus,
      };
    },

    async previewEssence(tx, playerId, baseAmount) {
      assertPreviewable(baseAmount);
      if (baseAmount === 0) return { baseAmount: 0, finalAmount: 0, bonus: null };
      const { finalAmount, bonus } = await resolve(tx, playerId, baseAmount);
      return { baseAmount, finalAmount, bonus };
    },

    async previewEssenceMany(tx, playerId, baseAmounts) {
      for (const amount of baseAmounts) assertPreviewable(amount);
      if (baseAmounts.length === 0) return [];
      // Every amount that could carry a bonus is zero: nothing to look up, so
      // do not spend two queries proving it.
      if (baseAmounts.every((a) => a === 0)) {
        return baseAmounts.map(() => ({ baseAmount: 0, finalAmount: 0, bonus: null }));
      }
      const active = await buddyBonus?.getActiveBuddyBonus(tx, playerId);
      return baseAmounts.map((baseAmount) => {
        if (baseAmount === 0) return { baseAmount: 0, finalAmount: 0, bonus: null };
        const { finalAmount, bonus } = scale(active, baseAmount);
        return { baseAmount, finalAmount, bonus };
      });
    },
  };
}
