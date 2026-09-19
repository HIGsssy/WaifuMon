/**
 * New-effect defaults — pure, no React.
 *
 * The server's `EffectSchema` (`src/modules/worldEncounters/types.ts`) is the
 * authority on what an effect must carry. Every effect the editor creates, or
 * re-types, starts from {@link newEffect}, which puts each required field that
 * has a sensible default *into the effect itself* — so what an input shows is
 * what Save sends. An input that displays a fallback the state does not hold
 * is exactly how a `give_item` once reached the server with no `quantity`.
 *
 * Fields with no sensible default (which item, which vendor, a buff key) are
 * left absent and shown empty; the author has to choose them.
 */
import type { EffectShape } from './EffectEditor';

/** Every World Encounter effect type, in the order the editor offers them. */
export const EFFECT_TYPES = [
  'waifubux_gain',
  'waifubux_loss',
  'waifubux_loss_percent',
  'essence_gain',
  'essence_loss',
  'energy_gain',
  'energy_loss',
  'player_xp',
  'buddy_xp',
  'affection_gain',
  'give_item',
  'consume_item',
  'trigger_encounter',
  'trigger_waifumon_encounter',
  'temp_buff',
  'open_vendor',
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** `give_item` / `consume_item` quantity: `z.number().int().positive().max(99)`. */
export const ITEM_QUANTITY_MIN = 1;
export const ITEM_QUANTITY_MAX = 99;

/**
 * Required-field defaults per effect type. Each entry, plus whatever the
 * author must pick, satisfies that type's schema member.
 */
const DEFAULTS: Record<EffectType, Record<string, unknown>> = {
  waifubux_gain: { amount: 100 },
  waifubux_loss: { amount: 50 },
  waifubux_loss_percent: { percent: 0.1 },
  essence_gain: { amount: 25 },
  essence_loss: { amount: 25 },
  energy_gain: { amount: 1 },
  energy_loss: { amount: 1 },
  player_xp: { amount: 10 },
  buddy_xp: { amount: 10 },
  affection_gain: { amount: 5 },
  give_item: { quantity: 1 },
  consume_item: { quantity: 1 },
  trigger_encounter: {},
  // `{ type }` alone is the valid legacy hunt-draw sighting.
  trigger_waifumon_encounter: {},
  temp_buff: { durationSeconds: 3600 },
  open_vendor: {},
};

/** Every field each type's schema member defines, besides `type`. */
const FIELDS: Record<EffectType, readonly string[]> = {
  waifubux_gain: ['amount'],
  waifubux_loss: ['amount'],
  waifubux_loss_percent: ['percent', 'maxAmount'],
  essence_gain: ['amount'],
  essence_loss: ['amount'],
  energy_gain: ['amount'],
  energy_loss: ['amount'],
  player_xp: ['amount'],
  buddy_xp: ['amount'],
  affection_gain: ['amount'],
  give_item: ['slug', 'quantity'],
  consume_item: ['slug', 'quantity'],
  trigger_encounter: ['encounterSlug'],
  trigger_waifumon_encounter: ['speciesSlug', 'selection'],
  temp_buff: ['key', 'durationSeconds', 'payload'],
  open_vendor: ['vendorKey'],
};

/** A fresh effect of `type`, carrying every required field that has a default. */
export function newEffect(type: string): EffectShape {
  return { type, ...(isEffectType(type) ? DEFAULTS[type] : {}) };
}

function isEffectType(type: string): type is EffectType {
  return (EFFECT_TYPES as readonly string[]).includes(type);
}

/**
 * Re-type an effect. The result is the new type's defaults, plus any field the
 * new type *also* defines that the author already set (a `give_item`'s item
 * and quantity survive a switch to `consume_item`; an `amount` survives
 * `waifubux_gain` → `essence_gain`). Fields the new type does not define are
 * dropped, never carried along — the Waifumon sighting is `.strict()` on the
 * server, and stale fields elsewhere would only be stripped silently.
 */
export function switchEffectType(effect: EffectShape, type: string): EffectShape {
  const next = newEffect(type);
  for (const field of isEffectType(type) ? FIELDS[type] : []) {
    if (effect[field] !== undefined) next[field] = effect[field];
  }
  return next;
}

/**
 * Unfinished item effects, as author-facing text (empty when valid). Checked
 * before Save, so an unpicked item or an out-of-range quantity blocks the save
 * rather than reaching the server as a malformed payload.
 */
export function itemEffectIssues(effect: EffectShape): string[] {
  if (effect.type !== 'give_item' && effect.type !== 'consume_item') return [];
  const issues: string[] = [];
  if (typeof effect.slug !== 'string' || effect.slug === '') issues.push('pick an item.');
  const q = effect.quantity;
  if (
    typeof q !== 'number' ||
    !Number.isInteger(q) ||
    q < ITEM_QUANTITY_MIN ||
    q > ITEM_QUANTITY_MAX
  ) {
    issues.push(
      `quantity must be a whole number from ${ITEM_QUANTITY_MIN} to ${ITEM_QUANTITY_MAX}.`,
    );
  }
  return issues;
}
