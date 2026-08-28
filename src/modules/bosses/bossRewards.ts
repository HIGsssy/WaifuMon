/**
 * Boss encounter payouts — pure, deterministic, and versioned.
 *
 * Rewards are generated **only when the battle resolves**, never when a buddy
 * is committed. That is the rule the whole shape here exists to enforce: this
 * module is not reachable from the commit path, and the commit path has
 * nothing to call.
 *
 * Three payouts, deliberately different in kind:
 *
 *   - **Guaranteed buddy XP.** Not a roll. A max-level buddy gets zero and the
 *     XP is *not* redirected anywhere — see {@link applicableBuddyXp}.
 *   - **One weighted minor-item roll.** Conservative by design: a boss appears
 *     several times a day and one participation is free, so this sits at the
 *     scale of a hunt find rather than a daily package.
 *   - **A separate jackpot check.** Kept out of the weighted table so that
 *     retuning the minor pool cannot move the jackpot's odds, and so the
 *     jackpot never *displaces* an ordinary reward — a lucky participant gets
 *     both.
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
 * different independence structure between the minor and jackpot draws. The
 * reward table's own `version` string covers retuning the numbers; this covers
 * changing what the numbers mean.
 */
export const BOSS_REWARD_LOGIC_VERSION = 1;

/** One granted stack, as stored on the participation row and printed in results. */
export interface BossRewardItemGrant {
  slug: string;
  quantity: number;
}

export interface BossRewardRoll {
  /** XP the buddy will actually receive — already zeroed for a capped copy. */
  buddyXp: number;
  /** Minor roll plus, when it hits, the jackpot. Never empty in shipped content. */
  items: BossRewardItemGrant[];
  /** Whether the jackpot fired. Surfaced for logging and the result callout. */
  jackpotHit: boolean;
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
 * written at commitment and resolution only ever reads it back.
 */
export function rollBossRewards(input: {
  table: BossRewardTable;
  encounterId: number;
  participationId: number;
  buddyLevel: number;
  maxLevel: number;
}): BossRewardRoll {
  const { table, encounterId, participationId, buddyLevel, maxLevel } = input;

  const minor = rollWeighted(
    table.minorItems.map((entry) => ({ weight: entry.weight, value: entry })),
    bossDrawRng(encounterId, participationId, 'minor-item'),
  );

  const items: BossRewardItemGrant[] = [{ slug: minor.slug, quantity: minor.quantity }];

  // Independent of the minor roll: its own purpose, therefore its own draw.
  let jackpotHit = false;
  if (table.jackpot && table.jackpot.chance > 0) {
    const roll = bossDrawFraction(encounterId, participationId, 'mythic');
    if (roll < table.jackpot.chance) {
      jackpotHit = true;
      items.push({ slug: table.jackpot.slug, quantity: table.jackpot.quantity });
    }
  }

  return {
    buddyXp: applicableBuddyXp(table.buddyXp, buddyLevel, maxLevel),
    items,
    jackpotHit,
  };
}

/**
 * Merge stacks of the same item before they are handed over.
 *
 * Only reachable when a reward table lists its jackpot slug in the minor pool
 * too, which shipped content does not — but a single `+2` inventory write is
 * both cheaper and easier to read in a result line than two `+1`s, and the
 * caller should not have to care whether the table happens to overlap.
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
