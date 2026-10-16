/**
 * History: every published revision of one region, the audit trail, and
 * rollback.
 *
 * A rollback is a publish of an earlier revision's entries: it goes through the
 * same server review (fresh fingerprint, warnings acknowledged by id), is
 * revalidated against today's species and other regions, creates a new
 * revision, and replaces the saved draft. History rows are never changed.
 */
import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import {
  getRegionPoolEvents,
  getRegionPoolHistory,
  getRegionPoolRevision,
  previewRegionPoolRollback,
  regionPoolKeys,
  rollbackRegionPool,
  type RegionPoolEntry,
  type RegionPoolHistoryItem,
  type RegionPoolStaleDetails,
  type RegionPoolView,
  type RegionRef,
} from '@/api/adminRegionPools';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/layout/ErrorState';

import { RegionPoolReviewDialog } from './RegionPoolReviewDialog';
import {
  EVENT_LABELS,
  SOURCE_LABELS,
  entryDiff,
  formatWhen,
  type SpeciesFacts,
} from './regionPoolModel';
import { DiffList } from './regionPoolParts';

const EVENT_PAGE = 25;

export function RegionPoolHistoryPanel({
  view,
  canPublish,
  dirty,
  facts,
  regionNames,
  onRolledBack,
  onStaleDraft,
}: {
  view: RegionPoolView;
  canPublish: boolean;
  /** Unsaved edits on this page, which a rollback also discards. */
  dirty: boolean;
  facts: ReadonlyMap<string, SpeciesFacts>;
  regionNames: ReadonlyMap<string, RegionRef>;
  onRolledBack: (view: RegionPoolView) => void;
  onStaleDraft: (details: RegionPoolStaleDetails) => void;
}) {
  const regionId = view.region.id;
  const history = useQuery({
    queryKey: regionPoolKeys.history(regionId),
    queryFn: ({ signal }) => getRegionPoolHistory(regionId, signal),
  });
  const [rollingBack, setRollingBack] = useState<number | null>(null);

  return (
    <div className="space-y-4" data-testid="region-pool-history">
      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Published revisions</h3>
        {history.isPending && <Skeleton className="h-32 w-full" />}
        {history.isError && (
          <ErrorState
            title="Could not load history"
            error={history.error}
            onRetry={() => void history.refetch()}
          />
        )}
        {history.data && (
          <ol className="space-y-2" aria-label="Published revisions">
            {history.data.revisions.map((rev, i) => (
              <RevisionRow
                key={rev.number}
                regionId={regionId}
                revision={rev}
                previous={history.data.revisions[i + 1] ?? null}
                facts={facts}
                canPublish={canPublish}
                onRollback={() => setRollingBack(rev.number)}
              />
            ))}
          </ol>
        )}
        {!canPublish && (
          <p className="text-xs text-ink-muted">
            Rolling back needs the regions.publish permission.
          </p>
        )}
      </Card>

      <AuditTrail regionId={regionId} />

      {rollingBack !== null && (
        <RollbackDialog
          view={view}
          revision={rollingBack}
          dirty={dirty}
          facts={facts}
          regionNames={regionNames}
          onClose={() => setRollingBack(null)}
          onDone={(next) => {
            setRollingBack(null);
            onRolledBack(next);
          }}
          onStaleDraft={onStaleDraft}
        />
      )}
    </div>
  );
}

function RevisionRow({
  regionId,
  revision,
  previous,
  facts,
  canPublish,
  onRollback,
}: {
  regionId: string;
  revision: RegionPoolHistoryItem;
  previous: RegionPoolHistoryItem | null;
  facts: ReadonlyMap<string, SpeciesFacts>;
  canPublish: boolean;
  onRollback: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="space-y-2 rounded border border-border p-3"
      data-testid={`revision-${revision.number}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            Revision #{revision.number} {revision.current && <Badge variant="solid">Live</Badge>}
          </p>
          <p className="text-xs text-ink-muted">
            {formatWhen(revision.publishedAt)}
            {revision.publishedBy ? ` · by ${revision.publishedBy}` : ' · by the system'} ·{' '}
            {SOURCE_LABELS[revision.source]}
            {revision.rolledBackFrom !== null && ` of revision #${revision.rolledBackFrom}`} ·{' '}
            {revision.entryCount} species
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide changes' : 'Show changes'}
          </Button>
          {canPublish && !revision.current && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRollback}
              aria-label={`Roll back to revision ${revision.number}`}
            >
              Roll back to this revision
            </Button>
          )}
        </div>
      </div>
      {open && (
        <RevisionChanges
          regionId={regionId}
          revision={revision.number}
          previous={previous?.number ?? null}
          facts={facts}
        />
      )}
    </li>
  );
}

function RevisionChanges({
  regionId,
  revision,
  previous,
  facts,
}: {
  regionId: string;
  revision: number;
  previous: number | null;
  facts: ReadonlyMap<string, SpeciesFacts>;
}) {
  const now = useQuery({
    queryKey: regionPoolKeys.revision(regionId, revision),
    queryFn: ({ signal }) => getRegionPoolRevision(regionId, revision, signal),
  });
  const before = useQuery({
    queryKey: regionPoolKeys.revision(regionId, previous ?? 0),
    queryFn: ({ signal }) => getRegionPoolRevision(regionId, previous!, signal),
    enabled: previous !== null,
  });
  if (now.isPending || (previous !== null && before.isPending))
    return <Skeleton className="h-10 w-full" />;
  if (now.isError || before.isError)
    return <p className="text-xs text-danger">Could not load this revision.</p>;
  const plain = (list: readonly RegionPoolEntry[]) =>
    list.map((e) => ({ species: e.species, weight: e.weight }));
  const nameOf = (slug: string) =>
    now.data.entries.find((e) => e.species === slug)?.name ??
    before.data?.entries.find((e) => e.species === slug)?.name ??
    facts.get(slug)?.name ??
    slug;
  return (
    <DiffList
      diff={entryDiff(plain(before.data?.entries ?? []), plain(now.data.entries))}
      nameOf={nameOf}
      testId={`revision-${revision}-changes`}
      empty={
        previous === null ? 'First revision.' : 'Same species and weights as the previous revision.'
      }
    />
  );
}

