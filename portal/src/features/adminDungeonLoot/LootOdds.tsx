/**
 * What a loot table — or one activity's whole reward bundle, loot tables
 * included — gives on average, in a sentence, with the full odds one click
 * away. Every figure is the server's exact analysis of what is on screen; this
 * component only words and formats it.
 */
import { useState } from 'react';
import type { DungeonRewardAnalysis } from '@/api/adminDungeonLootTables';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import {
  LOOT_LIMITS,
  averageParts,
  formatAverage,
  formatChance,
  listText,
  rewardLabel,
  type RewardNames,
} from './lootModel';

interface Props {
  analysis: DungeonRewardAnalysis | null | undefined;
  /** A loot table previewed for a number of rolls; omit for an activity, which pays once. */
  rolls?: number;
  onRolls?: (rolls: number) => void;
  /** An activity's bundle: names its loot tables, and words the summary for an activity. */
  tableName?: (key: string) => string;
  names: RewardNames;
  /** The form has something to fix, so there is no table to analyse. */
  blocked: boolean;
  /** A newer answer is on its way. */
  updating: boolean;
  failed: boolean;
}

export function LootOdds({
  analysis,
  rolls,
  onRolls,
  tableName,
  names,
  blocked,
  updating,
  failed,
}: Props) {
  const [open, setOpen] = useState(false);
  const activity = tableName !== undefined;
  const subject = activity ? 'This activity' : 'This table';
  const scope = activity
    ? ''
    : rolls === undefined || rolls === 1
      ? ' per roll'
      : ` from ${rolls} rolls`;
  /** One pick of each group of random picks, as the server sees it. */
  const picks = [
    ...new Map(
      (analysis?.sources ?? [])
        .filter((s) => s.mode === 'pool')
        .map((source) => [
          `${source.tableReferenceId ?? ''}:${source.poolId ?? ''}`,
          {
            source,
            label: `“${source.poolName ?? 'a group'}”${
              tableName && source.tableKey ? ` in ${tableName(source.tableKey)}` : ''
            }`,
          },
        ]),
    ),
  ].map(([key, pick]) => ({ key, ...pick }));
  const average = analysis ? averageParts(analysis, names) : [];
  const atRisk = (analysis?.rewards ?? [])
    .filter((entry) => entry.riskClass === 'at_risk')
    .map((entry) => `${formatAverage(entry.expectedQuantity)} ${rewardLabel(entry.reward, names)}`);
  const Frame = activity ? 'div' : Card;
  return (
    <Frame
      className={activity ? 'space-y-2 border-t border-border pt-2' : 'space-y-2 p-4'}
      data-testid="loot-odds"
      aria-busy={updating}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase text-ink-muted">What players can expect</h2>
        {rolls !== undefined && onRolls && (
          <label className="flex items-center gap-2 whitespace-nowrap text-xs text-ink-muted">
            If a dungeon rolls this table
            <select
              aria-label="Number of rolls"
              className={`${selectClass} w-auto`}
              value={rolls}
              onChange={(e) => onRolls(Number(e.target.value))}
            >
              {Array.from({ length: LOOT_LIMITS.tableRolls }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'once' : `${n} times`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {blocked ? (
        <p className="text-sm text-ink-muted">Fix the highlighted fields to see the odds.</p>
      ) : failed ? (
        <p className="text-sm text-danger" role="alert">
          The odds could not be loaded. They will be tried again when the rewards change.
        </p>
      ) : analysis === undefined ? (
        <Skeleton className="h-12 w-full" />
      ) : analysis === null ? (
        <p className="text-sm text-ink-muted">
          The odds cannot be worked out until the problems marked “Fix” are sorted.
        </p>
      ) : (
        <>
          <p className="text-sm text-ink" data-testid="odds-summary">
            {average.length === 0
              ? `${subject} gives nothing yet.`
              : `On average${scope}: ${listText(average)}.`}
          </p>
          <p className="text-sm text-ink" data-testid="odds-nothing">
            {analysis.noRewardChance > 0
              ? `Chance of getting nothing at all${scope}: ${formatChance(analysis.noRewardChance)}.`
              : average.length > 0 && `${subject} always gives something.`}
          </p>
          {atRisk.length > 0 && (
            <p className="text-xs text-ink-muted" data-testid="odds-risk">
              At risk until the run ends: {listText(atRisk)} on average. Everything else is kept.
            </p>
          )}
          {picks
            .filter(({ source }) => source.noRewardChance > 0)
            .map(({ key, label, source }) => (
              <p key={key} className="text-xs text-ink-muted">
                Each pick from {label} comes up empty {formatChance(source.noRewardChance)} of the
                time.
              </p>
            ))}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide all odds' : 'See all odds'}
          </Button>
          {open && (
            <div className="space-y-3" data-testid="all-odds">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Reward</th>
                      <th className="py-1 pr-3 font-medium">Chance of at least one</th>
                      <th className="py-1 pr-3 font-medium">Average amount</th>
                      <th className="py-1 font-medium">On defeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rewards.map((entry) => (
                      <tr key={JSON.stringify(entry.reward)} className="border-t border-border">
                        <td className="py-1 pr-3 text-ink">
                          {entry.reward.type === 'equipment' && (
                            <span className="text-ink-muted">Gear: </span>
                          )}
                          {rewardLabel(entry.reward, names)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {formatChance(entry.chanceAtLeastOnce)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {formatAverage(entry.expectedQuantity)}
                        </td>
                        <td className="py-1 text-ink-muted">
                          {entry.riskClass === 'at_risk' ? 'At risk' : 'Kept'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {analysis.expectedEquipmentPieces > 0 && (
                <p className="text-xs text-ink-muted">
                  Any gear at all: {formatChance(analysis.chanceAnyEquipment)}, from{' '}
                  {analysis.equipmentCandidateCount} possible{' '}
                  {analysis.equipmentCandidateCount === 1 ? 'piece' : 'pieces'}.
                </p>
              )}
              {picks.map(({ key, label, source }) => (
                <div key={key} className="text-xs" data-testid="pick-odds">
                  <p className="font-medium text-ink">Each pick from {label} gives one of:</p>
                  <ul className="mt-0.5 space-y-0.5 text-ink-muted">
                    {source.rewards.map((outcome) => (
                      <li key={JSON.stringify(outcome.reward)}>
                        {rewardLabel(outcome.reward, names)} — {formatChance(outcome.probability)}
                      </li>
                    ))}
                    {source.noRewardChance > 0 && (
                      <li>Nothing — {formatChance(source.noRewardChance)}</li>
                    )}
                  </ul>
                </div>
              ))}
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-muted">
                <li>Chance drops each roll on their own, so several can drop together.</li>
                <li>
                  Choices in a group compete: each pick gives exactly one of them, and a choice can
                  be picked again on the next pick.
                </li>
                <li>
                  Rolling a loot table more than once repeats everything in it: its “every time”
                  rewards, each chance drop and every pick.
                </li>
                <li>Essence and Affection are shown before the Buddy’s bonus.</li>
              </ul>
            </div>
          )}
        </>
      )}
    </Frame>
  );
}
