/**
 * An event activity in a room: which event or random pool it presents, and a
 * reading of that event as it will play.
 *
 * The only thing edited here is what the activity points at. The event or
 * pool itself is edited in its side sheet (`EventEditorSheet`,
 * `EventPoolSheet`); the summary below only reads it, so opening, closing or
 * scrolling this card cannot change one.
 */
import type {
  DungeonAction,
  DungeonDefinition,
  DungeonEvent,
  DungeonEventChoice,
  DungeonEventOutcome,
  DungeonReferenceData,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { EventSourcePicker } from './EventSourcePicker';
import { conditionText, eventSourceOf, flagNameOf } from './dungeonText';

const percent = (basisPoints: number) => `${Number((basisPoints / 100).toFixed(2))}%`;

function outcomeNotes(outcome: DungeonEventOutcome, definition: DungeonDefinition): string[] {
  const notes: string[] = [];
  for (const effect of outcome.effects ?? []) {
    if (effect.type === 'set_flag')
      notes.push(
        `${effect.value ? 'Remembers' : 'Forgets'} “${flagNameOf(definition, effect.flag)}”`,
      );
    else
      notes.push(
        `${effect.type === 'heal' ? 'Restores' : 'Costs'} ${percent(effect.basisPoints)} HP`,
      );
  }
  if (outcome.rewards) notes.push('Gives rewards');
  switch (outcome.then?.type) {
    case 'retreat':
      notes.push('The player steps back; the event stays open');
      break;
    case 'room_complete':
      notes.push('Finishes the room');
      break;
    case 'end_run':
      notes.push(
        outcome.then.outcome === 'completed'
          ? 'Ends the run as completed'
          : 'Ends the run as defeated',
      );
      break;
    default:
      break;
  }
  return notes;
}

function Outcome({
  title,
  outcome,
  definition,
}: {
  title: string;
  outcome: DungeonEventOutcome | undefined;
  definition: DungeonDefinition;
}) {
  if (!outcome) return null;
  const notes = outcomeNotes(outcome, definition);
  return (
    <div className="text-xs">
      <span className="font-medium">{title}:</span>{' '}
      <span className="text-ink-muted">{outcome.text || 'No result text.'}</span>
      {notes.length > 0 && <span className="text-ink-muted"> ({notes.join('; ')})</span>}
    </div>
  );
}

function Choice({
  choice,
  definition,
  itemName,
}: {
  choice: DungeonEventChoice;
  definition: DungeonDefinition;
  itemName: (slug: string) => string;
}) {
  return (
    <li className="space-y-1 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-1 text-sm font-medium">
        {choice.label}
        {choice.check && (
          <Badge variant="outline">
            Skill check, {percent(choice.check.baseChanceBasisPoints)} for an average Buddy
          </Badge>
        )}
        {choice.hideWhenUnavailable && <Badge variant="outline">Hidden when unavailable</Badge>}
      </div>
      {choice.description && <p className="text-xs text-ink-muted">{choice.description}</p>}
      {choice.requires && (
        <p className="text-xs text-ink-muted">
          Only when {conditionText(choice.requires, definition)}
        </p>
      )}
      {(choice.items ?? []).map((item) => (
        <p key={item.item} className="text-xs text-ink-muted" title={`Item: ${item.item}`}>
          Needs {item.quantity ?? 1}× {itemName(item.item)}
          {item.consume ? ', used up when chosen' : ''}
        </p>
      ))}
      <Outcome title="Result" outcome={choice.outcome} definition={definition} />
      <Outcome title="On success" outcome={choice.success} definition={definition} />
      <Outcome title="On failure" outcome={choice.failure} definition={definition} />
    </li>
  );
}

function EventDetails({
  event,
  definition,
  itemName,
}: {
  event: DungeonEvent;
  definition: DungeonDefinition;
  itemName: (slug: string) => string;
}) {
  return (
    <div className="space-y-2" data-testid={`event-readonly-${event.id}`}>
      <p className="text-sm font-medium">{event.title}</p>
      <p className="text-xs whitespace-pre-wrap text-ink-muted">{event.text}</p>
      {event.artwork && <p className="text-xs text-ink-muted">Has its own picture.</p>}
      <ul className="space-y-2">
        {event.choices.map((choice) => (
          <Choice key={choice.id} choice={choice} definition={definition} itemName={itemName} />
        ))}
      </ul>
    </div>
  );
}

export function EventActivity({
  action,
  definition,
  reference,
  disabled,
  onPick,
}: {
  action: DungeonAction;
  definition: DungeonDefinition;
  reference?: DungeonReferenceData | undefined;
  disabled: boolean;
  /** The activity now presents `action.source`; `definition` holds anything created for it. */
  onPick: (action: DungeonAction, definition: DungeonDefinition) => void;
}) {
  const source = eventSourceOf(action, definition);
  // An unknown item is still named, by its key, so a reader can tell which it was.
  const itemName = (slug: string) => reference?.items.find((i) => i.slug === slug)?.name ?? slug;
  return (
    <div className="space-y-3" data-testid="event-activity">
      <EventSourcePicker
        label="This activity shows"
        value={action.source?.kind === 'species' ? undefined : action.source}
        definition={definition}
        disabled={disabled}
        allowNone={false}
        onPick={(next, nextDefinition) => onPick({ ...action, source: next }, nextDefinition)}
      />
      {source.kind === 'missing' && (
        <p className="text-sm text-danger" role="alert">
          This activity points at {source.what} that is not in this dungeon. Choose another above.
        </p>
      )}
      {source.kind === 'event' && (
        <EventDetails event={source.event} definition={definition} itemName={itemName} />
      )}
      {source.kind === 'pool' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Random: {source.pool.name}</p>
          <p className="text-xs text-ink-muted">
            One of these is picked when the player arrives. Chances shown are with every entry in
            the draw.
          </p>
          <ul className="space-y-1 text-xs">
            {source.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-1">
                <span className="font-medium">{entry.label}</span>
                <span className="text-ink-muted">{percent(entry.shareBasisPoints)}</span>
                {entry.conditional && <Badge variant="outline">Conditional</Badge>}
                {entry.oncePerRun && <Badge variant="outline">Once per run</Badge>}
              </li>
            ))}
          </ul>
          {source.events.map((event) => (
            <details key={event.id} className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-sm">{event.title}</summary>
              <div className="mt-2">
                <EventDetails event={event} definition={definition} itemName={itemName} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
