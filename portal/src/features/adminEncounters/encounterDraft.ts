/**
 * The editor's local draft shape, and the two mappers between it and the API.
 *
 * Split out of `AdminEncounterEditorPage` so the component file exports only a
 * component (React Fast Refresh needs that, and eslint enforces it) — and so
 * the round trip these two functions define can be tested without rendering
 * anything. A field either of them forgets is dropped silently on save, which
 * is the failure mode worth having a test for.
 */
import type {
  AdminEncounter,
  EncounterInputPayload,
} from '@/api/adminEncounters';
import type { ChoiceDraft } from './ChoiceEditor';
import type { EffectShape } from './EffectEditor';
import { WAIFUMON_EFFECT, formFromEffect } from './waifumonSelection';

export interface Draft {
  slug: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  weight: number;
  lifecycle: 'draft' | 'active' | 'disabled';
  huntEligible: boolean;
  travelEligible: boolean;
  cooldownSeconds: number;
  artworkPath: string | null;
  chainedEncounterSlug: string | null;
  choicesRequired: boolean;
  regions: string[];
  routes: Array<{ fromRegion: string; toRegion: string }>;
  choices: ChoiceDraft[];
  metadata: Record<string, unknown>;
}

export const EMPTY_DRAFT: Draft = {
  slug: '',
  name: '',
  description: '',
  type: 'decision',
  rarity: 'common',
  weight: 10,
  lifecycle: 'draft',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 0,
  artworkPath: null,
  chainedEncounterSlug: null,
  choicesRequired: true,
  regions: [],
  routes: [],
  choices: [],
  metadata: {},
};

export function toPayload(d: Draft): EncounterInputPayload {
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    type: d.type,
    rarity: d.rarity,
    weight: d.weight,
    lifecycle: d.lifecycle,
    huntEligible: d.huntEligible,
    travelEligible: d.travelEligible,
    cooldownSeconds: d.cooldownSeconds,
    artworkPath: d.artworkPath,
    chainedEncounterSlug: d.chainedEncounterSlug,
    choicesRequired: d.choicesRequired,
    regions: d.regions,
    routes: d.routes,
    choices: d.choices.map((c) => ({
      label: c.label,
      emoji: c.emoji,
      requirements: c.requirements as Record<string, unknown>,
      check: c.check as unknown as Record<string, unknown>,
      successEffects: c.successEffects,
      failureEffects: c.failureEffects,
    })),
    metadata: d.metadata,
  };
}

/** Every effect in the draft, with a label an author can find it by. */
function labelledEffects(d: Draft): Array<{ where: string; effect: EffectShape }> {
  return d.choices.flatMap((c, i) => [
    ...c.successEffects.map((effect, j) => ({
      where: `Choice #${i + 1}, success effect #${j + 1}`,
      effect,
    })),
    ...c.failureEffects.map((effect, j) => ({
      where: `Choice #${i + 1}, failure effect #${j + 1}`,
      effect,
    })),
  ]);
}

/**
 * Waifumon sightings left in Specific Species mode with no species chosen.
 *
 * A plain form-state check — the author has not finished the field — so it
 * blocks every save (draft included) here rather than being left for the
 * server to reject.
 */
export function unchosenSpeciesIssues(d: Draft): string[] {
  return labelledEffects(d)
    .filter(({ effect }) => {
      if (effect.type !== WAIFUMON_EFFECT) return false;
      const form = formFromEffect(effect);
      return form.mode === 'specific' && form.speciesSlug === '';
    })
    .map(({ where }) => `${where}: pick a species for this Waifumon sighting.`);
}

/**
 * The random selectors in the draft, as stored. What they can match is
 * decided by the server's selector preview — nothing here evaluates them.
 */
export function randomSelections(
  d: Draft,
): Array<{ where: string; selection: Record<string, unknown> }> {
  return labelledEffects(d).flatMap(({ where, effect }) => {
    const selection = effect.selection as Record<string, unknown> | undefined;
    return effect.type === WAIFUMON_EFFECT && selection?.mode === 'random'
      ? [{ where, selection }]
      : [];
  });
}

export function draftFrom(server: AdminEncounter): Draft {
  return {
    slug: server.slug,
    name: server.name,
    description: server.description,
    type: server.type,
    rarity: server.rarity,
    weight: server.weight,
    lifecycle: server.lifecycle,
    huntEligible: server.huntEligible,
    travelEligible: server.travelEligible,
    cooldownSeconds: server.cooldownSeconds,
    artworkPath: server.artworkPath,
    chainedEncounterSlug: server.chainedEncounterSlug,
    choicesRequired: server.choicesRequired,
    regions: server.regions,
    routes: server.routes,
    choices: server.choices.map((c) => ({
      label: c.label,
      emoji: c.emoji,
      requirements: c.requirements as ChoiceDraft['requirements'],
      check: c.check as ChoiceDraft['check'],
      successEffects: c.successEffects as unknown as EffectShape[],
      failureEffects: c.failureEffects as unknown as EffectShape[],
    })),
    metadata: server.metadata,
  };
}
