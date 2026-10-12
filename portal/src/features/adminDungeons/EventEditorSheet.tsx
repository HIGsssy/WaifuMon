/**
 * A narrative event, edited in a side sheet over the dungeon.
 *
 * It edits the dungeon draft directly, like every other part of the editor:
 * there is nothing to save here, and the page's Save keeps it. Each control
 * changes the one thing it is about, so the rest of the event — its id, its
 * choices' ids, anything not shown — is carried through exactly.
 *
 * Read top to bottom it is the event as a player meets it: the story, the
 * choices, what each one needs and risks, what happens, and a preview of the
 * Discord screen for whatever situation the author wants to try.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';
import type {
  DungeonAction,
  DungeonDefinition,
  DungeonEvent,
  DungeonEventChoice,
  DungeonEventChoicePreview,
  DungeonEventEffect,
  DungeonEventOutcome,
  DungeonReferenceData,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ItemPicker } from '@/features/adminDungeonLoot/ItemPicker';
import { LootTableSheetContext } from '@/features/adminDungeonLoot/lootSheetContext';
import { ActivityRewards } from './ActivityRewards';
import { DungeonBackgroundField } from './DungeonBackgroundField';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { EventDiscordPreview } from './EventDiscordPreview';
import { EventScenarioControls } from './EventScenarioControls';
import { moveEntry } from './dungeonActionModel';
import {
  BRANCH_LABEL,
  DEFAULT_SP_INFLUENCE_BASIS_POINTS,
  EVENT_LIMITS,
  MAX_SP_INFLUENCE_BASIS_POINTS,
  choiceBranches,
  clampInt,
  conditionReads,
  consumesItems,
  eventById,
  eventUsage,
  failureHasContent,
  isAlwaysAvailable,
  newChoice,
  patchOutcome,
  percentOfBasisPoints,
  setChoiceCheck,
  turnsBack,
  updateEvent,
  usageText,
  withMember,
  type EventBranch,
} from './dungeonEventModel';
import {
  asActivityRewardIssue,
  newFlagKey,
  type EventIssueTarget,
  type FriendlyIssue,
} from './dungeonText';
import { EMPTY_SCENARIO, useEventInsight } from './useEventInsight';

const select = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
const field = 'block space-y-1 text-sm';
const hint = 'text-xs text-ink-muted';
const area = 'w-full rounded-lg border border-border bg-surface p-2 text-sm';
const heading = 'text-xs font-semibold tracking-wide text-ink-muted uppercase';
const count = (text: string, max: number) => `${text.length} / ${max}`;

/** What the sheet lends its parts for the dungeon's list of remembered things. */
interface FlagTools {
  list: DungeonDefinition['flags'];
  /** Declares a new one and applies it in the same edit, so the two cannot drift apart. */
  create: (use: (key: string) => DungeonEventChoice) => void;
  rename: (key: string, description: string) => void;
}

function IssueList({ issues, label }: { issues: FriendlyIssue[]; label: string }) {
  if (issues.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-1 rounded-lg border border-border p-2.5 text-sm">
      {issues.map((i, n) => (
        <li
          key={n}
          title={`${i.issue.code} · ${i.issue.path} · ${i.issue.message}`}
          className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}
        >
          <strong className="font-medium">{i.title}</strong> {i.help}
        </li>
      ))}
    </ul>
  );
}

const EFFECT_KINDS = [
  { id: 'remember', label: 'Remember that something happened' },
  { id: 'forget', label: 'Forget it again' },
  { id: 'heal', label: 'Restore health' },
  { id: 'damage', label: 'Lose health' },
] as const;
type EffectKind = (typeof EFFECT_KINDS)[number]['id'];
const kindOf = (effect: DungeonEventEffect): EffectKind =>
  effect.type === 'set_flag' ? (effect.value ? 'remember' : 'forget') : effect.type;

