/**
 * Choose an enemy by name. A native select with a filter box above it once
 * the catalogue is long (the Portal's `EntitySelect` pattern), so keyboard and
 * touch behaviour come for free and the value is always one the list offered.
 * Nothing is ever chosen on the author's behalf.
 */
import { useState } from 'react';
import type { DungeonReferenceData } from '@/api/adminDungeons';
import { Input } from '@/components/ui/input';

const SEARCH_THRESHOLD = 8;

export function EnemyPicker({
  label,
  value,
  reference,
  onChange,
}: {
  /** The accessible name, e.g. "Wave 1 enemy". */
  label: string;
  value: string;
  reference?: DungeonReferenceData | undefined;
  onChange: (key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const enemies = reference?.enemies ?? [];
  const needle = query.trim().toLowerCase();
  const visible = enemies.filter(
    (e) =>
      e.key === value ||
      !needle ||
      e.name.toLowerCase().includes(needle) ||
      e.key.toLowerCase().includes(needle),
  );
  const chosen = enemies.find((e) => e.key === value);
  return (
    <div className="min-w-0 flex-1 space-y-1">
      {enemies.length >= SEARCH_THRESHOLD && (
        <Input
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Type to find an enemy…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 sm:h-8"
        />
      )}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-surface px-2 py-1.5 text-sm text-ink ${value ? 'border-border' : 'border-danger'}`}
      >
        <option value="">Choose an enemy…</option>
        {value && !chosen && <option value={value}>Missing enemy ({value})</option>}
        {visible.map((e) => (
          <option key={e.key} value={e.key} disabled={!e.enabled && e.key !== value}>
            {e.name} — HP {e.hp} · ATK {e.attack} · DEF {e.defense}
            {!e.enabled ? ' (switched off)' : ''}
          </option>
        ))}
      </select>
      {enemies.length === 0 && (
        <p className="text-xs text-ink-muted">
          There are no enemies yet. Create some in the Enemy Catalogue first.
        </p>
      )}
      {needle && visible.length === (chosen ? 1 : 0) && (
        <p className="text-xs text-ink-muted">No enemy matches “{query}”.</p>
      )}
      {chosen && !chosen.enabled && (
        <p className="text-xs text-danger">{chosen.name} is switched off in the Enemy Catalogue.</p>
      )}
    </div>
  );
}
