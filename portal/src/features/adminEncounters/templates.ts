/**
 * Starting points for a new encounter. UI templates only: each one is an
 * ordinary draft with a few fields filled in and a hint about which tools to
 * put in front of the author. Nothing here is an engine type, and every field
 * stays editable afterwards.
 */
import type { ChoiceDraft } from './ChoiceEditor';
import { EMPTY_DRAFT, type Draft } from './encounterDraft';

export type EncounterTemplate = 'simple' | 'skill' | 'branching' | 'vendor';

export interface TemplateInfo {
  id: EncounterTemplate;
  title: string;
  blurb: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  {
    id: 'simple',
    title: 'Simple encounter',
    blurb: 'A scene with one or more choices that always work. Good for rewards and flavour.',
  },
  {
    id: 'skill',
    title: 'Skill-check encounter',
    blurb: 'A choice that can succeed or fail, with the buddy’s strength shifting the odds.',
  },
  {
    id: 'branching',
    title: 'Branching encounter / chain',
    blurb:
      'Choices that lead on to follow-up encounters, including different ones on success and failure.',
  },
  {
    id: 'vendor',
    title: 'Vendor encounter',
    blurb: 'A merchant the player can buy from. Pick an existing vendor or create one as you go.',
  },
];

const choice = (overrides: Partial<ChoiceDraft>): ChoiceDraft => ({
  label: 'Continue',
  emoji: null,
  requirements: {},
  check: { type: 'none' },
  successEffects: [],
  failureEffects: [],
  ...overrides,
});

export function draftForTemplate(template: EncounterTemplate): Draft {
  switch (template) {
    case 'simple':
      return { ...EMPTY_DRAFT, type: 'decision', choices: [choice({ label: 'Continue' })] };
    case 'skill':
      return {
        ...EMPTY_DRAFT,
        type: 'skill_check',
        choices: [
          choice({ label: 'Try it', check: { type: 'sp', baseChance: 0.5, maxSpModifier: 0.15 } }),
          choice({ label: 'Leave it' }),
        ],
      };
    case 'branching':
      return {
        ...EMPTY_DRAFT,
        type: 'decision',
        choices: [
          choice({ label: 'Go on', check: { type: 'sp', baseChance: 0.5, maxSpModifier: 0.15 } }),
          choice({ label: 'Turn back' }),
        ],
      };
    case 'vendor':
      return {
        ...EMPTY_DRAFT,
        type: 'vendor',
        choices: [
          choice({ label: 'Browse wares', successEffects: [{ type: 'open_vendor' }] }),
          choice({ label: 'Move on' }),
        ],
      };
  }
}

export function isTemplate(value: string | null): value is EncounterTemplate {
  return TEMPLATES.some((t) => t.id === value);
}