function RollbackDialog({
  view,
  revision,
  dirty,
  facts,
  regionNames,
  onClose,
  onDone,
  onStaleDraft,
}: {
  view: RegionPoolView;
  revision: number;
  dirty: boolean;
  facts: ReadonlyMap<string, SpeciesFacts>;
  regionNames: ReadonlyMap<string, RegionRef>;
  onClose: () => void;
  onDone: (view: RegionPoolView) => void;
  onStaleDraft: (details: RegionPoolStaleDetails) => void;
}) {
  const regionId = view.region.id;
  const target = useQuery({
    queryKey: regionPoolKeys.revision(regionId, revision),
    queryFn: ({ signal }) => getRegionPoolRevision(regionId, revision, signal),
  });
  const plain = (list: readonly RegionPoolEntry[]) =>
    list.map((e) => ({ species: e.species, weight: e.weight }));
  // The coverage table needs the target's entries; until they arrive there is nothing honest to show.
  if (!target.data) return null;
  return (
    <RegionPoolReviewDialog
      open
      onClose={onClose}
      title={`Roll back ${view.region.name} to revision #${revision}`}
      intro={
        <>
          <p>Rolling back:</p>
          <ul className="ml-4 list-disc">
            <li>
              creates a new published revision holding revision #{revision}'s species and weights;
            </li>
            <li>
              updates the live hunting pool
              {view.region.released
                ? ' — the next hunt draws from it'
                : ' (once the region is released)'}
              ;
            </li>
            <li>
              <strong>replaces the saved draft</strong> with the restored pool
              {view.draft.unpublishedChanges &&
                ' — your saved, unpublished draft changes will be lost'}
              ;
            </li>
            <li>does not erase any historical revision.</li>
          </ul>
          <p>It is revalidated against today's species and other regions.</p>
        </>
      }
      reviewKey={[...regionPoolKeys.region(regionId), 'rollback-review', revision]}
      loadReview={(signal) => previewRegionPoolRollback(regionId, revision, signal)}
      submit={(input) => rollbackRegionPool(regionId, { ...input, revision })}
      onDone={onDone}
      onStaleDraft={onStaleDraft}
      submitLabel={`Roll back to revision #${revision}`}
      facts={facts}
      regionNames={regionNames}
      before={plain(view.published?.entries ?? [])}
      after={plain(target.data.entries)}
      probability={
        <p className="text-xs text-ink-muted">
          The analysis API covers the draft and the published pool only, so it cannot price an
          earlier revision. After the rollback, the Probability tab shows the new live odds.
        </p>
      }
      confirmations={
        dirty
          ? [{ id: 'discard-local', label: 'Discard the unsaved edits on this page as well.' }]
          : []
      }
    />
  );
}

function AuditTrail({ regionId }: { regionId: string }) {
  const events = useInfiniteQuery({
    queryKey: regionPoolKeys.events(regionId),
    queryFn: ({ pageParam, signal }) =>
      getRegionPoolEvents(
        regionId,
        { limit: EVENT_PAGE, ...(pageParam ? { before: pageParam } : {}) },
        signal,
      ),
    initialPageParam: '',
    getNextPageParam: (last) =>
      last.events.length === EVENT_PAGE ? last.events[last.events.length - 1]!.cursor : undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <Card className="space-y-2 p-4" data-testid="region-pool-audit">
      <h3 className="text-sm font-semibold uppercase text-ink-muted">Audit trail</h3>
      {events.isPending && <Skeleton className="h-24 w-full" />}
      {events.isError && <p className="text-xs text-danger">Could not load the audit trail.</p>}
      <ol className="space-y-1.5" aria-label="Audit events">
        {rows.map((e) => (
          <li key={e.cursor} className="text-xs">
            <span className="font-medium text-ink">{EVENT_LABELS[e.action] ?? e.action}</span>{' '}
            <span className="text-ink-muted">
              · {formatWhen(e.createdAt)} · {e.actor ? `by ${e.actor}` : 'by the system'}
            </span>
            <EventDetails details={e.details} />
          </li>
        ))}
      </ol>
      {events.hasNextPage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          {events.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </Button>
      )}
    </Card>
  );
}

/** The scalar facts of an event; structured payloads stay folded. */
function EventDetails({ details }: { details: Record<string, unknown> }) {
  const scalars = Object.entries(details).filter(
    ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
  const lists = Object.entries(details).filter(
    ([, v]) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  );
  if (scalars.length === 0 && lists.length === 0) return null;
  return (
    <span className="block break-words text-ink-subtle">
      {[
        ...scalars.map(([k, v]) => `${k}: ${String(v)}`),
        ...lists.map(([k, v]) => `${k}: ${(v as string[]).join(', ') || '—'}`),
      ].join(' · ')}
    </span>
  );
}
