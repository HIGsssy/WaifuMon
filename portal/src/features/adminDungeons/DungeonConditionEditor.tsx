import type { DungeonCondition, DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';

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
  label: string;
  allowEmpty?: boolean;
}) {
  const flagOptions = definition.flags.filter((f) => f.scope === 'run');
  const firstFlag = flagOptions[0]?.key ?? '';
  const initial = (type: string): DungeonCondition | undefined => {
    if (type === 'none') return undefined;
    if (type === 'room_completed') return { type, roomId: definition.rooms[0]?.id ?? '' };
    if (type === 'all' || type === 'any')
      return { type, conditions: [{ type: 'flag', flag: firstFlag, scope: 'run', equals: true }] };
    if (type === 'not')
      return { type, condition: { type: 'flag', flag: firstFlag, scope: 'run', equals: true } };
    return { type: 'flag', flag: firstFlag, scope: 'run', equals: true };
  };
  return (
    <fieldset className="space-y-2 rounded border border-border p-2">
      <legend>{label}</legend>
      <label>
        Condition type{' '}
        <select
          aria-label={`${label} type`}
          value={value?.type ?? 'none'}
          onChange={(e) => onChange(initial(e.target.value))}
        >
          {allowEmpty && <option value="none">Always / no condition</option>}
          <option value="flag">Run flag</option>
          <option value="room_completed">Room completed</option>
          <option value="all">All conditions</option>
          <option value="any">Any condition</option>
          <option value="not">Not</option>
        </select>
      </label>
      {value?.type === 'flag' && (
        <>
          {value.scope === 'player' ? (
            <p role="alert">
              Player flag conditions are unsupported.
              <Button variant="outline" onClick={() => onChange({ ...value, scope: 'run' })}>
                Use run flag condition
              </Button>
            </p>
          ) : (
            <label>
              Flag{' '}
              <select
                aria-label={`${label} flag`}
                value={value.flag}
                onChange={(e) => onChange({ ...value, flag: e.target.value })}
              >
                <option value="">Choose a run flag</option>
                {value.flag && !flagOptions.some((f) => f.key === value.flag) && (
                  <option value={value.flag}>Undeclared: {value.flag}</option>
                )}
                {flagOptions.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.description || f.key}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!flagOptions.some((f) => f.key === value.flag) && (
            <p role="alert">Declare a run flag or choose an existing one.</p>
          )}
          <label>
            Expected value{' '}
            <select
              aria-label={`${label} equals`}
              value={String(value.equals ?? true)}
              onChange={(e) => onChange({ ...value, equals: e.target.value === 'true' })}
            >
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          </label>
        </>
      )}
      {value?.type === 'room_completed' && (
        <label>
          Room{' '}
          <select
            aria-label={`${label} room`}
            value={value.roomId}
            onChange={(e) => onChange({ ...value, roomId: e.target.value })}
          >
            {!definition.rooms.some((r) => r.id === value.roomId) && (
              <option value={value.roomId}>Missing: {value.roomId}</option>
            )}
            {definition.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {(value?.type === 'all' || value?.type === 'any') && (
        <>
          {value.conditions.map((child, index) => (
            <div key={index}>
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
              <Button
                variant="outline"
                onClick={() =>
                  onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) })
                }
              >
                Remove {label} condition {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              onChange({ ...value, conditions: [...value.conditions, initial('flag')!] })
            }
          >
            Add {label} condition
          </Button>
        </>
      )}
      {value?.type === 'not' && (
        <DungeonConditionEditor
          value={value.condition}
          definition={definition}
          label={`${label} negated`}
          allowEmpty={false}
          onChange={(next) => next && onChange({ ...value, condition: next })}
        />
      )}
    </fieldset>
  );
}
