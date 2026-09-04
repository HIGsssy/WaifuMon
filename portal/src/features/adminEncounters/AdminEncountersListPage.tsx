/**
 * Portal Admin — Encounter Manager list view.
 *
 * Rendered under `<RequirePortalPermission permission="encounters.read">`,
 * so an unprivileged session never gets here — but the API also re-checks
 * every call independently, so a direct URL is caught server-side too.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  cloneAdminEncounter,
  deleteAdminEncounter,
  listAdminEncounters,
  setAdminEncounterLifecycle,
  type AdminEncounter,
} from '@/api/adminEncounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';

const REGION_LABELS: Record<string, string> = {
  'waifu-valley': 'Waifu Valley',
  'twin-peeks': 'Twin Peeks',
  'flaccid-foothills': 'Flaccid Foothills',
  thirstlands: 'Thirstlands',
};

interface Filters {
  q: string;
  source: 'all' | 'hunt' | 'travel';
  rarity: string;
  lifecycle: string;
  region: string;
}

const DEFAULT_FILTERS: Filters = {
  q: '',
  source: 'all',
  rarity: '',
  lifecycle: '',
  region: '',
};

function filterEncounters(encounters: AdminEncounter[], f: Filters): AdminEncounter[] {
  return encounters.filter((e) => {
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!e.name.toLowerCase().includes(q) && !e.slug.toLowerCase().includes(q)) return false;
    }
    if (f.source === 'hunt' && !e.huntEligible) return false;
    if (f.source === 'travel' && !e.travelEligible) return false;
    if (f.rarity && e.rarity !== f.rarity) return false;
    if (f.lifecycle && e.lifecycle !== f.lifecycle) return false;
    if (f.region && e.regions.length > 0 && !e.regions.includes(f.region)) return false;
    return true;
  });
}

function regionSummary(e: AdminEncounter): string {
  if (e.regions.length === 0 && e.routes.length === 0) return 'any';
  const parts: string[] = [];
  if (e.regions.length > 0) parts.push(e.regions.map((r) => REGION_LABELS[r] ?? r).join(', '));
  if (e.routes.length > 0) parts.push(`${e.routes.length} route(s)`);
  return parts.join(' · ');
}

export function AdminEncountersListPage() {
  const canWrite = useHasPermission('encounters.write');
  const canPublish = useHasPermission('encounters.publish');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin', 'encounters', 'list'],
    queryFn: ({ signal }) => listAdminEncounters(signal),
  });

  const filtered = useMemo(
    () => (query.data ? filterEncounters(query.data.encounters, filters) : []),
    [query.data, filters],
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'encounters', 'list'] });

  const toggleLifecycle = useMutation({
    mutationFn: ({ id, lifecycle }: { id: number; lifecycle: 'active' | 'disabled' }) =>
      setAdminEncounterLifecycle(id, lifecycle),
    onSuccess: invalidate,
  });
  const cloneOne = useMutation({
    mutationFn: ({ id, newSlug }: { id: number; newSlug: string }) =>
      cloneAdminEncounter(id, newSlug),
    onSuccess: invalidate,
  });
  const deleteOne = useMutation({
    mutationFn: (id: number) => deleteAdminEncounter(id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Encounter Manager"
        description="World encounter definitions for Hunt and Travel."
        actions={
          canWrite ? (
            <Button asChild>
              <Link to="/admin/encounters/new">New encounter</Link>
            </Button>
          ) : undefined
        }
      />

      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Input
            placeholder="Search name or slug"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
          <select
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={filters.source}
            onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value as Filters['source'] }))}
          >
            <option value="all">Source: any</option>
            <option value="hunt">Hunt only</option>
            <option value="travel">Travel only</option>
          </select>
          <select
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={filters.rarity}
            onChange={(e) => setFilters((f) => ({ ...f, rarity: e.target.value }))}
          >
            <option value="">Rarity: any</option>
            <option value="common">Common</option>
            <option value="uncommon">Uncommon</option>
            <option value="rare">Rare</option>
            <option value="mythic">Mythic</option>
          </select>
          <select
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={filters.lifecycle}
            onChange={(e) => setFilters((f) => ({ ...f, lifecycle: e.target.value }))}
          >
            <option value="">Lifecycle: any</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
          <select
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={filters.region}
            onChange={(e) => setFilters((f) => ({ ...f, region: e.target.value }))}
          >
            <option value="">Region: any</option>
            {Object.entries(REGION_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
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
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Rarity</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Region</th>
                <th className="px-3 py-2 text-right">Weight</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-ink-muted">
                    No encounters match these filters.
                  </td>
                </tr>
              )}
              {filtered.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link to={`/admin/encounters/${e.id}`} className="font-medium text-primary">
                      {e.name}
                    </Link>
                    <div className="text-xs text-ink-muted">{e.slug}</div>
                  </td>
                  <td className="px-3 py-2 capitalize">{e.type.replace('_', ' ')}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{e.rarity}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.huntEligible && <Badge variant="outline">hunt</Badge>}{' '}
                    {e.travelEligible && <Badge variant="outline">travel</Badge>}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{regionSummary(e)}</td>
                  <td className="px-3 py-2 text-right tabular">{e.weight}</td>
                  <td className="px-3 py-2">
                    <Badge variant={e.lifecycle === 'active' ? 'default' : 'outline'}>
                      {e.lifecycle}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="outline" asChild>
                        <Link to={`/admin/encounters/${e.id}`}>Edit</Link>
                      </Button>
                      <Button size="sm" variant="outline" asChild>
                        <Link to={`/admin/encounters/${e.id}/preview`}>Preview</Link>
                      </Button>
                      {canPublish && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={toggleLifecycle.isPending}
                          onClick={() =>
                            toggleLifecycle.mutate({
                              id: e.id,
                              lifecycle: e.lifecycle === 'active' ? 'disabled' : 'active',
                            })
                          }
                        >
                          {e.lifecycle === 'active' ? 'Disable' : 'Activate'}
                        </Button>
                      )}
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cloneOne.isPending}
                          onClick={() => {
                            const suffix = Math.floor(Date.now() / 1000) % 100000;
                            cloneOne.mutate({ id: e.id, newSlug: `${e.slug}_copy_${suffix}` });
                          }}
                        >
                          Clone
                        </Button>
                      )}
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={deleteOne.isPending}
                          onClick={() => {
                            if (window.confirm(`Delete "${e.name}"? History will block this.`)) {
                              deleteOne.mutate(e.id);
                            }
                          }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
