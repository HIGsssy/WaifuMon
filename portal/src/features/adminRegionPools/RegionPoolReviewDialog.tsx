/**
 * The review gate in front of publish and rollback.
 *
 * The server issues the review — its issues, the warnings that must be
 * acknowledged and a `reviewHash` fingerprint over everything reviewed — and
 * this dialog sends exactly that fingerprint back with the warning ids the
 * administrator ticked. Nothing is re-derived locally.
 *
 *   - **A stale review is never retried.** On 409 `REGION_POOL_REVIEW_STALE`
 *     the dialog discards the acknowledgements, shows what changed, and waits
 *     for the administrator to ask for a fresh review. The new hash in the
 *     refusal is not used.
 *   - **The review is not refreshed behind the administrator's back.** No
 *     refetch on focus or interval: the fingerprint on screen is the one sent.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { isPortalApiError } from '@/api/client';
import type {
  RegionPoolEntry,
  RegionPoolIssue,
  RegionPoolReview,
  RegionPoolReviewInput,
  RegionPoolReviewStaleDetails,
  RegionPoolStaleDetails,
  RegionPoolView,
  RegionRef,
} from '@/api/adminRegionPools';
import { REGION_POOL_RARITIES, NOT_HUNTABLE_RARITY } from '@/api/adminRegionPools';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

import { rarityCoverage, type SpeciesFacts } from './regionPoolModel';
import { DiffList, IssueList } from './regionPoolParts';

export interface ReviewDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What this action does, in plain words. */
  intro: ReactNode;
  /** Where the review comes from (`validate` or `rollback-preview`). */
  reviewKey: readonly unknown[];
  loadReview: (signal: AbortSignal) => Promise<RegionPoolReview>;
  submit: (input: RegionPoolReviewInput) => Promise<RegionPoolView>;
  onDone: (view: RegionPoolView) => void;
  /** The draft moved on under the dialog: the page shows its reload banner. */
  onStaleDraft: (details: RegionPoolStaleDetails) => void;
  submitLabel: string;
  facts: ReadonlyMap<string, SpeciesFacts>;
  regionNames: ReadonlyMap<string, RegionRef>;
  /** Entries live now, and the entries this action would make live. */
  before: readonly RegionPoolEntry[];
  after: readonly RegionPoolEntry[];
  /** Probability changes, from the server's analysis (or why there are none). */
  probability: ReactNode;
  /** Extra confirmations the page needs (e.g. losing unsaved edits). All must be ticked. */
  confirmations?: Array<{ id: string; label: string }>;
}

type Refusal =
  | { kind: 'review_stale'; issues: RegionPoolIssue[] }
  | { kind: 'blocked'; issues: RegionPoolIssue[] }
  | { kind: 'acknowledgement'; missing: string[] }
  | { kind: 'other'; message: string };

