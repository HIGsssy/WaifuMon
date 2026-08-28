/**
 * Boss encounter payouts — pure, deterministic, and versioned.
 *
 * Rewards are generated **only when the battle resolves**, never when a buddy
 * is committed. That is the rule the whole shape here exists to enforce: this
 * module is not reachable from the commit path, and the commit path has
 * nothing to call.
 *
 * Two payouts, deliberately different in kind:
 *
 *   - **Guaranteed buddy XP.** Not a roll. A max-level buddy gets zero and the
 *     XP is *not* redirected anywhere — see {@link applicableBuddyXp}.
 *   - **One draw per roll of every enabled group** in the table. A group is a
 *     probability gate (`chanceBasisPoints`) in front of a weighted pick, and
 *     groups are independent of one another. That is what lets the shipped
 *     table hand out a guaranteed ordinary item and, separately and rarely, a
 *     Mythic Contract *in addition to* it rather than instead of it.
 *
 * **Weights are normalized over what is enabled, not over what is written.**
 * `rollWeighted` divides by the total of the entries it is handed, and only
 * enabled entries are handed to it, so disabling one redistributes its share
 * across the rest in proportion. There is no hole in the distribution and no
 * second number to keep in sync.
 *
 * **Nothing here consults the Shop.** Not `purchasable`, not `buyPrice`, not
 * `items.enabled`. A boss table is the complete statement of what a boss
 * drops; the Shop is a different acquisition source for the same items and has
 * no vote. See `BossRewardTableSchema` for why the two are separate files.
 *
 * Every draw goes through `bossRandom`, so a resolution that is retried after
 * a crash reproduces the same rewards rather than rolling fresh ones. Nothing
 * here reads a clock or a database.
 */
import { rollWeighted } from '../../shared/random';
import type { BossRewardTable } from '../content/schemas';
import { bossDrawFraction, bossDrawRng } from './bossRandom';

/**
 * Version of the reward *derivation*.
 *
 * Bumped when the way a payout is computed changes — a second roll, a
 * different independence structure between draws. The reward table's own
 * `version` covers retuning the numbers; this covers changing what the numbers
 * mean.
 *
 * `2`: the flat `minorItems` + `jackpot` pair became an arbitrary list of
 * independent groups, and the draw keys changed with it.
 */
export const BOSS_REWARD_LOGIC_VERSION = 2;

/** Basis-point denominator. 10000 bp = certainty. */
const BASIS_POINTS = 10_000;

/** One granted stack, as stored on the participation row and printed in results. */
export interface BossRewardItemGrant {
  slug: string;
  quantity: number;
}

/**
 * A configuration problem found while rolling.
 *
 * Returned rather than logged, because this module is pure and its caller owns
 * the logger. The caller logs these at resolution time, which is exactly when
 * an operator needs to hear about them: a group that can never produce
 * anything is silently paying nobody.
 */
export interface BossRewardWarning {
  groupId: string;
  message: string;
}

export interface BossRewardRoll {
  /** XP the buddy will actually receive — already zeroed for a capped copy. */
  buddyXp: number;
  /** Every stack won across every group. Empty is possible, if unusual. */
  items: BossRewardItemGrant[];
  /** Ids of the groups that produced a drop. Surfaced for logging and audit. */
  hitGroupIds: string[];
  /** Groups that were skipped because nothing in them could be drawn. */
  warnings: BossRewardWarning[];
}

/**
 * XP a buddy can actually absorb.
 *
 * A max-level buddy participates, fights, deals damage and receives items —
 * she simply gains nothing from XP she has no room for. The discarded XP is
 * **not** redirected to the player, to Essence, or to another copy: converting
 * a dead reward into a live one would quietly make capped buddies the optimal
 * choice, which is the opposite of what a level cap is for.
 */
export function applicableBuddyXp(
  configuredXp: number,
  buddyLevel: number,
  maxLevel: number,
): number {
  return buddyLevel >= maxLevel ? 0 : configuredXp;
}

/**
 * The full payout for one participation.
 *
 * `encounterId` and `participationId` are the stable identity the draws key
 * on — both exist by the time this is called, because a participation row is
 * written at commitment and resolution only ever reads it back. The group id
 * and roll index join them, which is what makes every group (and every roll
 * within a group) an independent quantity rather than another view of one
 * number.
 */
export function rollBossRewards(input: {
  table: BossRewardTable;
  encounterId: number;
  participationId: number;
  buddyLevel: number;
  maxLevel: number;
}): BossRewardRoll {
  const { table, encounterId, participationId, buddyLevel, maxLevel } = input;

  const items: BossRewardItemGrant[] = [];
  const hitGroupIds: string[] = [];
  const warnings: BossRewardWarning[] = [];

  for (const group of table.groups) {
    if (!group.enabled) continue;

    // Only enabled entries reach `rollWeighted`, which is where normalization
    // happens: the remaining weights are divided by their own total.
    const eligible = group.entries.filter((entry) => entry.enabled);
    if (eligible.length === 0) {
      warnings.push({
        groupId: group.id,
        message:
          `boss reward group "${group.id}" in table "${table.id}" has no enabled entries — ` +
          'skipped. Re-enable an entry or disable the group.',
      });
      continue;
    }
    if (group.chanceBasisPoints === 0) {
      warnings.push({
        groupId: group.id,
        message:
          `boss reward group "${group.id}" in table "${table.id}" has chanceBasisPoints 0 — ` +
          'it can never drop. Raise it or disable the group.',
      });
      continue;
    }

    for (let roll = 0; roll < group.rolls; roll += 1) {
      // A certain group skips the gate entirely rather than drawing a fraction
      // and comparing it to 1 — `bossDrawFraction` is in [0, 1), so the
      // comparison would always pass, but not drawing at all makes that
      // obvious instead of incidental.
      if (group.chanceBasisPoints < BASIS_POINTS) {
        const gate = bossDrawFraction(
          encounterId,
          participationId,
          `reward:${group.id}:${roll}:gate`,
        );
        if (gate >= group.chanceBasisPoints / BASIS_POINTS) continue;
      }
      const picked = rollWeighted(
        eligible.map((entry) => ({ weight: entry.weight, value: entry })),
        bossDrawRng(encounterId, participationId, `reward:${group.id}:${roll}:pick`),
      );
      items.push({ slug: picked.itemId, quantity: picked.quantity });
      hitGroupIds.push(group.id);
    }
  }

  return {
    buddyXp: applicableBuddyXp(table.buddyXp, buddyLevel, maxLevel),
    items,
    hitGroupIds,
    warnings,
  };
}

/**
 * Merge stacks of the same item before they are handed over.
 *
 * Reachable whenever two groups name the same item, or one group's repeated
 * rolls land on it twice. A single `+2` inventory write is both cheaper and
 * easier to read in a result line than two `+1`s, and the caller should not
 * have to care whether the table happens to overlap.
 */
export function mergeGrants(
  grants: readonly BossRewardItemGrant[],
): BossRewardItemGrant[] {
  const totals = new Map<string, number>();
  for (const grant of grants) {
    totals.set(grant.slug, (totals.get(grant.slug) ?? 0) + grant.quantity);
  }
  return [...totals].map(([slug, quantity]) => ({ slug, quantity }));
}
