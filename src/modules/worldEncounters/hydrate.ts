/**
 * Hydration — raw DB rows → `LoadedEncounter` with parsed JSONB.
 *
 * Kept in a leaf module so the engine, service, and admin preview all read
 * the same conversion, and so a Zod parse failure has one place to land. On
 * failure the affected choice's requirements/check/effects fall back to safe
 * defaults (no requirement, `check.none`, empty effects) — a corrupt row
 * cannot brick selection.
 */
import {
  CheckSchema,
  EffectSchema,
  RequirementsSchema,
  type CheckSpec,
  type Effect,
  type LoadedChoice,
  type LoadedEncounter,
  type Requirements,
} from './types';
import type {
  EncounterWithChildren,
  WorldEncounterChoiceRow,
} from './worldEncounterRepository';
import type {
  WorldEncounterLifecycle,
  WorldEncounterRarity,
  WorldEncounterType,
} from '../../db/schema';

function safeRequirements(json: unknown): Requirements {
  const parsed = RequirementsSchema.safeParse(json);
  return parsed.success ? parsed.data : {};
}

function safeCheck(json: unknown): CheckSpec {
  const parsed = CheckSchema.safeParse(json);
  return parsed.success ? parsed.data : { type: 'none' };
}

function safeEffects(json: unknown): Effect[] {
  if (!Array.isArray(json)) return [];
  const out: Effect[] = [];
  for (const entry of json) {
    const parsed = EffectSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function hydrateChoice(row: WorldEncounterChoiceRow): LoadedChoice {
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    label: row.label,
    emoji: row.emoji,
    requirements: safeRequirements(row.requirementsJson),
    check: safeCheck(row.checkJson),
    successEffects: safeEffects(row.successEffectsJson),
    failureEffects: safeEffects(row.failureEffectsJson),
  };
}

export function hydrateEncounter(row: EncounterWithChildren): LoadedEncounter {
  const e = row.encounter;
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    type: e.type as WorldEncounterType,
    rarity: e.rarity as WorldEncounterRarity,
    weight: e.weight,
    lifecycle: e.lifecycle as WorldEncounterLifecycle,
    huntEligible: e.huntEligible,
    travelEligible: e.travelEligible,
    cooldownSeconds: e.cooldownSeconds,
    artworkPath: e.artworkPath,
    chainedEncounterSlug: e.chainedEncounterSlug,
    choicesRequired: e.choicesRequired,
    regions: row.regions.map((r) => r.regionId),
    routes: row.routes.map((r) => ({ fromRegion: r.fromRegion, toRegion: r.toRegion })),
    choices: row.choices.map(hydrateChoice),
    metadata: e.metadata,
  };
}
