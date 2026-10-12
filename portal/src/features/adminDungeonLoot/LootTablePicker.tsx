/**
 * Chooses a reusable dungeon loot table by name. Archived tables are not
 * offered: a new reference to one could not be published.
 */
import { useState } from 'react';
import type { DungeonLootTable } from '@/api/adminDungeonLootTables';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TABLE_RISK_TEXT, tableRisk, tierText } from './bundleModel';

interface Props {
  /** The catalogue, or undefined while it loads. */
  tables: readonly DungeonLootTable[] | undefined;
  onPick: (table: DungeonLootTable) => void;
  onCancel: () => void;
}

export function LootTablePicker({ tables, onPick, onCancel }: Props) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const active = (tables ?? []).filter((table) => table.archivedAt === null);
  const shown = active.filter((table) => table.name.toLowerCase().includes(needle));
  return (
    <div
      className="space-y-2 rounded-lg border border-border-strong bg-surface p-3"
      data-testid="loot-table-picker"
    >
      <Input
        aria-label="Search loot tables"
        placeholder="Search loot tables by name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {tables === undefined ? (
        <p className="text-xs text-ink-muted">Loading loot tables…</p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-ink-muted" data-testid="loot-table-picker-empty">
          {active.length === 0
            ? 'There are no loot tables yet. Create one under Dungeon Loot Tables.'
            : 'No loot tables match that name.'}
        </p>
      ) : (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto">
          {shown.map((table) => (
            <li key={table.key}>
              <button
                type="button"
                title={table.key}
                aria-label={`Add ${table.name}`}
                className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-raised"
                onClick={() => onPick(table)}
              >
                <span className="font-medium text-ink">{table.name}</span>
                {table.tier && <Badge>{tierText(table.tier)}</Badge>}
                <span className="text-xs text-ink-subtle">
                  {TABLE_RISK_TEXT[tableRisk(table.body)].label}
                </span>
                {table.description && (
                  <span className="basis-full text-xs text-ink-muted">{table.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