function OutcomeEditor({
  branch,
  choice,
  event,
  definition,
  reference,
  issues,
  disabled,
  flags,
  onChange,
}: {
  branch: EventBranch;
  choice: DungeonEventChoice;
  event: DungeonEvent;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  issues: FriendlyIssue[];
  disabled: boolean;
  flags: FlagTools;
  onChange: (choice: DungeonEventChoice) => void;
}) {
  const outcome: DungeonEventOutcome = choice[branch] ?? {};
  const effects = outcome.effects ?? [];
  const patch = (change: (outcome: DungeonEventOutcome) => DungeonEventOutcome) =>
    onChange(patchOutcome(choice, branch, change));
  const setEffects = (next: DungeonEventEffect[]) => patch((o) => ({ ...o, effects: next }));
  const runFlags = flags.list.filter((f) => f.scope === 'run');
  const name = `${choice.label || 'choice'} ${BRANCH_LABEL[branch].toLowerCase()}`;
  const retreat = turnsBack(outcome);
  const thenKey = !outcome.then
    ? 'default'
    : outcome.then.type === 'end_run'
      ? `end_run:${outcome.then.outcome}`
      : outcome.then.type;
  const addFlagEffect = () => {
    const first = runFlags[0]?.key;
    if (first) return setEffects([...effects, { type: 'set_flag', flag: first, value: true }]);
    flags.create((key) =>
      patchOutcome(choice, branch, (o) => ({
        ...o,
        effects: [...(o.effects ?? []), { type: 'set_flag', flag: key, value: true }],
      })),
    );
  };
  // The Rewards section edits an activity; an outcome's bundle is lent to it as one.
  const holder: DungeonAction = {
    id: `${choice.id}-${branch}`,
    type: 'event',
    ...(outcome.rewards ? { rewards: outcome.rewards } : {}),
  };
  return (
    <fieldset
      className="space-y-3 rounded-md border border-border p-2"
      data-testid={`outcome-${branch}`}
      data-event-field={branch}
    >
      <legend className="px-1 text-xs font-medium text-ink-muted">{BRANCH_LABEL[branch]}</legend>
      <fieldset disabled={disabled} className="space-y-3">
        <label className={field} data-event-field={`${branch}.text`}>
          What the player is told
          <textarea
            aria-label={`${name}: result text`}
            className={area}
            rows={2}
            maxLength={EVENT_LIMITS.outcomeText}
            placeholder="Optional. One or two sentences."
            value={outcome.text ?? ''}
            onChange={(e) => patch((o) => ({ ...o, text: e.target.value }))}
          />
        </label>
        <label className={field}>
          Mood
          <select
            aria-label={`${name}: mood`}
            className={select}
            value={outcome.tone ?? 'neutral'}
            onChange={(e) =>
              patch((o) =>
                withMember(
                  o,
                  'tone',
                  e.target.value === 'neutral' ? undefined : (e.target.value as 'good' | 'bad'),
                ),
              )
            }
          >
            <option value="neutral">Neutral</option>
            <option value="good">Good news</option>
            <option value="bad">Bad news</option>
          </select>
        </label>
        <div className="space-y-2" data-event-field={`${branch}.effects`}>
          <p className="text-sm">What changes</p>
          {effects.length === 0 && <p className={hint}>Nothing changes. Add an effect below.</p>}
          {effects.map((effect, x) => {
            const replace = (next: DungeonEventEffect) =>
              setEffects(effects.map((old, i) => (i === x ? next : old)));
            const current =
              effect.type === 'set_flag' ? runFlags.find((f) => f.key === effect.flag) : undefined;
            return (
              <div key={x} className="space-y-1 rounded-md border border-border p-2">
                <div className="flex items-start gap-2">
                  <select
                    aria-label={`${name}: effect ${x + 1}`}
                    className={`${select} min-w-0 flex-1`}
                    value={kindOf(effect)}
                    onChange={(e) => {
                      const kind = e.target.value as EffectKind;
                      if (kind === 'heal' || kind === 'damage')
                        return replace({
                          type: kind,
                          basisPoints: effect.type === 'set_flag' ? 2500 : effect.basisPoints,
                        });
                      const flag = effect.type === 'set_flag' ? effect.flag : runFlags[0]?.key;
                      if (flag)
                        return replace({ type: 'set_flag', flag, value: kind === 'remember' });
                      flags.create((key) =>
                        patchOutcome(choice, branch, (o) => ({
                          ...o,
                          effects: (o.effects ?? []).map((old, i) =>
                            i === x
                              ? { type: 'set_flag', flag: key, value: kind === 'remember' }
                              : old,
                          ),
                        })),
                      );
                    }}
                  >
                    {EFFECT_KINDS.map((kind) => (
                      <option key={kind.id} value={kind.id}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${name}: remove effect ${x + 1}`}
                    onClick={() => setEffects(effects.filter((_, i) => i !== x))}
                  >
                    <X />
                  </Button>
                </div>
                {effect.type === 'set_flag' ? (
                  <>
                    <div className="flex items-end gap-2">
                      <select
                        aria-label={`${name}: effect ${x + 1} what`}
                        className={`${select} min-w-0 flex-1`}
                        value={effect.flag}
                        onChange={(e) => replace({ ...effect, flag: e.target.value })}
                      >
                        {!current && <option value={effect.flag}>Missing ({effect.flag})</option>}
                        {runFlags.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.description || 'Unnamed note'}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${name}: effect ${x + 1} new thing to remember`}
                        onClick={() =>
                          flags.create((key) =>
                            patchOutcome(choice, branch, (o) => ({
                              ...o,
                              effects: (o.effects ?? []).map((old, i) =>
                                i === x && old.type === 'set_flag' ? { ...old, flag: key } : old,
                              ),
                            })),
                          )
                        }
                      >
                        New…
                      </Button>
                    </div>
                    {current && (
                      <label className={field}>
                        <span className={hint}>Call it</span>
                        <Input
                          aria-label={`${name}: effect ${x + 1} name`}
                          maxLength={300}
                          value={current.description ?? ''}
                          onChange={(e) => flags.rename(current.key, e.target.value)}
                        />
                      </label>
                    )}
                    <p className={hint}>
                      Paths, activities and other choices can check this later in the same run.
                    </p>
                  </>
                ) : (
                  <label className="flex items-center gap-2 text-sm">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      className="w-24"
                      aria-label={`${name}: effect ${x + 1} percent`}
                      value={Number((effect.basisPoints / 100).toFixed(2))}
                      onChange={(e) =>
                        replace({
                          ...effect,
                          basisPoints: clampInt(Number(e.target.value) * 100, 1, 10_000),
                        })
                      }
                    />
                    % of the Buddy’s maximum HP
                    {effect.type === 'damage' && <span className={hint}>(never below 1 HP)</span>}
                  </label>
                )}
              </div>
            );
          })}
          {effects.length < EVENT_LIMITS.effects ? (
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                aria-label={`${name}: add remember`}
                onClick={addFlagEffect}
              >
                + Remember something
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${name}: add restore health`}
                onClick={() => setEffects([...effects, { type: 'heal', basisPoints: 2500 }])}
              >
                + Restore health
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${name}: add lose health`}
                onClick={() => setEffects([...effects, { type: 'damage', basisPoints: 2500 }])}
              >
                + Lose health
              </Button>
            </div>
          ) : (
            <p className={hint}>A result holds up to {EVENT_LIMITS.effects} effects.</p>
          )}
        </div>
      </fieldset>
      <div data-event-field={`${branch}.rewards`}>
        {/* Loot tables open in a new tab from here, so this sheet and its unsaved work stay put. */}
        <LootTableSheetContext.Provider value={null}>
          <ActivityRewards
            action={holder}
            room={{ id: '', actions: [] }}
            definition={definition}
            reference={reference}
            issues={issues
              .filter((i) => i.issue.path.includes(`.${branch}.rewards`))
              .map((i) => ({ ...i, issue: asActivityRewardIssue(i.issue) }))}
            readOnly={disabled}
            startCollapsed
            payout={
              branch === 'failure'
                ? 'Paid once, when the player picks this choice and the skill check fails.'
                : branch === 'success'
                  ? 'Paid once, when the player picks this choice and the skill check succeeds.'
                  : 'Paid once, when the player picks this choice.'
            }
            testTitle={`${event.title}: ${choice.label}`}
            onChange={(next) => patch((o) => withMember(o, 'rewards', next.rewards))}
          />
        </LootTableSheetContext.Provider>
      </div>
      <fieldset disabled={disabled} className="space-y-1">
        <label className={field} data-event-field={`${branch}.then`}>
          Then
          <select
            aria-label={`${name}: then`}
            className={select}
            value={thenKey}
            onChange={(e) => {
              const value = e.target.value;
              patch((o) =>
                withMember(
                  o,
                  'then',
                  value === 'default'
                    ? undefined
                    : value.startsWith('end_run:')
                      ? { type: 'end_run', outcome: value.slice(8) as 'completed' | 'defeated' }
                      : { type: value as 'next' | 'room_complete' | 'retreat' },
                ),
              );
            }}
          >
            <option value="default">Carry on</option>
            {thenKey === 'next' && (
              <option value="next">
                Carry on with the next activity, whatever the room’s flow says
              </option>
            )}
            <option value="room_complete">Finish the room</option>
            <option value="retreat">Turn back (the event stays open)</option>
            <option value="end_run:completed">End the run: the dungeon is completed</option>
            <option value="end_run:defeated">End the run in defeat</option>
          </select>
        </label>
        {retreat && (
          <p className={hint} role="note">
            The player goes back the way they came and meets this event again on return. A choice
            that turns back decides nothing, so it cannot change anything, give rewards, use up an
            item or have a skill check.
          </p>
        )}
      </fieldset>
    </fieldset>
  );
}

