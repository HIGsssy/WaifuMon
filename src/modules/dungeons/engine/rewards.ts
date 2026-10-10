/**
 * What a reward action pays, and what is banked when a run ends.
 *
 * Every draw is derived from the run's seed and the action, through the same
 * keyed draws and the same table roller expeditions use. So a payout is a
 * function of stored data: reproducible, and identical however many times it
 * is asked for. Only the *plan* is decided here; the Equipment instance
 * (multiplier, affix, bonuses) is rolled once by the Equipment service when
 * the live adapter grants the drop.
 *
 * ## Rounding
 *
 * One rule wherever a share is taken (rest healing, defeat retention):
 * multiply, divide by 10,000, round **toward zero**.
 */
import { expeditionDrawInt } from '../../expeditions/expeditionRandom';
import { mergeGrants, rollExpeditionTable } from '../../expeditions/expeditionRewards';
import { BASIS_POINTS, type RewardSpec } from '../content/dungeonDefinition';
import type { DungeonRewardPlan, DungeonRngSource, EngineDependencies } from './types';

export const NO_REWARD_PLAN: DungeonRewardPlan = Object.freeze({ currency: 0, waifubux: 0, items: [], equipment: [] });

export function planHasSecuredRewards(plan: Pick<DungeonRewardPlan, 'waifubux' | 'items' | 'equipment'>): boolean {
  return plan.waifubux > 0 || plan.items.length > 0 || plan.equipment.length > 0;
}

/** `amount × basisPoints / 10000`, rounded toward zero. */
export function shareOf(amount: number, basisPoints: number): number {
  return Math.trunc((amount * basisPoints) / BASIS_POINTS);
}

/** What is banked and what is lost when `total` unbanked currency is settled. */
export function settleCurrency(total: number, retentionBasisPoints: number): { banked: number; lost: number } {
  const banked = Math.min(total, Math.max(0, shareOf(total, retentionBasisPoints)));
  return { banked, lost: total - banked };
}

/** HP after a rest: never above max, never below where it was. */
export function hpAfterRest(maxHp: number, currentHp: number, healBasisPoints: number): number {
  return Math.min(maxHp, currentHp + Math.max(0, shareOf(maxHp, healBasisPoints)));
}

function rollTable(
  dependencies: EngineDependencies,
  tableId: string | null,
  drawId: number,
  kind: 'success' | 'bonus',
): Pick<DungeonRewardPlan, 'waifubux' | 'items' | 'equipment'> {
  // A table disabled (or missing) when the run started was promised nothing.
  const entry = tableId ? dependencies.rewardTables[tableId] : null;
  if (!entry) return { waifubux: 0, items: [], equipment: [] };
  const roll = rollExpeditionTable({ table: entry.table, expeditionId: drawId, kind, equipmentPools: entry.equipmentPools });
  // Dungeons pay a table's WaifuBux, items and gear. Essence and XP on a
  // shared table are expedition rewards and are not paid here.
  return { waifubux: roll.waifubux, items: roll.items, equipment: roll.equipment };
}

/** What one reward action pays in this run. Same seed, same action → same plan. */
export function rollRewardPlan(
  spec: RewardSpec,
  place: { roomId: string; actionId: string },
  dependencies: EngineDependencies,
  rng: DungeonRngSource,
): DungeonRewardPlan {
  const drawId = rng.seedOf('reward', place.roomId, place.actionId);
  const ordinary = rollTable(dependencies, spec.rewardTable, drawId, 'success');
  const gear = rollTable(dependencies, spec.equipmentRewardTable, drawId, 'bonus');
  return {
    currency:
      spec.currency.max <= 0 ? 0 : expeditionDrawInt(drawId, 'success:dungeon-currency', spec.currency.min, spec.currency.max),
    waifubux: ordinary.waifubux + gear.waifubux,
    items: mergeGrants([...ordinary.items, ...gear.items]),
    equipment: [...ordinary.equipment, ...gear.equipment],
  };
}

/** The claim key of one reward action in one run — the idempotency key of its delivery. */
export function rewardClaimKey(runKey: string, roomId: string, actionId: string): string {
  return `run:${runKey}:${roomId}:${actionId}`;
}

/** The grant key of one gear drop of a claim. */
export function equipmentGrantKey(claimKey: string, rewardIndex: number): string {
  return `dungeon:${claimKey}:${rewardIndex}`;
}
