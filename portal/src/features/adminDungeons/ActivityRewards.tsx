/**
 * The Rewards section of a fight or treasure: what the activity pays once, on
 * success. Collapsed it is one line; opened it has three groups — guaranteed
 * rewards, chance drops and shared loot tables — built from the same reward
 * form, odds panel and Test Roll the Dungeon Loot editor uses.
 *
 * The bundle lives in the dungeon draft like every other field, so it is saved
 * and validated with the draft. A percentage that is not usable yet is held
 * here and explained, and never written into the draft.
 */
import { useContext, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  listDungeonLootTables,
  testRollDungeonRewards,
  type DungeonRewardGrant,
} from '@/api/adminDungeonLootTables';
import type {
  DungeonAction,
  DungeonDefinition,
  DungeonReferenceData,
  DungeonRewardBundle,
  DungeonRoom,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LootOdds } from '@/features/adminDungeonLoot/LootOdds';
import {
  AddButton,
  ChanceSection,
  GuaranteedSection,
  Notes,
  Section,
  rowClass,
  sentenceClass,
  type SectionTools,
} from '@/features/adminDungeonLoot/LootSections';
import { LootTablePicker } from '@/features/adminDungeonLoot/LootTablePicker';
import { TestRollDialog } from '@/features/adminDungeonLoot/TestRollDialog';
import {
  BUNDLE_LIMITS,
  TABLE_RISK_TEXT,
  bundleIsEmpty,
  bundleIssueText,
  emptyBundle,
  payoutTiming,
  rewardsSummary,
  riskExplanation,
  tableRisk,
  tierText,
  withBundle,
} from '@/features/adminDungeonLoot/bundleModel';
import {
  isAtRisk,
  kindOfGrant,
  moved,
  newEntryId,
  parsePercent,
  percentText,
  rewardNames,
  type ChanceRow,
  type FriendlyLootIssue,
} from '@/features/adminDungeonLoot/lootModel';
import { LootTableSheetContext } from '@/features/adminDungeonLoot/lootSheetContext';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { activityOf, roomLabel, type FriendlyIssue } from './dungeonText';

/** How long the rewards must sit still before their odds are asked for again. */
const PREVIEW_DELAY_MS = 400;

interface Props {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  /** The friendly issues that belong to this activity. */
  issues: FriendlyIssue[];
  readOnly: boolean;
  onChange: (action: DungeonAction) => void;
  /** When the bundle is paid, for a holder that is not a fight or a treasure (an event result). */
  payout?: string;
  /** What a Test Roll of it is called. */
  testTitle?: string;
  /** Start as one line even when the holder is not a fight. */
  startCollapsed?: boolean;
}

