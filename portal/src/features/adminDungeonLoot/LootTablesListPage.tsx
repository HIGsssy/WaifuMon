/**
 * Dungeon Loot Tables: the catalogue of reusable loot that dungeon activities
 * roll. Find a table, see which dungeons use it, and open, copy, archive or
 * delete it. Nothing here reaches players until a dungeon is published.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  getDungeonLootTableUsage,
  listDungeonLootTables,
  type DungeonLootTable,
} from '@/api/adminDungeonLootTables';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { ArchiveDialog, DeleteDialog, DuplicateDialog } from './LootTableActions';
import { dungeonCount, dungeonUses } from './lootUsage';
import { LOOT_TIERS, TIER_LABELS, type LootTier } from './lootModel';

const editorPath = (key: string) => `/admin/dungeons/loot/${encodeURIComponent(key)}`;

export function LootTablesListPage() {
  const navigate = useNavigate();
  const canWrite = useHasPermission('dungeons.write');
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState<LootTier | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [action, setAction] = useState<{
    kind: 'duplicate' | 'archive' | 'delete';
    table: DungeonLootTable;
  } | null>(null);
  const term = useDebouncedValue(search.trim(), 250);
  const filter = {
    includeArchived,
    ...(tier ? { tier } : {}),
    ...(term ? { search: term } : {}),
  };
  const query = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'list', filter],
    queryFn: ({ signal }) => listDungeonLootTables(filter, signal),
  });
  const tables = query.data?.tables ?? [];
  const usage = useQueries({
    queries: tables.map((table) => ({
      queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'usage', table.key],
      queryFn: ({ signal }: { signal: AbortSignal }) => getDungeonLootTableUsage(table.key, signal),
    })),
  });
  const filtered = !!term || tier !== null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeon Loot Tables"
        description="Reusable loot for dungeon fights, bosses and treasure. Editing a table never changes a published dungeon until that dungeon is published again."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/dungeons">Back to dungeons</Link>
            </Button>
            {canWrite && (
              <Button asChild>
                <Link to="/admin/dungeons/loot/new">New loot table</Link>
              </Button>
            )}
          </div>
        }
      />
      {!canWrite && (
        <p className="text-xs text-ink-muted" data-testid="loot-read-only">
          You can view loot tables and test-roll them. Changing them needs dungeon write access.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search loot tables"
          placeholder="Search by name…"
          className="min-w-48 flex-1 sm:max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Tier">
          <span className="text-xs text-ink-muted">Tier:</span>
          {[null, ...LOOT_TIERS].map((option) => (
            <button
              key={option ?? 'all'}
              type="button"
              aria-pressed={tier === option}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                tier === option
                  ? 'border-accent bg-surface-raised text-ink'
                  : 'border-border text-ink-muted hover:text-ink',
              )}
              onClick={() => setTier(option)}
            >
              {option ? TIER_LABELS[option] : 'All'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load loot tables"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && tables.length === 0 && (
        <Card className="p-6 text-sm text-ink-muted" data-testid="loot-empty">
          {filtered
            ? 'No loot tables match. Try another name or tier.'
            : includeArchived
              ? 'No loot tables yet.'
              : 'No loot tables yet. Create one to reuse the same loot across dungeons.'}
        </Card>
      )}
      {tables.map((table, index) => {
        const report = usage[index];
        const uses = dungeonUses(report?.data);
        return (
          <Card
            key={table.key}
            className="flex flex-wrap items-center gap-3 p-4"
            data-testid="loot-table-row"
          >
            <div className="min-w-0 flex-1 basis-56">
              <Link className="font-medium hover:underline" to={editorPath(table.key)}>
                {table.name}
              </Link>
              {table.description && (
                <p className="truncate text-sm text-ink-muted">{table.description}</p>
              )}
              <p className="text-xs text-ink-subtle" data-testid="loot-table-usage">
                {report?.isPending
                  ? 'Checking where it is used…'
                  : report?.isError
                    ? 'Could not check where it is used'
                    : uses.length === 0
                      ? 'Not used by any dungeon'
                      : `Used by ${dungeonCount(uses.length)}: ${uses.map((u) => u.name).join(', ')}`}
                {' · '}Updated {formatRelative(table.updatedAt)}
                {table.updatedBy ? ` by ${table.updatedBy}` : ''}
              </p>
            </div>
            {table.tier && <Badge>{TIER_LABELS[table.tier]}</Badge>}
            {table.archivedAt && <Badge variant="danger">Archived</Badge>}
            {table.issues.some((i) => i.severity === 'error') && (
              <Badge variant="outline">Needs repair</Badge>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to={editorPath(table.key)} aria-label={`Open ${table.name}`}>
                  {canWrite ? 'Edit' : 'View'}
                </Link>
              </Button>
              {canWrite && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Duplicate ${table.name}`}
                    onClick={() => setAction({ kind: 'duplicate', table })}
                  >
                    Duplicate
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${table.archivedAt ? 'Restore' : 'Archive'} ${table.name}`}
                    onClick={() => setAction({ kind: 'archive', table })}
                  >
                    {table.archivedAt ? 'Restore' : 'Archive'}
                  </Button>
                  {table.archivedAt && (
                    <Button
                      variant="danger"
                      size="sm"
                      aria-label={`Delete ${table.name}`}
                      disabled={!report?.data}
                      onClick={() => setAction({ kind: 'delete', table })}
                    >
                      Delete
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>
        );
      })}
      {query.data && tables.length > 0 && canWrite && (
        <p className="text-xs text-ink-muted">
          A table must be archived before it can be deleted, and can only be deleted once no dungeon
          needs it.
        </p>
      )}

      {action?.kind === 'duplicate' && (
        <DuplicateDialog
          table={action.table}
          onClose={() => setAction(null)}
          onDone={(copy) => navigate(editorPath(copy.key))}
        />
      )}
      {action?.kind === 'archive' && (
        <ArchiveDialog
          table={action.table}
          uses={dungeonUses(usage[tables.findIndex((t) => t.key === action.table.key)]?.data)}
          onClose={() => setAction(null)}
          onDone={() => setAction(null)}
        />
      )}
      {action?.kind === 'delete' && (
        <DeleteDialog
          table={action.table}
          uses={dungeonUses(usage[tables.findIndex((t) => t.key === action.table.key)]?.data)}
          onClose={() => setAction(null)}
          onDeleted={() => setAction(null)}
        />
      )}
    </div>
  );
}
