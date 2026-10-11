/**
 * One thing that happens in a room, as a compact card. Collapsed it is a
 * sentence; opened it asks only for what that kind of activity needs. Rules,
 * button text and custom flow sit behind "Advanced options", which opens by
 * itself when an existing activity already uses any of them.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Trash2, X } from 'lucide-react';
import type {
  ActionDestination,
  CombatWave,
  DungeonAction,
  DungeonArtworkRef,
  DungeonDefinition,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { EnemyAppearance } from './EnemyAppearance';
import { EnemyPicker } from './EnemyPicker';
import { ACTION_OUTCOMES, moveEntry, type ActionType } from './dungeonActionModel';
import {
  activityChips,
  activityOf,
  activitySummary,
  newFlagKey,
  roomNameOf,
  type FriendlyIssue,
} from './dungeonText';

const select = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
const field = 'block space-y-1 text-sm';
const hint = 'text-xs text-ink-muted';

const OUTCOME_LABEL: Record<string, string> = {
  victory: 'After winning',
  defeat: 'After losing',
  claimed: 'After the reward is claimed',
  done: 'Afterwards',
  passed: 'If the player may continue',
  blocked: 'If the player is turned away',
  declined: 'If the player skips it',
  next: 'After succeeding (general rule)',
};
const OUTCOME_DEFAULT: Record<string, string> = {
  defeat: 'the run ends in defeat',
  blocked: 'send the player back the way they came',
};

function destinationKey(value?: ActionDestination) {
  if (!value) return 'default';
  if (value.type === 'action') return `action:${value.actionId}`;
  if (value.type === 'leave') return `leave:${value.connectionId}`;
  if (value.type === 'end_run') return `end_run:${value.outcome}`;
  return value.type;
}
/** Where the room goes after one outcome. Forward only, exactly as the runtime routes. */
function DestinationEditor({
  outcome,
  value,
  room,
  actionIndex,
  definition,
  onChange,
}: {
  outcome: string;
  value?: ActionDestination | undefined;
  room: DungeonRoom;
  actionIndex: number;
  definition: DungeonDefinition;
  onChange: (destination: ActionDestination | undefined) => void;
}) {
  const label = OUTCOME_LABEL[outcome] ?? `After “${outcome}”`;
  const options = [
    {
      value: 'default',
      label: `Usual: ${OUTCOME_DEFAULT[outcome] ?? 'continue with the next activity'}`,
    },
    { value: 'next', label: 'Continue with the next activity' },
    { value: 'room_complete', label: 'Skip the rest of this room' },
    { value: 'retreat', label: 'Send the player back the way they came' },
    { value: 'end_run:completed', label: 'Finish the dungeon' },
    { value: 'end_run:defeated', label: 'End the run in defeat' },
    ...room.actions.slice(actionIndex + 1).map((a, offset) => ({
      value: `action:${a.id}`,
      label: `Skip ahead to activity ${actionIndex + offset + 2}: ${a.label || activityOf(a).title}`,
    })),
    ...definition.connections
      .filter((c) => c.from === room.id)
      .map((c) => ({
        value: `leave:${c.id}`,
        label: `Go through the path to ${roomNameOf(definition, c.to)}${c.label ? ` (${c.label})` : ''}`,
      })),
  ];
  const key = destinationKey(value);
  const invalid = !options.some((o) => o.value === key);
  function change(next: string) {
    if (next === 'default') return onChange(undefined);
    if (next.startsWith('action:')) return onChange({ type: 'action', actionId: next.slice(7) });
    if (next.startsWith('leave:')) return onChange({ type: 'leave', connectionId: next.slice(6) });
    if (next.startsWith('end_run:'))
      return onChange({ type: 'end_run', outcome: next.slice(8) as 'completed' | 'defeated' });
    onChange({ type: next as 'next' | 'room_complete' | 'retreat' });
  }
  return (
    <label className={field}>
      {label}
      <select
        aria-label={label}
        className={select}
        value={key}
        onChange={(e) => change(e.target.value)}
      >
        {invalid && <option value={key}>Something that no longer exists</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {invalid && (
        <span role="alert" className="block text-xs text-danger">
          This used to point at an activity or path that was removed or moved earlier. Choose what
          should happen instead.
        </span>
      )}
    </label>
  );
}

function FightEditor({
  action,
  reference,
  backgrounds,
  onChange,
}: {
  action: DungeonAction;
  reference?: DungeonReferenceData | undefined;
  /** The backgrounds a fight here falls back through, for the appearance preview. */
  backgrounds: Array<DungeonArtworkRef | null | undefined>;
  onChange: (action: DungeonAction) => void;
}) {
  const waves = action.waves ?? [];
  const setWave = (index: number, next: CombatWave) =>
    onChange({ ...action, waves: waves.map((w, i) => (i === index ? next : w)) });
  return (
    <div className="space-y-3">
      {waves.map((wave, w) => {
        const pool = 'pool' in wave.enemy ? wave.enemy.pool : null;
        return (
          <div key={w} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Wave {w + 1}</span>
              {waves.length > 1 && (
                <span className="flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move wave ${w + 1} up`}
                    disabled={w === 0}
                    onClick={() => onChange({ ...action, waves: moveEntry(waves, w, -1) })}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move wave ${w + 1} down`}
                    disabled={w === waves.length - 1}
                    onClick={() => onChange({ ...action, waves: moveEntry(waves, w, 1) })}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove wave ${w + 1}`}
                    onClick={() => onChange({ ...action, waves: waves.filter((_, i) => i !== w) })}
                  >
                    <X />
                  </Button>
                </span>
              )}
            </div>
            {!pool && 'key' in wave.enemy && (
              <>
                <EnemyPicker
                  label={`Wave ${w + 1} enemy`}
                  value={wave.enemy.key}
                  reference={reference}
                  onChange={(key) => setWave(w, { enemy: { key } })}
                />
                {wave.enemy.key && (
                  <EnemyAppearance
                    enemyKey={wave.enemy.key}
                    wave={w + 1}
                    reference={reference}
                    backgrounds={backgrounds}
                  />
                )}
              </>
            )}
            {pool && (
              <div className="space-y-2 rounded-md border border-border p-2">
                <p className={hint}>
                  One of these is picked at random each run. A higher chance number makes an enemy
                  more likely.
                </p>
                {pool.map((entry, p) => (
                  <div key={p} className="flex items-start gap-2">
                    <EnemyPicker
                      label={`Wave ${w + 1} group enemy ${p + 1}`}
                      value={entry.key}
                      reference={reference}
                      onChange={(key) =>
                        setWave(w, {
                          enemy: { pool: pool.map((e, i) => (i === p ? { ...e, key } : e)) },
                        })
                      }
                    />
                    <Input
                      type="number"
                      min={1}
                      max={1000000}
                      step={1}
                      className="w-20"
                      aria-label={`Wave ${w + 1} group chance ${p + 1}`}
                      value={entry.weight}
                      onChange={(e) =>
                        setWave(w, {
                          enemy: {
                            pool: pool.map((x, i) =>
                              i === p ? { ...x, weight: Number(e.target.value) } : x,
                            ),
                          },
                        })
                      }
                    />
                    {pool.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove wave ${w + 1} group enemy ${p + 1}`}
                        onClick={() =>
                          setWave(w, { enemy: { pool: pool.filter((_, i) => i !== p) } })
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Add enemy to wave ${w + 1} group`}
                  onClick={() => setWave(w, { enemy: { pool: [...pool, { key: '', weight: 1 }] } })}
                >
                  Add enemy to group
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange({ ...action, waves: [...waves, { enemy: { key: '' } }] })}
      >
        Add wave
      </Button>
      <p className={hint}>
        Waves are fought in order, one enemy at a time. Your Buddy’s HP carries over from one wave
        to the next.
      </p>
    </div>
  );
}

function Essentials({
  action,
  room,
  definition,
  reference,
  onChange,
  onDefinitionChange,
}: {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  onChange: (action: DungeonAction) => void;
  onDefinitionChange: (definition: DungeonDefinition) => void;
}) {
  const patch = (fields: Partial<DungeonAction>) => onChange({ ...action, ...fields });
  const flags = definition.flags.filter((f) => f.scope === 'run');
  switch (action.type) {
    case 'combat':
    case 'boss':
      return (
        <FightEditor
          action={action}
          reference={reference}
          backgrounds={[room.background, definition.background, definition.artwork]}
          onChange={onChange}
        />
      );
    case 'rest':
      return (
        <label className={field}>
          Restore this much of the Buddy’s maximum HP (%)
          <Input
            aria-label="Restore HP percent"
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={(action.healBasisPoints ?? 3000) / 100}
            onChange={(e) => patch({ healBasisPoints: Math.round(Number(e.target.value) * 100) })}
          />
        </label>
      );
    case 'reward': {
      const reward = action.reward ?? {
        rewardTable: null,
        equipmentRewardTable: null,
        currency: { min: 0, max: 0 },
      };
      const currency = reference?.currencies.find(
        (c) => c.key === definition.settings.progressionCurrency,
      );
      return (
        <div className="space-y-3">
          {(['rewardTable', 'equipmentRewardTable'] as const).map((name) => {
            const label = name === 'rewardTable' ? 'Reward table' : 'Equipment reward table';
            return (
              <label key={name} className={field}>
                {name === 'rewardTable' ? 'Reward table' : 'Extra gear reward table (optional)'}
                <select
                  aria-label={label}
                  className={select}
                  value={reward[name] ?? ''}
                  onChange={(e) => patch({ reward: { ...reward, [name]: e.target.value || null } })}
                >
                  <option value="">None</option>
                  {reward[name] && !reference?.rewardTables.some((t) => t.id === reward[name]) && (
                    <option value={reward[name]!}>Missing table ({reward[name]})</option>
                  )}
                  {reference?.rewardTables.map((t) => (
                    <option key={t.id} value={t.id} disabled={!t.enabled && t.id !== reward[name]}>
                      {t.id}
                      {!t.enabled ? ' (switched off)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {definition.settings.progressionCurrency || reward.currency.max > 0 ? (
            <div className="flex items-end gap-2">
              {(['min', 'max'] as const).map((bound) => (
                <label className={`${field} flex-1`} key={bound}>
                  {bound === 'min' ? 'At least' : 'At most'}
                  <Input
                    aria-label={`Progression currency ${bound}`}
                    type="number"
                    min={0}
                    max={1000000}
                    step={1}
                    value={reward.currency[bound]}
                    onChange={(e) =>
                      patch({
                        reward: {
                          ...reward,
                          currency: { ...reward.currency, [bound]: Number(e.target.value) },
                        },
                      })
                    }
                  />
                </label>
              ))}
              <span className="pb-2 text-sm text-ink-muted">
                {currency?.pluralName ?? definition.settings.progressionCurrency ?? 'currency'}
              </span>
            </div>
          ) : (
            <p className={hint}>
              This dungeon has no progression currency, so treasure here pays from reward tables
              only.
            </p>
          )}
        </div>
      );
    }
    case 'gate':
      return (
        <div className="space-y-3">
          <DungeonConditionEditor
            label="Players can continue only if"
            value={action.requires}
            allowEmpty={false}
            definition={definition}
            onChange={(requires) => requires && patch({ requires })}
          />
          <label className={field}>
            Message when they are turned away
            <Input
              aria-label="Blocked text"
              maxLength={300}
              placeholder="The way is barred."
              value={action.blockedText ?? ''}
              onChange={(e) => patch({ blockedText: e.target.value })}
            />
          </label>
        </div>
      );
    case 'set_flag': {
      const current = flags.find((f) => f.key === action.flag);
      return (
        <div className="space-y-3">
          {action.scope === 'player' && (
            <p role="alert">
              This remembers something across runs, which is not supported yet.{' '}
              <Button variant="outline" onClick={() => patch({ scope: 'run' })}>
                Remember it for this run only
              </Button>
            </p>
          )}
          <div className="flex items-end gap-2">
            <label className={`${field} min-w-0 flex-1`}>
              What to remember
              <select
                aria-label="What to remember"
                className={select}
                value={action.flag ?? ''}
                onChange={(e) => patch({ flag: e.target.value, scope: 'run' })}
              >
                <option value="">Choose…</option>
                {action.flag && !current && (
                  <option value={action.flag}>Missing ({action.flag})</option>
                )}
                {flags.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.description || 'Unnamed note'}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              onClick={() => {
                // Declared and chosen in one edit, so the two can never drift apart.
                const key = newFlagKey(definition);
                onDefinitionChange({
                  ...definition,
                  flags: [...definition.flags, { key, scope: 'run', description: 'Something new' }],
                  rooms: definition.rooms.map((r) =>
                    r.id === room.id
                      ? {
                          ...r,
                          actions: r.actions.map((a) =>
                            a.id === action.id ? { ...a, flag: key, scope: 'run' as const } : a,
                          ),
                        }
                      : r,
                  ),
                });
              }}
            >
              New…
            </Button>
          </div>
          {current && (
            <label className={field}>
              Call it
              <Input
                aria-label="Name of what is remembered"
                maxLength={300}
                value={current.description ?? ''}
                onChange={(e) =>
                  onDefinitionChange({
                    ...definition,
                    flags: definition.flags.map((f) =>
                      f.key === current.key && f.scope === 'run'
                        ? { ...f, description: e.target.value }
                        : f,
                    ),
                  })
                }
              />
            </label>
          )}
          {!current && (
            <p role="alert" className="text-xs text-danger">
              Choose what to remember, or create something new.
            </p>
          )}
          <label className={field}>
            When the player gets here
            <select
              aria-label="Remember or forget"
              className={select}
              value={String(action.value ?? true)}
              onChange={(e) => patch({ value: e.target.value === 'true' })}
            >
              <option value="true">Remember that it happened</option>
              <option value="false">Forget it again</option>
            </select>
          </label>
          <p className={hint}>
            Use this later in a rule, such as a path that opens only after it happened. It is
            forgotten when the run ends.
          </p>
        </div>
      );
    }
    case 'leave': {
      const outgoing = definition.connections.filter((c) => c.from === room.id);
      return (
        <div className="space-y-2">
          <label className={field}>
            Where the player goes
            <select
              aria-label="Leave transition"
              className={select}
              value={action.connectionId ?? ''}
              onChange={(e) => {
                const next = { ...action };
                if (e.target.value) next.connectionId = e.target.value;
                else delete next.connectionId;
                onChange(next);
              }}
            >
              <option value="">
                Nowhere: just finish this room
                {room.kind === 'exit' ? ' (and the dungeon)' : ''}
              </option>
              {action.connectionId && !outgoing.some((c) => c.id === action.connectionId) && (
                <option value={action.connectionId}>A path that no longer exists</option>
              )}
              {outgoing.map((c) => (
                <option key={c.id} value={c.id}>
                  {roomNameOf(definition, c.to)}
                  {c.label ? ` (${c.label})` : ''}
                </option>
              ))}
            </select>
          </label>
          <p className={hint}>
            Players normally choose their own way out once a room is finished. Use this only to send
            them somewhere without asking.
          </p>
        </div>
      );
    }
    default:
      return <p className={hint}>This kind of activity cannot be edited here.</p>;
  }
}

function AdvancedOptions({
  action,
  index,
  room,
  definition,
  onChange,
}: {
  action: DungeonAction;
  index: number;
  room: DungeonRoom;
  definition: DungeonDefinition;
  onChange: (action: DungeonAction) => void;
}) {
  const patch = (fields: Partial<DungeonAction>) => onChange({ ...action, ...fields });
  const unset = (key: string) => {
    const next = { ...action };
    delete next[key];
    onChange(next);
  };
  const fight = action.type === 'combat' || action.type === 'boss';
  const outcomes = [
    ...(ACTION_OUTCOMES[action.type as ActionType] ?? []),
    ...(action.optional ? ['declined'] : []),
  ];
  const waves = action.waves ?? [];
  return (
    <div className="space-y-3">
      <label className={field}>
        Button text players see
        <Input
          aria-label="Button text"
          maxLength={80}
          placeholder={`Usual text for a ${activityOf(action).title.toLowerCase()}`}
          value={action.label ?? ''}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Player can skip this"
          checked={action.optional ?? false}
          onChange={(e) => patch({ optional: e.target.checked })}
        />
        Players can choose to skip this
      </label>
      {fight && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Present as a boss fight"
              checked={action.type === 'boss'}
              onChange={(e) => patch({ type: e.target.checked ? 'boss' : 'combat' })}
            />
            Present this as a boss fight
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Fight remaining waves automatically"
              checked={action.advance === 'auto'}
              onChange={(e) => patch({ advance: e.target.checked ? 'auto' : 'confirm' })}
            />
            Fight all waves in one go (no button press between waves)
          </label>
          {waves.map((wave, w) => (
            <label key={w} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Wave ${w + 1} random enemy group`}
                checked={'pool' in wave.enemy}
                onChange={(e) => {
                  const enemy = wave.enemy;
                  const next: CombatWave = e.target.checked
                    ? { enemy: { pool: [{ key: 'key' in enemy ? enemy.key : '', weight: 1 }] } }
                    : { enemy: { key: 'pool' in enemy ? (enemy.pool[0]?.key ?? '') : enemy.key } };
                  patch({ waves: waves.map((x, i) => (i === w ? next : x)) });
                }}
              />
              Wave {w + 1}: pick a random enemy from a group
            </label>
          ))}
        </>
      )}
      <DungeonConditionEditor
        label="Only happens if"
        value={action.when}
        definition={definition}
        onChange={(when) => (when ? patch({ when }) : unset('when'))}
      />
      <fieldset className="space-y-2 rounded-md border border-border p-2">
        <legend className="px-1 text-xs font-medium text-ink-muted">What happens afterward?</legend>
        {action.type === 'leave' ? (
          <p className={hint}>The player leaves as set above.</p>
        ) : (
          outcomes.map((outcome) => (
            <DestinationEditor
              key={outcome}
              outcome={outcome}
              value={action.outcomes?.[outcome]}
              room={room}
              actionIndex={index}
              definition={definition}
              onChange={(next) => {
                const routes = { ...action.outcomes };
                if (next) routes[outcome] = next;
                else delete routes[outcome];
                patch({ outcomes: routes });
              }}
            />
          ))
        )}
        {action.next &&
          (action.type === 'leave' ? (
            <p role="alert" className="text-sm">
              An older general rule is stored on this activity, but leaving ignores it.{' '}
              <Button variant="outline" size="sm" onClick={() => unset('next')}>
                Remove unused rule
              </Button>
            </p>
          ) : (
            <DestinationEditor
              outcome="next"
              value={action.next}
              room={room}
              actionIndex={index}
              definition={definition}
              onChange={(next) => (next ? patch({ next }) : unset('next'))}
            />
          ))}
        {Object.keys(action.outcomes ?? {})
          .filter((o) => !outcomes.includes(o))
          .map((o) => (
            <p role="alert" key={o} className="text-sm">
              A rule for “{o}” is stored here, but this activity can never end that way.{' '}
              <Button
                variant="outline"
                size="sm"
                aria-label={`Remove ${o} rule`}
                onClick={() => {
                  const routes = { ...action.outcomes };
                  delete routes[o];
                  patch({ outcomes: routes });
                }}
              >
                Remove it
              </Button>
            </p>
          ))}
      </fieldset>
      <p className="font-mono text-[0.7rem] break-all text-ink-subtle">Activity ID: {action.id}</p>
    </div>
  );
}

export function ActivityCard({
  action,
  index,
  room,
  definition,
  reference,
  issues,
  open,
  disabled,
  onToggle,
  onChange,
  onDefinitionChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  action: DungeonAction;
  index: number;
  room: DungeonRoom;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  issues: FriendlyIssue[];
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onChange: (action: DungeonAction) => void;
  onDefinitionChange: (definition: DungeonDefinition) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const meta = activityOf(action);
  const chips = activityChips(action);
  const summary = activitySummary(action, definition, reference);
  // Customised activities show their advanced settings without being asked.
  const [advanced, setAdvanced] = useState(
    Boolean(action.optional || action.when || action.next || action.label) ||
      Object.keys(action.outcomes ?? {}).length > 0,
  );
  const Icon = meta.icon;
  return (
    <li
      className={`rounded-lg border ${issues.some((i) => i.level !== 'review') ? 'border-danger/60' : open ? 'border-accent' : 'border-border'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Activity ${index + 1}: ${meta.title}. ${summary}`}
        className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-surface-raised"
        onClick={onToggle}
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{action.label || meta.title}</span>
          <span className="block text-xs break-words text-ink-muted">{summary}</span>
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
          {issues.map((i, n) => (
            <li key={n} className={i.level === 'review' ? 'text-ink-muted' : 'text-danger'}>
              {i.title} {i.help}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <fieldset disabled={disabled} className="space-y-3 border-t border-border p-2.5">
          <Essentials
            action={action}
            room={room}
            definition={definition}
            reference={reference}
            onChange={onChange}
            onDefinitionChange={onDefinitionChange}
          />
          <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Move activity ${index + 1} up`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp /> Up
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Move activity ${index + 1} down`}
              disabled={index === room.actions.length - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown /> Down
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Duplicate activity ${index + 1}`}
              onClick={onDuplicate}
            >
              <Copy /> Duplicate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove activity ${index + 1}`}
              onClick={onRemove}
            >
              <Trash2 /> Remove
            </Button>
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? <ChevronDown /> : <ChevronRight />} Advanced options
            </Button>
            {advanced && (
              <div className="mt-2">
                <AdvancedOptions
                  action={action}
                  index={index}
                  room={room}
                  definition={definition}
                  onChange={onChange}
                />
              </div>
            )}
          </div>
        </fieldset>
      )}
    </li>
  );
}
