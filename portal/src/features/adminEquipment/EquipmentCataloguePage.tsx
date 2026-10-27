/**
 * Admin — the Equipment Catalogue: every equipment definition, all six
 * rarities, searchable and filterable, with its status, how many copies
 * players hold, and the actions an author takes on it.
 *
 * Definitions are database content. New ones — created, duplicated or
 * imported — start disabled, so nothing can drop until an author reviews and
 * enables it. Enabling N/R/SR gear shows the automatic rewards it would join
 * first; enabling SSR/UR/LR never makes it obtainable on its own.
 *
 * Export writes a `waifumon-equipment` package — everything, what the filters
 * show, or a selection — for backup, review or another environment.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';

import {
  EQUIPMENT_CATALOGUE_QUERY_KEY,
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  SLOT_LABELS,
  exportCatalogue,
  formatMultiplier,
  listCatalogue,
  type CatalogueDefinition,
  type CatalogueQuery,
  type CatalogueSort,
  type EquipmentRarity,
  type EquipmentSlotName,
} from '@/api/adminEquipment';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import {
  DuplicateDefinitionDialog,
  EnableDefinitionDialog,
  RarityBadge,
  StatusBadge,
} from './catalogueParts';
import { downloadJson, equipmentPath } from './equipmentModel';

const PAGE_SIZE = 25;
const SORT_LABELS: Record<CatalogueSort, string> = {
  key: 'Key',
  name: 'Name',
  rarity: 'Rarity',
  slot: 'Slot',
  updated: 'Last changed',
  owned: 'Copies owned',
};

export function EquipmentCataloguePage() {
  const canWrite = useHasPermission('equipment.write');
  const [search, setSearch] = useState('');
  const [rarity, setRarity] = useState<EquipmentRarity | ''>('');
  const [slot, setSlot] = useState<EquipmentSlotName | ''>('');
  const [status, setStatus] = useState<'' | 'enabled' | 'disabled'>('');
  const [sort, setSort] = useState<CatalogueSort>('key');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState<CatalogueDefinition | null>(null);
  const [duplicating, setDuplicating] = useState<CatalogueDefinition | null>(null);
  const q = useDebouncedValue(search.trim(), 250);

  const filters: CatalogueQuery = {
    ...(q ? { q } : {}),
    ...(rarity ? { rarity } : {}),
    ...(slot ? { slot } : {}),
    ...(status ? { status } : {}),
  };
  const query = useQuery({
    queryKey: [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'list', filters, sort, direction, page],
    queryFn: ({ signal }) =>
      listCatalogue({ ...filters, sort, direction, page, pageSize: PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = Object.keys(filters).length > 0;
  const exporting = useMutation({
    mutationFn: (scope: 'all' | 'filtered' | 'selected') =>
      exportCatalogue(
        scope === 'selected'
          ? { keys: [...selected] }
          : scope === 'filtered'
            ? { query: filters }
            : {},
      ),
    onSuccess: (pkg, scope) => downloadJson(`equipment-${scope}.json`, pkg),
  });
  const resetPage =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const toggleSelected = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Equipment Catalogue"
        description="Every equipment definition. Changes reach future drops only — gear players already own keeps what it rolled. New equipment starts disabled."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={exporting.isPending}
              onClick={() => exporting.mutate('all')}
            >
              Export all
            </Button>
            {filtered && (
              <Button
                variant="outline"
                disabled={exporting.isPending}
                onClick={() => exporting.mutate('filtered')}
              >
                Export filtered
              </Button>
            )}
            {selected.size > 0 && (
              <Button
                variant="outline"
                disabled={exporting.isPending}
                onClick={() => exporting.mutate('selected')}
              >
                Export {selected.size} selected
              </Button>
            )}
            {canWrite && (
              <>
                <Button variant="outline" asChild>
                  <Link to="/admin/equipment/import">Import JSON</Link>
                </Button>
                <Button asChild variant="accent">
                  <Link to="/admin/equipment/new">Create equipment</Link>
                </Button>
              </>
            )}
          </div>
        }
      />
      {exporting.isError && (
        <ErrorState variant="inline" title="Could not export" error={exporting.error} />
      )}

      {data && (
        <p className="text-xs text-ink-muted" data-testid="catalogue-counts">
          {data.counts.total} definitions · {data.counts.enabled} enabled · {data.counts.disabled}{' '}
          disabled ·{' '}
          {EQUIPMENT_RARITIES.map((r) => `${r} ${data.counts.byRarity[r] ?? 0}`).join(' · ')}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3" data-testid="catalogue-filters">
        <label className="min-w-48 flex-1 text-xs text-ink-muted">
          Search
          <Input
            aria-label="Search equipment"
            placeholder="Key, name or description"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Rarity
          <select
            aria-label="Filter by rarity"
            className={selectClass}
            value={rarity}
            onChange={(e) => resetPage(setRarity)(e.target.value as EquipmentRarity | '')}
          >
            <option value="">Any rarity</option>
            {EQUIPMENT_RARITIES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Slot
          <select
            aria-label="Filter by slot"
            className={selectClass}
            value={slot}
            onChange={(e) => resetPage(setSlot)(e.target.value as EquipmentSlotName | '')}
          >
            <option value="">Any slot</option>
            {EQUIPMENT_SLOTS.map((s) => (
              <option key={s} value={s}>
                {SLOT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Status
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={status}
            onChange={(e) => resetPage(setStatus)(e.target.value as '' | 'enabled' | 'disabled')}
          >
            <option value="">Enabled and disabled</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Sort by
          <select
            aria-label="Sort by"
            className={selectClass}
            value={sort}
            onChange={(e) => resetPage(setSort)(e.target.value as CatalogueSort)}
          >
            {(Object.keys(SORT_LABELS) as CatalogueSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={direction === 'asc' ? 'Sort descending' : 'Sort ascending'}
          onClick={() => resetPage(setDirection)(direction === 'asc' ? 'desc' : 'asc')}
        >
          {direction === 'asc' ? '↑ Ascending' : '↓ Descending'}
        </Button>
      </div>

      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load equipment"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {data && data.total === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted" data-testid="catalogue-empty">
          {filtered ? 'No equipment matches these filters.' : 'No equipment yet.'}
        </Card>
      )}
      {data && data.definitions.length > 0 && (
        <>
          <p className="text-xs text-ink-muted" role="status" data-testid="catalogue-shown">
            {filtered ? `${data.total} of ${data.counts.total} match` : `${data.total} definitions`}{' '}
            · page {data.page} of {pages}
          </p>
          <Card className="divide-y divide-border">
            {data.definitions.map((d) => (
              <div
                key={d.key}
                className="flex flex-wrap items-start gap-3 px-4 py-3"
                data-testid="catalogue-row"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`Select ${d.name}`}
                  checked={selected.has(d.key)}
                  onChange={() => toggleSelected(d.key)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={equipmentPath(d.key)}
                      className={cn(
                        'font-medium text-ink hover:underline',
                        !d.enabled && 'text-ink-muted',
                      )}
                    >
                      {d.name}
                    </Link>
                    <RarityBadge rarity={d.rarity} />
                    <StatusBadge enabled={d.enabled} />
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">
                    {SLOT_LABELS[d.slot]} · {formatMultiplier(d.multiplierMinBp)}–
                    {formatMultiplier(d.multiplierMaxBp)} ·{' '}
                    {d.ownedCount === 0
                      ? 'no copies owned'
                      : `${d.ownedCount} cop${d.ownedCount === 1 ? 'y' : 'ies'} owned`}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    <span className="font-mono">{d.key}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canWrite && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${d.enabled ? 'Disable' : 'Enable'} ${d.name}`}
                        onClick={() => setToggling(d)}
                      >
                        {d.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Duplicate ${d.name}`}
                        onClick={() => setDuplicating(d)}
                      >
                        Duplicate
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="outline" asChild>
                    <Link
                      to={equipmentPath(d.key)}
                      aria-label={`${canWrite ? 'Edit' : 'View'} ${d.name}`}
                    >
                      {canWrite ? 'Edit' : 'View'}
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </Card>
          {pages > 1 && (
            <div className="flex items-center gap-2" data-testid="catalogue-pager">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-xs text-ink-muted">
                Page {page} of {pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {toggling && (
        <EnableDefinitionDialog
          key={toggling.key}
          definition={toggling}
          onClose={() => setToggling(null)}
        />
      )}
      {duplicating && (
        <DuplicateDefinitionDialog
          key={duplicating.key}
          source={duplicating}
          onClose={() => setDuplicating(null)}
        />
      )}
    </div>
  );
}
