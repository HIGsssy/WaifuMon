/**
 * Affinity — the five capture/buddy styles, and how they present on a card.
 *
 * The affinity codes come straight from `src/db/schema.ts`; this module only
 * adds presentation: which icon file to inject and what blurb sits next to it.
 *
 * {@link AFFINITY_DESCRIPTIONS} is renderer-owned copy and stays that way.
 * These blurbs define what an affinity *classification* means, so every card
 * with the same affinity must say the same thing — putting them in species
 * content would duplicate one global definition across every entry and invite
 * five species to disagree about what "primal" is. Phase 2 does not add
 * affinity-description fields to the species schema. If per-character affinity
 * flavour is ever wanted, that is a separate optional field layered *beside*
 * these definitions, never a replacement for them.
 */
import { AFFINITIES, type Affinity } from '../../db/schema';

export const AFFINITY_ICON_FILES: Readonly<Record<Affinity, string>> = {
  dominant: 'dominant.svg',
  submissive: 'submissive.svg',
  caregiver: 'caregiver.svg',
  primal: 'primal.svg',
  switch: 'switch.svg',
};

/** Icon filename for an affinity, relative to `assets/cardart/icons/affinities/`. */
export function affinityIconFile(affinity: Affinity): string {
  const file = AFFINITY_ICON_FILES[affinity];
  if (!file) {
    throw new Error(`No card icon is mapped for affinity "${String(affinity)}"`);
  }
  return file;
}

/** Two-line blurb shown beside the affinity badge. Wrapped by the composer. */
export const AFFINITY_DESCRIPTIONS: Readonly<Record<Affinity, string>> = {
  dominant: 'Takes the lead and sets the pace. Responds best to a partner who yields gracefully.',
  submissive: 'Follows willingly and thrives on direction. Warms fastest to steady, confident hands.',
  caregiver: 'Looks after everyone first. Gives affection freely and expects patience in return.',
  primal: 'Runs on instinct and appetite. Unpredictable, intense, and never quite tamed.',
  switch: 'Reads the room and adapts. Comfortable leading or following, whichever the moment wants.',
};

/** Card-face label for an affinity, e.g. `dominant` → `DOMINANT`. */
export function affinityLabel(affinity: Affinity): string {
  return affinity.toUpperCase();
}

export { AFFINITIES, type Affinity };
