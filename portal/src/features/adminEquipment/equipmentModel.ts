/**
 * The Equipment Catalogue editor's form model: the author-facing shape of a
 * definition (percent-free, but multipliers shown as ×1.25 rather than basis
 * points), and the conversion to and from the API input.
 *
 * Business rules stay on the server. What lives here is only presentation:
 * which fields a rarity *shows*, a key-shape hint before the round trip, and
 * the words that explain what each field affects.
 */
import { isPortalApiError } from '@/api/client';
import {
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  HIGH_RARITIES,
  type CatalogueDefinition,
  type EquipmentDefinitionInput,
  type EquipmentIssue,
  type EquipmentRarity,
  type EquipmentSlotName,
  type RewardImpactEntry,
} from '@/api/adminEquipment';

export interface EquipmentForm {
  key: string;
  name: string;
  description: string;
  slot: EquipmentSlotName;
  rarity: EquipmentRarity;
  /** Multipliers as decimals an author types (`1.25`), converted to basis points on save. */
  multiplierMin: string;
  multiplierMax: string;
  multiplierStep: string;
  primarySpEligible: boolean;
  /** `''` = the rarity's own maximum. */
  maxAdditionalBonuses: '' | '0' | '1' | '2' | '3';
  tags: string;
  regionId: string;
  artworkPath: string;
  /** Kept from the stored definition; the editor never changes these. */
  enabled: boolean;
  secondaryEffects: unknown[];
  shopRegions: string[];
  buyPrice: number | null;
  priceCurrency: string;
}

export const isHighRarity = (rarity: string): boolean =>
  (HIGH_RARITIES as readonly string[]).includes(rarity);

const decimal = (bp: number) => String(bp / 10_000);

export function blankForm(): EquipmentForm {
  return {
    key: '',
    name: '',
    description: '',
    slot: 'attack',
    rarity: 'N',
    multiplierMin: '0.4',
    multiplierMax: '0.6',
    multiplierStep: '0.05',
    primarySpEligible: false,
    maxAdditionalBonuses: '',
    tags: '',
    regionId: '',
    artworkPath: '',
    enabled: false,
    secondaryEffects: [],
    shopRegions: [],
    buyPrice: null,
    priceCurrency: 'waifubux',
  };
}

export function formOf(definition: CatalogueDefinition | EquipmentDefinitionInput): EquipmentForm {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    slot: definition.slot,
    rarity: definition.rarity,
    multiplierMin: decimal(definition.multiplierMinBp),
    multiplierMax: decimal(definition.multiplierMaxBp),
    multiplierStep: decimal(definition.multiplierStepBp),
    primarySpEligible: definition.primarySpEligible,
    maxAdditionalBonuses:
      definition.maxAdditionalBonuses === null
        ? ''
        : (String(definition.maxAdditionalBonuses) as EquipmentForm['maxAdditionalBonuses']),
    tags: definition.tags.join(', '),
    regionId: definition.regionId ?? '',
    artworkPath: definition.artworkPath ?? '',
    enabled: definition.enabled,
    secondaryEffects: definition.secondaryEffects,
    shopRegions: definition.shopRegions,
    buyPrice: definition.buyPrice,
    priceCurrency: definition.priceCurrency,
  };
}

/** `1.25` → `12500`; anything unreadable passes through as NaN for the server to name. */
function basisPoints(value: string): number {
  const n = Number(value.trim());
  return Number.isFinite(n) ? Math.round(n * 10_000) : Number.NaN;
}

/**
 * The API input. A legacy rarity always sends the defaults for the
 * high-rarity fields, so switching rarity back to N/R/SR never submits a
 * policy the server would refuse.
 */
export function inputOf(form: EquipmentForm): EquipmentDefinitionInput {
  const high = isHighRarity(form.rarity);
  return {
    key: form.key.trim(),
    name: form.name.trim(),
    description: form.description,
    slot: form.slot,
    rarity: form.rarity,
    multiplierMinBp: basisPoints(form.multiplierMin),
    multiplierMaxBp: basisPoints(form.multiplierMax),
    multiplierStepBp: basisPoints(form.multiplierStep),
    primarySpEligible: high ? form.primarySpEligible : false,
    maxAdditionalBonuses:
      high && form.maxAdditionalBonuses !== '' ? Number(form.maxAdditionalBonuses) : null,
    secondaryEffects: form.secondaryEffects,
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    regionId: form.regionId.trim() === '' ? null : form.regionId.trim(),
    artworkPath: form.artworkPath.trim() === '' ? null : form.artworkPath.trim(),
    enabled: form.enabled,
    shopRegions: form.shopRegions,
    buyPrice: form.buyPrice,
    priceCurrency: form.priceCurrency,
  };
}

/** A key-shape hint before the round trip; the server is the authority. */
export function keyError(key: string): string | null {
  if (key.trim() === '') return 'Enter a key.';
  if (key.length > EQUIPMENT_KEY_MAX_LENGTH)
    return `Keys are at most ${EQUIPMENT_KEY_MAX_LENGTH} characters.`;
  if (!EQUIPMENT_KEY_PATTERN.test(key))
    return 'Use lower_snake_case: lowercase letters, digits and single underscores.';
  return null;
}

/** A key made from a name: `Relic Blade!` → `relic_blade`. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, EQUIPMENT_KEY_MAX_LENGTH);
}

/** Issues at `path` (and below it). */
export function issuesAt(issues: readonly EquipmentIssue[], path: string): EquipmentIssue[] {
  return issues.filter(
    (i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`),
  );
}

/** Server paths in basis points name the decimal field the author typed. */
export const FIELD_PATHS: Record<string, string[]> = {
  multiplierMin: ['multiplierMinBp'],
  multiplierMax: ['multiplierMaxBp'],
  multiplierStep: ['multiplierStepBp'],
};

/** What changing a field does, in the three ways an author needs to know. */
export const FIELD_EFFECTS = {
  future: 'Future rolls only — copies players already own keep what they rolled.',
  display: 'Changes how existing copies are shown (never their stats).',
  locked: 'Fixed once any copy exists, because owned copies were made as this.',
} as const;

export const SOURCE_LABELS: Record<RewardImpactEntry['source'], string> = {
  boss_reward_table: 'Boss reward table',
  expedition_reward_table: 'Expedition reward table',
  world_encounter: 'World Encounter',
  workshop_recipe: 'Workshop recipe',
  dungeon_loot_table: 'Dungeon loot table',
};

export const WHEN_LABELS: Record<RewardImpactEntry['when'], string> = {
  immediately: 'immediately',
  next_deploy: 'from the next mission deployed',
  next_publish: 'the next time a dungeon using it is published',
};

export function equipmentPath(key: string): string {
  return `/admin/equipment/${encodeURIComponent(key)}`;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** `0.4444` → `44.4%`. */
export function formatProbability(p: number): string {
  const percent = p * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** The issues a 400 carried, if any. */
export function refusedIssues(error: unknown): EquipmentIssue[] {
  if (!isPortalApiError(error)) return [];
  if (error.code !== 'EQUIPMENT_INVALID' && error.code !== 'EQUIPMENT_IMPORT_REJECTED') return [];
  return ((error.details ?? {}) as { issues?: EquipmentIssue[] }).issues ?? [];
}
