/**
 * The Text Input Puzzle's settings. Two halves, kept visibly apart: what
 * players read (title, prompt and the three result messages), and the
 * accepted answers, which only authors ever see. Where the room goes after a
 * solve or after the last attempt is the usual "What happens afterward?"
 * under Advanced options.
 */
import { Lock, Plus, X } from 'lucide-react';
import type { DungeonAction, DungeonDefinition, DungeonRoom } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { newFlagKey } from './dungeonText';

const select = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink';
const field = 'block space-y-1 text-sm';
const hint = 'text-xs text-ink-muted';

/** As the server allows. */
const MAX_ANSWERS = 20;
const MAX_ANSWER_LENGTH = 100;
const MAX_ATTEMPTS = 100;

export function PuzzleActivity({
  action,
  room,
  definition,
  onChange,
  onDefinitionChange,
}: {
  action: DungeonAction;
  room: DungeonRoom;
  definition: DungeonDefinition;
  onChange: (action: DungeonAction) => void;
  onDefinitionChange: (definition: DungeonDefinition) => void;
}) {
  const patch = (fields: Partial<DungeonAction>) => onChange({ ...action, ...fields });
  const answers = action.answers ?? [];
  const flags = definition.flags.filter((f) => f.scope === 'run');
  const remembered = flags.find((f) => f.key === action.solvedFlag);
  const setAnswers = (next: string[]) => patch({ answers: next });
  const rememberNothing = () => {
    const next = { ...action };
    delete next.solvedFlag;
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3" aria-label="What players read">
        <label className={field}>
          Puzzle title
          <Input
            aria-label="Puzzle title"
            maxLength={80}
            placeholder="Puzzle"
            value={action.label ?? ''}
            onChange={(e) => patch({ label: e.target.value })}
          />
        </label>
        <label className={field}>
          Prompt
          <textarea
            aria-label="Puzzle prompt"
            className={select}
            rows={3}
            maxLength={1000}
            placeholder="The security door has a four-digit keypad."
            value={action.prompt ?? ''}
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </label>
      </section>

      <section
        className="space-y-2 rounded-md border border-dashed border-border p-2"
        aria-label="Accepted answers (authors only)"
      >
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Lock className="size-3.5" /> Accepted answers
        </p>
        <p className={hint}>
          Only authors see these. Players are told whether they were right, never what the answer
          is. Numbers are kept exactly as typed, so 0042 stays 0042.
        </p>
        <ul className="space-y-1.5">
          {answers.map((answer, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                aria-label={`Accepted answer ${i + 1}`}
                maxLength={MAX_ANSWER_LENGTH}
                value={answer}
                onChange={(e) => setAnswers(answers.map((a, n) => (n === i ? e.target.value : a)))}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove accepted answer ${i + 1}`}
                onClick={() => setAnswers(answers.filter((_, n) => n !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        {answers.length === 0 && (
          <p role="alert" className="text-xs text-danger">
            Add at least one accepted answer.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={answers.length >= MAX_ANSWERS}
          onClick={() => setAnswers([...answers, ''])}
        >
          <Plus /> Add another accepted answer
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Answers are case-sensitive"
            checked={action.caseSensitive ?? false}
            onChange={(e) => patch({ caseSensitive: e.target.checked })}
          />
          Capitals must match exactly
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Ignore spaces before and after"
            checked={action.trimWhitespace ?? true}
            onChange={(e) => patch({ trimWhitespace: e.target.checked })}
          />
          Ignore spaces before and after the answer (spaces inside always count)
        </label>
      </section>

      <label className={field}>
        Attempts allowed
        <Input
          aria-label="Maximum attempts"
          type="number"
          min={1}
          max={MAX_ATTEMPTS}
          step={1}
          placeholder="Unlimited"
          value={action.maxAttempts ?? ''}
          onChange={(e) =>
            patch({ maxAttempts: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })
          }
        />
        <span className={hint}>
          Leave empty for unlimited. With a limit, running out follows “After the last attempt is
          used up” under Advanced options; by default the room carries on, unsolved.
          {action.maxAttempts == null && !action.optional
            ? ' With unlimited attempts and no way to skip, a player who cannot solve it can only abandon the run.'
            : ''}
        </span>
      </label>

      <section className="space-y-3" aria-label="Result messages">
        {(
          [
            ['solvedText', 'Message for a correct answer', 'That’s right.'],
            ['incorrectText', 'Message for a wrong answer', 'That isn’t right.'],
            ['exhaustedText', 'Message when attempts run out', 'Uses the wrong-answer message'],
          ] as const
        ).map(([name, label, placeholder]) => (
          <label key={name} className={field}>
            {label}
            <Input
              aria-label={label}
              maxLength={600}
              placeholder={placeholder}
              value={action[name] ?? ''}
              onChange={(e) => patch({ [name]: e.target.value })}
            />
          </label>
        ))}
      </section>

      <div className="flex items-end gap-2">
        <label className={`${field} min-w-0 flex-1`}>
          When solved, remember
          <select
            aria-label="Remember when solved"
            className={select}
            value={action.solvedFlag ?? ''}
            onChange={(e) => (e.target.value ? patch({ solvedFlag: e.target.value }) : rememberNothing())}
          >
            <option value="">Nothing</option>
            {action.solvedFlag && !remembered && (
              <option value={action.solvedFlag}>Missing ({action.solvedFlag})</option>
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
              flags: [...definition.flags, { key, scope: 'run', description: 'Puzzle solved' }],
              rooms: definition.rooms.map((r) =>
                r.id === room.id
                  ? { ...r, actions: r.actions.map((a) => (a.id === action.id ? { ...a, solvedFlag: key } : a)) }
                  : r,
              ),
            });
          }}
        >
          New…
        </Button>
      </div>
      <p className={hint}>
        Use what is remembered in a rule — a locked path, a checkpoint or a later activity that only
        happens once the puzzle is solved.
      </p>
    </div>
  );
}
