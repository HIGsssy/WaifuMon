/**
 * A rule in plain words — "Vault is completed", "Lever pulled has happened" —
 * over the existing condition schema. It reads and writes the same nested
 * `flag` / `room_completed` / `all` / `any` / `not` data and never reshapes
 * what it was given.
 */
import type { DungeonCondition, DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { roomLabel } from './dungeonText';

const select = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';

export function DungeonConditionEditor({
  value,
  definition,
  onChange,
  label,
  allowEmpty = true,
}: {
  value?: DungeonCondition | undefined;
  definition: DungeonDefinition;
  onChange: (value: DungeonCondition | undefined) => void;
  /** Reads as the start of a sentence, e.g. "This path opens when". */
  label: string;
  allowEmpty?: boolean;
}) {
  const flagOptions = definition.flags.filter((f) => f.scope === 'run');
  const firstFlag = flagOptions[0]?.key ?? '';
  const firstRoom = definition.rooms[0]?.id ?? '';
  // A new rule starts from something that exists, so it is valid as created.
  const simple = (): DungeonCondition =>
    firstFlag
      ? { type: 'flag', flag: firstFlag, scope: 'run', equals: true }
      : { type: 'room_completed', roomId: firstRoom };
  const initial = (type: string): DungeonCondition | undefined => {
    if (type === 'none') return undefined;
    if (type === 'room_completed') return { type, roomId: firstRoom };
    if (type === 'all' || type === 'any') return { type, conditions: [simple()] };
    if (type === 'not') return { type, condition: simple() };
    return { type: 'flag', flag: firstFlag, scope: 'run', equals: true };
  };
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-2">
      <legend className="px-1 text-xs font-medium text-ink-muted">{label}</legend>
      <select
        aria-label={`${label} type`}
        className={`${select} w-full`}
        value={value?.type ?? 'none'}
        onChange={(e) => onChange(initial(e.target.value))}
      >
        {allowEmpty && <option value="none">Always</option>}
        <option value="room_completed">A room is completed</option>
        <option value="flag" disabled={!firstFlag && value?.type !== 'flag'}>
          Something was remembered
        </option>
        <option value="all">All of these are true</option>
        <option value="any">Any of these is true</option>
        <option value="not">This is not true</option>
      </select>
      {!firstFlag && (!value || value.type !== 'flag') && (
        <p className="text-xs text-ink-subtle">
          To make a rule about something that happened, first add a “Remember something” activity to
          a room.
        </p>
      )}
      {value?.type === 'flag' && (
        <>
          {value.scope === 'player' ? (
            <p role="alert">
              This rule checks something remembered across runs, which is not supported yet.{' '}
              <Button variant="outline" onClick={() => onChange({ ...value, scope: 'run' })}>
                Check it within this run instead
              </Button>
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`${label} flag`}
                className={`${select} min-w-0 flex-1`}
                value={value.flag}
                onChange={(e) => onChange({ ...value, flag: e.target.value })}
              >
                <option value="">Choose what was remembered…</option>
                {value.flag && !flagOptions.some((f) => f.key === value.flag) && (
                  <option value={value.flag}>Missing ({value.flag})</option>
                )}
                {flagOptions.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.description || 'Unnamed note'}
                  </option>
                ))}
              </select>
              <select
                aria-label={`${label} equals`}
                className={select}
                value={String(value.equals ?? true)}
                onChange={(e) => onChange({ ...value, equals: e.target.value === 'true' })}
              >
                <option value="true">has happened</option>
                <option value="false">has not happened</option>
              </select>
            </div>
          )}
          {value.scope !== 'player' && !flagOptions.some((f) => f.key === value.flag) && (
            <p role="alert" className="text-xs text-danger">
              Choose something this dungeon remembers.
            </p>
          )}
        </>
      )}
      {value?.type === 'room_completed' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`${label} room`}
            className={`${select} min-w-0 flex-1`}
            value={value.roomId}
            onChange={(e) => onChange({ ...value, roomId: e.target.value })}
          >
            {!definition.rooms.some((r) => r.id === value.roomId) && (
              <option value={value.roomId}>Missing room</option>
            )}
            {definition.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {roomLabel(r)}
              </option>
            ))}
          </select>
          <span className="text-sm">is completed</span>
        </div>
      )}
      {(value?.type === 'all' || value?.type === 'any') && (
        <>
          {value.conditions.map((child, index) => (
            <div key={index} className="space-y-1">
              <DungeonConditionEditor
                value={child}
                definition={definition}
                label={`${label} ${index + 1}`}
                allowEmpty={false}
                onChange={(next) =>
                  next &&
                  onChange({
                    ...value,
                    conditions: value.conditions.map((c, i) => (i === index ? next : c)),
                  })
                }
              />
              {value.conditions.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label} ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      conditions: value.conditions.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove this rule
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            aria-label={`Add to ${label}`}
            onClick={() => onChange({ ...value, conditions: [...value.conditions, simple()] })}
          >
            Add another rule
          </Button>
        </>
      )}
      {value?.type === 'not' && (
        <DungeonConditionEditor
          value={value.condition}
          definition={definition}
          label={`${label} (not)`}
          allowEmpty={false}
          onChange={(next) => next && onChange({ ...value, condition: next })}
        />
      )}
    </fieldset>
  );
}
