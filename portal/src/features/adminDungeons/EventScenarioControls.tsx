/**
 * "Try a situation": an imagined run to look at an event or pool through —
 * what has been remembered, which rooms are done, which events were already
 * met, what the player holds and how strong the Buddy is. It is only a
 * question put to the server; nothing here is stored in the dungeon.
 */
import type { DungeonDefinition, DungeonEventScenario } from '@/api/adminDungeons';
import { Input } from '@/components/ui/input';
import { clampInt } from './dungeonEventModel';
import { roomLabel } from './dungeonText';

const toggled = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
/** Weakest, average and strongest Buddy, as the skill check curve defines them. */
const STRENGTHS = [
  { label: 'Weak', sp: 50 },
  { label: 'Average', sp: 200 },
  { label: 'Strong', sp: 350 },
] as const;

export function EventScenarioControls({
  definition,
  scenario,
  onChange,
  flags = [],
  rooms = [],
  events = [],
  items = [],
  strength = false,
  turnBack = false,
  itemName,
}: {
  definition: DungeonDefinition;
  scenario: DungeonEventScenario;
  onChange: (scenario: DungeonEventScenario) => void;
  /** Only what the thing being tried actually reads is offered. */
  flags?: string[];
  rooms?: string[];
  events?: string[];
  items?: string[];
  strength?: boolean;
  turnBack?: boolean;
  itemName?: (slug: string) => string;
}) {
  const nothing =
    !flags.length && !rooms.length && !events.length && !items.length && !strength && !turnBack;
  const check = (
    label: string,
    checked: boolean,
    change: (on: boolean) => void,
    title?: string,
  ) => (
    <label key={label} className="flex items-start gap-2 text-sm" title={title}>
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => change(e.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <fieldset
      className="space-y-3 rounded-md border border-border p-2"
      data-testid="event-scenario"
    >
      <legend className="px-1 text-xs font-medium text-ink-muted">Try a situation</legend>
      {nothing && (
        <p className="text-xs text-ink-muted">
          Nothing here depends on the run, so there is no situation to try.
        </p>
      )}
      {flags.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink-muted">This has already happened</p>
          {flags.map((key) =>
            check(
              definition.flags.find((f) => f.key === key)?.description || 'An unnamed note',
              scenario.flags.includes(key),
              (on) => onChange({ ...scenario, flags: toggled(scenario.flags, key, on) }),
              `ID: ${key}`,
            ),
          )}
        </div>
      )}
      {rooms.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink-muted">These rooms are completed</p>
          {rooms.map((id) =>
            check(
              roomLabel(definition.rooms.find((r) => r.id === id)),
              scenario.completedRooms.includes(id),
              (on) =>
                onChange({
                  ...scenario,
                  completedRooms: toggled(scenario.completedRooms, id, on),
                }),
            ),
          )}
        </div>
      )}
      {events.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink-muted">Already met earlier in the run</p>
          {events.map((id) =>
            check(
              definition.events?.find((e) => e.id === id)?.title ?? 'A missing event',
              scenario.seenEvents.includes(id),
              (on) => onChange({ ...scenario, seenEvents: toggled(scenario.seenEvents, id, on) }),
            ),
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink-muted">The player is holding</p>
          {items.map((slug) => (
            <label key={slug} className="flex items-center gap-2 text-sm" title={slug}>
              <Input
                type="number"
                min={0}
                max={999}
                step={1}
                className="w-20"
                aria-label={`How many ${itemName?.(slug) ?? slug} the player holds`}
                value={scenario.inventory[slug] ?? 0}
                onChange={(e) =>
                  onChange({
                    ...scenario,
                    inventory: {
                      ...scenario.inventory,
                      [slug]: clampInt(Number(e.target.value), 0, 999),
                    },
                  })
                }
              />
              × {itemName?.(slug) ?? slug}
            </label>
          ))}
        </div>
      )}
      {strength && (
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-ink-muted">How strong the Buddy is</span>
          <select
            aria-label="Buddy strength"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink"
            value={scenario.currentSp}
            onChange={(e) => onChange({ ...scenario, currentSp: Number(e.target.value) })}
          >
            {STRENGTHS.map((s) => (
              <option key={s.sp} value={s.sp}>
                {s.label} Buddy
              </option>
            ))}
          </select>
        </label>
      )}
      {turnBack &&
        check(
          'The player arrived from another room (turning back is possible)',
          scenario.canTurnBack,
          (on) => onChange({ ...scenario, canTurnBack: on }),
        )}
    </fieldset>
  );
}
