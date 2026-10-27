import { useId, useState } from 'react';
import { EQUIPMENT_SLOTS, SLOT_LABELS, type EquipmentIssue } from '@/api/adminEquipment';
import type { LibraryOption, ManagedRuleRarity, RollRules } from '@/api/adminEquipmentRules';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import {
  FAMILY_LABELS,
  percent,
  probabilityTotal,
  type FamilyStat,
  type RarityForm,
} from './rulesModel';

export function RuleIssues({
  issues,
  label = 'Issues',
}: {
  issues: EquipmentIssue[];
  label?: string;
}) {
  if (!issues.length) return null;
  return (
    <div className="space-y-1 text-sm" role="status">
      <p className="font-medium">{label}</p>
      <ul className="list-disc space-y-1 pl-5">
        {issues.map((issue, i) => (
          <li key={i}>
            <span className="font-medium" title={issue.path}>
              {issue.path
                .replace('rarities.', '')
                .replace('legacy', 'Protected N/R/SR rules')
                .replace('bonusCountWeightsBp', 'additional bonus chances')
                .replace(/families\.(\d+)/, (_, n: string) => `bonus family ${Number(n) + 1}`)
                .replace('flatSpLimits', 'Equipment SP limits')
                .replace('perItemMax', 'per-copy maximum')
                .replace('perLoadoutMax', 'per-loadout maximum')
                .replace('primarySp', 'primary SP')
                .replace('chanceBp', 'chance')
                .replace('minValue', 'minimum')
                .replace('maxValue', 'maximum')
                .replaceAll('.', ' → ')}
            </span>
            : {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  path,
  issues = [],
  unit = '%',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  path: string;
  issues?: EquipmentIssue[];
  unit?: '%' | 'SP';
}) {
  const errors = issues.filter((issue) => issue.path === path);
  const errorId = useId();
  return (
    <label className="grid gap-1 text-sm">
      <span>
        {label} ({unit})
      </span>
      <Input
        type="text"
        inputMode={unit === '%' ? 'decimal' : 'numeric'}
        aria-label={`${label} (${unit})`}
        aria-describedby={errors.length ? errorId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors.length > 0}
      />
      {errors.length > 0 && (
        <span id={errorId} className="text-xs text-danger">
          {errors.map((e) => e.message).join(' ')}
        </span>
      )}
    </label>
  );
}

export function LegacyRules({ rarity, rules }: { rarity: 'N' | 'R' | 'SR'; rules: RollRules }) {
  const legacy = rules.legacy;
  const rule = legacy.rarityRules[rarity];
  return (
    <Card className="space-y-4 p-4">
      <h2 className="font-display text-lg">{rarity} — read-only legacy rules</h2>
      <p className="text-sm text-ink-muted">
        N/R/SR mechanics are protected in Equipment 3.0. Imports and draft saves cannot change them.
      </p>
      <p>
        {percent(rule.bonusChanceBp)}% chance of {rule.bonusCount} additional{' '}
        {rule.bonusCount === 1 ? 'bonus' : 'bonuses'}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Bonus family</th>
              <th>Range</th>
              <th>Step</th>
              <th>Eligible slots</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {legacy.bonuses.map((f) => (
              <tr className="border-t border-line" key={f.stat}>
                <td className="py-2">{FAMILY_LABELS[f.stat]}</td>
                <td>
                  {percent(f.ranges[rarity].minBp)}–{percent(f.ranges[rarity].maxBp)}%
                </td>
                <td>{percent(f.stepBp)}%</td>
                <td>
                  {EQUIPMENT_SLOTS.filter((slot) => legacy.eligibility[slot].includes(f.stat))
                    .map((slot) => SLOT_LABELS[slot])
                    .join(', ')}
                </td>
                <td>{f.enabled ? 'Enabled' : 'Disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        Affix source: shipped {rarity} affixes, read-only. Each equipment slot uses its original
        pool.
      </p>
    </Card>
  );
}

export function HighRarityFields({
  rarity,
  form,
  onChange,
  disabled,
  issues,
  libraries,
}: {
  rarity: ManagedRuleRarity;
  form: RarityForm;
  onChange: (next: RarityForm) => void;
  disabled: boolean;
  issues: EquipmentIssue[];
  libraries: LibraryOption[];
}) {
  const [section, setSection] = useState('counts');
  const path = `rarities.${rarity}`;
  const total = probabilityTotal(form.weights);
  const activeLibrary = libraries.find((l) => l.key === form.library);
  const available = (l: LibraryOption) =>
    l.publishedRevision !== null && EQUIPMENT_SLOTS.every((s) => l.coveredSlots.includes(s));
  return (
    <Card className="space-y-4 p-4">
      <h2 className="font-display text-lg">{rarity} draft rules</h2>
      <label className="grid max-w-sm gap-1 text-sm">
        Configuration section
        <select
          className={selectClass}
          value={section}
          onChange={(e) => setSection(e.target.value)}
        >
          <option value="counts">Additional bonus chances</option>
          <option value="primary">Primary SP</option>
          <option value="families">Bonus families and slots</option>
          <option value="affixes">Affix assignment</option>
        </select>
      </label>
      <fieldset disabled={disabled} className="space-y-4">
        {section === 'counts' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {form.weights.map((weight, i) => (
                <NumberField
                  key={i}
                  label={`${i} additional ${i === 1 ? 'bonus' : 'bonuses'}`}
                  value={weight}
                  path={`${path}.bonusCountWeightsBp.${i}`}
                  issues={issues}
                  onChange={(value) =>
                    onChange({
                      ...form,
                      weights: form.weights.map((v, index) => (index === i ? value : v)),
                    })
                  }
                />
              ))}
            </div>
            <p
              className={total === 10000 ? 'text-sm text-success' : 'text-sm text-danger'}
              role="status"
            >
              Total: {total === null ? 'incomplete' : `${percent(total)}%`} — must equal 100%.
            </p>
            <p className="text-sm text-ink-muted">
              Individual equipment definitions can restrict the maximum additional bonus count.
              Excluded counts are removed and the remaining chances are rescaled proportionally when
              rolling. Values entered here are never automatically normalized.
            </p>
          </>
        )}
        {section === 'primary' && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.primary !== null}
                onChange={(e) =>
                  onChange({
                    ...form,
                    primary: e.target.checked ? { chance: '', min: '', max: '', step: '' } : null,
                  })
                }
              />
              Configure primary SP
            </label>
            <p className="text-sm text-ink-muted">
              Primary SP uses no additional bonus slot and rolls only for equipment definitions with
              Primary SP enabled. It can stack with Flat SP from the bonus pool. Both contribute to
              effective combat SP, never permanent natural SP.
            </p>
            {form.primary && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(['chance', 'min', 'max', 'step'] as const).map((key) => (
                  <NumberField
                    key={key}
                    label={
                      {
                        chance: 'Primary SP chance',
                        min: 'Minimum primary SP',
                        max: 'Maximum primary SP',
                        step: 'Primary SP step',
                      }[key]
                    }
                    unit={key === 'chance' ? '%' : 'SP'}
                    value={form.primary![key]}
                    path={`${path}.primarySp.${key === 'chance' ? 'chanceBp' : key}`}
                    issues={issues}
                    onChange={(value) =>
                      onChange({ ...form, primary: { ...form.primary!, [key]: value } })
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
        {section === 'families' && (
          <>
            <p className="text-sm text-ink-muted">
              Choose the existing families, their ranges and eligible slots. Each additional bonus
              draws a distinct enabled family. Combat caps remain enforced by the server.
            </p>
            {Object.entries(FAMILY_LABELS).map(([key, label]) => {
              const stat = key as FamilyStat;
              const index = form.families.findIndex((f) => f.stat === stat);
              const family = form.families[index];
              const update = (change: Partial<typeof family>) =>
                onChange({
                  ...form,
                  families: form.families.map((f, i) => (i === index ? { ...f, ...change } : f)),
                });
              return (
                <div key={key} className="space-y-3 rounded border border-line p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={!!family}
                      onChange={(e) =>
                        onChange({
                          ...form,
                          families: e.target.checked
                            ? [
                                ...form.families,
                                {
                                  stat,
                                  enabled: true,
                                  slots: [],
                                  minValue: '',
                                  maxValue: '',
                                  step: '',
                                },
                              ]
                            : form.families.filter((f) => f.stat !== stat),
                        })
                      }
                    />
                    Include {label}
                  </label>
                  {family && (
                    <>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={family.enabled}
                          onChange={(e) => update({ enabled: e.target.checked })}
                        />
                        {label} enabled
                      </label>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {(['minValue', 'maxValue', 'step'] as const).map((field) => (
                          <NumberField
                            key={field}
                            label={`${label} ${{ minValue: 'minimum', maxValue: 'maximum', step: 'step' }[field]}`}
                            unit={stat === 'flat_sp' ? 'SP' : '%'}
                            value={family[field]}
                            issues={issues}
                            path={`${path}.families.${index}.${field}`}
                            onChange={(value) => update({ [field]: value })}
                          />
                        ))}
                      </div>
                      <fieldset className="flex flex-wrap gap-3">
                        <legend className="mb-1 text-sm">{label} eligible slots</legend>
                        {EQUIPMENT_SLOTS.map((slot) => (
                          <label key={slot} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              aria-label={`${label} ${SLOT_LABELS[slot]}`}
                              checked={family.slots.includes(slot)}
                              onChange={(e) =>
                                update({
                                  slots: e.target.checked
                                    ? [...family.slots, slot]
                                    : family.slots.filter((s) => s !== slot),
                                })
                              }
                            />
                            {SLOT_LABELS[slot]}
                          </label>
                        ))}
                      </fieldset>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
        {section === 'affixes' && (
          <>
            <label className="grid gap-1 text-sm">
              Affix library
              <select
                className={selectClass}
                value={form.library}
                onChange={(e) => onChange({ ...form, library: e.target.value })}
              >
                <option value="">No affix library (affixless)</option>
                {form.library && !activeLibrary && (
                  <option value={form.library} disabled>
                    Missing library: {form.library}
                  </option>
                )}
                {libraries.map((l) => (
                  <option key={l.key} value={l.key} disabled={!available(l)}>
                    {l.name} —{' '}
                    {l.publishedRevision === null
                      ? 'unpublished'
                      : `published revision ${l.publishedRevision}`}
                    {l.publishedRevision !== null && !available(l)
                      ? ' (missing enabled slots)'
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            {form.library && (!activeLibrary || !available(activeLibrary)) && (
              <p className="text-sm text-danger">
                This assignment is unavailable. Select a published library with enabled entries for
                Attack, Defense and Health, or choose affixless.
              </p>
            )}
            {activeLibrary && (
              <p className="text-sm">
                Assigned: {activeLibrary.name}, published revision{' '}
                {activeLibrary.publishedRevision ?? 'none'}.{' '}
                {activeLibrary.assignedTo.length
                  ? `Currently used by ${activeLibrary.assignedTo.join(', ')}.`
                  : 'Not currently assigned.'}
              </p>
            )}
            <p className="text-sm text-ink-muted">
              Rarities can share a published library or use a dedicated one.{' '}
              {libraries.length === 0
                ? 'No managed libraries exist yet; affixless rules remain available.'
                : 'Only published libraries with enabled entries for every slot are available.'}{' '}
              Library editing belongs to the upcoming Affix Libraries editor.
            </p>
          </>
        )}
      </fieldset>
      {!disabled && (
        <p className="text-xs text-ink-subtle">
          Editing this section changes only your local form until you save the draft.
        </p>
      )}
    </Card>
  );
}
