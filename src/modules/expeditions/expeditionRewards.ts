/**
 * Expedition payouts — pure, deterministic, and versioned.
 *
 * Copies the *shape* of `bossRewards.ts` (independent groups, a
 * `chanceBasisPoints` gate in front of a weighted pick, weights normalized
 * over what is enabled) and extends it with the non-item reward kinds an
 * expedition pays: WaifuBux, Essence, WaifuMon XP and player XP.
 *
 * The two are deliberately not unified yet. The design warns against a
 * premature global reward-system rewrite, and the boss engine has shipped and
 * works; merging them is a mechanical change worth making once this shape has
 * proven itself twice, not before.
 *
 * ── Exceptional Success is additive ────────────────────────────────────────
 *
 * An exceptional result pays the ordinary success table **and then** the
 * bonus table, not one instead of the other. That is what makes Exceptional
 * unambiguously better rather than a different distribution the player has to
 * compare — and it lets a bonus table be authored as pure upside (extra
 * salvage, a rare curio, a key item) without also having to restate everything
 * an ordinary success already pays.
 *
 * The two tables draw from *separate purpose namespaces* (`success:` and
 * `bonus:`), so adding, removing or retuning a bonus table cannot shift what
 * the success table pays for the same mission. Independence in the arithmetic,
 * not just in the description.
 *
 * Every draw goes through `expeditionRandom`, so a resolution that is retried
 * after a crash reproduces the same payout rather than rolling a fresh one.
 * Nothing here reads a clock, a database or the content snapshot.
 */
import { rollWeighted } from '../../shared/random';
import type { ExpeditionRewardTable } from '../content/schemas';
import {
  expeditionDrawFraction,
  expeditionDrawInt,
  expeditionDrawRng,
  type ExpeditionDrawPurpose,
} from './expeditionRandom';

/** Basis-point denominator. 10000 bp = certainty. */
const BASIS_POINTS = 10_000;

