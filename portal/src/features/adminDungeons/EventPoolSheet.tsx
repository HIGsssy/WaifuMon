/**
 * A random event pool, edited in a side sheet over the dungeon.
 *
 * A pool is a list of entries, each with a share: an event, or "Nothing".
 * One is drawn when the player arrives. An entry can have a rule, and an
 * event can be limited to once per run, so the real odds depend on the run.
 *
 * No odds are worked out here. Every percentage on this sheet — with every
 * entry in the draw, and for the situation being tried — is the server's
 * answer from the rules the game itself draws by.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type {
  DungeonDefinition,
  DungeonEventPool,
  DungeonEventPoolEntry,
  DungeonEventPoolOdds,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { formatChance } from '@/features/adminDungeonLoot/lootModel';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { EventScenarioControls } from './EventScenarioControls';
import { moveEntry } from './dungeonActionModel';
import {
  EVENT_LIMITS,
  conditionReads,
  eventsOf,
  newPoolEntry,
  oneIn,
  poolById,
  poolUsage,
  retargetPoolEntry,
  updatePool,
  usageText,
  withMember,
} from './dungeonEventModel';
import type { EventIssueTarget, FriendlyIssue } from './dungeonText';
import { EMPTY_SCENARIO, useEventInsight } from './useEventInsight';

const select = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
const field = 'block space-y-1 text-sm';
const hint = 'text-xs text-ink-muted';
const heading = 'text-xs font-semibold tracking-wide text-ink-muted uppercase';
const NOTHING = '__nothing__';

const WHY_OUT = {
  condition: 'Not in the draw: its rule is not met',
  already_seen: 'Not in the draw: already met this run',
} as const;

function Odds({
  odds,
  entryName,
  testId,
}: {
  odds: DungeonEventPoolOdds;
  entryName: (id: string) => string;
  testId: string;
}) {
  const empty = odds.totalWeight === 0;
  return (
    <div className="space-y-1" data-testid={testId}>
      {empty && (
        <p
          role="status"
          data-testid="pool-empty"
          className="rounded-md border border-border bg-surface-raised p-2 text-sm font-medium"
        >
          No entry is in the draw, so this pool results in Nothing: the player walks on and no event
          appears.
        </p>
      )}
      <ul className="space-y-1 text-sm">
        {odds.entries.map((entry) => (
          <li
            key={entry.id}
            data-testid="pool-odds-row"
            className={`flex flex-wrap items-baseline gap-x-2 ${entry.eligible ? '' : 'text-ink-subtle'}`}
          >
            <span className="min-w-0 flex-1 break-words">{entryName(entry.id)}</span>
            {entry.eligible ? (
              <>
                <span className="font-medium">{formatChance(entry.probability)}</span>
                <span className={hint}>{oneIn(entry.probability)}</span>
              </>
            ) : (
              <span className="text-xs">
                {entry.reason ? WHY_OUT[entry.reason] : 'Not in the draw'}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className={hint} data-testid="pool-nothing-chance">
        Chance that no event appears: {formatChance(odds.nothingProbability)}
        {oneIn(odds.nothingProbability) ? ` (${oneIn(odds.nothingProbability)})` : ''}.
      </p>
    </div>
  );
}

export function EventPoolSheet({
  poolId,
  definition,
  issues,
  disabled,
  focus,
  onChange,
  onClose,
  onOpenEvent,
  onPlay,
}: {
  poolId: string;
  definition: DungeonDefinition;
  /** The friendly issues that belong to this pool. */
  issues: FriendlyIssue[];
  disabled: boolean;
  focus?: (EventIssueTarget & { nonce: number }) | undefined;
  onChange: (definition: DungeonDefinition) => void;
  onClose: () => void;
  onOpenEvent: (eventId: string) => void;
  onPlay: () => void;
}) {
  const pool = poolById(definition, poolId);
  const [scenario, setScenario] = useState(EMPTY_SCENARIO);
  const [ruleOpen, setRuleOpen] = useState<string | null>(null);
  /** Shares as typed, while they are not a usable whole number. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const insight = useEventInsight(definition, scenario);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pool) onClose();
  }, [pool, onClose]);
  useEffect(() => {
    if (!focus || (!focus.entryId && !focus.field)) return;
    const timer = window.setTimeout(() => {
      const root = body.current;
      if (!root) return;
      const scope = focus.entryId
        ? root.querySelector<HTMLElement>(`[data-entry-id="${focus.entryId}"]`)
        : null;
      const target =
        (focus.field
          ? (scope ?? root).querySelector<HTMLElement>(`[data-event-field="${focus.field}"]`)
          : null) ??
        scope ??
        root;
      target.scrollIntoView?.({ block: 'center' });
      const control = target.matches('input, select, textarea, button')
        ? target
        : target.querySelector<HTMLElement>('input, select, textarea, button');
      control?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  const reads = useMemo(() => {
    const into = { flags: new Set<string>(), rooms: new Set<string>() };
    const once: string[] = [];
    for (const entry of pool?.entries ?? []) {
      conditionReads(entry.when, into);
      if ('eventId' in entry && entry.eventId && entry.oncePerRun !== false)
        once.push(entry.eventId);
    }
    return { flags: [...into.flags], rooms: [...into.rooms], events: [...new Set(once)] };
  }, [pool]);
  if (!pool) return null;

  const events = eventsOf(definition);
  const setPool = (change: (pool: DungeonEventPool) => DungeonEventPool) =>
    onChange(updatePool(definition, poolId, change));
  const setEntry = (next: DungeonEventPoolEntry) =>
    setPool((p) => ({ ...p, entries: p.entries.map((e) => (e.id === next.id ? next : e)) }));
  const titleOf = (eventId: string) =>
    events.find((e) => e.id === eventId)?.title ?? 'A missing event';
  const entryName = (id: string) => {
    const entry = pool.entries.find((e) => e.id === id);
    if (!entry) return 'An entry';
    return 'eventId' in entry
      ? entry.eventId
        ? titleOf(entry.eventId)
        : 'No event chosen'
      : 'Nothing happens';
  };
  const analysis = insight.pools?.find((p) => p.poolId === poolId);
  const baseOf = (id: string) => analysis?.base.entries.find((e) => e.id === id);
  const listed = new Set(pool.entries.flatMap((e) => ('eventId' in e ? [e.eventId] : [])));
  const unlisted = events.filter((e) => !listed.has(e.id));
  const full = pool.entries.length >= EVENT_LIMITS.poolEntries;
  const stale = !insight.current && !insight.failed;
  const general = issues.filter((i) => !i.eventTarget?.entryId);

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        closeLabel="Close random pool"
        className="w-full max-w-none sm:w-[46rem] sm:max-w-[92vw]"
      >
        <div
          ref={body}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-4 pb-6"
          data-testid="event-pool-editor"
        >
          <div className="space-y-1 pr-10">
            <SheetTitle className="font-display text-xl break-words text-ink">
              Random events: {pool.name || 'Unnamed'}
            </SheetTitle>
            <SheetDescription className="text-sm text-ink-muted">
              One entry is drawn when a player arrives, and it stays drawn: leaving and coming back
              never rolls again.{' '}
              {disabled
                ? 'Changing it needs permission to edit dungeons.'
                : 'Changes here are part of your dungeon draft.'}
            </SheetDescription>
            <p className={hint} data-testid="pool-usage" title={`Pool ID: ${pool.id}`}>
              {usageText(poolUsage(definition, poolId))}.
            </p>
          </div>
          {general.length > 0 && (
            <ul
              aria-label="To do in this pool"
              className="space-y-1 rounded-lg border border-border p-2.5 text-sm"
            >
              {general.map((i, n) => (
                <li key={n} className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}>
                  <strong className="font-medium">{i.title}</strong> {i.help}
                </li>
              ))}
            </ul>
          )}

          <fieldset disabled={disabled}>
            <label className={field} data-event-field="name">
              Pool name (only you see it)
              <Input
                aria-label="Pool name"
                maxLength={EVENT_LIMITS.poolName}
                value={pool.name}
                onChange={(e) => setPool((p) => ({ ...p, name: e.target.value }))}
              />
            </label>
          </fieldset>

          <section aria-label="Entries" className="space-y-2" data-event-field="entries">
            <h3 className={heading}>What can happen</h3>
            <p className={hint}>
              A bigger share makes an entry more likely. Shares are compared with each other, so 1,
              1 and 2 mean a quarter, a quarter and a half.
            </p>
            <ol className="space-y-2">
              {pool.entries.map((entry, index) => {
                const n = index + 1;
                const isEvent = 'eventId' in entry;
                const base = baseOf(entry.id);
                const entryIssues = issues.filter((i) => i.eventTarget?.entryId === entry.id);
                const shareText = typed[entry.id] ?? String(entry.weight);
                const badShare = typed[entry.id] !== undefined;
                return (
                  <li
                    key={entry.id}
                    data-entry-id={entry.id}
                    data-testid="pool-entry"
                    className={`space-y-2 rounded-lg border p-2.5 ${entryIssues.some((i) => i.level !== 'review') ? 'border-danger/60' : 'border-border'}`}
                  >
                    <fieldset disabled={disabled} className="space-y-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <label className={`${field} min-w-0 flex-1`} data-event-field="eventId">
                          Entry {n}
                          <select
                            aria-label={`Entry ${n}: what happens`}
                            className={select}
                            value={isEvent ? entry.eventId : NOTHING}
                            onChange={(e) =>
                              setEntry(
                                retargetPoolEntry(
                                  entry,
                                  e.target.value === NOTHING ? null : e.target.value,
                                ),
                              )
                            }
                          >
                            <option value={NOTHING}>Nothing happens</option>
                            {isEvent && !entry.eventId && (
                              <option value="">Choose an event…</option>
                            )}
                            {isEvent &&
                              entry.eventId &&
                              !events.some((e) => e.id === entry.eventId) && (
                                <option value={entry.eventId}>A missing event</option>
                              )}
                            {events.map((e) => (
                              <option
                                key={e.id}
                                value={e.id}
                                disabled={listed.has(e.id) && !(isEvent && entry.eventId === e.id)}
                              >
                                {e.title || 'Untitled event'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={field} data-event-field="weight">
                          Share
                          <Input
                            type="number"
                            min={1}
                            max={EVENT_LIMITS.weight}
                            step={1}
                            className="w-24"
                            aria-label={`Entry ${n} share`}
                            aria-invalid={badShare}
                            value={shareText}
                            onChange={(e) => {
                              const text = e.target.value;
                              const value = Number(text);
                              const usable =
                                Number.isInteger(value) &&
                                value >= 1 &&
                                value <= EVENT_LIMITS.weight;
                              setTyped((held) => {
                                const next = { ...held };
                                if (usable) delete next[entry.id];
                                else next[entry.id] = text;
                                return next;
                              });
                              if (usable) setEntry({ ...entry, weight: value });
                            }}
                          />
                        </label>
                        <span
                          className="pb-2 text-sm"
                          data-testid="pool-entry-chance"
                          aria-live="polite"
                        >
                          {base ? (
                            <>
                              <strong>{formatChance(base.probability)}</strong>{' '}
                              <span className={hint}>{oneIn(base.probability)}</span>
                            </>
                          ) : (
                            <span className={hint}>…</span>
                          )}
                        </span>
                      </div>
                      {badShare && (
                        <p role="alert" className="text-xs text-danger">
                          A share is a whole number from 1 to {EVENT_LIMITS.weight.toLocaleString()}
                          . The draft still says {entry.weight} until this is one.
                        </p>
                      )}
                      {isEvent ? (
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`Entry ${n}: once per run`}
                            checked={entry.oncePerRun !== false}
                            onChange={(e) => setEntry({ ...entry, oncePerRun: e.target.checked })}
                          />
                          <span>
                            At most once per run
                            <span className={`block ${hint}`}>
                              Left out of the draw once the player has met this event anywhere in
                              the run.
                            </span>
                          </span>
                        </label>
                      ) : (
                        <label className={field}>
                          A line players read when nothing happens (optional)
                          <Input
                            aria-label={`Entry ${n} nothing text`}
                            maxLength={EVENT_LIMITS.nothingText}
                            placeholder="Left blank, nothing is said at all."
                            value={entry.text ?? ''}
                            onChange={(e) =>
                              setEntry(withMember(entry, 'text', e.target.value || undefined))
                            }
                          />
                        </label>
                      )}
                      <div data-event-field="requires">
                        {entry.when || ruleOpen === entry.id ? (
                          <DungeonConditionEditor
                            label={`Entry ${n} is in the draw`}
                            value={entry.when}
                            definition={definition}
                            onChange={(when) => {
                              if (!when) setRuleOpen(null);
                              setEntry(withMember(entry, 'when', when));
                            }}
                          />
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Entry ${n}: add a rule`}
                            onClick={() => setRuleOpen(entry.id)}
                          >
                            Only if…
                          </Button>
                        )}
                      </div>
                    </fieldset>
                    <div className="flex flex-wrap items-center gap-1">
                      {entry.when && <Badge variant="outline">Conditional</Badge>}
                      {isEvent && entry.eventId && events.some((e) => e.id === entry.eventId) && (
                        <Button
                          variant="link"
                          size="sm"
                          aria-label={`Entry ${n}: open event`}
                          onClick={() => onOpenEvent(entry.eventId)}
                        >
                          {disabled ? 'View event' : 'Edit event'}
                        </Button>
                      )}
                      {!disabled && (
                        <span className="ml-auto flex items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move entry ${n} up`}
                            disabled={index === 0}
                            onClick={() =>
                              setPool((p) => ({ ...p, entries: moveEntry(p.entries, index, -1) }))
                            }
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move entry ${n} down`}
                            disabled={index === pool.entries.length - 1}
                            onClick={() =>
                              setPool((p) => ({ ...p, entries: moveEntry(p.entries, index, 1) }))
                            }
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove entry ${n}`}
                            disabled={pool.entries.length === 1}
                            title={
                              pool.entries.length === 1
                                ? 'A pool needs at least one entry.'
                                : undefined
                            }
                            onClick={() =>
                              setPool((p) => ({
                                ...p,
                                entries: p.entries.filter((e) => e.id !== entry.id),
                              }))
                            }
                          >
                            <X />
                          </Button>
                        </span>
                      )}
                    </div>
                    {entryIssues.length > 0 && (
                      <ul className="space-y-1 text-xs">
                        {entryIssues.map((i, k) => (
                          <li
                            key={k}
                            className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}
                          >
                            {i.title} {i.help}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
            {!disabled &&
              (full ? (
                <p className={hint}>A pool holds up to {EVENT_LIMITS.poolEntries} entries.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={unlisted.length === 0}
                    title={
                      unlisted.length === 0
                        ? 'Every event in this dungeon is already in the pool.'
                        : undefined
                    }
                    onClick={() =>
                      setPool((p) => ({
                        ...p,
                        entries: [...p.entries, newPoolEntry(p, unlisted[0]!.id)],
                      }))
                    }
                  >
                    + Add event
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPool((p) => ({ ...p, entries: [...p.entries, newPoolEntry(p, null)] }))
                    }
                  >
                    + Add “Nothing happens”
                  </Button>
                </div>
              ))}
          </section>

          <section aria-label="Chances" className="space-y-3" aria-busy={stale}>
            <h3 className={heading}>Chances</h3>
            {insight.failed && (
              <p role="alert" className="text-sm text-danger">
                The chances could not be worked out just now. They are asked for again when you
                change something.
              </p>
            )}
            {insight.unreadable && (
              <p role="status" className="text-sm text-ink-muted">
                The chances appear once every blank field in the dungeon is filled in.
              </p>
            )}
            {!analysis && !insight.failed && !insight.unreadable && (
              <p role="status" className={hint}>
                Working out the chances…
              </p>
            )}
            {analysis && (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-medium">With every entry in the draw</p>
                  <Odds odds={analysis.base} entryName={entryName} testId="pool-base-odds" />
                </div>
                <EventScenarioControls
                  definition={definition}
                  scenario={scenario}
                  onChange={setScenario}
                  flags={reads.flags}
                  rooms={reads.rooms}
                  events={reads.events}
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium">In that situation</p>
                  <Odds
                    odds={analysis.scenario}
                    entryName={entryName}
                    testId="pool-scenario-odds"
                  />
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onPlay}>
                Play the dungeon
              </Button>
              <span className={hint}>
                Walk through your draft with the real game rules. Nothing is given or used up.
              </span>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
