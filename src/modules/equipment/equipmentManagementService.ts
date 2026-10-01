/**
 * Equipment management — the read models and actions behind a quick-management
 * screen (Discord today; nothing here is Discord-specific).
 *
 * A thin orchestration layer over the domain services. It owns no state and
 * writes nothing itself: equip, unequip and flags go through
 * `equipmentService`, every number comes from `combatStatsService`. What it
 * adds is the one rule every screen needs: **the Equipment feature must be
 * unlocked** — enforced here, on every read as well as every write, so a
 * forged or stale button from a locked player reaches nothing.
 *
 * Every call re-reads authoritative state. Nothing is cached between calls:
 * a Buddy changed elsewhere, gear removed by an admin, or a slot changed in
 * another window all show up on the next screen.
 */
import { FeatureLockedError, EquipmentNotOwnedError } from '../../shared/errors';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { CombatStatsService, SlotCandidatePreview } from './combatStatsService';
import type { CombatStats } from './equipmentMath';
import type { EquipmentInstanceView } from './equipmentQueries';
import type { EquipmentGroup, EquipmentService } from './equipmentService';
import {
  GEAR_BAG_PAGE_SIZE,
  filterGearBagGroups,
  filterSlot,
  groupFocusId,
  paginate,
  sortGearBagGroups,
  type GearBagFilter,
  type Page,
} from './gearBag';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from './vocabulary';

/** Slot screens list this many candidates per page. */
export const SLOT_PAGE_SIZE = 10;

export interface HomeView {
  stats: CombatStats;
}

export interface SlotCandidate {
  group: EquipmentGroup;
  /** The copy that would be equipped: an unequipped one. */
  equipmentId: number;
  preview: SlotCandidatePreview;
}

export interface SlotView {
  slot: EquipmentSlot;
  stats: CombatStats;
  /** What the slot holds now, or null. */
  equipped: EquipmentInstanceView | null;
  /** The slot's stat now; null when empty or without a Buddy. */
  current: number | null;
  candidates: Page<SlotCandidate>;
}

export interface BagEntry {
  group: EquipmentGroup;
  /** The copy the entry opens: the equipped one if any, else the representative. */
  focusId: number;
}

export interface BagView {
  filter: GearBagFilter;
  entries: Page<BagEntry>;
}

export interface ItemView {
  instance: EquipmentInstanceView;
  /** Every copy of this definition the player holds (the item included). */
  copies: number[];
  /** Copies of this definition equipped right now (0 or 1 in V1). */
  equippedCopies: number;
  /** What the item's slot holds now, or null. */
  slotEquipped: EquipmentInstanceView | null;
  current: number | null;
  preview: SlotCandidatePreview;
  stats: CombatStats;
}

export interface SlotChangeOutcome {
  slot: EquipmentSlot;
  changed: boolean;
  /** The item now in the slot (equip) or the one taken out (unequip). */
  item: EquipmentInstanceView | null;
  /** The slot's stat before and after, both from the combat-stat service. */
  before: number | null;
  after: number | null;
}

export type EquipmentFlag = 'favorite' | 'locked';

export interface EquipmentManagementService {
  home(playerId: number): Promise<HomeView>;
  slot(playerId: number, slot: EquipmentSlot, page: number): Promise<SlotView>;
  bag(playerId: number, filter: GearBagFilter, page: number): Promise<BagView>;
  /** Throws `EquipmentNotOwnedError` for missing, foreign and removed ids alike. */
  item(playerId: number, equipmentId: number): Promise<ItemView>;
  /** `expectedCurrentId` is what the screen showed in the slot (null = empty). */
  equip(playerId: number, equipmentId: number, expectedCurrentId: number | null): Promise<SlotChangeOutcome>;
  unequip(playerId: number, slot: EquipmentSlot, expectedCurrentId: number | null): Promise<SlotChangeOutcome>;
  /** Sets (not toggles) one flag, so a doubled click lands on the same value. */
  setFlag(playerId: number, equipmentId: number, flag: EquipmentFlag, value: boolean): Promise<EquipmentInstanceView>;
}

export interface EquipmentManagementDeps {
  equipment: Pick<
    EquipmentService,
    'listEquipmentGroups' | 'getActiveLoadout' | 'getOwned' | 'equip' | 'unequip' | 'setFlags'
  >;
  combatStats: Pick<CombatStatsService, 'calculateCombatStats' | 'previewSlot'>;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
}

const SLOT_STAT: Readonly<Record<EquipmentSlot, keyof CombatStats['stats']>> = {
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
};