function ChoiceCard({
  choice,
  index,
  event,
  definition,
  reference,
  issues,
  shown,
  open,
  disabled,
  flags,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  choice: DungeonEventChoice;
  index: number;
  event: DungeonEvent;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  issues: FriendlyIssue[];
  /** The server's reading of this choice, for its skill check range. */
  shown: DungeonEventChoicePreview | undefined;
  open: boolean;
  disabled: boolean;
  flags: FlagTools;
  onToggle: () => void;
  onChange: (choice: DungeonEventChoice) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [picking, setPicking] = useState<number | null>(null);
  const [fineTune, setFineTune] = useState(
    choice.check !== undefined &&
      (choice.check.maxSpModifierBasisPoints ?? DEFAULT_SP_INFLUENCE_BASIS_POINTS) !==
        DEFAULT_SP_INFLUENCE_BASIS_POINTS,
  );
  const n = index + 1;
  const items = choice.items ?? [];
  const restricted = !isAlwaysAvailable(choice);
  const setItems = (next: NonNullable<DungeonEventChoice['items']>) =>
    onChange(withMember(choice, 'items', next.length ? next : undefined));
  const check = choice.check;
  const influence = check?.maxSpModifierBasisPoints ?? DEFAULT_SP_INFLUENCE_BASIS_POINTS;
  const consumes = consumesItems(choice);
  const chips = [
    check &&
      `Skill check, ${percentOfBasisPoints(check.baseChanceBasisPoints)} for an average Buddy`,
    items.length > 0 && (consumes ? 'Uses up an item' : 'Needs an item'),
    choice.requires && 'Conditional',
    choice.hideWhenUnavailable && 'Hidden when unavailable',
    choiceBranches(choice).some((b) => turnsBack(choice[b])) && 'Turns back',
  ].filter(Boolean) as string[];
  return (
    <li
      data-choice-id={choice.id}
      data-testid="event-choice"
      className={`rounded-lg border ${issues.some((i) => i.level !== 'review') ? 'border-danger/60' : open ? 'border-accent' : 'border-border'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Choice ${n}: ${choice.label || 'Untitled'}`}
        title={`Choice ID: ${choice.id}`}
        className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-surface-raised"
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium break-words">
            {choice.label || 'Untitled choice'}
          </span>
          {chips.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {chips.map((chip) => (
                <Badge key={chip} variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                  {chip}
                </Badge>
              ))}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0" />
        )}
      </button>
      {issues.length > 0 && (
        <ul className="space-y-1 border-t border-border px-2.5 py-2 text-xs">
          {issues.map((i, k) => (
            <li key={k} className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}>
              {i.title} {i.help}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="space-y-4 border-t border-border p-2.5">
          <fieldset disabled={disabled} className="space-y-3">
            <label className={field} data-event-field="label">
              Button text
              <Input
                aria-label={`Choice ${n} button text`}
                maxLength={EVENT_LIMITS.label}
                value={choice.label}
                onChange={(e) => onChange({ ...choice, label: e.target.value })}
              />
              <span className={hint}>{count(choice.label, EVENT_LIMITS.label)}</span>
            </label>
            <label className={field} data-event-field="description">
              A line under it (optional)
              <Input
                aria-label={`Choice ${n} description`}
                maxLength={EVENT_LIMITS.description}
                value={choice.description ?? ''}
                onChange={(e) =>
                  onChange(withMember(choice, 'description', e.target.value || undefined))
                }
              />
            </label>
          </fieldset>

          <section className="space-y-2" aria-label={`Choice ${n}: who can pick this`}>
            <h4 className={heading}>Who can pick this?</h4>
            {!restricted && <p className={hint}>Anyone, always.</p>}
            <fieldset disabled={disabled} className="space-y-2">
              <div data-event-field="requires">
                <DungeonConditionEditor
                  label={`Choice ${n} is available`}
                  value={choice.requires}
                  definition={definition}
                  onChange={(requires) => onChange(withMember(choice, 'requires', requires))}
                />
              </div>
              <div className="space-y-2" data-event-field="items">
                {items.map((item, i) => {
                  const known = reference?.items.find((x) => x.slug === item.item);
                  const set = (patch: Partial<NonNullable<DungeonEventChoice['items']>[number]>) =>
                    setItems(items.map((old, k) => (k === i ? { ...old, ...patch } : old)));
                  return (
                    <div
                      key={i}
                      className="space-y-2 rounded-md border border-border p-2"
                      data-testid="item-requirement"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm" title={item.item}>
                          Needs{' '}
                          <strong className="font-medium">
                            {item.item
                              ? (known?.name ?? 'an item that no longer exists')
                              : 'an item…'}
                          </strong>
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Choice ${n}: choose item ${i + 1}`}
                          onClick={() => setPicking(picking === i ? null : i)}
                        >
                          {item.item ? 'Change item' : 'Choose item'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Choice ${n}: remove item ${i + 1}`}
                          onClick={() => {
                            setPicking(null);
                            setItems(items.filter((_, k) => k !== i));
                          }}
                        >
                          <X />
                        </Button>
                      </div>
                      {!item.item && picking !== i && (
                        <p role="alert" className="text-xs text-danger">
                          Choose which item this needs.
                        </p>
                      )}
                      {picking === i && (
                        <ItemPicker
                          items={reference?.items ?? []}
                          value={item.item}
                          // Anything a player can hold can be asked for, a limited key most of all.
                          unusable={() => null}
                          onChange={(slug) => {
                            set({ item: slug });
                            setPicking(null);
                          }}
                        />
                      )}
                      <label className="flex items-center gap-2 text-sm">
                        How many
                        <Input
                          type="number"
                          min={1}
                          max={EVENT_LIMITS.itemQuantity}
                          step={1}
                          className="w-20"
                          aria-label={`Choice ${n}: item ${i + 1} quantity`}
                          value={item.quantity ?? 1}
                          onChange={(e) =>
                            set({
                              quantity: clampInt(
                                Number(e.target.value),
                                1,
                                EVENT_LIMITS.itemQuantity,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          aria-label={`Choice ${n}: item ${i + 1} is used up`}
                          checked={item.consume ?? false}
                          onChange={(e) => set({ consume: e.target.checked })}
                        />
                        Picking this uses it up
                      </label>
                    </div>
                  );
                })}
                {items.length < EVENT_LIMITS.itemRequirements && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Choice ${n}: add item requirement`}
                    onClick={() => {
                      setItems([...items, { item: '', quantity: 1, consume: false }]);
                      setPicking(items.length);
                    }}
                  >
                    + Needs an item
                  </Button>
                )}
              </div>
              {consumes && (
                <p
                  role="note"
                  data-testid="consume-warning"
                  className="rounded-md border border-border bg-surface-raised p-2 text-xs"
                >
                  {check
                    ? 'The item is used up the moment the player picks this, before the skill check is rolled. They lose it even if the check fails.'
                    : 'The item is used up the moment the player picks this.'}{' '}
                  Players are told so on the choice.
                </p>
              )}
              {restricted && (
                <>
                  <label className={field}>
                    What players read when they can’t pick it (optional)
                    <Input
                      aria-label={`Choice ${n} unavailable text`}
                      maxLength={EVENT_LIMITS.unavailableText}
                      placeholder="Not available right now."
                      value={choice.unavailableText ?? ''}
                      onChange={(e) =>
                        onChange(withMember(choice, 'unavailableText', e.target.value || undefined))
                      }
                    />
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`Choice ${n}: hide when unavailable`}
                      checked={choice.hideWhenUnavailable ?? false}
                      onChange={(e) =>
                        onChange(
                          withMember(choice, 'hideWhenUnavailable', e.target.checked || undefined),
                        )
                      }
                    />
                    <span>
                      Hide it from players who can’t pick it
                      <span className={`block ${hint}`}>
                        Otherwise it is shown greyed out, with the line above.
                      </span>
                    </span>
                  </label>
                </>
              )}
            </fieldset>
          </section>

          <section className="space-y-2" aria-label={`Choice ${n}: what happens`}>
            <h4 className={heading}>What happens?</h4>
            <fieldset disabled={disabled} className="space-y-2" data-event-field="check">
              <label className={field}>
                <span className="sr-only">Choice {n} result kind</span>
                <select
                  aria-label={`Choice ${n} result kind`}
                  className={select}
                  value={check ? 'check' : 'fixed'}
                  onChange={(e) => {
                    const checked = e.target.value === 'check';
                    if (
                      !checked &&
                      failureHasContent(choice) &&
                      !window.confirm(
                        'Remove the skill check? The success result is kept as the one result. What you wrote for failure is removed.',
                      )
                    )
                      return;
                    onChange(setChoiceCheck(choice, checked));
                  }}
                >
                  <option value="fixed">Always the same result</option>
                  <option value="check">Skill check: it can succeed or fail</option>
                </select>
              </label>
              {check && (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <label className={field}>
                    Chance for an average Buddy:{' '}
                    <strong>{percentOfBasisPoints(check.baseChanceBasisPoints)}</strong>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      className="w-full"
                      aria-label={`Choice ${n} chance for an average Buddy`}
                      value={Math.round(check.baseChanceBasisPoints / 100)}
                      onChange={(e) =>
                        onChange({
                          ...choice,
                          check: {
                            ...check,
                            baseChanceBasisPoints: clampInt(Number(e.target.value), 0, 100) * 100,
                          },
                        })
                      }
                    />
                  </label>
                  <p className="text-xs" data-testid="check-range" aria-live="polite">
                    {shown?.chances
                      ? `Weakest Buddy ${percentOfBasisPoints(shown.chances.weakest)} · average ${percentOfBasisPoints(shown.chances.average)} · strongest ${percentOfBasisPoints(shown.chances.strongest)}`
                      : 'Working out the chances…'}
                  </p>
                  <p className={hint}>
                    A stronger Buddy is more likely to succeed. A skill check is never certain: the
                    chance always stays between 5% and 95%. Players see their own chance on the
                    button.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={fineTune}
                    onClick={() => setFineTune(!fineTune)}
                  >
                    {fineTune ? <ChevronDown /> : <ChevronRight />} Advanced
                  </Button>
                  {fineTune && (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      Buddy strength moves the chance by up to
                      <Input
                        type="number"
                        min={0}
                        max={MAX_SP_INFLUENCE_BASIS_POINTS / 100}
                        step={1}
                        className="w-20"
                        aria-label={`Choice ${n} Buddy strength influence`}
                        value={Math.round(influence / 100)}
                        onChange={(e) =>
                          onChange({
                            ...choice,
                            check: {
                              ...check,
                              maxSpModifierBasisPoints:
                                clampInt(
                                  Number(e.target.value),
                                  0,
                                  MAX_SP_INFLUENCE_BASIS_POINTS / 100,
                                ) * 100,
                            },
                          })
                        }
                      />
                      points either way
                    </label>
                  )}
                </div>
              )}
            </fieldset>
            {choiceBranches(choice).map((branch) => (
              <OutcomeEditor
                key={branch}
                branch={branch}
                choice={choice}
                event={event}
                definition={definition}
                reference={reference}
                issues={issues}
                disabled={disabled}
                flags={flags}
                onChange={onChange}
              />
            ))}
          </section>

          {!disabled && (
            <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move choice ${n} up`}
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUp /> Up
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move choice ${n} down`}
                disabled={index === event.choices.length - 1}
                onClick={() => onMove(1)}
              >
                <ArrowDown /> Down
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove choice ${n}`}
                disabled={event.choices.length === 1}
                title={
                  event.choices.length === 1 ? 'An event needs at least one choice.' : undefined
                }
                onClick={onRemove}
              >
                <Trash2 /> Remove
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function EventEditorSheet({
  eventId,
  definition,
  reference,
  issues,
  disabled,
  focus,
  onChange,
  onClose,
  onPlay,
}: {
  eventId: string;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  /** The friendly issues that belong to this event. */
  issues: FriendlyIssue[];
  disabled: boolean;
  /** A choice and field to bring into view; `nonce` changes each time it is asked for. */
  focus?: (EventIssueTarget & { nonce: number }) | undefined;
  onChange: (definition: DungeonDefinition) => void;
  onClose: () => void;
  onPlay: () => void;
}) {
  const event = eventById(definition, eventId);
  const [openChoice, setOpenChoice] = useState<string | null>(
    focus?.choiceId ?? (event?.choices.length === 1 ? event.choices[0]!.id : null),
  );
  const [scenario, setScenario] = useState(EMPTY_SCENARIO);
  const insight = useEventInsight(definition, scenario);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!event) onClose();
  }, [event, onClose]);
  useEffect(() => {
    // Opened without a place in mind: focus is left where the author puts it.
    if (!focus || (!focus.choiceId && !focus.field)) return;
    if (focus.choiceId) setOpenChoice(focus.choiceId);
    // After the choice has opened and the sheet has taken focus for itself.
    const timer = window.setTimeout(() => {
      const root = body.current;
      if (!root) return;
      const scope = focus.choiceId
        ? root.querySelector<HTMLElement>(`[data-choice-id="${focus.choiceId}"]`)
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
    // Asked for again only when the request itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  const reads = useMemo(() => {
    const into = { flags: new Set<string>(), rooms: new Set<string>() };
    const items = new Set<string>();
    for (const choice of event?.choices ?? []) {
      conditionReads(choice.requires, into);
      for (const item of choice.items ?? []) if (item.item) items.add(item.item);
    }
    return { flags: [...into.flags], rooms: [...into.rooms], items: [...items] };
  }, [event]);
  if (!event) return null;

  const setEvent = (change: (event: DungeonEvent) => DungeonEvent) =>
    onChange(updateEvent(definition, eventId, change));
  const setChoice = (next: DungeonEventChoice) =>
    setEvent((e) => ({ ...e, choices: e.choices.map((c) => (c.id === next.id ? next : c)) }));
  const flagTools = (choiceId: string): FlagTools => ({
    list: definition.flags,
    create: (use) => {
      const key = newFlagKey(definition);
      onChange(
        updateEvent(
          {
            ...definition,
            flags: [...definition.flags, { key, scope: 'run', description: 'Something new' }],
          },
          eventId,
          (e) => ({ ...e, choices: e.choices.map((c) => (c.id === choiceId ? use(key) : c)) }),
        ),
      );
    },
    rename: (key, description) =>
      onChange({
        ...definition,
        flags: definition.flags.map((f) =>
          f.key === key && f.scope === 'run' ? { ...f, description } : f,
        ),
      }),
  });
  const itemName = (slug: string) =>
    reference?.items.find((i) => i.slug === slug)?.name ?? 'Unknown item';
  const preview = insight.previews?.find((p) => p.eventId === eventId);
  const uses = eventUsage(definition, eventId);
  const general = issues.filter((i) => !i.eventTarget?.choiceId);
  const open = event.choices.some(isAlwaysAvailable);

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        closeLabel="Close event"
        className="w-full max-w-none sm:w-[46rem] sm:max-w-[92vw]"
      >
        <div
          ref={body}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-4 pb-6"
          data-testid="event-editor"
        >
          <div className="space-y-1 pr-10">
            <SheetTitle className="font-display text-xl break-words text-ink">
              Event: {event.title || 'Untitled'}
            </SheetTitle>
            <SheetDescription className="text-sm text-ink-muted">
              {disabled
                ? 'You can look at this event, try situations and see how it plays. Changing it needs permission to edit dungeons.'
                : 'Changes here are part of your dungeon draft. Save the draft to keep them; players see them after you publish.'}
            </SheetDescription>
            <p className={hint} data-testid="event-usage" title={`Event ID: ${event.id}`}>
              {usageText(uses)}.
            </p>
          </div>
          <IssueList issues={general} label="To do in this event" />

          <section aria-label="Story" className="space-y-3">
            <h3 className={heading}>Story</h3>
            <fieldset disabled={disabled} className="space-y-3">
              <label className={field} data-event-field="title">
                Title
                <Input
                  aria-label="Event title"
                  maxLength={EVENT_LIMITS.title}
                  value={event.title}
                  onChange={(e) => setEvent((ev) => ({ ...ev, title: e.target.value }))}
                />
                <span className={hint}>{count(event.title, EVENT_LIMITS.title)}</span>
              </label>
              <label className={field} data-event-field="text">
                What the player reads
                <textarea
                  aria-label="Event story"
                  className={area}
                  rows={5}
                  maxLength={EVENT_LIMITS.text}
                  value={event.text}
                  onChange={(e) => setEvent((ev) => ({ ...ev, text: e.target.value }))}
                />
                <span className={hint}>{count(event.text, EVENT_LIMITS.text)}</span>
              </label>
            </fieldset>
            <div data-event-field="artwork">
              <DungeonBackgroundField
                label="Event picture"
                hint="Optional. Shown with the event as it is. Without one, players see the room’s background."
                testId="event-artwork"
                category="dungeon_background"
                value={event.artwork}
                disabled={disabled}
                onChange={(ref) => setEvent((ev) => withMember(ev, 'artwork', ref ?? undefined))}
              />
            </div>
          </section>

          <section aria-label="Choices" className="space-y-2" data-event-field="choices">
            <h3 className={heading}>Choices</h3>
            <p className={hint}>
              Each choice is a button. Players pick one, and the event is settled for the rest of
              the run.
            </p>
            {!open && (
              <p role="alert" className="text-sm text-danger" data-testid="no-open-choice">
                Players need one choice they can always pick. Every choice here has a rule or needs
                an item, so someone could be stuck. Remove them from one choice, or add a plain one.
              </p>
            )}
            <ol className="space-y-2">
              {event.choices.map((choice, index) => (
                <ChoiceCard
                  key={choice.id}
                  choice={choice}
                  index={index}
                  event={event}
                  definition={definition}
                  reference={reference}
                  issues={issues.filter((i) => i.eventTarget?.choiceId === choice.id)}
                  shown={preview?.choices.find((c) => c.id === choice.id)}
                  open={openChoice === choice.id}
                  disabled={disabled}
                  flags={flagTools(choice.id)}
                  onToggle={() => setOpenChoice(openChoice === choice.id ? null : choice.id)}
                  onChange={setChoice}
                  onMove={(delta) =>
                    setEvent((ev) => ({ ...ev, choices: moveEntry(ev.choices, index, delta) }))
                  }
                  onRemove={() => {
                    if (!window.confirm(`Remove the choice “${choice.label || 'Untitled'}”?`))
                      return;
                    setEvent((ev) => ({
                      ...ev,
                      choices: ev.choices.filter((c) => c.id !== choice.id),
                    }));
                  }}
                />
              ))}
            </ol>
            {!disabled &&
              (event.choices.length < EVENT_LIMITS.choices ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const added = newChoice(event);
                    setEvent((ev) => ({ ...ev, choices: [...ev.choices, added] }));
                    setOpenChoice(added.id);
                  }}
                >
                  + Add choice
                </Button>
              ) : (
                <p className={hint}>An event has up to {EVENT_LIMITS.choices} choices.</p>
              ))}
          </section>

          <section aria-label="Preview" className="space-y-3">
            <h3 className={heading}>How players see it</h3>
            <EventScenarioControls
              definition={definition}
              scenario={scenario}
              onChange={setScenario}
              flags={reads.flags}
              rooms={reads.rooms}
              items={reads.items}
              strength={event.choices.some((c) => c.check)}
              turnBack={event.choices.some((c) => choiceBranches(c).some((b) => turnsBack(c[b])))}
              itemName={itemName}
            />
            {insight.failed && (
              <p role="alert" className="text-sm text-danger">
                The preview could not be worked out just now. It tries again when you change
                something.
              </p>
            )}
            <EventDiscordPreview
              event={event}
              preview={preview}
              itemName={itemName}
              updating={!insight.current && !insight.failed}
            />
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