/** One granted stack, as stored in the resolved payload and printed in results. */
export interface ExpeditionItemGrant {
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
export interface ExpeditionRewardWarning {
  tableId: string;
  groupId: string;
  message: string;
}

/** What one table produced. Merged into the payload by {@link mergeRolls}. */
export interface ExpeditionTableRoll {
  tableId: string;
  /** The table's `version`, defaulting to its id. Carried for audit. */
  tableVersion: string;
  waifubux: number;
  essence: number;
  waifuXp: number;
  playerXp: number;
  items: ExpeditionItemGrant[];
  hitGroupIds: string[];
  warnings: ExpeditionRewardWarning[];
}

/** The complete payout for one resolved expedition. */
export interface ExpeditionRewardPayload {
  waifubux: number;
  essence: number;
  waifuXp: number;
  playerXp: number;
  items: ExpeditionItemGrant[];
  /**
   * Which tables contributed, with their versions. This is the audit trail
   * that survives `resolution_plan` being cleared: a historical row can still
   * say which tuning produced it.
   */
  sources: { tableId: string; tableVersion: string; kind: RewardTableKind }[];
  warnings: ExpeditionRewardWarning[];
}

/**
 * Which slot a table was rolled in. Also the draw-purpose namespace, which is
 * what keeps the success and bonus rolls independent.
 */
export type RewardTableKind = 'success' | 'bonus' | 'failure';

/**
 * Roll one table.
 *
 * `kind` namespaces every draw, so the same table id rolled as `success` and
 * as `bonus` for the same expedition produces *different* results — which is
 * what a content author would expect if they ever pointed both fields at one
 * table, and is the honest behaviour rather than a silent doubling of one draw.
 */
export function rollExpeditionTable(input: {
  table: ExpeditionRewardTable;
  expeditionId: number;
  kind: RewardTableKind;
}): ExpeditionTableRoll {
  const { table, expeditionId, kind } = input;
  const purpose = (suffix: string): ExpeditionDrawPurpose =>
    `${kind}:${suffix}` as ExpeditionDrawPurpose;

  const items: ExpeditionItemGrant[] = [];
  const hitGroupIds: string[] = [];
  const warnings: ExpeditionRewardWarning[] = [];

  // Currency and Essence are drawn as inclusive integers rather than scaled
  // floats, so both ends of an authored range are exactly reachable.
  const waifubux = table.waifubux
    ? expeditionDrawInt(expeditionId, purpose('waifubux'), table.waifubux.min, table.waifubux.max)
    : 0;
  const essence = table.essence
    ? expeditionDrawInt(expeditionId, purpose('essence'), table.essence.min, table.essence.max)
    : 0;

  for (const group of table.groups) {
    if (!group.enabled) continue;

    // Only enabled entries reach `rollWeighted`, which is where normalization
    // happens: the remaining weights are divided by their own total, so
    // disabling one entry redistributes its share in proportion. There is no
    // hole in the distribution and no second number to keep in sync.
    const eligible = group.entries.filter((entry) => entry.enabled);
    if (eligible.length === 0) {
      warnings.push({
        tableId: table.id,
        groupId: group.id,
        message:
          `expedition reward group "${group.id}" in table "${table.id}" has no enabled ` +
          'entries — skipped. Re-enable an entry or disable the group.',
      });
      continue;
    }
    if (group.chanceBasisPoints === 0) {
      warnings.push({
        tableId: table.id,
        groupId: group.id,
        message:
          `expedition reward group "${group.id}" in table "${table.id}" has ` +
          'chanceBasisPoints 0 — it can never drop. Raise it or disable the group.',
      });
      continue;
    }

    for (let roll = 0; roll < group.rolls; roll += 1) {
      // A certain group skips the gate entirely rather than drawing a fraction
      // and comparing it to 1. The comparison would always pass — the draw is
      // in [0, 1) — but not drawing at all makes that obvious rather than
      // incidental.
      if (group.chanceBasisPoints < BASIS_POINTS) {
        const gate = expeditionDrawFraction(expeditionId, purpose(`${group.id}:${roll}:gate`));
        if (gate >= group.chanceBasisPoints / BASIS_POINTS) continue;
      }
      const picked = rollWeighted(
        eligible.map((entry) => ({ weight: entry.weight, value: entry })),
        expeditionDrawRng(expeditionId, purpose(`${group.id}:${roll}:pick`)),
      );
      items.push({ slug: picked.itemId, quantity: picked.quantity });
      hitGroupIds.push(group.id);
    }
  }

  return {
    tableId: table.id,
    tableVersion: table.version ?? table.id,
    waifubux,
    essence,
    waifuXp: table.waifuXp,
    playerXp: table.playerXp,
    items,
    hitGroupIds,
    warnings,
  };
}

/**
 * Merge stacks of the same item before they are handed over.
 *
 * Reachable whenever two groups name the same item, one group's repeated rolls
 * land on it twice, or — the case this feature adds — a success table and a
 * bonus table both pay salvage. A single `+3` inventory write is cheaper and
 * reads better in a result line than three `+1`s, and no caller should have to
 * care whether the tables happen to overlap.
 */
export function mergeGrants(
  grants: readonly ExpeditionItemGrant[],
): ExpeditionItemGrant[] {
  const totals = new Map<string, number>();
  for (const grant of grants) {
    totals.set(grant.slug, (totals.get(grant.slug) ?? 0) + grant.quantity);
  }
  return [...totals].map(([slug, quantity]) => ({ slug, quantity }));
}

/** Sum several table rolls into the single payload that gets persisted. */
export function mergeRolls(
  rolls: readonly { roll: ExpeditionTableRoll; kind: RewardTableKind }[],
): ExpeditionRewardPayload {
  return {
    waifubux: rolls.reduce((sum, r) => sum + r.roll.waifubux, 0),
    essence: rolls.reduce((sum, r) => sum + r.roll.essence, 0),
    waifuXp: rolls.reduce((sum, r) => sum + r.roll.waifuXp, 0),
    playerXp: rolls.reduce((sum, r) => sum + r.roll.playerXp, 0),
    items: mergeGrants(rolls.flatMap((r) => r.roll.items)),
    sources: rolls.map((r) => ({
      tableId: r.roll.tableId,
      tableVersion: r.roll.tableVersion,
      kind: r.kind,
    })),
    warnings: rolls.flatMap((r) => r.roll.warnings),
  };
}

/**
 * The complete payout for one resolved expedition.
 *
 * `outcome` decides which tables are rolled, and the *additive* rule for
 * Exceptional lives here and nowhere else:
 *
 *   - `failure`    → the failure table alone, if the mission has one.
 *   - `success`    → the success table alone.
 *   - `exceptional`→ the success table **plus** the bonus table.
 *
 * The failure table is chosen by the mission, never by how well-matched the
 * deployed copy was. Suitability already moved the odds of failing; letting it
 * also shrink the consolation would penalise a risky deployment twice, and two
 * players who fail the same mission should walk away with the same kind of
 * thing regardless of who they sent.
 *
 * Every table is optional. A mission with no failure table pays nothing on a
 * failure, and an exceptional result with no bonus table pays exactly what an
 * ordinary success pays — legal, and the honest reading of "no bonus authored".
 */
export function rollExpeditionRewards(input: {
  outcome: 'failure' | 'success' | 'exceptional';
  expeditionId: number;
  successTable: ExpeditionRewardTable | null;
  bonusTable: ExpeditionRewardTable | null;
  failureTable: ExpeditionRewardTable | null;
}): ExpeditionRewardPayload {
  const { outcome, expeditionId, successTable, bonusTable, failureTable } = input;
  const rolls: { roll: ExpeditionTableRoll; kind: RewardTableKind }[] = [];

  if (outcome === 'failure') {
    if (failureTable) {
      rolls.push({
        roll: rollExpeditionTable({ table: failureTable, expeditionId, kind: 'failure' }),
        kind: 'failure',
      });
    }
    return mergeRolls(rolls);
  }

  if (successTable) {
    rolls.push({
      roll: rollExpeditionTable({ table: successTable, expeditionId, kind: 'success' }),
      kind: 'success',
    });
  }
  // The bonus rides on top of the success roll above — it never replaces it.
  if (outcome === 'exceptional' && bonusTable) {
    rolls.push({
      roll: rollExpeditionTable({ table: bonusTable, expeditionId, kind: 'bonus' }),
      kind: 'bonus',
    });
  }
  return mergeRolls(rolls);
}
