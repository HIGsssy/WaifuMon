/**
 * The preview an author confirms before a legacy treasure is converted to
 * dungeon rewards. Everything shown comes from the server's plan; confirming
 * applies exactly that plan or nothing.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import * as api from '@/api/adminDungeons';
import type { DungeonLootTableBody } from '@/api/adminDungeonLootTables';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/layout/ErrorState';
import { bundleIssueText } from '@/features/adminDungeonLoot/bundleModel';
import {
  describeGrant,
  formatChance,
  rewardNames,
  type RewardNames,
} from '@/features/adminDungeonLoot/lootModel';
import { retentionPercent } from './dungeonRiskModel';

interface Props {
  dungeonKey: string;
  /** The saved draft the preview is about; a newer draft is a different preview. */
  draftRevision: number;
  target: api.DungeonTreasureTarget;
  reference: api.DungeonReferenceData | undefined;
  onClose: () => void;
  onConverted: (result: api.DungeonTreasureConversionResult) => void;
}

const range = (r: { min: number; max: number }) =>
  r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** What one loot table gives, a line per guaranteed reward and per group. */
function describeConvertedTable(body: DungeonLootTableBody, names: RewardNames): string[] {
  return [
    ...body.guaranteed.map((entry) => `Always: ${describeGrant(entry.grant, names)}`),
    ...body.pools.map((pool) => {
      const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0);
      const choices = pool.entries.map(
        (entry) =>
          `${formatChance(entry.weight / total)} ${'grant' in entry ? describeGrant(entry.grant, names) : 'nothing'}`,
      );
      return `“${pool.name}”, picked ${times(pool.draws)}: ${choices.join(' · ')}`;
    }),
  ];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}
const list = 'list-disc space-y-1 pl-5 text-sm text-ink-muted';

