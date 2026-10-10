import type {
  ActionDestination,
  CombatWave,
  DungeonAction,
  DungeonConnection,
  DungeonDefinition,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import { ACTION_OUTCOMES, moveEntry, type ActionType } from './dungeonActionModel';

function destinationKey(value?: ActionDestination) {
  if (!value) return 'default';
  if (value.type === 'action') return `action:${value.actionId}`;
  if (value.type === 'leave') return `leave:${value.connectionId}`;
  if (value.type === 'end_run') return `end_run:${value.outcome}`;
  return value.type;
}
export function DestinationEditor({
  label,
  value,
  room,
  actionIndex,
  connections,
  definition,
  onChange,
}: {
  label: string;
  value?: ActionDestination | undefined;
  room: DungeonRoom;
  actionIndex: number;
  connections: DungeonConnection[];
  definition: DungeonDefinition;
  onChange: (destination: ActionDestination | undefined) => void;
}) {
  const options = [
    { value: 'default', label: 'Use default behaviour' },
    { value: 'next', label: 'Next action in sequence' },
    { value: 'room_complete', label: 'Complete room now' },
    { value: 'retreat', label: 'Retreat (resume on return)' },
    { value: 'end_run:completed', label: 'Complete dungeon' },
    { value: 'end_run:defeated', label: 'End dungeon as defeated' },
    ...room.actions
      .slice(actionIndex + 1)
      .map((a) => ({ value: `action:${a.id}`, label: `Jump to ${a.label || a.type} (${a.id})` })),
    ...connections.map((c) => ({
      value: `leave:${c.id}`,
      label: `Leave via ${connectionLabel(c, definition)}`,
    })),
  ];
  const key = destinationKey(value);
  const invalid = !options.some((o) => o.value === key);
  function change(key: string) {
    if (key === 'default') return onChange(undefined);
    if (key.startsWith('action:')) return onChange({ type: 'action', actionId: key.slice(7) });
    if (key.startsWith('leave:')) return onChange({ type: 'leave', connectionId: key.slice(6) });
    if (key.startsWith('end_run:'))
      return onChange({ type: 'end_run', outcome: key.slice(8) as 'completed' | 'defeated' });
    onChange({ type: key as 'next' | 'room_complete' | 'retreat' });
  }
  return (
    <div>
      <label>
        {label}{' '}
        <select aria-label={label} value={key} onChange={(e) => change(e.target.value)}>
          {invalid && <option value={key}>Invalid destination: {key}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {invalid && (
        <p role="alert">
          This reference is missing or is no longer a valid forward destination. Choose a
          destination to repair it.
        </p>
      )}
    </div>
  );
}
function connectionLabel(connection: DungeonConnection, definition: DungeonDefinition) {
  return `${connection.label || connection.id} → ${definition.rooms.find((r) => r.id === connection.to)?.name || connection.to}`;
}
function EnemySelect({
  value,
  onChange,
  label,
  reference,
}: {
  value: string;
  onChange: (key: string) => void;
  label: string;
  reference?: DungeonReferenceData | undefined;
}) {
  const enemies = reference?.enemies ?? [];
  return (
    <label>
      {label}{' '}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose enemy</option>
        {value && !enemies.some((e) => e.key === value) && (
          <option value={value}>Missing: {value}</option>
        )}
        {enemies.map((e) => (
          <option key={e.key} value={e.key} disabled={!e.enabled}>
            {e.name} ({e.key}){!e.enabled ? ' · Disabled' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
export function DungeonActionEditor({
  action,
  room,
  definition,
  reference,
  onChange,
}: {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  onChange: (action: DungeonAction) => void;
}) {
  const patch = (fields: Partial<DungeonAction>) => onChange({ ...action, ...fields });
  const unset = (key: string) => {
    const next = { ...action };
    delete next[key];
    onChange(next);
  };
  const outgoing = definition.connections.filter((c) => c.from === room.id);
  const index = room.actions.findIndex((a) => a.id === action.id);
  const outcomes = [
    ...(ACTION_OUTCOMES[action.type as ActionType] ?? []),
    ...(action.optional ? ['declined'] : []),
  ];
  const waves = action.waves ?? [];
  const updateWave = (index: number, next: CombatWave) =>
    patch({ waves: waves.map((w, i) => (i === index ? next : w)) });
  const flags = definition.flags.filter((f) => f.scope === 'run');
  return (
    <div className="space-y-3">
      <h4>Action configuration: {action.label || action.type}</h4>
      <label className="block">
        Action label
        <Input
          aria-label="Action label"
          maxLength={80}
          value={action.label ?? ''}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <label className="block">
        <input
          type="checkbox"
          aria-label="Optional action"
          checked={action.optional ?? false}
          onChange={(e) => patch({ optional: e.target.checked })}
        />{' '}
        Optional (can be declined)
      </label>
      <DungeonConditionEditor
        label="Run action when"
        value={action.when}
        definition={definition}
        onChange={(when) => (when ? patch({ when }) : unset('when'))}
      />
      {(action.type === 'combat' || action.type === 'boss') && (
        <>
          <label>
            Combat action type{' '}
            <select
              aria-label="Combat action type"
              value={action.type}
              onChange={(e) => patch({ type: e.target.value })}
            >
              <option value="combat">Combat</option>
              <option value="boss">Boss</option>
            </select>
          </label>
          <label>
            Wave advancement{' '}
            <select
              aria-label="Wave advancement"
              value={action.advance ?? 'confirm'}
              onChange={(e) => patch({ advance: e.target.value as 'auto' | 'confirm' })}
            >
              <option value="confirm">Confirm each wave</option>
              <option value="auto">Automatic remaining waves</option>
            </select>
          </label>
          {waves.map((wave, waveIndex) => (
            <fieldset className="space-y-2 rounded border border-border p-3" key={waveIndex}>
              <legend>Wave {waveIndex + 1}</legend>
              <label>
                Enemy selection{' '}
                <select
                  aria-label={`Wave ${waveIndex + 1} enemy selection`}
                  value={'key' in wave.enemy ? 'fixed' : 'pool'}
                  onChange={(e) =>
                    updateWave(waveIndex, {
                      enemy:
                        e.target.value === 'fixed'
                          ? {
                              key:
                                'key' in wave.enemy
                                  ? wave.enemy.key
                                  : (wave.enemy.pool[0]?.key ?? ''),
                            }
                          : {
                              pool: [{ key: 'key' in wave.enemy ? wave.enemy.key : '', weight: 1 }],
                            },
                    })
                  }
                >
                  <option value="fixed">Single enemy</option>
                  <option value="pool">Weighted pool (one opponent)</option>
                </select>
              </label>
              {'key' in wave.enemy ? (
                <EnemySelect
                  label={`Wave ${waveIndex + 1} enemy`}
                  value={wave.enemy.key}
                  reference={reference}
                  onChange={(key) => updateWave(waveIndex, { enemy: { key } })}
                />
              ) : (
                <>
                  {wave.enemy.pool.map((entry, poolIndex) => (
                    <div key={poolIndex} className="space-y-1">
                      <EnemySelect
                        label={`Wave ${waveIndex + 1} pool enemy ${poolIndex + 1}`}
                        value={entry.key}
                        reference={reference}
                        onChange={(key) => {
                          if ('pool' in wave.enemy)
                            updateWave(waveIndex, {
                              enemy: {
                                pool: wave.enemy.pool.map((e, i) =>
                                  i === poolIndex ? { ...e, key } : e,
                                ),
                              },
                            });
                        }}
                      />
                      <label>
                        Weight
                        <Input
                          type="number"
                          min={1}
                          max={1000000}
                          step={1}
                          aria-label={`Wave ${waveIndex + 1} pool weight ${poolIndex + 1}`}
                          value={entry.weight}
                          onChange={(e) => {
                            if ('pool' in wave.enemy)
                              updateWave(waveIndex, {
                                enemy: {
                                  pool: wave.enemy.pool.map((p, i) =>
                                    i === poolIndex ? { ...p, weight: Number(e.target.value) } : p,
                                  ),
                                },
                              });
                          }}
                        />
                      </label>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if ('pool' in wave.enemy)
                            updateWave(waveIndex, {
                              enemy: { pool: wave.enemy.pool.filter((_, i) => i !== poolIndex) },
                            });
                        }}
                      >
                        Remove wave {waveIndex + 1} pool enemy {poolIndex + 1}
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => {
                      if ('pool' in wave.enemy)
                        updateWave(waveIndex, {
                          enemy: {
                            pool: [
                              ...wave.enemy.pool,
                              {
                                key: reference?.enemies.find((e) => e.enabled)?.key ?? '',
                                weight: 1,
                              },
                            ],
                          },
                        });
                    }}
                  >
                    Add wave {waveIndex + 1} pool enemy
                  </Button>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={waveIndex === 0}
                  onClick={() => patch({ waves: moveEntry(waves, waveIndex, -1) })}
                >
                  Move wave {waveIndex + 1} up
                </Button>
                <Button
                  variant="outline"
                  disabled={waveIndex === waves.length - 1}
                  onClick={() => patch({ waves: moveEntry(waves, waveIndex, 1) })}
                >
                  Move wave {waveIndex + 1} down
                </Button>
                <Button
                  variant="outline"
                  onClick={() => patch({ waves: waves.filter((_, i) => i !== waveIndex) })}
                >
                  Remove wave {waveIndex + 1}
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              patch({
                waves: [
                  ...waves,
                  { enemy: { key: reference?.enemies.find((e) => e.enabled)?.key ?? '' } },
                ],
              })
            }
          >
            Add combat wave
          </Button>
          <p className="text-xs text-ink-muted">
            Waves fight one opponent at a time. HP carries between waves and combat actions.
          </p>
        </>
      )}
      {action.type === 'reward' &&
        (() => {
          const reward = action.reward ?? {
            rewardTable: null,
            equipmentRewardTable: null,
            currency: { min: 0, max: 0 },
          };
          return (
            <fieldset className="space-y-2">
              <legend>Reward</legend>
              {(['rewardTable', 'equipmentRewardTable'] as const).map((field) => (
                <label key={field} className="block">
                  {field === 'rewardTable' ? 'Reward table' : 'Equipment reward table'}{' '}
                  <select
                    aria-label={field === 'rewardTable' ? 'Reward table' : 'Equipment reward table'}
                    value={reward[field] ?? ''}
                    onChange={(e) =>
                      patch({ reward: { ...reward, [field]: e.target.value || null } })
                    }
                  >
                    <option value="">None</option>
                    {reward[field] &&
                      !reference?.rewardTables.some((t) => t.id === reward[field]) && (
                        <option value={reward[field]!}>Missing: {reward[field]}</option>
                      )}
                    {reference?.rewardTables.map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.enabled}>
                        {t.id}
                        {!t.enabled ? ' · Disabled' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {(['min', 'max'] as const).map((field) => (
                <label className="block" key={field}>
                  Progression currency {field}
                  <Input
                    aria-label={`Progression currency ${field}`}
                    type="number"
                    min={0}
                    max={1000000}
                    step={1}
                    value={reward.currency[field]}
                    onChange={(e) =>
                      patch({
                        reward: {
                          ...reward,
                          currency: { ...reward.currency, [field]: Number(e.target.value) },
                        },
                      })
                    }
                  />
                </label>
              ))}
              <p>
                Progression currency: {definition.settings.progressionCurrency ?? 'None configured'}
                .
              </p>
            </fieldset>
          );
        })()}
      {action.type === 'rest' && (
        <label className="block">
          Restore percent of maximum HP
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
      )}
      {action.type === 'gate' && (
        <>
          <DungeonConditionEditor
            label="Gate requires"
            value={action.requires}
            allowEmpty={false}
            definition={definition}
            onChange={(requires) => requires && patch({ requires })}
          />
          <label className="block">
            Blocked text
            <Input
              aria-label="Blocked text"
              maxLength={300}
              value={action.blockedText ?? ''}
              onChange={(e) => patch({ blockedText: e.target.value })}
            />
          </label>
        </>
      )}
      {action.type === 'set_flag' && (
        <>
          {action.scope === 'player' && (
            <p role="alert">
              Player-scoped flag writes are unsupported.{' '}
              <Button variant="outline" onClick={() => patch({ scope: 'run' })}>
                Use run scope
              </Button>
            </p>
          )}
          <label>
            Set run flag{' '}
            <select
              aria-label="Set run flag"
              value={action.flag ?? ''}
              onChange={(e) => patch({ flag: e.target.value, scope: 'run' })}
            >
              <option value="">Choose flag</option>
              {action.flag && !flags.some((f) => f.key === action.flag) && (
                <option value={action.flag}>Undeclared: {action.flag}</option>
              )}
              {flags.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.description || f.key}
                </option>
              ))}
            </select>
          </label>
          {!flags.some((f) => f.key === action.flag) && (
            <p role="alert">Declare a run flag or choose an existing one.</p>
          )}
          <label>
            Flag value{' '}
            <select
              aria-label="Flag value"
              value={String(action.value ?? true)}
              onChange={(e) => patch({ value: e.target.value === 'true' })}
            >
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          </label>
        </>
      )}
      {action.type === 'leave' && (
        <>
          <label>
            Leave transition{' '}
            <select
              aria-label="Leave transition"
              value={action.connectionId ?? ''}
              onChange={(e) =>
                e.target.value ? patch({ connectionId: e.target.value }) : unset('connectionId')
              }
            >
              <option value="">Complete this room (exit rooms complete dungeon)</option>
              {action.connectionId && !outgoing.some((c) => c.id === action.connectionId) && (
                <option value={action.connectionId}>
                  Invalid connection: {action.connectionId}
                </option>
              )}
              {outgoing.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionLabel(c, definition)}
                </option>
              ))}
            </select>
          </label>
          <p>
            For immediate dungeon completion in any room, route another action to Complete dungeon.
          </p>
          {action.next && (
            <p role="alert">
              Leave ignores the shared next field.{' '}
              <Button variant="outline" onClick={() => unset('next')}>
                Remove unused next route
              </Button>
            </p>
          )}
        </>
      )}
      <fieldset className="space-y-2">
        <legend>Outcome routing</legend>
        <p className="text-xs text-ink-muted">
          Outcome overrides take precedence. The shared success route applies only to successful
          actions. Defeat ends the run and blocked gates retreat unless overridden.
        </p>
        {action.type !== 'leave' && (
          <DestinationEditor
            label="Success default route"
            value={action.next}
            room={room}
            actionIndex={index}
            connections={outgoing}
            definition={definition}
            onChange={(next) => (next ? patch({ next }) : unset('next'))}
          />
        )}
        {outcomes.map((outcome) => (
          <DestinationEditor
            key={outcome}
            label={`${outcome} route`}
            value={action.outcomes?.[outcome]}
            room={room}
            actionIndex={index}
            connections={outgoing}
            definition={definition}
            onChange={(next) => {
              const routes = { ...action.outcomes };
              if (next) routes[outcome] = next;
              else delete routes[outcome];
              patch({ outcomes: routes });
            }}
          />
        ))}
        {Object.keys(action.outcomes ?? {})
          .filter((o) => !outcomes.includes(o))
          .map((o) => (
            <p role="alert" key={o}>
              Unsupported outcome: {o}.{' '}
              <Button
                variant="outline"
                onClick={() => {
                  const routes = { ...action.outcomes };
                  delete routes[o];
                  patch({ outcomes: routes });
                }}
              >
                Remove {o} route
              </Button>
            </p>
          ))}
      </fieldset>
    </div>
  );
}
