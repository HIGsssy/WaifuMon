/**
 * Test Roll: one sample roll of a loot table, or of one activity's whole
 * reward bundle, exactly as it stands on screen, saved or not, resolved by the
 * game's own resolver on the server.
 *
 * It is a preview. Nothing is given to anyone, and equipment is shown as the
 * piece that would drop — its stats are only rolled by a real drop, so none
 * are shown or invented here.
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  testRollDungeonLootTable,
  testRollDungeonRewards,
  type DungeonLootTable,
  type DungeonLootTableBody,
  type DungeonResolvedRewardLine,
  type DungeonRewardGrant,
  type DungeonTestRollResult,
} from '@/api/adminDungeonLootTables';
import type { DungeonRewardBundle } from '@/api/adminDungeons';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { formatNumber } from '@/lib/format';
import { bundleIssueText, tableNameOf } from './bundleModel';
import {
  LOOT_LIMITS,
  describeGrant,
  formatAverage,
  formatChance,
  friendlyLootIssues,
  rewardLabel,
  rewardNames,
  type ItemRef,
  type RewardNames,
} from './lootModel';

const SIMULATED_ROLLS = 1000;
const MAX_SEED = 0xffff_ffff;
const MODE_ORDER = ['guaranteed', 'chance', 'pool'];
/** The key the server gives the table of a table-only Test Roll. */
const TABLE_TARGET_KEY = 'test_roll_table';

/** What is rolled, as it stands in the editor, unsaved edits included. */
export type TestRollTarget =
  | { kind: 'table'; body: DungeonLootTableBody; initialRolls: number }
  | {
      kind: 'bundle';
      bundle: DungeonRewardBundle;
      /** The dungeon's currency, so a Shards reward is checked as it would be on publish. */
      progressionCurrency: string | null;
      /** The catalogue, to name the loot tables the bundle rolls and their rewards. */
      tables: ReadonlyArray<Pick<DungeonLootTable, 'key' | 'name' | 'body'>>;
    };
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TestRollTarget;
  /** What is being rolled, by name. */
  title: string;
  items: readonly ItemRef[];
}

export function TestRollDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close test roll">{open && <TestRoll {...rest} />}</DialogContent>
    </Dialog>
  );
}

function Risk({ atRisk }: { atRisk: boolean }) {
  return <Badge variant="outline">{atRisk ? 'At risk' : 'Kept'}</Badge>;
}

/** What one resolved line gave, in the same words as the editor's rows. */
function wonText(line: DungeonResolvedRewardLine, names: RewardNames): string {
  const grant = line.grant!;
  if (grant.type === 'equipment') return names.equipment(grant.definitionKey);
  if (grant.type === 'item') return `${formatNumber(grant.quantity)} ${names.item(grant.item)}`;
  return `${formatNumber(grant.amount)} ${rewardLabel(grant, names)}`;
}