export function TreasureConversionDialog({
  dungeonKey,
  draftRevision,
  target,
  reference,
  onClose,
  onConverted,
}: Props) {
  const plan = useQuery({
    queryKey: [...api.DUNGEONS_QUERY_KEY, 'treasure-conversion', dungeonKey, draftRevision, target],
    queryFn: ({ signal }) => api.planTreasureConversion(dungeonKey, target, signal),
    // A preview is only good for the moment it was made.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const convert = useMutation({
    mutationFn: (p: api.DungeonTreasureConversionPlan) =>
      api.convertTreasure(dungeonKey, {
        ...target,
        expectedRevision: p.draftRevision,
        expectedPlanHash: p.planHash,
      }),
    onSuccess: onConverted,
  });
  const names = rewardNames(reference?.items);
  const p = plan.data;
  const stale =
    isPortalApiError(convert.error) &&
    (convert.error.code === 'DUNGEON_CONVERSION_STALE' ||
      convert.error.code === 'DUNGEON_DRAFT_STALE');
  const blocked = (p?.blockers.length ?? 0) > 0;
  const tableNames = p?.tables.map((t) => ({ key: t.key, name: t.name })) ?? [];
  const leftOut = (reasons: string[]) => p?.omitted.filter((o) => reasons.includes(o.reason)) ?? [];
  const neverPaid = leftOut(['never_paid']);
  const switchedOff = leftOut(['disabled', 'cannot_drop']);
  return (
    <Dialog open onOpenChange={(open) => !open && !convert.isPending && onClose()}>
      <DialogContent>
        <Card
          className="max-h-full w-full max-w-2xl space-y-4 overflow-y-auto p-6"
          data-testid="treasure-conversion"
        >
          <DialogTitle className="font-display text-lg text-ink">
            Convert this treasure to Dungeon Rewards?
          </DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Converting replaces the older reward settings on this treasure with guaranteed rewards
            and dungeon loot tables that give the same things with the same odds. Nothing changes
            until you confirm below.
          </DialogDescription>
          {plan.isPending && <p className="text-sm text-ink-muted">Working out the conversion…</p>}
          {plan.isError && (
            <ErrorState
              title="This treasure cannot be converted right now"
              error={plan.error}
              onRetry={() => void plan.refetch()}
            />
          )}
          {p && (
            <>
              <Section title="What it pays today">
                <ul className={list} data-testid="conversion-legacy">
                  <li>
                    {p.legacy.currency.max > 0
                      ? `${range(p.legacy.currency)} Baddie Shards`
                      : 'No Baddie Shards'}
                  </li>
                  <li>Reward table: {p.legacy.rewardTable ?? 'none'}</li>
                  <li>Gear reward table: {p.legacy.equipmentRewardTable ?? 'none'}</li>
                </ul>
              </Section>
              {blocked ? (
                <Section title="It cannot be converted yet">
                  <ul
                    className={`${list} text-danger`}
                    role="alert"
                    data-testid="conversion-blockers"
                  >
                    {p.blockers.map((b, n) => (
                      <li key={n}>{b.message}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-ink-muted">
                    Converting would have to change what this treasure gives, so it stops here. Make
                    the correction above, then open this preview again. Nothing has been changed.
                  </p>
                </Section>
              ) : (
                <>
                  <Section title="What it will pay after converting">
                    <ul className={list} data-testid="conversion-result">
                      {p.rewards!.guaranteed.map((entry) => (
                        <li key={entry.id}>Always: {describeGrant(entry.grant, names)}</li>
                      ))}
                      {p.rewards!.tables.map((ref) => {
                        const table = p.tables.find((t) => t.key === ref.table)!;
                        return (
                          <li key={ref.id}>
                            Loot table “{table.name}”, rolled {times(ref.draws)}
                          </li>
                        );
                      })}
                      {p.rewards!.guaranteed.length + p.rewards!.tables.length === 0 && (
                        <li>Nothing. This treasure gives nothing today either.</li>
                      )}
                    </ul>
                  </Section>
                  {p.tables.length > 0 && (
                    <Section title="Dungeon loot tables">
                      <ul className="space-y-2" data-testid="conversion-tables">
                        {p.tables.map((table) => (
                          <li
                            key={table.key}
                            title={table.key}
                            className="rounded-lg border border-border p-3 text-sm"
                          >
                            <p className="font-medium text-ink">
                              {table.action === 'create' ? 'New: ' : 'Already converted, reused: '}“
                              {table.name}”
                            </p>
                            <p className="text-xs text-ink-muted">
                              {table.action === 'create'
                                ? `Made from the reward table ${table.sourceTable}. That table is not changed and keeps working for expeditions.`
                                : `An identical table was made from ${table.sourceTable} before, so no second copy is created.`}
                            </p>
                            <ul className={`${list} mt-1`}>
                              {describeConvertedTable(table.body, names).map((line, n) => (
                                <li key={n}>{line}</li>
                              ))}
                              {table.body.guaranteed.length + table.body.pools.length === 0 && (
                                <li>Gives nothing in a dungeon.</li>
                              )}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}
                </>
              )}
              {(neverPaid.length > 0 || switchedOff.length > 0) && (
                <Section title="Not carried over">
                  {neverPaid.length > 0 && (
                    <>
                      <p className="text-sm text-ink-muted">
                        On the reward tables, but never paid by a dungeon, so leaving them out
                        changes nothing for players:
                      </p>
                      <ul className={list} data-testid="conversion-never-paid">
                        {neverPaid.map((o, n) => (
                          <li key={n}>
                            {o.text}
                            {o.table ? ` (${o.table})` : ''}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {switchedOff.length > 0 && (
                    <>
                      <p className="text-sm text-ink-muted">
                        Switched off or unable to drop today, so they are left out:
                      </p>
                      <ul className={list} data-testid="conversion-switched-off">
                        {switchedOff.map((o, n) => (
                          <li key={n}>{o.text}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </Section>
              )}
              {!blocked && p.issues.length > 0 && (
                <Section title="To fix after converting">
                  <p className="text-sm text-ink-muted">
                    You can convert now. These show in the checklist afterwards, and the ones marked
                    Fix must be dealt with before the dungeon can be published.
                  </p>
                  <ul className={list} data-testid="conversion-issues">
                    {p.issues.map((issue, n) => {
                      const text = bundleIssueText(
                        issue,
                        p.rewards!,
                        names,
                        reference?.items ?? [],
                        tableNames,
                      );
                      return (
                        <li key={n} title={`${issue.code} · ${issue.path}`}>
                          {issue.severity === 'error' ? 'Fix: ' : 'Review: '}
                          {text.subject ? `${text.subject}: ` : ''}
                          {text.text}
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
              <div
                className="space-y-1 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-ink"
                role="note"
                aria-label="What changes for players"
                data-testid="conversion-warnings"
              >
                <p className="font-semibold">What changes for players</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Today this treasure pays its WaifuBux straight away, and the player keeps them
                    whatever happens next.
                  </li>
                  <li>
                    After converting, its WaifuBux are at risk until the player extracts or
                    completes the dungeon.
                  </li>
                  <li>
                    In this dungeon a defeated player keeps{' '}
                    {retentionPercent(p.retention.defeatBasisPoints)}% and a player who abandons
                    keeps {retentionPercent(p.retention.abandonBasisPoints)}%, so some or all of
                    those WaifuBux can be lost.
                    {!p.waifubuxAtRisk && ' (This treasure pays no WaifuBux today.)'}
                  </li>
                  <li>
                    Every drop keeps the same odds, but the dice are rolled differently: a given run
                    will not get the same loot it would have got before.
                  </li>
                  <li>
                    Players see no change yet. Revisions already published keep paying the old way
                    until you publish this dungeon again.
                  </li>
                </ul>
              </div>
            </>
          )}
          {convert.isError && (
            <div className="space-y-2" data-testid="conversion-error">
              <ErrorState
                title={
                  stale
                    ? 'Something changed since this preview was made'
                    : 'The treasure was not converted'
                }
                error={convert.error}
              />
              <p className="text-sm text-ink-muted">
                Nothing was changed.{' '}
                {stale && 'Review the conversion again to see it as things stand now.'}
              </p>
              {stale && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    convert.reset();
                    void plan.refetch();
                  }}
                >
                  Review again
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!p || blocked || convert.isPending || convert.isError || plan.isFetching}
              onClick={() => p && convert.mutate(p)}
            >
              {convert.isPending ? 'Converting…' : 'Convert this treasure'}
            </Button>
            <Button variant="outline" disabled={convert.isPending} onClick={onClose}>
              {p && !blocked ? 'Cancel, keep it as it is' : 'Close preview'}
            </Button>
          </div>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
