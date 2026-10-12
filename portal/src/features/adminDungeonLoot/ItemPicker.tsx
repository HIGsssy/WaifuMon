/**
 * Chooses one item by its readable name. Shared by the Dungeon Loot editor and
 * by an activity's Rewards section.
 *
 * Items that cannot be dungeon loot stay listed, disabled, with the reason —
 * an author looking for one should learn why it is missing, not wonder where
 * it went. The slug is stored and shown only as a hover title.
 */
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  ITEM_FILTERS,
  categoryLabel,
  itemMatchesFilter,
  itemUnusable,
  type ItemFilter,
  type ItemRef,
} from './lootModel';

interface Props {
  items: readonly ItemRef[];
  /** The chosen item's slug, or '' while nothing is chosen. */
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
}

export function ItemPicker({ items, value, onChange, disabled = false }: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ItemFilter>('all');
  const needle = search.trim().toLowerCase();
  const shown = items.filter(
    (item) => itemMatchesFilter(item, filter) && item.name.toLowerCase().includes(needle),
  );
  const chosen = items.find((item) => item.slug === value);
  return (
    <div className="space-y-2" data-testid="item-picker">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search items"
          placeholder="Search items by name…"
          className="min-w-40 flex-1"
          value={search}
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Item type">
          {ITEM_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              disabled={disabled}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                filter === f.id
                  ? 'border-accent bg-surface-raised text-ink'
                  : 'border-border text-ink-muted hover:text-ink',
              )}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {value && !chosen && (
        <p className="text-xs text-danger" role="alert">
          The item chosen before no longer exists. Pick another one.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-xs text-ink-muted" data-testid="item-picker-empty">
          {items.length === 0
            ? 'No items are available.'
            : 'No items match. Try another name or type.'}
        </p>
      ) : (
        <ul
          role="listbox"
          aria-label="Items"
          className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border bg-surface p-1"
        >
          {shown.map((item) => {
            const reason = itemUnusable(item);
            const selected = item.slug === value;
            return (
              <li key={item.slug} role="option" aria-selected={selected} aria-disabled={!!reason}>
                <button
                  type="button"
                  title={item.slug}
                  disabled={disabled || !!reason}
                  className={cn(
                    'flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1.5 text-left text-sm',
                    selected ? 'bg-surface-raised text-ink' : 'text-ink hover:bg-surface-raised',
                    reason && 'cursor-not-allowed text-ink-subtle hover:bg-transparent',
                  )}
                  onClick={() => onChange(item.slug)}
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="text-xs text-ink-muted">{categoryLabel(item.category)}</span>
                  <span className={cn('text-xs', reason ? 'text-danger' : 'text-ink-subtle')}>
                    {reason ?? (selected ? 'Chosen' : 'Available')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
