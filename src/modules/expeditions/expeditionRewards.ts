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
 * ── Equipment ──────────────────────────────────────────────────────────────
 *
 * A group's `equipment` entries compete in the same weighted pick as its
 * items. When one wins, the base definition is chosen here — uniformly, with
 * a derived draw, from the pool the plan snapshotted at deploy — and the
 * instance (multiplier, affix) is created at claim by the Equipment service.
 *
 * Every draw goes through `expeditionRandom`, so a resolution that is retried
 * after a crash reproduces the same payout rather than rolling a fresh one.
 * Nothing here reads a clock, a database or the content snapshot.
 */
import { rollWeighted } from '../../shared/random';
import { equipmentEntrySelector, type ExpeditionRewardTable } from '../content/schemas';
import { equipmentSelectorKey, pickRewardDefinition } from '../equipment/rewardSelector';
import type { EquipmentSlot } from '../equipment/vocabulary';
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

/** One base definition an Equipment entry may pay, as snapshotted at deploy. */
export interface ExpeditionEquipmentCandidate {
  key: string;
  name: string;
  slot: EquipmentSlot;
  rarity: string;
}

/**
 * Every enabled Equipment entry's eligible definitions, keyed by
 * `equipmentSelectorKey`, resolved against the database **at deploy** and
 * carried on the plan — the gear twin of copying the tables themselves. Lets
 * resolution stay pure and deterministic, and means a definition disabled
 * mid-mission is still paid to the mission that was promised it.
 */
export type ExpeditionEquipmentPools = Readonly<Record<string, readonly ExpeditionEquipmentCandidate[]>>;

/**
 * A gear drop the mission won, with its base definition already chosen.
 *
 * `drawKey` (`<kind>:<groupId>:<roll>`) is the drop's stable identity: the
 * claim derives its grant key from it, so a claim retried after a failure
 * finds the instance rather than minting a second. The instance itself — its
 * multiplier and affix — does not exist until the claim.
 */
export interface ExpeditionEquipmentDraw {
  drawKey: string;
  definitionKey: string;
  name: string;
  slot: EquipmentSlot;
  rarity: string;
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
  equipment: ExpeditionEquipmentDraw[];
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
   * Gear won, base definition chosen, one instance each — granted at claim.
   * Optional because rows resolved before gear existed do not carry it;
   * absent means none.
   */
  equipment?: ExpeditionEquipmentDraw[];
  /**
   * What each contributing table paid, with its version.
   *
   * Two jobs. It is the audit trail that survives the resolution plan being
   * trimmed — a historical row can still say which tuning produced it — and it
   * is what lets a result screen show an Exceptional Success as
   * "Normal Rewards" **plus** "Exceptional Bonus" rather than flattening the
   * two into one indistinguishable list. Without the per-table amounts the
   * player has no way to see what excelling actually earned them.
   *
   * The flat totals above stay **authoritative for granting**: the claim loop
   * reads those and never this. That is a deliberate duplication — the totals
   * are the sum of these entries — accepted because both are written together,
   * once, by `mergeRolls`, and nothing else ever writes either. Presentation
   * reads the breakdown; the ledger reads the totals.
   */
  sources: {
    tableId: string;
    tableVersion: string;
    kind: RewardTableKind;
    waifubux: number;
    essence: number;
    waifuXp: number;
    playerXp: number;
    items: ExpeditionItemGrant[];
    equipment?: ExpeditionEquipmentDraw[];
  }[];
  warnings: ExpeditionRewardWarning[];
}

/**
 * Which slot a table was rolled in. Also the draw-purpose namespace, which is
 * what keeps the success and bonus rolls independent.
 */
export type RewardTableKind = 'success' | 'bonus' | 'failure';

type ExpeditionRewardGroup = ExpeditionRewardTable['groups'][number];
type PickableEntry =
  | { kind: 'item'; entry: ExpeditionRewardGroup['entries'][number] }
  | { kind: 'equipment'; entry: NonNullable<ExpeditionRewardGroup['equipment']>[number] };

/**
 * Every enabled Equipment entry's selector across these tables, deduplicated
 * by `equipmentSelectorKey` — what deploy must resolve into
 * {@link ExpeditionEquipmentPools}. Disabled groups and entries never roll, so
 * they need no pool.
 */
