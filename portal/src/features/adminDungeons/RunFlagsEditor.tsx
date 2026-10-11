/**
 * The dungeon-wide list of things a run can remember (run-scoped flags).
 * It lives in the dungeon's Advanced settings: ordinary rooms never need it,
 * and a "Remember something" activity creates entries where they are used.
 */
import type { DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { newFlagKey } from './dungeonText';

export function RunFlagsEditor({
  definition,
  disabled,
  onChange,
}: {
  definition: DungeonDefinition;
  disabled: boolean;
  onChange: (definition: DungeonDefinition) => void;
}) {
  const flags = definition.flags.filter((f) => f.scope === 'run');
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-sm font-medium">Things this dungeon remembers</legend>
      <p className="text-xs text-ink-muted">
        Notes a run keeps until it ends, such as “Lever pulled”. A “Remember something” activity
        sets one, and rules on paths and activities can check it.
      </p>
      {flags.length === 0 && <p className="text-sm text-ink-muted">Nothing yet.</p>}
      {flags.map((flag, index) => (
        <label key={flag.key} className="block text-sm">
          <span className="sr-only">Remembered thing {index + 1}</span>
          <Input
            aria-label={`Remembered thing ${index + 1}`}
            title={`ID: ${flag.key}`}
            maxLength={300}
            value={flag.description ?? ''}
            onChange={(e) =>
              onChange({
                ...definition,
                flags: definition.flags.map((f) =>
                  f.key === flag.key && f.scope === 'run'
                    ? { ...f, description: e.target.value }
                    : f,
                ),
              })
            }
          />
        </label>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange({
            ...definition,
            flags: [
              ...definition.flags,
              { key: newFlagKey(definition), scope: 'run', description: 'Something new' },
            ],
          })
        }
      >
        Add something to remember
      </Button>
      {definition.flags.some((f) => f.scope === 'player') && (
        <p className="text-xs text-ink-muted">
          This dungeon also declares notes kept across runs. They are preserved as they are, but
          cannot be edited or set yet.
        </p>
      )}
    </fieldset>
  );
}
