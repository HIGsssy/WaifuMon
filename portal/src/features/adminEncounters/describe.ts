/**
 * Plain-language summaries of what an encounter's choices do — pure, no React.
 *
 * The stored shapes stay exactly as they are (`energy_gain: 3`); these turn
 * them into what an author reads on a collapsed choice card ("Gain 3 Energy").
 * Names come from lookups the caller supplies, so a summary never shows a raw
 * slug when the content knows a better name — and falls back to the slug,
 * never to nothing, when it does not.
 */
import { summarizeEffect as summarizeSighting, WAIFUMON_EFFECT } from './waifumonSelection';
import { formatDuration } from './duration';

export interface NameLookups {
  item?: (slug: string) => string | undefined;
  encounter?: (slug: string) => string | undefined;
  vendor?: (key: string) => string | undefined;
  species?: (slug: string) => string | undefined;
  equipment?: (key: string) => string | undefined;
}

/** Author-facing names for the effect-type picker, in the stored type's order. */
export const EFFECT_TYPE_LABELS: Record<string, string> = {
  waifubux_gain: 'Gain Waifubux',
  waifubux_loss: 'Lose Waifubux',
  waifubux_loss_percent: 'Lose a % of Waifubux',
  essence_gain: 'Gain Essence',
  essence_loss: 'Lose Essence',
  energy_gain: 'Gain Energy',
  energy_loss: 'Lose Energy',
  player_xp: 'Player XP',
  buddy_xp: 'Buddy XP',
  affection_gain: 'Buddy Affection',
  give_item: 'Give an item',
  give_equipment: 'Give equipment',
  consume_item: 'Consume an item',
  trigger_encounter: 'Continue to another encounter',
  trigger_waifumon_encounter: 'Waifumon sighting',
  temp_buff: 'Temporary buff',
  open_vendor: 'Open a vendor',
};

const num = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');

function named(
  lookup: ((key: string) => string | undefined) | undefined,
  key: unknown,
  missing: string,
): string {
  if (typeof key !== 'string' || key === '') return missing;
  return lookup?.(key) ?? key;
}

/** One effect as a short sentence: "Gain 3 Energy", "Consume 1 × Basic Charm". */
export function describeEffect(effect: Record<string, unknown>, names: NameLookups = {}): string {
  const amount = num(effect.amount);
  switch (effect.type) {
    case 'waifubux_gain':
      return `Gain ${amount} Waifubux`;
    case 'waifubux_loss':
      return `Lose ${amount} Waifubux`;
    case 'waifubux_loss_percent': {
      const pct =
        typeof effect.percent === 'number' ? `${Math.round(effect.percent * 1000) / 10}%` : '?%';
      const cap = typeof effect.maxAmount === 'number' ? ` (at most ${num(effect.maxAmount)})` : '';
      return `Lose ${pct} of Waifubux${cap}`;
    }
    case 'essence_gain':
      return `Gain ${amount} Essence`;
    case 'essence_loss':
      return `Lose ${amount} Essence`;
    case 'energy_gain':
      return `Gain ${amount} Energy`;
    case 'energy_loss':
      return `Lose ${amount} Energy`;
    case 'player_xp':
      return `+${amount} Player XP`;
    case 'buddy_xp':
      return `+${amount} Buddy XP`;
    case 'affection_gain':
      return `+${amount} Buddy Affection`;
    case 'give_item':
      return `Give ${num(effect.quantity)} × ${named(names.item, effect.slug, '(no item picked)')}`;
    case 'give_equipment': {
      const keys = Array.isArray(effect.definitionKeys) ? (effect.definitionKeys as string[]) : [];
      const rarity = typeof effect.rarity === 'string' ? `${effect.rarity} ` : '';
      const slot = typeof effect.slot === 'string' ? `${effect.slot} ` : '';
      if (keys.length > 0) {
        return `Give one of: ${keys.map((k) => named(names.equipment, k, k)).join(', ')}`;
      }
      return `Give random ${rarity}${slot}equipment`;
    }
    case 'consume_item':
      return `Consume ${num(effect.quantity)} × ${named(names.item, effect.slug, '(no item picked)')}`;
    case 'trigger_encounter':
      return `Continue to ${named(names.encounter, effect.encounterSlug, '(no encounter picked)')}`;
    case WAIFUMON_EFFECT:
      return summarizeSighting(effect, names.species);
    case 'temp_buff': {
      const key = typeof effect.key === 'string' && effect.key ? `“${effect.key}”` : '(no key)';
      const secs = typeof effect.durationSeconds === 'number' ? effect.durationSeconds : 0;
      return `Buff ${key} for ${formatDuration(secs)}`;
    }
    case 'open_vendor':
      return `Open vendor: ${named(names.vendor, effect.vendorKey, '(no vendor picked)')}`;
    default:
      return String(effect.type ?? 'Unknown effect');
  }
}

/** A list of effects, comma-joined; "Nothing" when empty. */
export function describeEffects(
  effects: ReadonlyArray<Record<string, unknown>>,
  names: NameLookups = {},
): string {
  return effects.length === 0 ? 'Nothing' : effects.map((e) => describeEffect(e, names)).join(', ');
}

export interface RequirementShape {
  affinity?: string | undefined;
  raceAny?: string[] | undefined;
  minPlayerLevel?: number | undefined;
  minBuddyLevel?: number | undefined;
  requiresItem?: string | undefined;
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "None", or every requirement joined: "Owns Basic Charm · Player level 10+". */
export function describeRequirements(req: RequirementShape, names: NameLookups = {}): string {
  const parts: string[] = [];
  if (req.requiresItem) parts.push(`Owns ${named(names.item, req.requiresItem, '?')}`);
  if (req.minPlayerLevel) parts.push(`Player level ${req.minPlayerLevel}+`);
  if (req.minBuddyLevel) parts.push(`Buddy level ${req.minBuddyLevel}+`);
  if (req.affinity) parts.push(`${title(req.affinity)} buddy`);
  if (req.raceAny && req.raceAny.length > 0) {
    parts.push(`${req.raceAny.map(title).join(' or ')} buddy`);
  }
  return parts.length === 0 ? 'None' : parts.join(' · ');
}

export interface CheckShape {
  type: string;
  baseChance?: number | undefined;
  maxSpModifier?: number | undefined;
  difficulty?: number | undefined;
}

/** "Automatic", "Skill check · 40% base, ±15% from Buddy SP", "Skill check (legacy) · difficulty 50". */
export function describeCheck(check: CheckShape): string {
  if (check.type !== 'sp') return 'Automatic';
  if (check.baseChance === undefined && check.difficulty !== undefined) {
    return `Skill check (legacy) · difficulty ${check.difficulty}`;
  }
  const base = Math.round((check.baseChance ?? 0.4) * 100);
  const sp = Math.round((check.maxSpModifier ?? 0.15) * 100);
  return sp > 0
    ? `Skill check · ${base}% base, ±${sp}% from Buddy SP`
    : `Skill check · ${base}% base`;
}
