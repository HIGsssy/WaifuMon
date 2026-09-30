/**
 * Read-only equipment queries and views, shared by `equipmentService` (the
 * only writer) and `combatStatsService` (which never writes).
 *
 * Nothing in this file inserts, updates or deletes — `equipmentBoundary.test.ts`
 * holds it to that — so the stat service can read loadouts through it without
 * depending on the service that mutates them.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import {
  equipmentDefinitions,
  playerEquipment,
  playerLoadoutSlots,
  playerLoadouts,
  type EquipmentDefinitionRow,
  type PlayerEquipmentRow,
  type PlayerLoadoutRow,
} from '../../db/schema';
import { ownSlotMultiplierBp, type CombatSlotItem } from './equipmentMath';
import type { EquipmentSlot } from './vocabulary';

/** A definition as clients see it. Never carries the internal id. */
export interface EquipmentDefinitionView {
  key: string;
  name: string;
  description: string;
  slot: EquipmentSlot;
  rarity: string;
  attackBp: number;
  defenseBp: number;
  healthBp: number;
  /** The multiplier this definition applies to its own slot's stat. */
  multiplierBp: number;
  tags: string[];
  regionId: string | null;
  artworkPath: string | null;
  enabled: boolean;
}

/** One owned instance as clients see it. */
export interface EquipmentInstanceView {
  id: number;
  slot: EquipmentSlot;
  definition: EquipmentDefinitionView;
  rolledProperties: Record<string, unknown>;
  isFavorite: boolean;
  isLocked: boolean;
  sourceType: string;
  sourceKey: string | null;
  acquiredAt: Date;
  /** Whether the instance sits in the player's *active* loadout. */
  equipped: boolean;
}

/** The active loadout. `loadoutId` is null until the first write creates one. */
export interface LoadoutView {
  loadoutId: number | null;
  name: string;
  slots: Record<EquipmentSlot, EquipmentInstanceView | null>;
}

export function toDefinitionView(row: EquipmentDefinitionRow): EquipmentDefinitionView {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    slot: row.slot as EquipmentSlot,
    rarity: row.rarity,
    attackBp: row.attackBp,
    defenseBp: row.defenseBp,
    healthBp: row.healthBp,
    multiplierBp: ownSlotMultiplierBp(row),
    tags: row.tags,
    regionId: row.regionId,
    artworkPath: row.artworkPath,
    enabled: row.enabled,
  };
}

export function toInstanceView(
  instance: PlayerEquipmentRow,
  definition: EquipmentDefinitionRow,
  equipped: boolean,
): EquipmentInstanceView {
  return {
    id: instance.id,
    slot: instance.slot as EquipmentSlot,
    definition: toDefinitionView(definition),
    rolledProperties: instance.rolledProperties,
    isFavorite: instance.isFavorite,
    isLocked: instance.isLocked,
    sourceType: instance.sourceType,
    sourceKey: instance.sourceKey,
    acquiredAt: instance.acquiredAt,
    equipped,
  };
}

/** What the combat calculation needs to know about one equipped instance. */
export function toCombatSlotItem(
  instance: PlayerEquipmentRow,
  definition: EquipmentDefinitionRow,
): CombatSlotItem {
  return {
    equipmentId: instance.id,
    definitionKey: definition.key,
    name: definition.name,
    rarity: definition.rarity,
    // The *instance's* slot decides which multiplier applies. It equals the
    // definition's by construction (copied at grant; slot is immutable once
    // referenced), and reading it from the instance keeps that true even if
    // a definition were edited underneath by hand.
    multiplierBp: ownSlotMultiplierBp({ ...definition, slot: instance.slot }),
    rolledProperties: instance.rolledProperties,
  };
}

export async function readActiveLoadoutRow(
  tx: DbOrTx,
  playerId: number,
): Promise<PlayerLoadoutRow | null> {
  const [row] = await tx
    .select()
    .from(playerLoadouts)
    .where(and(eq(playerLoadouts.playerId, playerId), eq(playerLoadouts.isActive, true)));
  return row ?? null;
}

/** The instances in one loadout's slots, with their definitions. */
export async function readLoadoutSlotRows(
  tx: DbOrTx,
  loadoutId: number,
): Promise<{ slot: EquipmentSlot; instance: PlayerEquipmentRow; definition: EquipmentDefinitionRow }[]> {
  const rows = await tx
    .select({
      slot: playerLoadoutSlots.slot,
      instance: playerEquipment,
      definition: equipmentDefinitions,
    })
    .from(playerLoadoutSlots)
    .innerJoin(playerEquipment, eq(playerLoadoutSlots.equipmentId, playerEquipment.id))
    .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
    .where(eq(playerLoadoutSlots.loadoutId, loadoutId))
    .orderBy(asc(playerLoadoutSlots.slot));
  return rows.map((r) => ({ ...r, slot: r.slot as EquipmentSlot }));
}

/** The player's active loadout as a view; a virtual empty one when none exists. */
export async function readActiveLoadoutView(tx: DbOrTx, playerId: number): Promise<LoadoutView> {
  const loadout = await readActiveLoadoutRow(tx, playerId);
  const slots: Record<EquipmentSlot, EquipmentInstanceView | null> = {
    attack: null,
    defense: null,
    health: null,
  };
  if (!loadout) return { loadoutId: null, name: 'Default', slots };
  for (const row of await readLoadoutSlotRows(tx, loadout.id)) {
    slots[row.slot] = toInstanceView(row.instance, row.definition, true);
  }
  return { loadoutId: loadout.id, name: loadout.name, slots };
}

/**
 * One instance the player owns and has not had removed, or null.
 *
 * "Missing", "someone else's" and "removed" are indistinguishable here on
 * purpose, so every caller refuses all three with the same error.
 */
export async function readOwnedInstance(
  tx: DbOrTx,
  playerId: number,
  equipmentId: number,
  opts: {
    /**
     * Row-lock the instance (never the definition). `share` is what equip
     * takes: it conflicts with the `update` lock admin removal holds, and
     * Postgres re-evaluates `removed_at IS NULL` against the committed row
     * after waiting — so an instance removed while we waited reads as missing.
     */
    lock?: 'share' | 'update';
  } = {},
): Promise<{ instance: PlayerEquipmentRow; definition: EquipmentDefinitionRow } | null> {
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) return null;
  const query = tx
    .select({ instance: playerEquipment, definition: equipmentDefinitions })
    .from(playerEquipment)
    .innerJoin(equipmentDefinitions, eq(playerEquipment.definitionId, equipmentDefinitions.id))
    .where(
      and(
        eq(playerEquipment.id, equipmentId),
        eq(playerEquipment.playerId, playerId),
        isNull(playerEquipment.removedAt),
      ),
    );
  const [row] = opts.lock
    ? await query.for(opts.lock, { of: playerEquipment })
    : await query;
  return row ?? null;
}
