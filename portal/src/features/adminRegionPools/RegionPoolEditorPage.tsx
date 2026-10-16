/**
 * Admin — one region's encounter pool.
 *
 * Three states are always told apart, because only one of them is live:
 *
 *   1. **Unsaved edits** on this page — nowhere but this browser tab;
 *   2. **the saved draft** — shared by administrators, never hunted;
 *   3. **the published pool** — what hunts in this region draw from (once the
 *      region is released, which the region catalogue decides).
 *
 * Edits are ordinary rows; saving names the draft revision it started from and
 * is refused (409) if another administrator saved first. Publishing goes
 * through the server's review. Every share and chance shown comes from the
 * server's analysis of the saved draft; a rarity with unsaved edits says "save
 * to recalculate" instead of guessing.
 */
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Link,
  UNSAFE_DataRouterContext,
  useBlocker,
  useParams,
  useSearchParams,
} from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';

import {
  NOT_HUNTABLE_RARITY,
  analyseRegionPool,
  discardRegionPoolDraft,
  getRegionPool,
  getRegionPoolDrift,
  getRegionPoolSpecies,
  invalidateRegionPoolQueries,
  listRegionPools,
  loadShippedIntoDraft,
  mergeShippedIntoDraft,
  publishRegionPool,
  regionPoolKeys,
  reviewRegionPoolPublish,
  saveRegionPoolDraft,
  validateRegionPoolEntries,
  type DistributionResult,
  type RegionPoolAnalysisRequest,
  type RegionPoolIssue,
  type RegionPoolStaleDetails,
  type RegionPoolView,
  type RegionRef,
} from '@/api/adminRegionPools';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { rarityStyle } from '@/lib/rarity';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

import { PublishProbabilityChanges, RegionPoolAnalysisPanel } from './RegionPoolAnalysisPanel';
import { RegionPoolHistoryPanel } from './RegionPoolHistoryPanel';
import { RegionPoolReviewDialog } from './RegionPoolReviewDialog';
import { RegionPoolShippedPanel } from './RegionPoolShippedPanel';
import { RegionSpeciesPicker } from './RegionSpeciesPicker';
import {
  EXCLUSION_LABELS,
  TIER_LABELS,
  entriesOf,
  factsIndex,
  formatPercent,
  formatWhen,
  groupRows,
  hasLocalChanges,
  issuesForRarity,
  issuesForSpecies,
  localChanges,
  oddsFor,
  parseWeight,
  poolIssues,
  rarityOdds,
  rowsOf,
  sectionOf,
  type PoolRow,
  type SpeciesFacts,
} from './regionPoolModel';
import {
  IssueList,
  RegionSpeciesThumb,
  ReleaseBadge,
  SpeciesFlags,
  StaleDraftBanner,
} from './regionPoolParts';

const LIST = '/admin/region-pools';
const DISCARD = 'Discard unsaved Region Pool edits and leave this page?';
/** How long the rows must sit still before the server checks them again. */
export const VALIDATE_DELAY_MS = 400;
const TABS = {
  editor: 'Pool editor',
  odds: 'Probability',
  shipped: 'Shipped content',
  history: 'History',
} as const;
type Tab = keyof typeof TABS;
/** The odds beside each row: normal hunting, level 1, no Buddy, saved draft. */
const EDITOR_ANALYSIS: RegionPoolAnalysisRequest = {
  source: 'draft',
  mode: 'hunt',
  level: 1,
  compare: false,
};

export function RegionPoolEditorPage() {
  const { regionId = '' } = useParams<{ regionId: string }>();
  return <Editor key={regionId} regionId={regionId} />;
}

interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  run: () => void;
}

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return settled;
}

function UnsavedNavigationGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(DISCARD)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  return null;
}

