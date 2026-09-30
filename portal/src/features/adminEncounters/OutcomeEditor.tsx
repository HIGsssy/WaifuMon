/**
 * One result of a choice — "Outcome" for an automatic choice, "On success" /
 * "On failure" for a skill check: its effects, its text, and its follow-up.
 */
import type { ReactNode } from 'react';

import type { AdminEncounterReference, SelectorPreviewEncounter } from '@/api/adminEncounters';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useAuthoring } from './AuthoringContext';
import { EFFECT_TYPES, newEffect } from './effectDefaults';
import { EffectEditor, type EffectShape } from './EffectEditor';
import { FollowUpEditor } from './FollowUpEditor';
import { FOLLOW_UP_EFFECT, followUpIndices, type OutcomeBranch } from './followUps';

/** Follow-ups have their own control; the effect-type picker offers everything else. */
const LIST_TYPES = EFFECT_TYPES.filter((t) => t !== FOLLOW_UP_EFFECT);

interface Props {
  title: string;
  tone: 'neutral' | 'success' | 'failure';
  effects: EffectShape[];
  onChange: (effects: EffectShape[]) => void;
  addLabel: string;
  newEffectType: string;
  choiceIndex: number;
  branch: OutcomeBranch;
  reference: AdminEncounterReference | undefined;
  encounterContext?: SelectorPreviewEncounter | undefined;
  /** Flavor text field(s) for this result. */
  children?: ReactNode | undefined;
  notice?: string | undefined;
  runs?: boolean | undefined;
}

const TONE: Record<Props['tone'], string> = {
  neutral: 'border-border',
  success: 'border-emerald-500/40',
  failure: 'border-danger/40',
};

export function OutcomeEditor({
  title,
  tone,
  effects,
  onChange,
  addLabel,
  newEffectType,
  choiceIndex,
  branch,
  reference,
  encounterContext,
  children,
  notice,
  runs = true,
}: Props) {
  const { names } = useAuthoring();
  // The first follow-up lives in its own slot; every other effect — later
  // follow-ups included, since the engine ignores them — is listed here.
  const slotIndex = followUpIndices(effects)[0];

  return (
    <fieldset className={cn('space-y-2 rounded-md border-l-4 border p-3', TONE[tone])}>
      <legend className="px-1 text-xs font-semibold uppercase text-ink-muted">{title}</legend>
      {notice && <p className="text-xs text-ink-muted">⚠ {notice}</p>}
      <div className="space-y-2">
        {effects.map((eff, i) =>
          i === slotIndex ? null : (
            <EffectEditor
              key={i}
              effect={eff}
              reference={reference}
              encounterContext={encounterContext}
              types={LIST_TYPES}
              names={names}
              onChange={(next) => onChange(effects.map((e, k) => (k === i ? next : e)))}
              onRemove={() => onChange(effects.filter((_, k) => k !== i))}
            />
          ),
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...effects, newEffect(newEffectType)])}
        >
          {addLabel}
        </Button>
      </div>
      {children}
      <FollowUpEditor
        effects={effects}
        onChange={onChange}
        choiceIndex={choiceIndex}
        branch={branch}
        runs={runs}
      />
    </fieldset>
  );
}
