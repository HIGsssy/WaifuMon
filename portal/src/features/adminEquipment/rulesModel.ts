/** Lossless author-facing numeric strings. Invalid precision is refused, never rounded. */
import type { EquipmentIssue, EquipmentSlotName } from '@/api/adminEquipment';
import type { ManagedRarityRule, ManagedRuleRarity, RollRules } from '@/api/adminEquipmentRules';

export const MANAGED_RARITIES = ['SSR', 'UR', 'LR'] as const;
export const FAMILY_LABELS = {
  crit_chance_bp: 'Critical chance',
  crit_damage_bonus_bp: 'Critical damage bonus',
  double_attack_chance_bp: 'Double attack chance',
  armor_penetration_bp: 'Armor penetration',
  lifesteal_bp: 'Lifesteal',
  flat_sp: 'Flat SP',
} as const;
export type FamilyStat = keyof typeof FAMILY_LABELS;
export interface FamilyForm {
  stat: FamilyStat;
  enabled: boolean;
  slots: EquipmentSlotName[];
  minValue: string;
  maxValue: string;
  step: string;
}
export interface RarityForm {
  weights: string[];
  families: FamilyForm[];
  primary: { chance: string; min: string; max: string; step: string } | null;
  library: string;
}
export interface RulesForm {
  rarities: Partial<Record<ManagedRuleRarity, RarityForm>>;
  perItemMax: string;
  perLoadoutMax: string;
}
export const percent = (bp: number) => String(bp / 100);
export const emptyRarity = (): RarityForm => ({
  weights: ['', '', '', ''],
  families: [],
  primary: null,
  library: '',
});
export function formOfRules(rules: RollRules): RulesForm {
  return {
    perItemMax: String(rules.flatSpLimits.perItemMax),
    perLoadoutMax: String(rules.flatSpLimits.perLoadoutMax),
    rarities: Object.fromEntries(
      MANAGED_RARITIES.flatMap((rarity) => {
        const rule = rules.rarities[rarity];
        return rule
          ? [
              [
                rarity,
                {
                  weights: rule.bonusCountWeightsBp.map(percent),
                  families: rule.families.map((f) => ({
                    ...f,
                    minValue: f.stat === 'flat_sp' ? String(f.minValue) : percent(f.minValue),
                    maxValue: f.stat === 'flat_sp' ? String(f.maxValue) : percent(f.maxValue),
                    step: f.stat === 'flat_sp' ? String(f.step) : percent(f.step),
                  })),
                  primary: rule.primarySp
                    ? {
                        chance: percent(rule.primarySp.chanceBp),
                        min: String(rule.primarySp.min),
                        max: String(rule.primarySp.max),
                        step: String(rule.primarySp.step),
                      }
                    : null,
                  library: rule.affixes.mode === 'library' ? rule.affixes.library : '',
                },
              ],
            ]
          : [];
      }),
    ),
  };
}
export function parsePercent(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole = '0', decimals = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}
export function probabilityTotal(weights: string[]): number | null {
  const values = weights.map(parsePercent);
  return values.some((v) => v === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}
export function inputOfRules(
  form: RulesForm,
  saved: RollRules,
): { rules: RollRules | null; issues: EquipmentIssue[] } {
  const issues: EquipmentIssue[] = [];
  function number(value: string, path: string, bp = false): number {
    const n = bp ? parsePercent(value) : /^\d+$/.test(value) ? Number(value) : null;
    if (n === null || !Number.isSafeInteger(n)) {
      issues.push({
        path,
        message: bp
          ? 'Enter a percentage with at most two decimal places.'
          : 'Enter a whole number of SP points.',
      });
      return 0;
    }
    return n;
  }
  const rarities: RollRules['rarities'] = {};
  for (const rarity of MANAGED_RARITIES) {
    const row = form.rarities[rarity];
    if (!row) continue;
    const path = `rarities.${rarity}`;
    const weights = row.weights.map((w, i) => number(w, `${path}.bonusCountWeightsBp.${i}`, true));
    if (weights.some((w) => w < 0 || w > 10000) || weights.reduce((s, w) => s + w, 0) !== 10000) {
      issues.push({
        path: `${path}.bonusCountWeightsBp`,
        message: 'The four chances must total exactly 100% and each must be between 0% and 100%.',
      });
    }
    rarities[rarity] = {
      bonusCountWeightsBp: weights,
      families: row.families.map((f, i) => ({
        ...f,
        minValue: number(f.minValue, `${path}.families.${i}.minValue`, f.stat !== 'flat_sp'),
        maxValue: number(f.maxValue, `${path}.families.${i}.maxValue`, f.stat !== 'flat_sp'),
        step: number(f.step, `${path}.families.${i}.step`, f.stat !== 'flat_sp'),
      })),
      primarySp: row.primary
        ? {
            chanceBp: number(row.primary.chance, `${path}.primarySp.chanceBp`, true),
            min: number(row.primary.min, `${path}.primarySp.min`),
            max: number(row.primary.max, `${path}.primarySp.max`),
            step: number(row.primary.step, `${path}.primarySp.step`),
          }
        : null,
      affixes: row.library ? { mode: 'library', library: row.library } : { mode: 'none' },
    };
  }
  const flatSpLimits = {
    perItemMax: number(form.perItemMax, 'flatSpLimits.perItemMax'),
    perLoadoutMax: number(form.perLoadoutMax, 'flatSpLimits.perLoadoutMax'),
  };
  return { rules: issues.length ? null : { ...saved, rarities, flatSpLimits }, issues };
}
export function familyText(f: ManagedRarityRule['families'][number]): string {
  const sp = f.stat === 'flat_sp';
  return `${FAMILY_LABELS[f.stat]}: ${sp ? f.minValue : percent(f.minValue)}–${sp ? f.maxValue : percent(f.maxValue)}${sp ? ' SP' : '%'}, step ${sp ? f.step : percent(f.step)}${sp ? ' SP' : '%'}; ${f.slots.join(', ')}; ${f.enabled ? 'enabled' : 'disabled'}`;
}
