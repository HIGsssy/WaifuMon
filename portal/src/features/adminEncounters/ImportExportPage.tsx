/**
 * World Encounters — Import / Export (content promotion), moved off the
 * encounter list.
 *
 * The promotion panel is unchanged; this page gives it something to pick from:
 * a searchable checklist whose selection survives searching, so an author can
 * select, refine, select more and export both. Select-all only reaches the
 * rows in view. The list page's "Export…" action arrives here with that
 * encounter already selected.
 *
 * Exports carry the vendors their encounters open, exactly as before.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { ContentPromotionPanel } from './ContentPromotionPanel';
import { useEncounterList } from './useAuthoringData';

export function ImportExportPage() {
  const location = useLocation();
  const preselected = (location.state as { selected?: string[] } | null)?.selected ?? [];
  const query = useEncounterList();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected));

  const encounters = useMemo(
    () => [...(query.data?.encounters ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [query.data],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? encounters.filter(
          (e) => e.name.toLowerCase().includes(needle) || e.slug.toLowerCase().includes(needle),
        )
      : encounters;
  }, [encounters, q]);

  const filteredSlugs = filtered.map((e) => e.slug);
  const inView = filteredSlugs.filter((s) => selected.has(s)).length;
  const allInView = filteredSlugs.length > 0 && inView === filteredSlugs.length;
  const someInView = inView > 0 && !allInView;

  const toggle = (slug: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of filteredSlugs) {
        if (allInView) next.delete(s);
        else next.add(s);
      }
      return next;
    });
  const clear = () => setSelected(new Set());
  const selectedSlugs = useMemo(() => Array.from(selected), [selected]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import / Export"
        description="Move encounters (and the vendors they open) between servers as a reviewable file."
      />

      <ContentPromotionPanel selectedSlugs={selectedSlugs} onClearSelection={clear} />

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase text-ink-muted">
          Choose encounters to export
        </h2>
        <Input
          type="search"
          placeholder="Search name or slug"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm"
        />
        {query.isPending && <Skeleton className="h-24 w-full" />}
        {query.isError && (
          <ErrorState
            title="Could not load encounters"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        )}
        {query.data && (
          <div className="overflow-hidden rounded-md border border-border">
            {selected.size > 0 && (
              <div
                className="flex items-center justify-between border-b border-border bg-surface-sunken px-3 py-2 text-sm"
                data-testid="encounter-selection-status"
              >
                <span className="text-ink-muted">{selected.size} selected</span>
                <Button size="sm" variant="outline" onClick={clear}>
                  Clear selection
                </Button>
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all encounters in view"
                      checked={allInView}
                      disabled={filteredSlugs.length === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = someInView;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-ink-muted">
                      No encounters match.
                    </td>
                  </tr>
                )}
                {filtered.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.name}`}
                        checked={selected.has(e.slug)}
                        onChange={() => toggle(e.slug)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to={`/admin/encounters/${e.id}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {e.name}
                      </Link>
                      <div className="text-xs text-ink-muted">{e.slug}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-muted">{e.lifecycle}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