export function ActivityRewards({
  action,
  room,
  definition,
  reference,
  issues,
  readOnly,
  onChange,
  payout,
  testTitle,
  startCollapsed = false,
}: Props) {
  const openTable = useContext(LootTableSheetContext);
  const bundle = action.rewards ?? emptyBundle();
  const rewardIssues = issues.filter((i) => i.issue.path.includes('.rewards'));
  // A boss and a treasure are where loot is expected, so theirs starts open.
  const [expanded, setExpanded] = useState(
    (action.type !== 'combat' && !startCollapsed) || rewardIssues.length > 0,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  /** Percentages as typed, for chance rows whose text is not the stored value. */
  const [typed, setTyped] = useState<Record<string, string>>({});

  const catalogue = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'list', { includeArchived: true }],
    queryFn: ({ signal }) => listDungeonLootTables({ includeArchived: true }, signal),
    enabled: expanded,
  });
  const tables = catalogue.data?.tables;
  const currency = definition.settings.progressionCurrency;
  const settled = useDebouncedValue(JSON.stringify(bundle), PREVIEW_DELAY_MS);
  const preview = useQuery({
    // Under the loot-table key, so saving a referenced table refreshes these odds.
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'activity-preview', settled, currency],
    enabled: expanded && !bundleIsEmpty(bundle),
    // Keyed by the rewards it describes, so an answer for older rewards is never shown as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      testRollDungeonRewards(
        {
          bundle: JSON.parse(settled) as DungeonRewardBundle,
          seed: 0,
          progressionCurrency: currency,
        },
        signal,
      ),
  });
  const items = reference?.items ?? [];
  const names = rewardNames(reference?.items, preview.data?.equipmentPools);
  const known = tables ?? reference?.lootTables;
  const risk = riskExplanation(definition.settings);

  const commit = (next: DungeonRewardBundle) => onChange(withBundle(action, next));
  const chanceRows: ChanceRow[] = bundle.chances.map((entry) => ({
    id: entry.id,
    grant: entry.grant,
    percent: typed[entry.id] ?? percentText(entry.chanceBasisPoints),
  }));
  /** Applies a change from the shared sections; an unusable percentage stays out of the draft. */
  const update = (patch: {
    guaranteed?: DungeonRewardBundle['guaranteed'];
    chances?: ChanceRow[];
  }) => {
    const stored = new Map(bundle.chances.map((entry) => [entry.id, entry.chanceBasisPoints]));
    const held: Record<string, string> = {};
    const chances = (patch.chances ?? chanceRows).flatMap((row) => {
      const parsed = parsePercent(row.percent);
      const previous = stored.get(row.id);
      if ('problem' in parsed) {
        held[row.id] = row.percent;
        return previous === undefined
          ? []
          : [{ id: row.id, chanceBasisPoints: previous, grant: row.grant }];
      }
      if (row.percent !== percentText(parsed.basisPoints)) held[row.id] = row.percent;
      return [{ id: row.id, chanceBasisPoints: parsed.basisPoints, grant: row.grant }];
    });
    setTyped(held);
    commit({ ...bundle, guaranteed: patch.guaranteed ?? bundle.guaranteed, chances });
  };

  const located: FriendlyLootIssue[] = rewardIssues.map(({ issue }) => {
    const found = bundleIssueText(issue, bundle, names, items, known);
    return {
      at: found.at,
      severity: issue.severity,
      text: found.text,
      raw: `${issue.code} · ${issue.path} · ${issue.message}`,
    };
  });
  const chip = (grant: DungeonRewardGrant) => {
    const atRisk = isAtRisk(kindOfGrant(grant));
    return (
      <Badge
        variant="outline"
        className="shrink-0"
        title={atRisk ? risk.atRisk : risk.kept}
        data-testid="risk-chip"
      >
        {atRisk ? 'At risk' : 'Kept'}
      </Badge>
    );
  };
  const tools: SectionTools = {
    names,
    items,
    readOnly,
    open,
    setOpen,
    problems: (at) => {
      const text = typed[at];
      const parsed = text === undefined ? null : parsePercent(text);
      const stored = bundle.chances.find((entry) => entry.id === at);
      return parsed && 'problem' in parsed && stored
        ? [
            `${parsed.problem} The draft still says ${percentText(stored.chanceBasisPoints)}% until this is a usable percentage.`,
          ]
        : [];
    },
    issues: (at) => located.filter((issue) => issue.at === at),
    chip,
  };

  const refs = bundle.tables;
  const setRefs = (next: DungeonRewardBundle['tables']) => commit({ ...bundle, tables: next });
  const meta = activityOf(action);
  const summary = rewardsSummary(bundle, names, known);

  return (
    <section className="rounded-lg border border-border" data-testid="activity-rewards">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Rewards: ${summary}`}
        className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-surface-raised"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Rewards</span>
          <span className="block text-xs break-words text-ink-muted" data-testid="rewards-summary">
            {summary}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="space-y-4 border-t border-border p-2.5">
          <p className="text-xs text-ink-muted" data-testid="payout-timing">
            {payout ?? payoutTiming(action)}
          </p>
          <GuaranteedSection
            form={{ guaranteed: bundle.guaranteed, chances: chanceRows, pools: [] }}
            update={update}
            tools={tools}
            copy={{
              title: 'Guaranteed',
              hint: 'always given',
              intro: null,
              addLabel: '+ Add guaranteed reward',
              max: BUNDLE_LIMITS.guaranteed,
              limit: `An activity holds up to ${BUNDLE_LIMITS.guaranteed} of these.`,
            }}
          />
          <ChanceSection
            form={{ guaranteed: bundle.guaranteed, chances: chanceRows, pools: [] }}
            update={update}
            tools={tools}
            alwaysLabel="Guaranteed"
            copy={{
              title: 'Chance drops',
              hint: 'each one rolls on its own',
              intro: null,
              addLabel: '+ Add chance drop',
              max: BUNDLE_LIMITS.chances,
              limit: `An activity holds up to ${BUNDLE_LIMITS.chances} chance drops.`,
            }}
          />
          <Section
            title="Loot tables"
            hint="random picks from a shared list"
            testId="section-tables"
          >
            <ul className="space-y-1.5">
              {refs.map((ref, index) => {
                const table = tables?.find((t) => t.key === ref.table);
                const listed = known?.find((t) => t.key === ref.table);
                const name = listed?.name ?? 'A deleted loot table';
                const mix = table ? TABLE_RISK_TEXT[tableRisk(table.body)] : null;
                const archived = table
                  ? table.archivedAt !== null
                  : reference?.lootTables?.find((t) => t.key === ref.table)?.archived;
                return (
                  <li key={ref.id} className={rowClass} data-testid="table-row">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={sentenceClass}>
                        {name}
                        {listed?.tier && (
                          <span className="text-ink-muted"> · {tierText(listed.tier)}</span>
                        )}
                      </span>
                      <label className="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
                        roll
                        <select
                          aria-label={`Times ${name} is rolled`}
                          className={`${selectClass} w-auto`}
                          value={ref.draws}
                          disabled={readOnly}
                          onChange={(e) =>
                            setRefs(
                              refs.map((r) =>
                                r.id === ref.id ? { ...r, draws: Number(e.target.value) } : r,
                              ),
                            )
                          }
                        >
                          {Array.from({ length: BUNDLE_LIMITS.draws }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                        {ref.draws === 1 ? 'time' : 'times'}
                      </label>
                      {mix && (
                        <Badge
                          variant="outline"
                          className="shrink-0"
                          title={mix.detail}
                          data-testid="risk-chip"
                        >
                          {mix.label}
                        </Badge>
                      )}
                      {listed &&
                        (openTable ? (
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            aria-label={`Open table ${name}`}
                            onClick={() => openTable(ref.table)}
                          >
                            Open table
                          </Button>
                        ) : (
                          <a
                            className="shrink-0 text-xs text-accent underline-offset-4 hover:underline"
                            href={`/admin/dungeons/loot/${encodeURIComponent(ref.table)}`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open table ${name} in a new tab`}
                          >
                            Open table ↗
                          </a>
                        ))}
                      {!readOnly && (
                        <span className="flex shrink-0 items-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${name} up`}
                            disabled={index === 0}
                            onClick={() => setRefs(moved(refs, index, -1))}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${name} down`}
                            disabled={index === refs.length - 1}
                            onClick={() => setRefs(moved(refs, index, 1))}
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${name}`}
                            onClick={() => setRefs(refs.filter((r) => r.id !== ref.id))}
                          >
                            <X />
                          </Button>
                        </span>
                      )}
                    </div>
                    {mix && tableRisk(table!.body) === 'mixed' && (
                      <p className="mt-1 text-xs text-ink-muted" data-testid="mixed-note">
                        {mix.detail}
                      </p>
                    )}
                    {ref.draws > 1 && (
                      <p className="mt-1 text-xs text-ink-muted">
                        Rolled {ref.draws} times: everything in the table happens {ref.draws} times
                        over.
                      </p>
                    )}
                    {tables && !listed && (
                      <p className="mt-1 text-xs text-danger" role="alert">
                        This loot table was deleted. Remove it or pick another.
                      </p>
                    )}
                    {archived && (
                      <p className="mt-1 text-xs text-danger" role="alert">
                        This loot table is archived, so the dungeon cannot be published with it.
                        Open the table to restore it from Dungeon Loot Tables, or remove it here.
                      </p>
                    )}
                    <Notes at={ref.id} tools={tools} />
                  </li>
                );
              })}
            </ul>
            {open === 'add:tables' ? (
              <LootTablePicker
                tables={tables}
                onCancel={() => setOpen(null)}
                onPick={(table) => {
                  setRefs([...refs, { id: newEntryId('t'), table: table.key, draws: 1 }]);
                  setOpen(null);
                }}
              />
            ) : (
              <AddButton
                tools={tools}
                full={refs.length >= BUNDLE_LIMITS.tables}
                limit={`An activity rolls up to ${BUNDLE_LIMITS.tables} loot tables.`}
                onClick={() => setOpen('add:tables')}
              >
                + Add loot table
              </AddButton>
            )}
            <p className="text-xs text-ink-muted">
              Loot tables are shared: editing one changes it for every dungeon that uses it. A
              published dungeon keeps the loot it was published with until it is published again.
            </p>
          </Section>
          {located
            .filter((issue) => issue.at === null)
            .map((issue) => (
              <p
                key={issue.raw}
                title={issue.raw}
                className={`text-xs ${issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}`}
              >
                {issue.severity === 'error' ? 'Fix: ' : 'Review: '}
                {issue.text}
              </p>
            ))}
          <div className="space-y-1 text-xs text-ink-muted" data-testid="risk-explanation">
            <p>{risk.atRisk}</p>
            <p>{risk.kept}</p>
          </div>
          {!bundleIsEmpty(bundle) && (
            <>
              <LootOdds
                analysis={preview.data ? preview.data.analysis : undefined}
                tableName={(key) => known?.find((t) => t.key === key)?.name ?? 'a loot table'}
                names={names}
                blocked={false}
                updating={preview.isFetching || settled !== JSON.stringify(bundle)}
                failed={preview.isError}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => setTesting(true)}>
                Test roll
              </Button>
              <TestRollDialog
                open={testing}
                onOpenChange={setTesting}
                target={{
                  kind: 'bundle',
                  bundle,
                  progressionCurrency: currency,
                  tables: tables ?? [],
                }}
                title={testTitle ?? `${meta.title} in ${roomLabel(room)}`}
                items={items}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
