/**
 * An event as Discord will show it: the story, one block per choice saying
 * what it needs and risks, the buttons, and what each result looks like.
 *
 * Which choices are available, hidden or greyed out, and every success
 * chance, are the server's answer for the situation being tried — the same
 * functions a run uses. Only the layout and the fixed wording are repeated
 * here, with the lengths the Discord screen cuts text at.
 */
import type {
  DungeonEvent,
  DungeonEventChoice,
  DungeonEventChoicePreview,
  DungeonEventOutcome,
  DungeonEventPreview,
} from '@/api/adminDungeons';
import { choiceBranches, percentOfBasisPoints, type EventBranch } from './dungeonEventModel';
import { DISCORD_EVENT_LIMITS, choiceNotes, truncate } from './eventPreviewModel';
import { usePreview } from './useDungeonArtworkPreview';
import { LoadedArtwork } from '@/components/media/LoadedArtwork';

const L = DISCORD_EVENT_LIMITS;
const TONE_EMOJI = { good: '✨', neutral: '❔', bad: '⚠️' } as const;

function outcomeLines(
  event: DungeonEvent,
  choice: DungeonEventChoice,
  branch: EventBranch,
  outcome: DungeonEventOutcome,
  shown: DungeonEventChoicePreview | undefined,
  itemName: (slug: string) => string,
): string[] {
  if (outcome.then?.type === 'retreat')
    return [
      outcome.text
        ? truncate(outcome.text, L.outcomeText)
        : `You leave ${truncate(event.title, L.title)} for now.`,
      'The player goes back the way they came. The event is offered again when they return.',
    ];
  const lines: string[] = [];
  if (branch !== 'outcome') {
    const chance = shown?.check
      ? ` — ${percentOfBasisPoints(shown.check.chanceBasisPoints)} chance`
      : '';
    lines.push(`${branch === 'success' ? '✅ Success' : '❌ Failed'}${chance}`);
  }
  if (outcome.text) lines.push(truncate(outcome.text, L.outcomeText));
  for (const item of choice.items ?? [])
    if (item.consume) lines.push(`Used ${item.quantity ?? 1}× ${itemName(item.item)}`);
  for (const effect of outcome.effects ?? []) {
    if (effect.type === 'heal')
      lines.push(
        `HP goes up by ${percentOfBasisPoints(effect.basisPoints)} of the Buddy’s maximum.`,
      );
    if (effect.type === 'damage')
      lines.push(
        `HP goes down by ${percentOfBasisPoints(effect.basisPoints)} of the Buddy’s maximum, never below 1.`,
      );
  }
  if (outcome.rewards) lines.push('The rewards it gives are listed underneath.');
  if (outcome.then?.type === 'room_complete') lines.push('The room is finished.');
  if (outcome.then?.type === 'end_run')
    lines.push(
      outcome.then.outcome === 'completed'
        ? 'The dungeon is completed.'
        : 'The run ends in defeat.',
    );
  return lines.length ? lines : ['Done.'];
}

export function EventDiscordPreview({
  event,
  preview,
  itemName,
  updating,
}: {
  event: DungeonEvent;
  /** The server's reading of the choices for the situation being tried. */
  preview: DungeonEventPreview | undefined;
  itemName: (slug: string) => string;
  updating: boolean;
}) {
  const picture = usePreview(event.artwork);
  const byId = new Map(preview?.choices.map((c) => [c.id, c]));
  const shown = (preview?.choices ?? []).filter((c) => !c.hidden).slice(0, L.choices);
  const hidden = (preview?.choices ?? []).filter((c) => c.hidden);
  return (
    <div className="space-y-3" data-testid="event-discord-preview" aria-busy={updating}>
      <div className="rounded-md border-l-4 border-accent bg-surface-sunken p-3 text-sm break-words">
        <p className="font-semibold" data-testid="preview-title">
          ❔ {truncate(event.title || 'Untitled event', L.title)}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-ink-muted" data-testid="preview-text">
          {truncate(event.text, L.text)}
        </p>
        {!preview && (
          <p className="mt-2 text-xs text-ink-subtle" role="status">
            {updating
              ? 'Working out the choices…'
              : 'The choices appear here once every blank field above is filled in.'}
          </p>
        )}
        <ul className="mt-2 space-y-2">
          {shown.map((choice) => (
            <li key={choice.id} data-testid="preview-choice" data-available={choice.available}>
              <p className="font-medium">
                {choice.available ? '▸' : '🚫'} {truncate(choice.label, L.choiceLabel)}
              </p>
              {choiceNotes(choice, itemName).map((note, n) => (
                <p
                  key={n}
                  className={`text-xs ${note.strong ? 'font-semibold text-ink' : note.muted ? 'text-ink-subtle italic' : 'text-ink-muted'}`}
                  {...(note.strong ? { 'data-testid': 'preview-consumed' } : {})}
                >
                  {note.text}
                </p>
              ))}
            </li>
          ))}
        </ul>
        {event.artwork && (
          <div className="mt-3 flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-surface">
            {picture.state === 'shown' ? (
              <LoadedArtwork
                url={picture.url}
                alt={`Event picture for ${event.title}`}
                className="h-full w-full object-cover"
                testId="preview-picture"
              />
            ) : (
              <span className="px-3 text-center text-xs text-ink-muted">
                {picture.state === 'missing'
                  ? 'The event’s picture can’t be found on this server, so players see the room’s background.'
                  : 'Loading the event’s picture…'}
              </span>
            )}
          </div>
        )}
        {!event.artwork && (
          <p className="mt-2 text-xs text-ink-subtle">
            No event picture: players see the room’s background instead.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Buttons players see">
        {shown.map((choice) => (
          <span
            key={choice.id}
            data-testid="preview-button"
            aria-disabled={!choice.available}
            className={`max-w-full truncate rounded px-3 py-1.5 text-xs font-medium ${
              !choice.available
                ? 'bg-surface-raised text-ink-subtle line-through'
                : choice.walksAway
                  ? 'bg-surface-raised text-ink'
                  : 'bg-accent text-accent-ink'
            }`}
          >
            {truncate(
              choice.check
                ? `${truncate(choice.label, L.choiceLabel)} (${percentOfBasisPoints(choice.check.chanceBasisPoints)})`
                : choice.label,
              L.button,
            )}
          </span>
        ))}
      </div>
      {hidden.length > 0 && (
        <p className="text-xs text-ink-muted" data-testid="preview-hidden">
          Hidden from this player:{' '}
          {hidden.map((c) => `“${truncate(c.label, L.choiceLabel)}”`).join(', ')}. It appears only
          once they can pick it.
        </p>
      )}
      <details className="rounded-md border border-border p-2">
        <summary className="cursor-pointer text-sm font-medium">What each choice leads to</summary>
        <ul className="mt-2 space-y-2" data-testid="preview-outcomes">
          {event.choices.flatMap((choice) =>
            choiceBranches(choice).map((branch) => {
              const outcome = choice[branch] ?? {};
              return (
                <li key={`${choice.id}:${branch}`} className="text-xs break-words">
                  <p className="font-medium">
                    {TONE_EMOJI[outcome.tone ?? 'neutral']} {truncate(event.title, L.title)} —{' '}
                    {truncate(choice.label, L.choiceLabel)}
                  </p>
                  {outcomeLines(event, choice, branch, outcome, byId.get(choice.id), itemName).map(
                    (line, n) => (
                      <p key={n} className="whitespace-pre-wrap text-ink-muted">
                        {line}
                      </p>
                    ),
                  )}
                </li>
              );
            }),
          )}
        </ul>
      </details>
    </div>
  );
}