export function createEquipmentManagementService(deps: EquipmentManagementDeps): EquipmentManagementService {
  const { equipment, combatStats, featureUnlocks } = deps;

  async function requireUnlocked(playerId: number): Promise<void> {
    if (!(await featureUnlocks.isUnlocked(playerId, 'equipment'))) throw new FeatureLockedError('equipment');
  }

  async function equippedIds(playerId: number): Promise<Set<number>> {
    const loadout = await equipment.getActiveLoadout(playerId);
    return new Set(EQUIPMENT_SLOTS.flatMap((slot) => (loadout.slots[slot] ? [loadout.slots[slot]!.id] : [])));
  }

  async function slotValue(playerId: number, slot: EquipmentSlot): Promise<number | null> {
    return (await combatStats.calculateCombatStats(playerId)).stats[SLOT_STAT[slot]];
  }

  return {
    async home(playerId) {
      await requireUnlocked(playerId);
      return { stats: await combatStats.calculateCombatStats(playerId) };
    },

    async slot(playerId, slot, page) {
      await requireUnlocked(playerId);
      const loadout = await equipment.getActiveLoadout(playerId);
      const equipped = loadout.slots[slot];
      const groups = await equipment.listEquipmentGroups(playerId, { slot, sort: 'multiplier' });
      // Another copy of what is already equipped would change nothing.
      const options = groups
        .filter((g) => g.definition.key !== equipped?.definition.key)
        .map((group) => ({ group, equipmentId: group.representativeId }));
      const paged = paginate(options, page, SLOT_PAGE_SIZE);
      const preview = await combatStats.previewSlot(
        playerId,
        slot,
        paged.items.map((o) => o.equipmentId),
      );
      return {
        slot,
        stats: preview.stats,
        equipped,
        current: preview.current,
        candidates: {
          ...paged,
          items: paged.items.map((o, i) => ({ ...o, preview: preview.candidates[i]! })),
        },
      };
    },

    async bag(playerId, filter, page) {
      await requireUnlocked(playerId);
      const slot = filterSlot(filter);
      const [groups, equippedSet] = await Promise.all([
        equipment.listEquipmentGroups(playerId, slot ? { slot } : {}),
        equippedIds(playerId),
      ]);
      const ordered = sortGearBagGroups(filterGearBagGroups(groups, filter));
      const entries = paginate(
        ordered.map((group) => ({ group, focusId: groupFocusId(group, equippedSet) })),
        page,
        GEAR_BAG_PAGE_SIZE,
      );
      return { filter, entries };
    },

    async item(playerId, equipmentId) {
      await requireUnlocked(playerId);
      const instance = await equipment.getOwned(playerId, equipmentId);
      if (!instance) throw new EquipmentNotOwnedError(equipmentId);
      const [groups, loadout, preview] = await Promise.all([
        equipment.listEquipmentGroups(playerId, { definitionKey: instance.definition.key }),
        equipment.getActiveLoadout(playerId),
        combatStats.previewSlot(playerId, instance.slot, [instance.id]),
      ]);
      const group = groups[0];
      return {
        instance,
        copies: group?.instanceIds ?? [instance.id],
        equippedCopies: group?.equippedCount ?? (instance.equipped ? 1 : 0),
        slotEquipped: loadout.slots[instance.slot],
        current: preview.current,
        preview: preview.candidates[0]!,
        stats: preview.stats,
      };
    },

    async equip(playerId, equipmentId, expectedCurrentId) {
      await requireUnlocked(playerId);
      const instance = await equipment.getOwned(playerId, equipmentId);
      if (!instance) throw new EquipmentNotOwnedError(equipmentId);
      const before = await slotValue(playerId, instance.slot);
      const result = await equipment.equip(playerId, {
        slot: instance.slot,
        equipmentId,
        expectedCurrentId,
      });
      return {
        slot: instance.slot,
        changed: result.changed,
        item: instance,
        before,
        after: await slotValue(playerId, instance.slot),
      };
    },

    async unequip(playerId, slot, expectedCurrentId) {
      await requireUnlocked(playerId);
      const loadout = await equipment.getActiveLoadout(playerId);
      const removedItem = loadout.slots[slot];
      const before = await slotValue(playerId, slot);
      const result = await equipment.unequip(playerId, { slot, expectedCurrentId });
      // Report what the service actually took out, read under its lock.
      const taken =
        !result.changed || result.previousEquipmentId == null
          ? null
          : removedItem?.id === result.previousEquipmentId
            ? removedItem
            : await equipment.getOwned(playerId, result.previousEquipmentId);
      return {
        slot,
        changed: result.changed,
        item: taken,
        before,
        after: await slotValue(playerId, slot),
      };
    },

    async setFlag(playerId, equipmentId, flag, value) {
      await requireUnlocked(playerId);
      return equipment.setFlags(playerId, equipmentId, flag === 'favorite' ? { isFavorite: value } : { isLocked: value });
    },
  };
}
