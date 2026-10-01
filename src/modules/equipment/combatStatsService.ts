/**
 * Combat stats — the one place a player's ATK / DEF / HP are calculated.
 *
 * Discord, the Portal, and every future combat system (Boss Attacks, Dungeon,
 * Raid) ask this service; none of them multiplies SP by a multiplier itself.
 * The arithmetic lives in `equipmentMath.ts`; this service only resolves the
 * inputs — the Buddy, her Current SP, and what is equipped — and hands them
 * over.
 *
 * **Never writes equipment state.** Previews (`slotOverrides`) are evaluated in
 * memory after the same ownership and slot checks `equip` performs, and are
 * never persisted. The only write reachable from here is the pre-existing
 * Buddy self-heal inside `resolveActiveBuddy`, which clears a pointer at a
 * released copy — the same behaviour every Buddy read in the game has.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { playerWaifus, species } from '../../db/schema';
import {
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  EquipmentValidationError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { OwnedEntry } from '../collection/collectionService';
import { currentSeductivePower } from '../power/seductivePower';
import type { EquipmentAffixCatalogue } from './affixCatalogue';
import {
  assembleCombatStats,
  emptySlots,
  type CombatBuddy,
  type CombatSlotItem,
  type CombatStats,
} from './equipmentMath';
import {
  readActiveLoadoutRow,
  readLoadoutSlotRows,
  readOwnedInstance,
  toCombatSlotItem,
} from './equipmentQueries';
import { isEquipmentSlot, type EquipmentSlot } from './vocabulary';

/** Which `CombatStats.stats` value each slot feeds. */
const SLOT_STAT_KEY: Readonly<Record<EquipmentSlot, keyof CombatStats['stats']>> = {
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
};

export interface CombatStatsOptions {
  /**
   * Calculate for this owned copy instead of the active Buddy (a "what if I
   * swapped Buddies" preview). Must be owned by the player and not released.
   */
  buddyWaifuId?: number;
  /**
   * Preview only: replace a slot's item with another owned instance, or with
   * nothing (`null`). Validated exactly as `equip` validates; never written.
   */
  slotOverrides?: Partial<Record<EquipmentSlot, number | null>>;
}

/** One candidate's result in {@link CombatStatsService.previewSlot}. */
export interface SlotCandidatePreview {
  equipmentId: number;
  /**
   * False when the id is not one of the player's own, unremoved instances for
   * this slot. Missing, foreign, removed and wrong-slot ids all read the same.
   */
  available: boolean;
  /** The slot's stat with this item equipped; null without a Buddy or when unavailable. */
  value: number | null;
  /** `value - current`; null whenever either side is null. */
  delta: number | null;
}

export interface SlotPreview {
  /** The live calculation, exactly as `calculateCombatStats` returns it. */
  stats: CombatStats;
  slot: EquipmentSlot;
  /** The slot's stat as things stand; null when the slot is empty or there is no Buddy. */
  current: number | null;
  candidates: SlotCandidatePreview[];
}

export interface CombatStatsService {
  calculateCombatStats(playerId: number, opts?: CombatStatsOptions): Promise<CombatStats>;
  /**
   * The same calculation inside the caller's transaction, for a combat system
   * that freezes the result at entry (a future Dungeon run or Boss Attack).
   * The returned object is the snapshot — self-describing and JSON-safe.
   */
  snapshotCombatStats(tx: DbOrTx, playerId: number): Promise<CombatStats>;
  /**
   * "What would this slot read with each of these items instead?" — the
   * comparison a management screen shows, for many candidates at once. The
   * Buddy and loadout are resolved once; each candidate is the same
   * calculation as a single-slot `slotOverrides` preview. Never writes, and
   * never throws for a bad candidate: it comes back `available: false`.
   */
  previewSlot(playerId: number, slot: EquipmentSlot, candidateIds: readonly number[]): Promise<SlotPreview>;
}

export interface CombatStatsServiceDeps {
  db: Db;
  /** `collection.resolveActiveBuddy` — the canonical, self-healing Buddy read. */
  resolveActiveBuddy(tx: DbOrTx, playerId: number): Promise<OwnedEntry | null>;
  /** `tables.waifuProgression.maxLevel`, read live so a content reload is followed. */
  getMaxLevel(): number;
  /** The affix catalogue, read live — names only; affixes never enter the arithmetic. */
  getAffixes(): EquipmentAffixCatalogue;
}