export function equipmentSelectorsOf(tables: readonly (ExpeditionRewardTable | null)[]) {
  const selectors = new Map<string, ReturnType<typeof equipmentEntrySelector>>();
  for (const table of tables) {
    for (const group of table?.groups ?? []) {
      if (!group.enabled) continue;
      for (const entry of group.equipment ?? []) {
        if (!entry.enabled) continue;
        const selector = equipmentEntrySelector(entry);
        selectors.set(equipmentSelectorKey(selector), selector);
      }
    }
  }
  return selectors;
}

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
  /** Required only when the table has Equipment entries. */
  equipmentPools?: ExpeditionEquipmentPools | undefined;
}): ExpeditionTableRoll {
  const { table, expeditionId, kind } = input;
  const purpose = (suffix: string): ExpeditionDrawPurpose =>
    `${kind}:${suffix}` as ExpeditionDrawPurpose;

  const items: ExpeditionItemGrant[] = [];
  const equipment: ExpeditionEquipmentDraw[] = [];
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
    // hole in the distribution and no second number to keep in sync. Gear
    // entries join the same pick *after* the items, so a group with no gear
    // draws exactly what it always drew.
    const eligible: PickableEntry[] = [
      ...group.entries.filter((entry) => entry.enabled).map((entry) => ({ kind: 'item' as const, entry })),
      ...(group.equipment ?? [])
        .filter((entry) => entry.enabled)
        .map((entry) => ({ kind: 'equipment' as const, entry })),
    ];
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
        eligible.map((pickable) => ({ weight: pickable.entry.weight, value: pickable })),
        expeditionDrawRng(expeditionId, purpose(`${group.id}:${roll}:pick`)),
      );
      if (picked.kind === 'item') {
        items.push({ slug: picked.entry.itemId, quantity: picked.entry.quantity });
      } else {
        // The base definition, chosen uniformly from the pool snapshotted at
        // deploy with a draw of its own — derived, so a retried resolution
        // chooses the same one. Multiplier and affix are left to the claim.
        const selectorKey = equipmentSelectorKey(equipmentEntrySelector(picked.entry));
        const pool = input.equipmentPools?.[selectorKey];
        if (!pool || pool.length === 0) {
          // Unreachable through `deploy`, which snapshots a non-empty pool for
          // every enabled entry or refuses the mission. Loud, never a skip.
          throw new Error(
            `expedition ${expeditionId}: no snapshotted equipment pool for "${selectorKey}" ` +
              `in table "${table.id}" group "${group.id}"`,
          );
        }
        const chosen = pickRewardDefinition(
          pool,
          expeditionDrawRng(expeditionId, purpose(`${group.id}:${roll}:equipment`)),
        );
        equipment.push({
          drawKey: `${kind}:${group.id}:${roll}`,
          definitionKey: chosen.key,
          name: chosen.name,
          slot: chosen.slot,
          rarity: chosen.rarity,
        });
      }
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
    equipment,
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
  // Never merged: every gear drop is its own instance with its own grant key.
  // Written only when something dropped, so a gear-free payout persists
  // exactly the shape it always did.
  const equipment = rolls.flatMap((r) => r.roll.equipment);
  return {
    waifubux: rolls.reduce((sum, r) => sum + r.roll.waifubux, 0),
    essence: rolls.reduce((sum, r) => sum + r.roll.essence, 0),
    waifuXp: rolls.reduce((sum, r) => sum + r.roll.waifuXp, 0),
    playerXp: rolls.reduce((sum, r) => sum + r.roll.playerXp, 0),
    items: mergeGrants(rolls.flatMap((r) => r.roll.items)),
    ...(equipment.length > 0 ? { equipment } : {}),
    sources: rolls.map((r) => ({
      tableId: r.roll.tableId,
      tableVersion: r.roll.tableVersion,
      kind: r.kind,
      waifubux: r.roll.waifubux,
      essence: r.roll.essence,
      waifuXp: r.roll.waifuXp,
      playerXp: r.roll.playerXp,
      // Merged within the table, but deliberately *not* across tables: the
      // whole point is that the bonus stays separable from the success roll.
      items: mergeGrants(r.roll.items),
      ...(r.roll.equipment.length > 0 ? { equipment: r.roll.equipment } : {}),
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
  /** The plan's snapshotted gear pools; needed only when a table pays gear. */
  equipmentPools?: ExpeditionEquipmentPools | undefined;
}): ExpeditionRewardPayload {
  const { outcome, expeditionId, successTable, bonusTable, failureTable, equipmentPools } = input;
  const rolls: { roll: ExpeditionTableRoll; kind: RewardTableKind }[] = [];

  if (outcome === 'failure') {
    if (failureTable) {
      rolls.push({
        roll: rollExpeditionTable({ table: failureTable, expeditionId, kind: 'failure', equipmentPools }),
        kind: 'failure',
      });
    }
    return mergeRolls(rolls);
  }

  if (successTable) {
    rolls.push({
      roll: rollExpeditionTable({ table: successTable, expeditionId, kind: 'success', equipmentPools }),
      kind: 'success',
    });
  }
  // The bonus rides on top of the success roll above — it never replaces it.
  if (outcome === 'exceptional' && bonusTable) {
    rolls.push({
      roll: rollExpeditionTable({ table: bonusTable, expeditionId, kind: 'bonus', equipmentPools }),
      kind: 'bonus',
    });
  }
  return mergeRolls(rolls);
}
