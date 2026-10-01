/**
 * One choice, collapsed to what an author needs to read at a glance:
 *
 *   Choice: Take a bite
 *   Requirement: None
 *   Resolution: Skill check · 40% base, ±15% from Buddy SP
 *   On success: Gain 3 Energy, +10 Player XP
 *   On failure: Lose 2 Energy
 *   Follow-up: On success → Security Override
 *
 * "Edit details" expands it into the full {@link ChoiceEditor}.
 */
import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { useAuthoring } from './AuthoringContext';
import { ChoiceEditor, type ChoiceDraft } from './ChoiceEditor';
import { describeCheck, describeEffects, describeRequirements } from './describe';
import { FOLLOW_UP_EFFECT, describeFollowUps } from './followUps';

type EditorProps = Omit<ComponentProps<typeof ChoiceEditor>, 'onDone'>;

interface Props extends EditorProps {
  expanded: boolean;
  onToggle: () => void;
}

const withoutFollowUps = (effects: ChoiceDraft['successEffects']) =>
  effects.filter((e) => e.type !== FOLLOW_UP_EFFECT);

export function ChoiceCard({ expanded, onToggle, ...editor }: Props) {
  const { names } = useAuthoring();
  if (expanded) return <ChoiceEditor {...editor} onDone={onToggle} />;

  const { choice, index } = editor;
  const auto = choice.check.type === 'none';
  const rows: Array<[string, string]> = [
    ['Requirement', describeRequirements(choice.requirements, names)],
    ['Resolution', describeCheck(choice.check)],
    [
      auto ? 'Outcome' : 'On success',
      describeEffects(withoutFollowUps(choice.successEffects), names),
    ],
    ...(auto
      ? []
      : ([['On failure', describeEffects(withoutFollowUps(choice.failureEffects), names)]] as Array<
          [string, string]
        >)),
    ['Follow-up', describeFollowUps(choice, names)],
  ];

  return (
    <div className="rounded-md border border-border bg-surface p-3" data-testid="choice-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-muted">#{index + 1}</span>
        <h4 className="font-medium">
          {choice.emoji ? `${choice.emoji} ` : ''}
          {choice.label || <em className="text-ink-muted">(no label)</em>}
        </h4>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!editor.onMoveUp}
          onClick={editor.onMoveUp}
          aria-label={`Move ${choice.label} up`}
        >
          ↑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!editor.onMoveDown}
          onClick={editor.onMoveDown}
          aria-label={`Move ${choice.label} down`}
        >
          ↓
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onToggle}>
          Edit details
        </Button>
      </div>
      <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-xs text-ink-muted">{term}</dt>
            <dd data-testid={`choice-${term.toLowerCase().replace(/\s+/g, '-')}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
