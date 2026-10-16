/**
 * Shipped content vs the Portal-managed pool.
 *
 * The region file's `encounterPool` seeded each region once; since then the
 * database is authoritative and a changed file is only *reported*. This panel
 * shows the difference and offers the backend's two safe operations:
 *
 *   - **Load shipped pool into draft** — replaces the saved draft (not live);
 *   - **Merge newly shipped species** — appends shipped species the draft lacks,
 *     keeping every existing entry and weight.
 *
 * Removals and weight conflicts need a person to decide whose change wins, so
 * they are applied — only if ticked — as ordinary unsaved edits on this page.
 * Nothing here publishes.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getRegionPoolShipped, regionPoolKeys, type RegionPoolEntry } from '@/api/adminRegionPools';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import type { PoolRow, SpeciesFacts } from './regionPoolModel';
import { DiffList } from './regionPoolParts';

export function RegionPoolShippedPanel({
  regionId,
  draftRevision,
  facts,
  canWrite,
  dirty,
  rows,
  onRowsChange,
  onLoadShipped,
  onMerge,
}: {
  regionId: string;
  /** The saved draft this comparison is against. */
  draftRevision: number;
  facts: ReadonlyMap<string, SpeciesFacts>;
  canWrite: boolean;
  dirty: boolean;
  rows: readonly PoolRow[];
  onRowsChange: (rows: PoolRow[]) => void;
  onLoadShipped: () => void;
  onMerge: (species?: string[]) => void;
}) {
  const shipped = useQuery({
    queryKey: [...regionPoolKeys.shipped(regionId), draftRevision],
    queryFn: ({ signal }) => getRegionPoolShipped(regionId, signal),
  });
  const [pickMerge, setPickMerge] = useState<Set<string>>(new Set());
  const [pickRemove, setPickRemove] = useState<Set<string>>(new Set());
  const [pickWeight, setPickWeight] = useState<Set<string>>(new Set());

  if (shipped.isPending) return <Skeleton className="h-48 w-full" />;
  if (shipped.isError)
    return (
      <ErrorState
        title="Could not load the shipped pool"
        error={shipped.error}
        onRetry={() => void shipped.refetch()}
      />
    );
  const data = shipped.data;
  const nameOf = (slug: string) => facts.get(slug)?.name ?? slug;
  const toggle = (set: Set<string>, slug: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    apply(next);
  };

  if (!data.available)
    return (
      <Card className="p-4 text-sm text-ink-muted" data-testid="region-pool-shipped">
        This region has no shipped pool in the content files, so there is nothing to compare.
      </Card>
    );

  // "Only in the Portal pool": the saved draft lists her, the shipped file does not.
  const portalOnly = data.diffFromDraft.removed;
  const onPage = new Set(rows.map((r) => r.species));

  const applyRemovals = () => {
    onRowsChange(rows.filter((r) => !pickRemove.has(r.species)));
    setPickRemove(new Set());
  };
  const applyWeights = () => {
    const shippedWeight = new Map(data.weightConflicts.map((c) => [c.species, c.shipped]));
    onRowsChange(
      rows.map((r) =>
        pickWeight.has(r.species) && shippedWeight.has(r.species)
          ? { ...r, weight: String(shippedWeight.get(r.species)) }
          : r,
      ),
    );
    setPickWeight(new Set());
  };

  return (
    <div className="space-y-4" data-testid="region-pool-shipped">
      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Shipped pool</h3>
        <p className="text-xs text-ink-muted">
          The region file lists {data.entries.length} species
          {data.hash && (
            <>
              {' '}
              (fingerprint <code className="break-all font-mono">{data.hash}</code>)
            </>
          )}
          . It seeded this region once; changing the file never changes the pool on its own.
        </p>
        {data.skipped.length > 0 && (
          <p className="text-xs text-danger">
            The file names species that do not exist and are skipped: {data.skipped.join(', ')}.
          </p>
        )}
        {dirty && (
          <p className="text-xs text-danger" role="note">
            The comparison below is against your saved draft (revision {draftRevision}), not your
            unsaved edits.
          </p>
        )}
      </Card>

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">
          Shipped vs published (live)
        </h3>
        <DiffList
          diff={data.diffFromPublished}
          nameOf={nameOf}
          testId="shipped-vs-published"
          empty="The published pool matches the shipped file."
        />
        <p className="text-xs text-ink-subtle">
          "Added" are species the file has and the live pool does not; "Removed" are live species
          the file no longer lists.
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Shipped vs saved draft</h3>

        <section
          aria-label="Newly shipped species"
          className="space-y-1"
          data-testid="shipped-merge-candidates"
        >
          <h4 className="text-xs font-semibold">
            Newly shipped species ({data.mergeCandidates.length})
          </h4>
          {data.mergeCandidates.length === 0 ? (
            <p className="text-xs text-ink-muted">The draft already lists every shipped species.</p>
          ) : (
            <>
              <CheckList
                entries={data.mergeCandidates.map((e) => ({
                  slug: e.species,
                  label: `${nameOf(e.species)} — shipped weight ${e.weight}`,
                }))}
                picked={pickMerge}
                disabled={!canWrite}
                onToggle={(slug) => toggle(pickMerge, slug, setPickMerge)}
                name="Merge"
              />
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pickMerge.size === 0}
                    onClick={() => onMerge([...pickMerge])}
                  >
                    Merge selected into draft
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => onMerge()}>
                    Merge all newly shipped species
                  </Button>
                </div>
              )}
              <p className="text-xs text-ink-subtle">
                Merging appends them at their shipped weights and saves the draft. Existing entries
                and custom weights are kept; nothing is removed or published.
              </p>
            </>
          )}
        </section>

        <section
          aria-label="Only in the Portal pool"
          className="space-y-1"
          data-testid="shipped-portal-only"
        >
          <h4 className="text-xs font-semibold">
            Only in the Portal-managed draft ({portalOnly.length})
          </h4>
          {portalOnly.length === 0 ? (
            <p className="text-xs text-ink-muted">
              Every draft species is also in the shipped file.
            </p>
          ) : (
            <>
              <CheckList
                entries={portalOnly
                  .filter((e) => onPage.has(e.species))
                  .map((e: RegionPoolEntry) => ({
                    slug: e.species,
                    label: `${nameOf(e.species)} — weight ${e.weight}`,
                  }))}
                picked={pickRemove}
                disabled={!canWrite}
                onToggle={(slug) => toggle(pickRemove, slug, setPickRemove)}
                name="Remove"
              />
              {canWrite && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pickRemove.size === 0}
                  onClick={applyRemovals}
                >
                  Remove selected from my edits
                </Button>
              )}
              <p className="text-xs text-ink-subtle">
                Either the file dropped them or an administrator added them. Removing is an ordinary
                unsaved edit — review it in the editor and save.
              </p>
            </>
          )}
        </section>

        <section
          aria-label="Weight differences"
          className="space-y-1"
          data-testid="shipped-weight-conflicts"
        >
          <h4 className="text-xs font-semibold">
            Weight differences ({data.weightConflicts.length})
          </h4>
          {data.weightConflicts.length === 0 ? (
            <p className="text-xs text-ink-muted">Shared species have the same weights.</p>
          ) : (
            <>
              <CheckList
                entries={data.weightConflicts
                  .filter((c) => onPage.has(c.species))
                  .map((c) => ({
                    slug: c.species,
                    label: `${nameOf(c.species)} — draft ${c.draft}, shipped ${c.shipped}`,
                  }))}
                picked={pickWeight}
                disabled={!canWrite}
                onToggle={(slug) => toggle(pickWeight, slug, setPickWeight)}
                name="Use shipped weight for"
              />
              {canWrite && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pickWeight.size === 0}
                  onClick={applyWeights}
                >
                  Use shipped weights for selected
                </Button>
              )}
              <p className="text-xs text-ink-subtle">
                Custom weights are never replaced automatically. Ticked ones become unsaved edits.
              </p>
            </>
          )}
        </section>

        {canWrite && (
          <div className="space-y-1 border-t border-border pt-3">
            <Button type="button" size="sm" variant="danger" onClick={onLoadShipped}>
              Load shipped pool into draft
            </Button>
            <p className="text-xs text-ink-subtle">
              Replaces the whole saved draft with the shipped pool. Hunting is unaffected until
              someone publishes.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function CheckList({
  entries,
  picked,
  disabled,
  onToggle,
  name,
}: {
  entries: Array<{ slug: string; label: string }>;
  picked: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (slug: string) => void;
  name: string;
}) {
  return (
    <ul className="space-y-1">
      {entries.map((e) => (
        <li key={e.slug}>
          <label className="flex min-h-8 items-center gap-2 text-sm">
            {!disabled && (
              <input
                type="checkbox"
                aria-label={`${name} ${e.label}`}
                checked={picked.has(e.slug)}
                onChange={() => onToggle(e.slug)}
              />
            )}
            <span className="break-words">{e.label}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
