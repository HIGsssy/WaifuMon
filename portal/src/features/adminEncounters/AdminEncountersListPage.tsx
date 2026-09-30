/**
 * World Encounters — the encounter list.
 *
 * Built for finding an encounter and understanding it without opening it:
 * every row states where it appears, how it takes part in a chain (and which
 * encounters lead to it), how many choices it has, its repeat cooldown,
 * whether it opens a vendor, and whether anything about its links looks
 * wrong. Filters persist for the tab, so returning from the editor lands on
 * the same view.
 *
 * Rendered under `<RequirePortalPermission permission="admin.access">`, and
 * the API re-checks every call independently.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';

import {
  cloneAdminEncounter,
  deleteAdminEncounter,
  setAdminEncounterLifecycle,
  type AdminEncounter,
} from '@/api/adminEncounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';

import { buildEncounterGraph } from './encounterGraph';
import { EncounterFilterBar } from './EncounterFilterBar';
import {
  filterEncounters,
  loadFilters,
  namesOf,
  saveFilters,
  summaryBadges,
  type EncounterFilterState,
} from './encounterFilters';
import { uniqueSlug } from './slugs';
import { useEncounterList, useEncounterSettings, useReference } from './useAuthoringData';
import { regionLabel } from './waifumonSelection';

const STATUS_LABEL: Record<AdminEncounter['lifecycle'], string> = {
  active: 'Active',
  draft: 'Draft',
  disabled: 'Disabled',
};

export function AdminEncountersListPage() {
  const canWrite = useHasPermission('encounters.write');
  const canPublish = useHasPermission('encounters.publish');
  const [filters, setFilters] = useState<EncounterFilterState>(loadFilters);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const query = useEncounterList();
  const reference = useReference().data;
  const settings = useEncounterSettings().data;

  useEffect(() => saveFilters(filters), [filters]);

  const encounters = useMemo(() => query.data?.encounters ?? [], [query.data]);
  const graph = useMemo(() => buildEncounterGraph(encounters), [encounters]);
  const filtered = useMemo(
    () => filterEncounters(encounters, filters, graph).sort((a, b) => a.name.localeCompare(b.name)),
    [encounters, filters, graph],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'encounters'] });
  const lifecycle = useMutation({
    mutationFn: ({ id, next }: { id: number; next: 'active' | 'disabled' }) =>
      setAdminEncounterLifecycle(id, next),
    onSuccess: invalidate,
  });
  const clone = useMutation({
    mutationFn: (e: AdminEncounter) =>
      cloneAdminEncounter(
        e.id,
        uniqueSlug(`${e.slug.slice(0, 58)}_copy`, new Set(encounters.map((x) => x.slug))),
      ),
    onSuccess: (created) => {
      void invalidate();
      navigate(`/admin/encounters/${created.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteAdminEncounter(id),
    onSuccess: invalidate,
  });
  const failure = lifecycle.error ?? clone.error ?? remove.error;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Encounters"
        description="Find, understand and edit the encounters players meet while hunting and travelling."
        actions={
          canWrite ? (
            <Button asChild variant="accent">
              <Link to="/admin/encounters/new">New encounter</Link>
            </Button>
          ) : undefined
        }
      />

      {/* A refused action — e.g. activating a Waifumon selector that matches
          nothing anywhere, or deleting an encounter with history — must say
          why rather than leave the button looking dead. */}
      {failure != null && (
        <p
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {failure instanceof Error ? failure.message : 'That did not work.'}
        </p>
      )}

      {/* Force Trigger left on looks like broken drop rates, so it stays
          visible here even though the switch now lives under Settings. */}
      {settings?.forceTrigger && (
        <p
          className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
          role="status"
          data-testid="force-trigger-banner"
        >
          <strong>Force Trigger is on</strong> — every eligible hunt and travel produces a World
          Encounter.{' '}
          <Link to="/admin/encounters/settings" className="underline">
            Settings
          </Link>
        </p>
      )}

      <Card className="p-4">
        <EncounterFilterBar value={filters} onChange={setFilters} reference={reference} />
      </Card>

      {query.isPending && (
        <Card className="p-4">
          <Skeleton className="h-32 w-full" />
        </Card>
      )}
      {query.isError && (
        <ErrorState
          title="Could not load encounters"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <Card className="divide-y divide-border overflow-hidden">
          <p className="px-4 py-2 text-xs text-ink-muted" data-testid="encounter-count">
            Showing {filtered.length} of {encounters.length}
          </p>
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-ink-muted">
              No encounters match these filters.
            </p>
          )}
          {filtered.map((e) => {
            const issues = graph.issuesFor(e.slug);
            const regions =
              e.regions.length === 0
                ? 'All regions'
                : e.regions.map((r) => regionLabel(r, reference?.regionNames)).join(', ');
            return (
              <div
                key={e.id}
                className="flex flex-wrap items-start gap-3 px-4 py-3"
                data-testid="encounter-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/admin/encounters/${e.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {e.name}
                    </Link>
                    <Badge variant={e.lifecycle === 'active' ? 'solid' : 'outline'}>
                      {STATUS_LABEL[e.lifecycle]}
                    </Badge>
                    <Badge variant="outline">{e.rarity}</Badge>
                    {!e.artworkPath && <Badge variant="outline">No artwork</Badge>}
                    {issues.length > 0 && (
                      <Badge
                        variant={issues.some((i) => i.severity === 'error') ? 'danger' : 'outline'}
                        title={issues.map((i) => i.message).join('\n')}
                        data-testid="row-issues"
                      >
                        ⚠ {issues.length}
                      </Badge>
                    )}
                  </div>
                  <p
                    className="mt-1 text-xs font-medium tracking-wide text-ink-muted"
                    data-testid="row-summary"
                  >
                    {summaryBadges(e, graph).join(' · ')}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {e.slug} · {e.type.replace('_', ' ')} · {regions}
                    {e.routes.length > 0
                      ? ` · ${e.routes.length} route${e.routes.length === 1 ? '' : 's'}`
                      : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/admin/encounters/${e.id}`}>Edit</Link>
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="icon" variant="ghost" aria-label={`More actions for ${e.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-52 p-1">
                      <div className="flex flex-col text-sm" role="menu">
                        <Link
                          role="menuitem"
                          className="rounded px-3 py-2 hover:bg-surface-sunken"
                          to={`/admin/encounters/${e.id}/preview`}
                        >
                          Preview
                        </Link>
                        <Link
                          role="menuitem"
                          className="rounded px-3 py-2 hover:bg-surface-sunken"
                          to={`/admin/encounters/chains?focus=${encodeURIComponent(e.slug)}`}
                        >
                          View chain
                        </Link>
                        <Link
                          role="menuitem"
                          className="rounded px-3 py-2 hover:bg-surface-sunken"
                          to="/admin/encounters/import-export"
                          state={{ selected: [e.slug] }}
                        >
                          Export…
                        </Link>
                        {canWrite && (
                          <button
                            role="menuitem"
                            type="button"
                            className="rounded px-3 py-2 text-left hover:bg-surface-sunken disabled:opacity-50"
                            disabled={clone.isPending}
                            onClick={() => clone.mutate(e)}
                          >
                            Clone as draft
                          </button>
                        )}
                        {e.lifecycle !== 'active' && canPublish && (
                          <button
                            role="menuitem"
                            type="button"
                            className="rounded px-3 py-2 text-left hover:bg-surface-sunken"
                            disabled={lifecycle.isPending}
                            onClick={() => lifecycle.mutate({ id: e.id, next: 'active' })}
                          >
                            Activate
                          </button>
                        )}
                        {e.lifecycle === 'active' && canWrite && (
                          <button
                            role="menuitem"
                            type="button"
                            className="rounded px-3 py-2 text-left hover:bg-surface-sunken"
                            disabled={lifecycle.isPending}
                            onClick={() => lifecycle.mutate({ id: e.id, next: 'disabled' })}
                          >
                            Disable
                          </button>
                        )}
                        {canWrite && (
                          <button
                            role="menuitem"
                            type="button"
                            className="rounded px-3 py-2 text-left text-danger hover:bg-danger-soft"
                            disabled={remove.isPending}
                            onClick={() => {
                              const parents = graph.roleOf(e.slug).parents;
                              const warn = parents.length
                                ? `\n\n${namesOf(graph, parents)} still continue${parents.length === 1 ? 's' : ''} to it.`
                                : '';
                              if (
                                window.confirm(
                                  `Delete "${e.name}"? Encounters with history cannot be deleted — disable them instead.${warn}`,
                                )
                              ) {
                                remove.mutate(e.id);
                              }
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