function TestRoll({ target, title, items }: Omit<Props, 'open' | 'onOpenChange'>) {
  const [rolls, setRolls] = useState(target.kind === 'table' ? target.initialRolls : 1);
  const [seedText, setSeedText] = useState('');
  const [simulate, setSimulate] = useState(false);
  const seed = /^\d+$/.test(seedText.trim()) ? Number(seedText.trim()) : null;
  const seedInvalid = seedText.trim() !== '' && (seed === null || seed > MAX_SEED);
  const roll = useMutation({
    mutationFn: () => {
      const options = {
        ...(seed !== null ? { seed } : {}),
        ...(simulate ? { simulate: SIMULATED_ROLLS } : {}),
      };
      return target.kind === 'table'
        ? testRollDungeonLootTable({ tableBody: target.body, draws: rolls, ...options })
        : testRollDungeonRewards({
            bundle: target.bundle,
            ...options,
            progressionCurrency: target.progressionCurrency,
          });
    },
  });
  const rollNow = roll.mutate;
  // Opening the dialog is the author asking for a roll.
  useEffect(() => rollNow(), [rollNow]);

  const result = roll.data;
  return (
    <Card
      className="max-h-full w-full max-w-2xl space-y-3 overflow-y-auto p-5"
      data-testid="test-roll"
    >
      <DialogTitle className="font-display text-xl text-ink">Test roll — {title}</DialogTitle>
      <DialogDescription className="text-sm text-ink-muted">
        This is a preview of {target.kind === 'table' ? 'the table' : 'this activity’s rewards'} as{' '}
        {target.kind === 'table' ? 'it is' : 'they are'} on screen, including changes you have not
        saved. It awards nothing to any player.
      </DialogDescription>
      <div className="flex flex-wrap items-end gap-3">
        {target.kind === 'table' && (
          <label className="text-xs text-ink-muted">
            Roll the table
            <select
              aria-label="Rolls in this test"
              className={selectClass}
              value={rolls}
              onChange={(e) => setRolls(Number(e.target.value))}
            >
              {Array.from({ length: LOOT_LIMITS.tableRolls }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'once' : `${n} times`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs text-ink-muted">
          Seed (empty for a new random roll)
          <Input
            aria-label="Seed"
            className="w-40"
            inputMode="numeric"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={simulate}
            onChange={(e) => setSimulate(e.target.checked)}
          />
          Also simulate {formatNumber(SIMULATED_ROLLS)} rolls
        </label>
        <Button
          type="button"
          variant="accent"
          size="sm"
          disabled={roll.isPending || seedInvalid}
          onClick={() => roll.mutate()}
        >
          {roll.isPending ? 'Rolling…' : 'Roll again'}
        </Button>
      </div>
      {seedInvalid && (
        <p className="text-xs text-danger" role="alert">
          A seed is a whole number from 0 to {formatNumber(MAX_SEED)}.
        </p>
      )}
      {roll.isError && (
        <ErrorState variant="inline" title="The test roll failed" error={roll.error} />
      )}
      {result && (
        <Outcome
          result={result}
          target={target}
          items={items}
          reuseSeed={() => setSeedText(String(result.seed))}
        />
      )}
    </Card>
  );
}

function Outcome({
  result,
  target,
  items,
  reuseSeed,
}: {
  result: DungeonTestRollResult;
  target: TestRollTarget;
  items: readonly ItemRef[];
  reuseSeed: () => void;
}) {
  const names = rewardNames(
    [
      ...items,
      ...Object.entries(result.items)
        .filter(([slug]) => !items.some((i) => i.slug === slug))
        .map(([slug, item]) => ({ slug, ...item, enabled: true, maxOwned: null })),
    ],
    result.equipmentPools,
  );
  const plan = result.roll;
  if (!plan) {
    const problems =
      target.kind === 'table'
        ? friendlyLootIssues(result.issues, target.body, names, items).filter(
            (i) => i.severity === 'error',
          )
        : result.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => {
              const found = bundleIssueText(issue, target.bundle, names, items, target.tables);
              return {
                raw: `${issue.code} · ${issue.path} · ${issue.message}`,
                text: found.subject
                  ? `${found.subject.replace(/^./, (c) => c.toUpperCase())}: ${found.text}`
                  : found.text,
              };
            });
    return (
      <div className="space-y-1" role="alert" data-testid="test-roll-blocked">
        <p className="text-sm font-medium text-danger">
          {target.kind === 'table' ? 'This table' : 'These rewards'} cannot be rolled yet.
        </p>
        <ul className="list-disc pl-4 text-sm text-ink">
          {problems.map((problem) => (
            <li key={problem.raw} title={problem.raw}>
              {problem.text}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // What each authored entry gives, by the table it sits in ('' for the activity's own rewards).
  const entries = new Map<string, DungeonRewardGrant>();
  const noteBody = (table: string, body: DungeonLootTableBody) => {
    for (const entry of [...body.guaranteed, ...body.chances])
      entries.set(`${table}|${entry.id}`, entry.grant);
    for (const pool of body.pools)
      for (const entry of pool.entries)
        if ('grant' in entry) entries.set(`${table}|${entry.id}`, entry.grant);
  };
  if (target.kind === 'table') noteBody(TABLE_TARGET_KEY, target.body);
  else {
    for (const entry of [...target.bundle.guaranteed, ...target.bundle.chances])
      entries.set(`|${entry.id}`, entry.grant);
    for (const table of target.tables) noteBody(table.key, table.body);
  }
  const authored = (line: DungeonResolvedRewardLine) => {
    const grant = entries.get(
      `${target.kind === 'table' ? TABLE_TARGET_KEY : (line.tableKey ?? '')}|${line.entryId}`,
    );
    return grant ? describeGrant(grant, names) : 'a reward';
  };
  const atRisk = [
    plan.atRisk.shards > 0 && `${formatNumber(plan.atRisk.shards)} Baddie Shards`,
    plan.atRisk.waifubux > 0 && `${formatNumber(plan.atRisk.waifubux)} WaifuBux`,
  ].filter((text): text is string => !!text);
  const kept = [
    plan.secured.essence > 0 && `${formatNumber(plan.secured.essence)} Essence`,
    plan.secured.affection > 0 && `${formatNumber(plan.secured.affection)} Affection`,
    ...plan.secured.items.map((i) => `${formatNumber(i.quantity)} ${names.item(i.item)}`),
    ...plan.secured.equipment.map((e) => names.equipment(e.definitionKey)),
  ].filter((text): text is string => !!text);
  // One group per roll of a table; an activity's own rewards come first.
  const references = target.kind === 'bundle' ? target.bundle.tables.map((t) => t.id) : [];
  const groupOf = (line: DungeonResolvedRewardLine) =>
    `${target.kind === 'bundle' ? (line.tableReferenceId ?? '') : ''}|${line.tableDraw ?? 0}`;
  const groups = [...new Set(plan.lines.map(groupOf))]
    .map((key) => {
      const [reference = '', draw = '0'] = key.split('|');
      return { key, reference, draw: Number(draw) };
    })
    .sort(
      (a, b) =>
        references.indexOf(a.reference) - references.indexOf(b.reference) || a.draw - b.draw,
    );
  const heading = (group: (typeof groups)[number]) => {
    if (target.kind === 'table') return groups.length > 1 ? `Roll ${group.draw + 1}` : null;
    const reference = target.bundle.tables.find((t) => t.id === group.reference);
    if (!reference) return 'This activity’s own rewards';
    const name = tableNameOf(reference.table, target.tables);
    return reference.draws > 1 ? `${name}, roll ${group.draw + 1} of ${reference.draws}` : name;
  };

  return (
    <div className="space-y-3">
      <section className="space-y-1" data-testid="test-roll-got">
        <h3 className="text-sm font-semibold text-ink">You got</h3>
        {atRisk.length + kept.length === 0 ? (
          <p className="text-sm text-ink">This roll gave nothing.</p>
        ) : (
          <ul className="space-y-1 text-sm text-ink">
            {atRisk.length > 0 && (
              <li>
                <Risk atRisk /> {atRisk.join(', ')}
                <span className="block text-xs text-ink-muted">
                  Held during the run; banked when the player extracts or completes the dungeon.
                </span>
              </li>
            )}
            {kept.length > 0 && (
              <li>
                <Risk atRisk={false} /> {kept.join(', ')}
                <span className="block text-xs text-ink-muted">
                  Given straight away and never taken back.
                </span>
              </li>
            )}
          </ul>
        )}
        {plan.secured.equipment.length > 0 && (
          <p className="text-xs text-ink-muted">
            Gear is shown as the piece that would drop. Its stats are rolled only when it really
            drops, so none are shown here.
          </p>
        )}
      </section>
      <section className="space-y-1" data-testid="test-roll-lines">
        <h3 className="text-sm font-semibold text-ink">What happened</h3>
        {plan.lines.length === 0 && (
          <p className="text-sm text-ink-muted">There is nothing to roll.</p>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            {heading(group) && (
              <p className="text-xs font-medium text-ink-muted" data-testid="roll-group">
                {heading(group)}
              </p>
            )}
            <ul className="space-y-0.5 text-sm">
              {plan.lines
                .filter((line) => groupOf(line) === group.key)
                // In the order the editor lists them: every time, chance drops, random picks.
                .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode))
                .map((line) => {
                  const chance = line.rolls.chance
                    ? formatChance(line.rolls.chance.chanceBasisPoints / 10_000)
                    : '';
                  const group = `“${line.poolName ?? 'A group'}”`;
                  return (
                    <li
                      key={line.dropId}
                      className={line.hit ? 'text-ink' : 'text-ink-muted'}
                      data-testid={line.hit ? 'line-hit' : 'line-miss'}
                    >
                      {line.hit
                        ? line.mode === 'pool'
                          ? `${group} picked: ${wonText(line, names)}`
                          : line.mode === 'chance'
                            ? `Dropped (${chance} chance): ${wonText(line, names)}`
                            : `Every time: ${wonText(line, names)}`
                        : line.missReason === 'nothing'
                          ? `${group} picked Nothing`
                          : `Missed (${chance} chance): ${authored(line)}`}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </section>
      <p className="text-xs text-ink-muted" data-testid="test-roll-seed">
        Seed {result.seed}. Enter it again to repeat this exact roll.{' '}
        <button
          type="button"
          className="text-accent underline-offset-4 hover:underline"
          onClick={reuseSeed}
        >
          Use this seed
        </button>
      </p>
      {result.simulation && (
        <section className="space-y-1" data-testid="test-roll-simulation">
          <h3 className="text-sm font-semibold text-ink">
            Across {formatNumber(result.simulation.runs)} simulated rolls
          </h3>
          <ul className="space-y-0.5 text-sm text-ink">
            {result.simulation.averages.map((average) => (
              <li key={JSON.stringify(average.reward)}>
                {rewardLabel(average.reward, names)}: {formatAverage(average.averageQuantity)} on
                average <Risk atRisk={average.riskClass === 'at_risk'} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">
            Gave nothing at all in {formatChance(result.simulation.nothingRate)} of them. These are
            observed results, so they sit close to the exact odds without matching them.
          </p>
        </section>
      )}
    </div>
  );
}
