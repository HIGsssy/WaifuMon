/**
 * Equipment presentation — labels and number formatting only.
 *
 * Every value formatted here arrived from the API already decided: stats come
 * from the combat-stat service, roll quality is computed server-side, and a
 * multiplier is the copy's own roll. Nothing in this file derives a number.
 */
import { Heart, Shield, Swords, type LucideIcon } from 'lucide-react';

import type { EquipmentSlot, EquipmentStat } from '@/api/types';

export const SLOTS: readonly EquipmentSlot[] = ['attack', 'defense', 'health'];

export const SLOT_LABEL: Readonly<Record<EquipmentSlot, string>> = {
  attack: 'Attack',
  defense: 'Defense',
  health: 'Health',
};

export const SLOT_ICON: Readonly<Record<EquipmentSlot, LucideIcon>> = {
  attack: Swords,
  defense: Shield,
  health: Heart,
};

/** Which stat each slot feeds — mirrors the API's `comparison.stat`. */
export const SLOT_STAT: Readonly<Record<EquipmentSlot, EquipmentStat>> = {
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
};

export const STAT_LABEL: Readonly<Record<EquipmentStat, string>> = {
  attack: 'ATK',
  defense: 'DEF',
  maxHp: 'HP',
};

/** `0.8` → `×0.80`. */
export function formatMultiplier(multiplier: number): string {
  return `×${multiplier.toFixed(2)}`;
}

/** `{ min: 0.65, max: 0.85 }` → `×0.65–0.85`; a single-value range reads `×0.50`. */
export function formatRange(range: { min: number; max: number }): string {
  return range.min === range.max
    ? formatMultiplier(range.min)
    : `×${range.min.toFixed(2)}–${range.max.toFixed(2)}`;
}

/** A stat value, or an em dash when the API reports it unavailable (null). */
export function formatStat(value: number | null): string {
  return value == null ? '—' : value.toLocaleString();
}

/** `12` → `+12`, `-3` → `−3`, `0` → `±0`. */
export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta.toLocaleString()}`;
  if (delta < 0) return `−${Math.abs(delta).toLocaleString()}`;
  return '±0';
}
