/**
 * How Equipment 3.0 flat SP reads next to a Buddy's Current SP.
 *
 * Current SP stays the natural number every screen already shows. When the
 * equipped gear adds flat SP, the line gains what it adds and the combat SP
 * ATK / DEF / HP were derived from; without gear SP nothing changes, so every
 * existing screen reads exactly as before.
 */
import type { CombatSp } from '../modules/equipment/equipmentMath';

/** `''`, or ` · Gear +31 SP → 281 combat SP` (bold numbers when `bold`). */
export function gearSpSuffix(sp: CombatSp | null | undefined, opts: { bold?: boolean } = {}): string {
  if (!sp || sp.equipmentBonus <= 0) return '';
  const b = (v: number | string) => (opts.bold ? `**${v}**` : String(v));
  return ` · Gear ${b(`+${sp.equipmentBonus}`)} SP → ${b(sp.effective)} combat SP`;
}
