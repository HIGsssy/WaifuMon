/**
 * Small form pieces the dungeon editors share: a titled section, issue lists,
 * number fields that can be cleared and retyped, and the pickers for regions,
 * room types, amounts and reward tables.
 */
import { useState, type ReactNode } from 'react';

import {
  DUNGEON_NODE_TYPES,
  type AmountRange,
  type DungeonNodeType,
  type DungeonReferenceData,
  type DungeonRegionRef,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { NODE_TYPE_LABELS, intOrNull } from './dungeonModel';

export function Issues({ issues }: { issues: DungeonZoneIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid="zone-issues">
      {issues.map((i) => (
        <li
          key={`${i.path}:${i.message}`}
          className={i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
        >
          {i.severity === 'error' ? '' : '⚠ '}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function Section({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      <div>
        <h2 className="text-sm font-semibold uppercase text-ink-muted">{title}</h2>
        {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/**
 * Settings most dungeons never need, folded away. The controls stay in the
 * page — only out of the way — so a search still finds them and a problem
 * inside can open the fold.
 */
export function Advanced({
  title = 'Advanced',
  hint,
  testId,
  open,
  children,
}: {
  title?: string;
  hint?: string;
  testId: string;
  /** Start open — when something inside needs attention. */
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="rounded-lg border border-border bg-surface-sunken/40 p-3"
      data-testid={testId}
      {...(open ? { open: true } : {})}
    >
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </summary>
      {hint && <p className="mt-2 text-xs text-ink-muted">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

/**
 * A required number. The field keeps what was typed while it has focus, so it
 * can be cleared and retyped; the draft only changes when the text is a
 * number, and an abandoned empty field shows the draft's value again on blur.
 */
export function NumberField({
  label,
  value,
  onChange,
  disabled,
  min = 0,
  step,
  className = 'w-24',
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
  min?: number;
  step?: number;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        step={step}
        aria-label={label}
        className={className}
        value={text ?? value}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(n)) onChange(step ? n : Math.trunc(n));
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

/**
 * The regions a zone is open in, as checkboxes: names shown, stable ids stored,
 * in the catalogue's order. An id the catalogue no longer has stays visible
 * (and checked) so it can be seen and removed rather than silently carried.
 */
export function RegionChecks({
  regions,
  value,
  onChange,
  disabled,
}: {
  regions: DungeonRegionRef[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const unknown = value.filter((id) => !regions.some((r) => r.id === id));
  const options = [
    ...regions,
    ...unknown.map((id) => ({ id, name: id, enabled: true, unknown: true })),
  ];
  return (
    <fieldset className="text-xs text-ink-muted" data-testid="region-checks">
      <legend>Available in</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {options.map((region) => (
          <label key={region.id} className="flex items-center gap-1 text-sm text-ink">
            <input
              type="checkbox"
              aria-label={`Available in ${region.name}`}
              checked={value.includes(region.id)}
              disabled={disabled}
              onChange={(e) =>
                // Kept in catalogue order, so a toggle never reorders the document.
                onChange(
                  options
                    .map((r) => r.id)
                    .filter((id) => (id === region.id ? e.target.checked : value.includes(id))),
                )
              }
            />
            {region.name}
            {'unknown' in region && <span className="text-xs text-danger">(unknown region)</span>}
            {!region.enabled && <span className="text-xs text-ink-subtle">(not released)</span>}
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <p className="mt-2 text-xs text-ink-subtle">
          No region selected — the zone cannot be started anywhere.
        </p>
      )}
    </fieldset>
  );
}

/** An optional depth or count: empty means "no limit". */
export function OptionalNumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder = 'no limit',
  min = 1,
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  disabled: boolean;
  placeholder?: string;
  min?: number;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        aria-label={label}
        className="w-24"
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(intOrNull(e.target.value))}
      />
    </label>
  );
}

export function TypeChecks({
  label,
  value,
  onChange,
  disabled,
  types = DUNGEON_NODE_TYPES,
}: {
  label: string;
  value: DungeonNodeType[];
  onChange: (next: DungeonNodeType[]) => void;
  disabled: boolean;
  types?: readonly DungeonNodeType[];
}) {
  return (
    <fieldset className="text-xs text-ink-muted">
      <legend>{label}</legend>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {types.map((type) => (
          <label key={type} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`${label}: ${NODE_TYPE_LABELS[type]}`}
              checked={value.includes(type)}
              disabled={disabled}
              onChange={(e) =>
                // Kept in vocabulary order so a toggle never reorders the document.
                onChange(types.filter((t) => (t === type ? e.target.checked : value.includes(t))))
              }
            />
            {NODE_TYPE_LABELS[type]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function RangeFields({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: AmountRange;
  onChange: (next: AmountRange) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end gap-2">
      <NumberField
        label={`${label} min`}
        value={value.min}
        disabled={disabled}
        onChange={(min) => onChange({ ...value, min })}
      />
      <NumberField
        label={`${label} max`}
        value={value.max}
        disabled={disabled}
        onChange={(max) => onChange({ ...value, max })}
      />
    </div>
  );
}

export function TableSelect({
  label,
  value,
  onChange,
  disabled,
  tables,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled: boolean;
  tables: DungeonReferenceData['rewardTables'];
}) {
  const known = value === null || tables.some((t) => t.id === value);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <select
        aria-label={label}
        className={selectClass}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">None</option>
        {!known && <option value={value ?? ''}>{value} (unknown)</option>}
        {tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.id}
            {t.enabled ? '' : ' (disabled)'}
          </option>
        ))}
      </select>
    </label>
  );
}