function Editor({ regionId }: { regionId: string }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('regions.write');
  const canPublish = useHasPermission('regions.publish');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (params.get('tab') as Tab) in TABS ? (params.get('tab') as Tab) : 'editor';

  const poolQuery = useQuery({
    queryKey: regionPoolKeys.region(regionId),
    queryFn: ({ signal }) => getRegionPool(regionId, signal),
  });
  const speciesQuery = useQuery({
    queryKey: regionPoolKeys.species(),
    queryFn: ({ signal }) => getRegionPoolSpecies(signal),
  });
  const listQuery = useQuery({
    queryKey: regionPoolKeys.list(),
    queryFn: ({ signal }) => listRegionPools(signal),
  });

  const [loaded, setLoaded] = useState<RegionPoolView | null>(null);
  const [rows, setRows] = useState<PoolRow[]>([]);
  const [stale, setStale] = useState<RegionPoolStaleDetails | null>(null);
  const [refused, setRefused] = useState<{ message: string; issues: RegionPoolIssue[] } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = (view: RegionPoolView) => {
    setLoaded(view);
    setRows(rowsOf(view.draft.entries));
    setStale(null);
    setRefused(null);
  };
  useEffect(() => {
    if (poolQuery.data && loaded === null) adopt(poolQuery.data);
  }, [poolQuery.data, loaded]);

  const saved = useMemo(
    () =>
      loaded ? loaded.draft.entries.map((e) => ({ species: e.species, weight: e.weight })) : [],
    [loaded],
  );
  const changes = localChanges(saved, rows);
  const dirty = loaded !== null && hasLocalChanges(changes);

  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);

  const draftRevision = loaded?.draft.revision ?? 0;
  const editorAnalysis = useQuery({
    queryKey: [...regionPoolKeys.analysis(regionId, EDITOR_ANALYSIS), draftRevision],
    queryFn: ({ signal }) => analyseRegionPool(regionId, EDITOR_ANALYSIS, signal),
    enabled: loaded !== null,
    retry: false,
  });
  const drift = useQuery({
    queryKey: regionPoolKeys.drift(regionId),
    queryFn: ({ signal }) => getRegionPoolDrift(regionId, signal),
    enabled: loaded !== null,
  });

  const pending = useDebounced(rows, VALIDATE_DELAY_MS);
  const liveValidation = useQuery({
    queryKey: [...regionPoolKeys.region(regionId), 'validate-unsaved', entriesOf(pending)],
    queryFn: ({ signal }) => validateRegionPoolEntries(regionId, entriesOf(pending), signal),
    enabled: dirty,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const onWriteError = (err: unknown) => {
    if (isPortalApiError(err) && err.code === 'REGION_POOL_STALE') {
      setStale((err.details ?? {}) as RegionPoolStaleDetails);
    } else if (isPortalApiError(err)) {
      setRefused({
        message: err.message,
        issues: ((err.details ?? {}) as { issues?: RegionPoolIssue[] }).issues ?? [],
      });
    } else {
      setRefused({ message: 'The request failed.', issues: [] });
    }
  };
  const afterWrite = (view: RegionPoolView, message: string) => {
    adopt(view);
    queryClient.setQueryData(regionPoolKeys.region(regionId), view);
    invalidateRegionPoolQueries(queryClient, regionId);
    setNotice(message);
  };
  const write = useMutation({
    mutationFn: (job: { run: () => Promise<RegionPoolView>; message: string }) => job.run(),
    onSuccess: (view, job) => afterWrite(view, job.message),
    onError: onWriteError,
  });

  const reload = async () => {
    const result = await poolQuery.refetch();
    if (result.data) adopt(result.data);
    invalidateRegionPoolQueries(queryClient, regionId);
  };

  if (poolQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (poolQuery.isError) {
    return (
      <div className="space-y-4">
        <Link to={LIST} className="text-sm text-accent underline">
          Back to Region Pools
        </Link>
        <ErrorState
          title={
            isPortalApiError(poolQuery.error) && poolQuery.error.isNotFound
              ? 'Region not found'
              : 'Could not load this region pool'
          }
          error={poolQuery.error}
          onRetry={() => void poolQuery.refetch()}
        />
      </div>
    );
  }
  if (!loaded) return <Skeleton className="h-64 w-full" />;

  const catalogue = speciesQuery.data?.species ?? [];
  const facts = factsIndex(
    [...loaded.draft.entries, ...(loaded.published?.entries ?? [])],
    catalogue,
  );
  const regionNames = new Map<string, RegionRef>(
    (listQuery.data?.regions ?? []).map((r) => [r.region.id, r.region]),
  );
  const nameOf = (slug: string) => facts.get(slug)?.name ?? slug;
  const issues: RegionPoolIssue[] = dirty
    ? (liveValidation.data?.issues ?? loaded.issues)
    : loaded.issues;
  const badWeights = rows.filter((r) => parseWeight(r.weight) === null).map((r) => r.species);
  const remoteRevision = poolQuery.data?.draft.revision ?? loaded.draft.revision;
  const busy = write.isPending;
  const analysis = editorAnalysis.data?.result;

  const replacingLocal = dirty ? ' The unsaved edits on this page will be discarded.' : '';
  const run = (job: () => Promise<RegionPoolView>, message: string) =>
    write.mutate({ run: job, message });

  const save = () =>
    run(
      () => saveRegionPoolDraft(regionId, entriesOf(rows), loaded.draft.revision),
      'Draft saved. Hunting is unchanged until it is published.',
    );
  const discardLocal = () =>
    setConfirm({
      title: 'Discard unsaved edits?',
      body: 'Every change on this page since the draft was last saved is thrown away. The saved draft and the published pool are not touched.',
      confirmLabel: 'Discard unsaved edits',
      run: () => {
        setRows(rowsOf(loaded.draft.entries));
        setRefused(null);
      },
    });
  const resetToPublished = () =>
    setConfirm({
      title: 'Reset the saved draft to the published pool?',
      body: `The saved draft (revision ${loaded.draft.revision}) is replaced with published revision #${loaded.published?.number ?? '—'}. Other administrators' unpublished draft work is lost too.${replacingLocal}`,
      confirmLabel: 'Reset draft',
      run: () =>
        run(
          () => discardRegionPoolDraft(regionId, loaded.draft.revision),
          'Draft reset to the published pool.',
        ),
    });
  const loadShipped = () =>
    setConfirm({
      title: 'Load the shipped pool into the draft?',
      body: `The whole saved draft is replaced with the pool in the region file. Custom species and weights in the draft are lost. Nothing is published.${replacingLocal}`,
      confirmLabel: 'Load shipped pool',
      run: () =>
        run(
          () => loadShippedIntoDraft(regionId, loaded.draft.revision),
          'Shipped pool loaded into the draft. Not published.',
        ),
    });
  const merge = (species?: string[]) => {
    const go = () =>
      run(
        () => mergeShippedIntoDraft(regionId, loaded.draft.revision, species),
        'Newly shipped species merged into the draft. Not published.',
      );
    if (!dirty) return go();
    setConfirm({
      title: 'Merge into the saved draft?',
      body: `Merging saves a new draft from the server's copy, so the unsaved edits on this page will be discarded. Save them first if you want to keep them.`,
      confirmLabel: 'Merge and discard my edits',
      run: go,
    });
  };

  const removeRow = (slug: string) => {
    const doRemove = () => setRows((current) => current.filter((r) => r.species !== slug));
    const rarity = sectionOf(facts.get(slug));
    const sameTier = rows.filter((r) => sectionOf(facts.get(r.species)) === rarity);
    if (rarity !== NOT_HUNTABLE_RARITY && rarity !== 'unknown' && sameTier.length === 1) {
      const tier = rarityOdds(analysis, rarity);
      setConfirm({
        title: `Remove the last ${rarity} species?`,
        body: (
          <>
            <p>
              {nameOf(slug)} is the only {rarity} species in this pool. Without her, {rarity} rolls
              in this region have no species of their own
              {tier
                ? ` (today ${formatPercent(tier.rollProbability)} of rarity rolls at level 1)`
                : ''}
              .
            </p>
            <p className="mt-2">
              Hunts then draw a {rarity} species from the default region, then from any open species
              — the validation panel shows the server's exact fallback once she is removed. Save and
              check the Probability tab before publishing.
            </p>
          </>
        ),
        confirmLabel: `Remove ${nameOf(slug)}`,
        run: doRemove,
      });
      return;
    }
    doRemove();
  };
  const addSpecies = (slug: string) => {
    setRows((current) => [...current, { species: slug, weight: '1' }]);
    setNotice(`${nameOf(slug)} added with weight 1 (unsaved).`);
  };
  const setWeight = (slug: string, weight: string) =>
    setRows((current) => current.map((r) => (r.species === slug ? { ...r, weight } : r)));

  const groups = groupRows(rows, facts);
  const removedRarities = new Set(changes.removed.map((s) => sectionOf(facts.get(s))));
  const changedSlugs = new Set([...changes.added, ...changes.reweighted]);

  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      {dataRouter && <UnsavedNavigationGuard dirty={dirty} />}
      <PageHeader
        title={`Region Pool — ${loaded.region.name}`}
        description="Rarity is rolled first from the game's rarity table; then one species of that rarity is picked from this pool by weight."
        actions={
          <Button variant="outline" asChild>
            <Link to={LIST}>Back to Region Pools</Link>
          </Button>
        }
      />

      <StatusStrip view={loaded} changes={changes} dirty={dirty} />

      {stale && <StaleDraftBanner details={stale} onReload={() => void reload()} />}
      {!stale && remoteRevision !== loaded.draft.revision && (
        <Card className="space-y-2 p-4 text-sm" role="status" data-testid="remote-change">
          <p>
            Another administrator saved draft revision {remoteRevision} after you opened this page.
            Saving now will be refused.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            Reload latest draft{dirty ? ' (discard my edits)' : ''}
          </Button>
        </Card>
      )}
      {refused && (
        <Card className="space-y-2 border-danger/40 p-4" role="alert" data-testid="write-refused">
          <p className="text-sm font-medium text-danger">{refused.message}</p>
          <IssueList issues={refused.issues} regionNames={regionNames} />
        </Card>
      )}
      {notice && (
        <p role="status" className="text-sm text-ink" data-testid="region-pool-notice">
          {notice}
        </p>
      )}

      <ActionBar
        canWrite={canWrite}
        canPublish={canPublish}
        dirty={dirty}
        busy={busy}
        badWeights={badWeights.length > 0}
        unpublished={loaded.draft.unpublishedChanges}
        onSave={save}
        onDiscardLocal={discardLocal}
        onReset={resetToPublished}
        onPublish={() => setPublishing(true)}
      />

      <div role="tablist" aria-label="Region Pool sections" className="flex flex-wrap gap-2">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Button
            key={t}
            role="tab"
            aria-selected={t === tab}
            variant={t === tab ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setParams(t === 'editor' ? {} : { tab: t }, { replace: true })}
          >
            {TABS[t]}
          </Button>
        ))}
      </div>

      {tab === 'editor' && (
        <div className="space-y-4" role="tabpanel" aria-label={TABS.editor}>
          <HowOddsWork />
          {drift.data?.status === 'drift' && (
            <DriftCard drift={drift.data} nameOf={nameOf} regionNames={regionNames} />
          )}
          {poolIssues(issues).length > 0 && (
            <Card className="p-4">
              <IssueList
                issues={poolIssues(issues)}
                regionNames={regionNames}
                testId="pool-issues"
              />
            </Card>
          )}
          {editorAnalysis.isError && (
            <p className="text-xs text-danger" role="alert">
              Odds are unavailable: {editorAnalysis.error.message}
            </p>
          )}
          {groups.map((g) => (
            <RaritySection
              key={g.rarity}
              rarity={g.rarity}
              rows={g.rows}
              facts={facts}
              issues={issues}
              analysis={analysis}
              analysisLoading={editorAnalysis.isPending}
              stale={
                g.rows.some((r) => changedSlugs.has(r.species)) || removedRarities.has(g.rarity)
              }
              changedSlugs={changedSlugs}
              regionId={regionId}
              regionNames={regionNames}
              canWrite={canWrite}
              onWeight={setWeight}
              onRemove={removeRow}
            />
          ))}
          {canWrite && (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase text-ink-muted">Add species</h2>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={picking}
                  onClick={() => setPicking(!picking)}
                >
                  {picking ? 'Close picker' : '+ Add species'}
                </Button>
              </div>
              {picking &&
                (speciesQuery.isError ? (
                  <ErrorState
                    title="Could not load species"
                    error={speciesQuery.error}
                    onRetry={() => void speciesQuery.refetch()}
                  />
                ) : speciesQuery.isPending ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <RegionSpeciesPicker
                    regionId={regionId}
                    species={catalogue}
                    listed={new Set(rows.map((r) => r.species))}
                    regionNames={regionNames}
                    onSelect={addSpecies}
                  />
                ))}
            </Card>
          )}
        </div>
      )}

      {tab === 'odds' && (
        <div role="tabpanel" aria-label={TABS.odds}>
          <RegionPoolAnalysisPanel
            regionId={regionId}
            catalogue={catalogue}
            poolSpecies={[
              ...new Set([
                ...saved.map((e) => e.species),
                ...(loaded.published?.entries.map((e) => e.species) ?? []),
              ]),
            ].map((slug) => ({ slug, name: nameOf(slug) }))}
            hasUnpublishedDraft={loaded.draft.unpublishedChanges}
            dirty={dirty}
          />
        </div>
      )}

      {tab === 'shipped' && (
        <div role="tabpanel" aria-label={TABS.shipped}>
          <RegionPoolShippedPanel
            regionId={regionId}
            draftRevision={loaded.draft.revision}
            facts={facts}
            canWrite={canWrite}
            dirty={dirty}
            rows={rows}
            onRowsChange={(next) => {
              setRows(next);
              setNotice(
                'Changes applied as unsaved edits. Review them in the Pool editor and save.',
              );
            }}
            onLoadShipped={loadShipped}
            onMerge={merge}
          />
        </div>
      )}

      {tab === 'history' && (
        <div role="tabpanel" aria-label={TABS.history}>
          <RegionPoolHistoryPanel
            view={loaded}
            canPublish={canPublish}
            dirty={dirty}
            facts={facts}
            regionNames={regionNames}
            onRolledBack={(view) =>
              afterWrite(
                view,
                `Rolled back: published revision #${view.published?.number ?? '?'} is now live and the draft matches it.`,
              )
            }
            onStaleDraft={setStale}
          />
        </div>
      )}

      <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />

      {publishing && (
        <RegionPoolReviewDialog
          open
          onClose={() => setPublishing(false)}
          title={`Publish ${loaded.region.name}'s draft`}
          intro={
            <>
              <p>
                Publishing makes saved draft revision {loaded.draft.revision} a new immutable
                revision and rebuilds the live hunting pool for this region
                {loaded.region.released
                  ? ' — the next hunt here draws from it.'
                  : '. The region is unreleased, so hunts reach it only once it is released.'}
              </p>
              <p>The server re-checks everything when you confirm.</p>
            </>
          }
          reviewKey={[...regionPoolKeys.region(regionId), 'publish-review', loaded.draft.revision]}
          loadReview={(signal) => reviewRegionPoolPublish(regionId, signal)}
          submit={(input) => publishRegionPool(regionId, input)}
          onDone={(view) => {
            setPublishing(false);
            afterWrite(
              view,
              `Published revision #${view.published?.number ?? '?'}. Hunts in this region now use it${view.region.released ? '' : ' once the region is released'}.`,
            );
          }}
          onStaleDraft={setStale}
          submitLabel="Publish"
          facts={facts}
          regionNames={regionNames}
          before={(loaded.published?.entries ?? []).map((e) => ({
            species: e.species,
            weight: e.weight,
          }))}
          after={saved}
          probability={
            <PublishProbabilityChanges regionId={regionId} draftRevision={loaded.draft.revision} />
          }
        />
      )}
    </div>
  );
}