export function createCombatStatsService(deps: CombatStatsServiceDeps): CombatStatsService {
  const { db } = deps;

  function toCombatBuddy(entry: OwnedEntry): CombatBuddy {
    return {
      waifuId: entry.waifu.id,
      speciesSlug: entry.species.slug,
      name: entry.waifu.nickname?.trim() || entry.species.name,
      level: entry.waifu.level,
      baseSp: entry.waifu.baseSp,
      currentSp: currentSeductivePower(entry.waifu.baseSp, entry.waifu.level, deps.getMaxLevel()),
    };
  }

  async function resolveBuddy(tx: DbOrTx, playerId: number, buddyWaifuId?: number): Promise<CombatBuddy | null> {
    if (buddyWaifuId === undefined) {
      const entry = await deps.resolveActiveBuddy(tx, playerId);
      return entry ? toCombatBuddy(entry) : null;
    }
    // A malformed id is simply not a copy this player owns — refused here
    // rather than sent to Postgres as an invalid bigint.
    if (!Number.isInteger(buddyWaifuId) || buddyWaifuId <= 0) throw new WaifuNotOwnedError(buddyWaifuId);
    const [row] = await tx
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(
        and(
          eq(playerWaifus.id, buddyWaifuId),
          eq(playerWaifus.playerId, playerId),
          isNull(playerWaifus.releasedAt),
        ),
      );
    if (!row) throw new WaifuNotOwnedError(buddyWaifuId);
    return toCombatBuddy(row);
  }

  async function resolveSlots(
    tx: DbOrTx,
    playerId: number,
    overrides: CombatStatsOptions['slotOverrides'],
  ): Promise<{ loadoutId: number | null; slots: Record<EquipmentSlot, CombatSlotItem | null> }> {
    const slots = emptySlots();
    const loadout = await readActiveLoadoutRow(tx, playerId);
    if (loadout) {
      for (const row of await readLoadoutSlotRows(tx, loadout.id)) {
        slots[row.slot] = toCombatSlotItem(row.instance, row.definition, deps.getAffixes());
      }
    }
    for (const [slot, equipmentId] of Object.entries(overrides ?? {})) {
      if (!isEquipmentSlot(slot)) {
        throw new EquipmentValidationError([{ path: `slotOverrides.${slot}`, message: 'unknown slot' }]);
      }
      if (equipmentId === undefined) continue;
      if (equipmentId === null) {
        slots[slot] = null;
        continue;
      }
      const owned = await readOwnedInstance(tx, playerId, equipmentId);
      if (!owned) throw new EquipmentNotOwnedError(equipmentId);
      if (owned.instance.slot !== slot) {
        throw new EquipmentSlotMismatchError(equipmentId, slot, owned.instance.slot);
      }
      slots[slot] = toCombatSlotItem(owned.instance, owned.definition, deps.getAffixes());
    }
    return { loadoutId: loadout?.id ?? null, slots };
  }

  async function calculate(tx: DbOrTx, playerId: number, opts: CombatStatsOptions): Promise<CombatStats> {
    const buddy = await resolveBuddy(tx, playerId, opts.buddyWaifuId);
    const { loadoutId, slots } = await resolveSlots(tx, playerId, opts.slotOverrides);
    return assembleCombatStats({ buddy, loadoutId, slots });
  }

  return {
    calculateCombatStats(playerId, opts = {}) {
      return calculate(db, playerId, opts);
    },
    snapshotCombatStats(tx, playerId) {
      return calculate(tx, playerId, {});
    },
    async previewSlot(playerId, slot, candidateIds) {
      if (!isEquipmentSlot(slot)) {
        throw new EquipmentValidationError([{ path: 'slot', message: `unknown slot "${String(slot)}"` }]);
      }
      const buddy = await resolveBuddy(db, playerId);
      const { loadoutId, slots } = await resolveSlots(db, playerId, undefined);
      const stats = assembleCombatStats({ buddy, loadoutId, slots });
      const key = SLOT_STAT_KEY[slot];
      const current = stats.stats[key];
      const candidates: SlotCandidatePreview[] = [];
      for (const equipmentId of candidateIds) {
        const owned = await readOwnedInstance(db, playerId, equipmentId);
        if (!owned || owned.instance.slot !== slot) {
          candidates.push({ equipmentId, available: false, value: null, delta: null });
          continue;
        }
        const preview = assembleCombatStats({
          buddy,
          loadoutId,
          slots: { ...slots, [slot]: toCombatSlotItem(owned.instance, owned.definition, deps.getAffixes()) },
        });
        const value = preview.stats[key];
        candidates.push({
          equipmentId,
          available: true,
          value,
          delta: value != null && current != null ? value - current : null,
        });
      }
      return { stats, slot, current, candidates };
    },
  };
}
