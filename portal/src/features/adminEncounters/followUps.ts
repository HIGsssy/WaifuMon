/**
 * Follow-ups as the editor presents them — pure, no React.
 *
 * Storage is unchanged: a follow-up is a `trigger_encounter` effect inside a
 * choice outcome's effect list. These helpers let the editor show it as a
 * dedicated "Follow-up" slot while keeping the effect exactly where it was in
 * the list, so re-saving an untouched encounter never reorders its effects.
 */
import type { ChoiceDraft } from './ChoiceEditor';
import type { Draft } from './encounterDraft';
import type { EffectShape } from './EffectEditor';
import type { NameLookups } from './describe';

export type OutcomeBranch = 'success' | 'failure';

export const FOLLOW_UP_EFFECT = 'trigger_encounter';

/** Indices of every follow-up in an outcome; the engine uses only the first. */
export function followUpIndices(effects: readonly EffectShape[]): number[] {
  return effects.flatMap((e, i) => (e.type === FOLLOW_UP_EFFECT ? [i] : []));
}

/** The outcome's follow-up slug ('' when one is being picked), or null for none. */
export function followUpOf(effects: readonly EffectShape[]): string | null {
  const first = effects.find((e) => e.type === FOLLOW_UP_EFFECT);
  if (!first) return null;
  return typeof first.encounterSlug === 'string' ? first.encounterSlug : '';
}

/**
 * Set the outcome's (first) follow-up in place, or append one. `null` removes
 * the first follow-up; any later ones are left for the author to see.
 */
export function withFollowUp(effects: readonly EffectShape[], slug: string | null): EffectShape[] {
  const at = effects.findIndex((e) => e.type === FOLLOW_UP_EFFECT);
  if (slug === null) return at < 0 ? [...effects] : effects.filter((_, i) => i !== at);
  const link: EffectShape = { type: FOLLOW_UP_EFFECT, encounterSlug: slug };
  if (at < 0) return [...effects, link];
  return effects.map((e, i) => (i === at ? link : e));
}

const FIELD: Record<OutcomeBranch, 'successEffects' | 'failureEffects'> = {
  success: 'successEffects',
  failure: 'failureEffects',
};

/** The draft with one choice outcome's follow-up set to `slug`. */
export function setChoiceFollowUp(
  draft: Draft,
  choiceIndex: number,
  branch: OutcomeBranch,
  slug: string,
): Draft {
  const field = FIELD[branch];
  return {
    ...draft,
    choices: draft.choices.map((c, i): ChoiceDraft =>
      i === choiceIndex ? { ...c, [field]: withFollowUp(c[field], slug) } : c,
    ),
  };
}

/** "On success → X · On failure → Y", "→ X", or "None". */
export function describeFollowUps(choice: ChoiceDraft, names: NameLookups): string {
  const name = (slug: string) => (slug ? (names.encounter?.(slug) ?? slug) : '(not picked)');
  const auto = choice.check.type === 'none';
  const success = followUpOf(choice.successEffects);
  const failure = auto ? null : followUpOf(choice.failureEffects);
  if (success === null && failure === null) return 'None';
  if (auto) return `→ ${name(success!)}`;
  return [
    success !== null && `On success → ${name(success)}`,
    failure !== null && `On failure → ${name(failure)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