function StatusStrip({
  view,
  changes,
  dirty,
}: {
  view: RegionPoolView;
  changes: ReturnType<typeof localChanges>;
  dirty: boolean;
}) {
  const { draft, published, region } = view;
  return (
    <div className="grid gap-2 md:grid-cols-3" data-testid="region-pool-status">
      <Card className={`space-y-1 p-3 ${dirty ? 'border-accent' : ''}`} data-testid="status-local">
        <p className="text-xs font-semibold uppercase text-ink-muted">
          1 · Unsaved edits on this page
        </p>
        <p className="text-sm">
          {dirty
            ? `${changes.added.length} added, ${changes.removed.length} removed, ${changes.reweighted.length} reweighted`
            : 'None'}
        </p>
      </Card>
      <Card className="space-y-1 p-3" data-testid="status-draft">
        <p className="text-xs font-semibold uppercase text-ink-muted">2 · Saved draft (not live)</p>
        <p className="text-sm">
          Revision {draft.revision} · {draft.entries.length} species ·{' '}
          {draft.unpublishedChanges ? (
            <Badge variant="solid">Unpublished changes</Badge>
          ) : (
            'matches published'
          )}
        </p>
        <p className="text-xs text-ink-muted">
          Saved {formatWhen(draft.updatedAt)}
          {draft.updatedBy ? ` by ${draft.updatedBy}` : ' by the system'}
        </p>
      </Card>
      <Card className="space-y-1 p-3" data-testid="status-published">
        <p className="text-xs font-semibold uppercase text-ink-muted">3 · Published pool</p>
        <p className="flex flex-wrap items-center gap-1 text-sm">
          {published
            ? `Revision #${published.number} · ${published.entryCount} species`
            : 'Nothing published'}
          <ReleaseBadge region={region} />
        </p>
        <p className="text-xs text-ink-muted">
          {published
            ? `${formatWhen(published.publishedAt)}${published.publishedBy ? ` by ${published.publishedBy}` : ''} · ${region.released ? 'live for hunting' : 'not hunted until the region is released'}`
            : ''}
        </p>
        <p className="text-xs text-ink-subtle">Release state is set in the region catalogue.</p>
      </Card>
    </div>
  );
}