export function RegionPoolReviewDialog(props: ReviewDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent closeLabel={`Cancel: ${props.title}`}>
        {props.open && <ReviewBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ReviewBody({
  onClose,
  title,
  intro,
  reviewKey,
  loadReview,
  submit,
  onDone,
  onStaleDraft,
  submitLabel,
  facts,
  regionNames,
  before,
  after,
  probability,
  confirmations = [],
}: ReviewDialogProps) {
  const review = useQuery({
    queryKey: reviewKey,
    queryFn: ({ signal }) => loadReview(signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pending, setPending] = useState(false);

  // A new review (fresh hash) starts with nothing acknowledged.
  const hash = review.data?.reviewHash;
  useEffect(() => {
    setAcked(new Set());
  }, [hash]);

  const nameOf = (slug: string) => facts.get(slug)?.name ?? slug;

  const freshReview = () => {
    setRefusal(null);
    setAcked(new Set());
    void review.refetch();
  };

  const send = async (data: RegionPoolReview) => {
    setPending(true);
    setRefusal(null);
    try {
      const view = await submit({
        expectedDraftRevision: data.draftRevision,
        reviewHash: data.reviewHash,
        acknowledgedWarnings: data.requiredAcknowledgements.filter((id) => acked.has(id)),
      });
      onDone(view);
    } catch (err) {
      if (!isPortalApiError(err)) {
        setRefusal({ kind: 'other', message: 'The request failed.' });
      } else if (err.code === 'REGION_POOL_REVIEW_STALE') {
        const details = (err.details ?? {}) as RegionPoolReviewStaleDetails;
        setAcked(new Set());
        setRefusal({ kind: 'review_stale', issues: details.issues ?? [] });
      } else if (err.code === 'REGION_POOL_STALE') {
        onStaleDraft((err.details ?? {}) as RegionPoolStaleDetails);
        onClose();
      } else if (err.code === 'REGION_POOL_PUBLISH_BLOCKED') {
        setRefusal({
          kind: 'blocked',
          issues: ((err.details ?? {}) as { issues?: RegionPoolIssue[] }).issues ?? [],
        });
      } else if (err.code === 'REGION_POOL_ACKNOWLEDGEMENT_REQUIRED') {
        setRefusal({
          kind: 'acknowledgement',
          missing: ((err.details ?? {}) as { missing?: string[] }).missing ?? [],
        });
      } else {
        setRefusal({ kind: 'other', message: err.message });
      }
    } finally {
      setPending(false);
    }
  };

  const data = review.data;
  const errors = data?.issues.filter((i) => i.severity === 'error') ?? [];
  const toAck = data ? data.issues.filter((i) => data.requiredAcknowledgements.includes(i.id)) : [];
  const otherWarnings =
    data?.issues.filter(
      (i) => i.severity === 'warning' && !data.requiredAcknowledgements.includes(i.id),
    ) ?? [];
  const allAcked = data ? data.requiredAcknowledgements.every((id) => acked.has(id)) : false;
  const allConfirmed = confirmations.every((c) => confirmed.has(c.id));
  const stale = refusal?.kind === 'review_stale';
  const canSubmit = Boolean(data?.canPublish) && allAcked && allConfirmed && !pending && !stale;

  const coverageBefore = rarityCoverage(before, facts);
  const coverageAfter = rarityCoverage(after, facts);

  return (
    <div
      className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-4 sm:p-5"
      data-testid="region-pool-review"
    >
      <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
      <DialogDescription asChild>
        <div className="space-y-1 text-sm text-ink-muted">{intro}</div>
      </DialogDescription>

      {review.isPending && <Skeleton className="h-40 w-full" />}
      {review.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not load the review: {review.error.message}
        </p>
      )}

      {data && (
        <>
          <section aria-label="Species changes" className="space-y-1">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">Species changes</h3>
            <DiffList diff={data.diffFromPublished} nameOf={nameOf} testId="review-diff" />
          </section>

          <section aria-label="Rarity coverage" className="space-y-1">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">Rarity coverage</h3>
            <table className="w-full text-left text-xs" data-testid="review-coverage">
              <thead>
                <tr className="text-ink-subtle">
                  <th scope="col" className="py-1 font-medium">
                    Rarity
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Live now
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    After
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...REGION_POOL_RARITIES, NOT_HUNTABLE_RARITY].map((r) => {
                  const b = coverageBefore[r] ?? 0;
                  const a = coverageAfter[r] ?? 0;
                  return (
                    <tr key={r} className={a !== b ? 'font-medium text-ink' : 'text-ink-muted'}>
                      <th scope="row" className="py-0.5 font-normal">
                        <RarityBadge rarity={r} />
                      </th>
                      <td>{b}</td>
                      <td>
                        {a}
                        {a === 0 && r !== NOT_HUNTABLE_RARITY && b > 0 && ' (becomes empty)'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section aria-label="Probability changes" className="space-y-1">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">Probability changes</h3>
            {probability}
          </section>

          {errors.length > 0 && (
            <section aria-label="Errors" className="space-y-1">
              <h3 className="text-xs font-semibold uppercase text-danger">
                Errors — these block publishing
              </h3>
              <IssueList issues={errors} regionNames={regionNames} testId="review-errors" />
            </section>
          )}

          {toAck.length > 0 && (
            <fieldset className="space-y-1" data-testid="review-acknowledgements">
              <legend className="text-xs font-semibold uppercase text-ink-muted">
                Warnings to acknowledge
              </legend>
              {toAck.map((i) => (
                <label key={i.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={acked.has(i.id)}
                    disabled={stale}
                    onChange={(e) => {
                      const next = new Set(acked);
                      if (e.target.checked) next.add(i.id);
                      else next.delete(i.id);
                      setAcked(next);
                    }}
                  />
                  <span className="min-w-0 break-words">
                    {i.message}
                    <span className="block font-mono text-[11px] text-ink-subtle">{i.id}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {otherWarnings.length > 0 && (
            <section aria-label="Other warnings" className="space-y-1">
              <h3 className="text-xs font-semibold uppercase text-ink-muted">Other warnings</h3>
              <IssueList issues={otherWarnings} regionNames={regionNames} />
            </section>
          )}

          {confirmations.length > 0 && (
            <fieldset className="space-y-1" data-testid="review-confirmations">
              <legend className="text-xs font-semibold uppercase text-ink-muted">Confirm</legend>
              {confirmations.map((c) => (
                <label key={c.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmed.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(confirmed);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setConfirmed(next);
                    }}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </fieldset>
          )}

          <p className="text-xs text-ink-subtle">
            Review fingerprint{' '}
            <code className="break-all font-mono" data-testid="review-hash">
              {data.reviewHash}
            </code>{' '}
            · draft revision {data.draftRevision}
          </p>
        </>
      )}

      {refusal && (
        <div
          role="alert"
          className="space-y-2 rounded border border-danger/40 p-3 text-sm"
          data-testid="review-refusal"
        >
          {refusal.kind === 'review_stale' && (
            <>
              <p className="font-medium text-danger">This review is out of date.</p>
              <p className="text-ink-muted">
                Something it covered changed after it was issued — the draft, a species, or another
                region's published pool. Nothing was published. Review again to see the current
                state; your acknowledgements have been cleared.
              </p>
              <IssueList issues={refusal.issues} regionNames={regionNames} label="Current issues" />
              <Button type="button" variant="outline" size="sm" onClick={freshReview}>
                Start a fresh review
              </Button>
            </>
          )}
          {refusal.kind === 'blocked' && (
            <>
              <p className="font-medium text-danger">Publishing was refused.</p>
              <IssueList issues={refusal.issues} regionNames={regionNames} />
            </>
          )}
          {refusal.kind === 'acknowledgement' && (
            <p className="text-danger">
              The server still needs these warnings acknowledged: {refusal.missing.join(', ')}.
            </p>
          )}
          {refusal.kind === 'other' && <p className="text-danger">{refusal.message}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="accent"
          disabled={!canSubmit}
          onClick={() => data && void send(data)}
        >
          {pending ? 'Working…' : submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {data && !data.canPublish && (
        <p className="text-xs text-danger">Resolve the errors above before continuing.</p>
      )}
    </div>
  );
}
