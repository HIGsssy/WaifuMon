/**
 * A searchable picker over content the Portal already knows — items,
 * encounters, vendors — that stores the entity's slug/key and shows its name.
 *
 * Deliberately a native `<select>` with a filter box above it rather than a
 * custom combobox: keyboard, screen-reader and mobile behaviour come for free,
 * and the stored value is always one the list offered. The filter only
 * appears once the list is long enough to need it, and it never hides the
 * option that is currently selected.
 */
import { useId, useMemo, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

export interface EntityOption {
  value: string;
  label: string;
  /** Secondary text shown after the name, e.g. "draft · chain-only". */
  hint?: string | undefined;
}

interface Props {
  label: string;
  value: string;
  options: readonly EntityOption[];
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name of the filter box, e.g. "Search items". */
  searchLabel?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** Show the filter from this many options up. */
  searchThreshold?: number | undefined;
}

export const selectClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink disabled:opacity-60';

export function EntitySelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  searchLabel,
  className,
  disabled,
  searchThreshold = 8,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const searchable = options.length >= searchThreshold;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) =>
        o.value === value ||
        o.label.toLowerCase().includes(needle) ||
        o.value.toLowerCase().includes(needle) ||
        (o.hint ?? '').toLowerCase().includes(needle),
    );
  }, [options, query, value]);

  // A stored value the list does not offer (a deleted item, a typo from an
  // older editor) is still shown, so opening and saving never drops it.
  const unknown = value !== '' && !options.some((o) => o.value === value);

  return (
    <div className={cn('text-xs text-ink-muted', className)}>
      <label htmlFor={id}>{label}</label>
      {searchable && (
        <Input
          type="search"
          aria-label={searchLabel ?? `Search ${label.toLowerCase()}`}
          placeholder="Type to filter…"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-1 h-8"
        />
      )}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        <option value="">{placeholder}</option>
        {unknown && <option value={value}>{value} (not found)</option>}
        {visible.map((o) => (
          <option key={o.value} value={o.value}>
            {o.hint ? `${o.label} — ${o.hint}` : o.label}
          </option>
        ))}
      </select>
      {searchable && query && visible.length === 0 && (
        <span className="mt-1 block text-[11px]">Nothing matches “{query}”.</span>
      )}
    </div>
  );
}