function ActionBar({
  canWrite,
  canPublish,
  dirty,
  busy,
  badWeights,
  unpublished,
  onSave,
  onDiscardLocal,
  onReset,
  onPublish,
}: {
  canWrite: boolean;
  canPublish: boolean;
  dirty: boolean;
  busy: boolean;
  badWeights: boolean;
  unpublished: boolean;
  onSave: () => void;
  onDiscardLocal: () => void;
  onReset: () => void;
  onPublish: () => void;
}) {
  if (!canWrite && !canPublish) {
    return (
      <p className="text-xs text-ink-muted" data-testid="read-only-note">
        Read only — editing needs regions.write and publishing needs regions.publish.
      </p>
    );
  }
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap gap-2 border-t border-border bg-surface/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0"
      data-testid="region-pool-actions"
    >
      {canWrite && (
        <>
          <Button
            type="button"
            variant="accent"
            disabled={!dirty || busy || badWeights}
            onClick={onSave}
          >
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || busy}
            onClick={onDiscardLocal}
          >
            Discard unsaved edits
          </Button>
          <Button type="button" variant="ghost" disabled={!unpublished || busy} onClick={onReset}>
            Reset draft to published
          </Button>
        </>
      )}
      {canPublish && (
        <Button
          type="button"
          variant="outline"
          disabled={dirty || busy}
          onClick={onPublish}
          title={
            dirty
              ? 'Save or discard your edits first: only the saved draft can be published.'
              : undefined
          }
        >
          Review &amp; publish
        </Button>
      )}
      {canPublish && dirty && (
        <p className="w-full text-xs text-ink-muted">
          Only the saved draft can be published — save first.
        </p>
      )}
      {!canPublish && canWrite && (
        <p className="w-full text-xs text-ink-muted">
          Publishing needs the regions.publish permission.
        </p>
      )}
      {badWeights && (
        <p className="w-full text-xs text-danger">
          Every weight must be a whole number from 1 to 1,000,000.
        </p>
      )}
    </div>
  );
}

function HowOddsWork() {
  return (
    <Card className="space-y-1 p-4 text-xs text-ink-muted" data-testid="how-odds-work">
      <h2 className="text-sm font-semibold uppercase">How a hunt picks a Waifumon</h2>
      <ol className="ml-4 list-decimal space-y-0.5">
        <li>
          A <strong>rarity</strong> is rolled from the game's rarity table. That chance is fixed by
          the game (read-only here); a Buddy or a high player level can shift it.
        </li>
        <li>
          A <strong>species of that rarity</strong> is picked from this pool by weight.
        </li>
      </ol>
      <p>
        A weight is relative <em>within its rarity only</em> — it is not a probability. Two SR
        species weighted 3 and 1 get 75% and 25% of SR encounters, whatever SR's own chance is. "Per
        encounter" multiplies by the rarity's chance; "per Hunt" also counts Hunts that find an item
        or nothing.
      </p>
    </Card>
  );
}

function RaritySection({
  rarity,
  rows,
  facts,
  issues,
  analysis,
  analysisLoading,
  stale,
  changedSlugs,
  regionId,
  regionNames,
  canWrite,
  onWeight,
  onRemove,
}: {
  rarity: string;
  rows: Array<PoolRow & { index: number }>;
  facts: ReadonlyMap<string, SpeciesFacts>;
  issues: readonly RegionPoolIssue[];
  analysis: DistributionResult | undefined;
  analysisLoading: boolean;
  stale: boolean;
  changedSlugs: ReadonlySet<string>;
  regionId: string;
  regionNames: ReadonlyMap<string, RegionRef>;
  canWrite: boolean;
  onWeight: (slug: string, weight: string) => void;
  onRemove: (slug: string) => void;
}) {
  const ex = rarity === NOT_HUNTABLE_RARITY;
  const unknown = rarity === 'unknown';
  if ((ex || unknown) && rows.length === 0) return null;
  const odds = rarityOdds(analysis, rarity);
  const heading = ex ? 'EX — Not Huntable' : unknown ? 'Unknown species' : rarity;
  return (
    <section
      aria-label={`${heading} species`}
      className="space-y-2"
      data-testid={`rarity-section-${rarity}`}
    >
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {!unknown && <RarityBadge rarity={rarity} />}
            {!unknown && <span>{rarityStyle(rarity).label}</span>}
            {ex && <span>— Not Huntable</span>}
            {unknown && <span>Unknown species</span>}
            <span className="text-xs font-normal text-ink-muted">({rows.length})</span>
          </h2>
          {!ex && !unknown && (
            <p className="text-xs text-ink-muted" data-testid={`rarity-chance-${rarity}`}>
              Base rarity chance:{' '}
              <span className="font-medium text-ink">
                {odds ? formatPercent(odds.rollProbability) : analysisLoading ? '…' : '—'}
              </span>{' '}
              of rolls (level 1, no Buddy · read-only)
              {odds && odds.tier !== 'region' && (
                <span className="block text-danger">Drawn from: {TIER_LABELS[odds.tier]}</span>
              )}
            </p>
          )}
        </div>
        {ex && (
          <p className="text-xs text-ink-muted" data-testid="ex-explanation">
            The hunt never rolls EX, so species listed here can never be met by hunting in this
            region. They are kept in the pool (the server warns at publish) but have no odds.
          </p>
        )}
        {stale && !ex && (
          <p className="text-xs text-ink-muted" role="note" data-testid={`rarity-stale-${rarity}`}>
            This rarity has unsaved edits — shares and chances below are for the saved draft. Save
            to recalculate.
          </p>
        )}
        <IssueList issues={issuesForRarity(issues, rarity)} regionNames={regionNames} />
        {rows.length === 0 && !ex && (
          <p className="text-xs text-danger">No {rarity} species in this pool.</p>
        )}
        <ul className="space-y-2" aria-label={`${heading} entries`}>
          {rows.map((row) => (
            <PoolRowView
              key={row.species}
              row={row}
              facts={facts.get(row.species)}
              issues={issuesForSpecies(issues, row.species)}
              odds={
                stale || changedSlugs.has(row.species) || ex
                  ? undefined
                  : oddsFor(analysis, row.species)
              }
              excluded={analysis?.excluded.find((e) => e.slug === row.species)?.reason}
              pending={stale || changedSlugs.has(row.species)}
              ex={ex}
              regionId={regionId}
              regionNames={regionNames}
              canWrite={canWrite}
              onWeight={onWeight}
              onRemove={onRemove}
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function PoolRowView({
  row,
  facts,
  issues,
  odds,
  excluded,
  pending,
  ex,
  regionId,
  regionNames,
  canWrite,
  onWeight,
  onRemove,
}: {
  row: PoolRow;
  facts: SpeciesFacts | undefined;
  issues: RegionPoolIssue[];
  odds: ReturnType<typeof oddsFor>;
  excluded: string | undefined;
  pending: boolean;
  ex: boolean;
  regionId: string;
  regionNames: ReadonlyMap<string, RegionRef>;
  canWrite: boolean;
  onWeight: (slug: string, weight: string) => void;
  onRemove: (slug: string) => void;
}) {
  const name = facts?.name ?? row.species;
  const elsewhere = (facts?.publishedIn ?? []).filter((r) => r !== regionId);
  const invalid = parseWeight(row.weight) === null;
  return (
    <li
      className="space-y-2 rounded border border-border p-2"
      data-testid={`pool-row-${row.species}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <RegionSpeciesThumb slug={row.species} name={name} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="break-words text-sm font-medium">{name}</p>
          <p className="font-mono text-xs text-ink-subtle">{row.species}</p>
          <p className="text-xs text-ink-muted">
            {facts?.race ?? '—'} · {facts?.affinity ?? '—'}
          </p>
          <SpeciesFlags facts={facts} />
          {elsewhere.length > 0 && (
            <p className={`text-xs ${facts?.regionExclusive ? 'text-danger' : 'text-ink-muted'}`}>
              Also published in {elsewhere.map((r) => regionNames.get(r)?.name ?? r).join(', ')}
            </p>
          )}
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-ink-muted">
            Weight
            <Input
              aria-label={`Weight for ${name}`}
              aria-invalid={invalid}
              inputMode="numeric"
              className="w-24"
              value={row.weight}
              disabled={!canWrite}
              onChange={(e) => onWeight(row.species, e.target.value)}
            />
          </label>
          {canWrite && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${name} from this pool`}
              onClick={() => onRemove(row.species)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {!ex && (
        <dl className="grid grid-cols-3 gap-2 text-xs" data-testid={`pool-row-${row.species}-odds`}>
          <div>
            <dt className="text-ink-subtle">Share of rarity</dt>
            <dd>
              {odds ? formatPercent(odds.shareOfRarity) : pending ? 'Save to recalculate' : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Per encounter</dt>
            <dd>
              {odds ? formatPercent(odds.perEncounter) : pending ? 'Save to recalculate' : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Per Hunt</dt>
            <dd>{odds ? formatPercent(odds.perHunt) : pending ? 'Save to recalculate' : '—'}</dd>
          </div>
          {!odds && !pending && excluded && (
            <p className="col-span-3 text-danger">
              Never met: {EXCLUSION_LABELS[excluded] ?? excluded}
            </p>
          )}
        </dl>
      )}
      <IssueList issues={issues} regionNames={regionNames} />
    </li>
  );
}

function DriftCard({
  drift,
  nameOf,
  regionNames,
}: {
  drift: NonNullable<Awaited<ReturnType<typeof getRegionPoolDrift>>>;
  nameOf: (slug: string) => string;
  regionNames: ReadonlyMap<string, RegionRef>;
}) {
  const KIND: Record<string, string> = {
    disabled: 'was disabled after publishing',
    enabled: 'was enabled after publishing',
    missing_from_content: 'is no longer in the loaded content',
    rarity_changed: 'changed rarity',
    tags_changed: 'changed tags',
  };
  return (
    <Card className="space-y-2 border-danger/40 p-4" data-testid="drift-card">
      <h2 className="text-sm font-semibold uppercase text-danger">
        Dependency drift since revision #{drift.publishedRevision ?? '—'}
      </h2>
      <p className="text-xs text-ink-muted">
        Species content changed after this pool was published. The pool itself is unchanged — review
        and republish if the change matters.
      </p>
      <ul className="space-y-0.5 text-xs">
        {drift.species.map((d) => (
          <li key={`${d.species}:${d.kind}`}>
            {nameOf(d.species)} {KIND[d.kind] ?? d.kind}
            {d.from !== undefined && ` (${d.from} → ${d.to})`}
            {d.addedTags?.length ? ` +${d.addedTags.join(', +')}` : ''}
            {d.removedTags?.length ? ` −${d.removedTags.join(', −')}` : ''}
          </li>
        ))}
        {drift.exclusiveConflicts.map((c) => (
          <li key={`x:${c.species}`} className="text-danger">
            {nameOf(c.species)} is region-exclusive and also published in{' '}
            {c.regions.map((r) => regionNames.get(r)?.name ?? r).join(', ')}
          </li>
        ))}
        {drift.emptyTiers.map((t) => (
          <li key={`t:${t.rarity}`}>
            {t.rarity} has no huntable species
            {t.causedByContent ? ' because of a content change' : ''}
          </li>
        ))}
        {drift.shipped.differs && (
          <li>The shipped region file differs from the published pool (see Shipped content).</li>
        )}
      </ul>
    </Card>
  );
}

function ConfirmDialog({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={confirmation !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel">
        {confirmation && (
          <div
            className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
            data-testid="region-pool-confirm"
          >
            <DialogTitle className="text-base font-semibold">{confirmation.title}</DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-ink-muted">{confirmation.body}</div>
            </DialogDescription>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  confirmation.run();
                  onClose();
                }}
              >
                {confirmation.confirmLabel}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
