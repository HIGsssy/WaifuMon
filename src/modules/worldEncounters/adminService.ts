/**
 * Admin CRUD for world encounters.
 *
 * The AdminContentService owns JSON-backed content (items, species, tables,
 * quests). World encounters live in the database instead, so this service is
 * its analogue: validated writes, atomic transactions, and structured error
 * bodies compatible with the admin panel's flash renderer.
 *
 * Every write is a single `db.transaction()`: the general fields, region
 * junction, route junction, and choices update together or not at all. A
 * partial write of a choice tree — the shape most likely to corrupt content
 * — cannot land.
 */
import { z } from 'zod';
import type { Db } from '../../db/client';
import type { LoadedContent } from '../content/schemas';
import { createWorldEncounterRepository } from './worldEncounterRepository';
import type { WorldEncounterRepository } from './worldEncounterRepository';
import { EncounterInputSchema, type EncounterInput } from './types';
import { hydrateEncounter } from './hydrate';
import type { LoadedEncounter } from './types';

export interface WorldEncounterAdminService {
  list(): Promise<LoadedEncounter[]>;
  get(id: number): Promise<LoadedEncounter | null>;
  getBySlug(slug: string): Promise<LoadedEncounter | null>;
  /**
   * Create or replace the encounter identified by `input.slug`. Returns the
   * hydrated record after the write.
   */
  upsert(input: EncounterInput): Promise<LoadedEncounter>;
  setLifecycle(id: number, lifecycle: 'draft' | 'active' | 'disabled'): Promise<void>;
  clone(id: number, newSlug: string): Promise<LoadedEncounter>;
  /** Refuses when history rows exist — the caller should disable instead. */
  remove(id: number): Promise<{ ok: boolean; reason?: string }>;
}

export class AdminEncounterValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super('Validation failed');
    this.name = 'AdminEncounterValidationError';
    this.issues = issues;
  }
}

/**
 * Cross-field validators that the {@link EncounterInputSchema} cannot
 * express: item slug existence, chained encounter existence, no
 * self-referencing loops in the immediate chain.
 */
function crossValidate(
  input: EncounterInput,
  itemSlugs: Set<string>,
  existingSlugs: Set<string>,
): string[] {
  const issues: string[] = [];
  if (input.chainedEncounterSlug === input.slug) {
    issues.push('chainedEncounterSlug refers to this encounter (would loop).');
  }
  if (
    input.chainedEncounterSlug != null &&
    !existingSlugs.has(input.chainedEncounterSlug) &&
    input.chainedEncounterSlug !== input.slug
  ) {
    // Not fatal — the chained encounter can be authored after; warn via a
    // structured issue and the panel prints it. Kept as an issue rather than
    // a silent accept so authors do not lose track of pending references.
    issues.push(
      `chainedEncounterSlug "${input.chainedEncounterSlug}" is not a known encounter yet.`,
    );
  }
  for (const [i, choice] of input.choices.entries()) {
    for (const effect of [...choice.successEffects, ...choice.failureEffects]) {
      if (effect.type === 'give_item' || effect.type === 'consume_item') {
        if (!itemSlugs.has(effect.slug)) {
          issues.push(`choice[${i}] references unknown item slug "${effect.slug}".`);
        }
      }
      if (effect.type === 'trigger_encounter') {
        if (effect.encounterSlug === input.slug) {
          issues.push(`choice[${i}] triggers this same encounter (would loop).`);
        }
      }
    }
  }
  if (input.choicesRequired && input.choices.length === 0) {
    issues.push('choicesRequired=true but no choices defined.');
  }
  if (!input.huntEligible && !input.travelEligible) {
    issues.push('At least one of huntEligible / travelEligible must be true.');
  }
  return issues;
}

/**
 * Take a form payload (probably-untyped) and return an
 * {@link EncounterInput} or throw a validation error. Also runs cross-field
 * validation.
 */
export function parseEncounterInput(
  payload: unknown,
  itemSlugs: Set<string>,
  existingSlugs: Set<string>,
): EncounterInput {
  const parsed = EncounterInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AdminEncounterValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  const cross = crossValidate(parsed.data, itemSlugs, existingSlugs);
  if (cross.some((issue) => !issue.includes('not a known encounter yet'))) {
    // Only "unknown chained slug" is downgraded to a warning-style issue.
    throw new AdminEncounterValidationError(cross);
  }
  return parsed.data;
}

export function createWorldEncounterAdminService(
  db: Db,
  getContent: () => LoadedContent,
): WorldEncounterAdminService {
  const repo: WorldEncounterRepository = createWorldEncounterRepository(db);

  async function itemSlugs(): Promise<Set<string>> {
    return new Set(getContent().items.map((i) => i.slug));
  }
  async function existingSlugs(): Promise<Set<string>> {
    return new Set((await repo.listAll()).map((e) => e.slug));
  }

  return {
    async list() {
      const rows = await repo.listAll();
      // For the list view we do not need choices/regions — but the caller
      // renders region/route summaries, so we load children lazily below.
      const loaded: LoadedEncounter[] = [];
      for (const row of rows) {
        const full = await repo.loadById(row.id);
        if (full) loaded.push(hydrateEncounter(full));
      }
      return loaded;
    },
    async get(id) {
      const row = await repo.loadById(id);
      return row ? hydrateEncounter(row) : null;
    },
    async getBySlug(slug) {
      const row = await repo.loadBySlug(slug);
      return row ? hydrateEncounter(row) : null;
    },
    async upsert(input) {
      const items = await itemSlugs();
      const existing = await existingSlugs();
      const validated = parseEncounterInput(input, items, existing);
      const priorRow = await repo.loadBySlug(validated.slug);
      const values = {
        slug: validated.slug,
        name: validated.name,
        description: validated.description,
        type: validated.type,
        rarity: validated.rarity,
        weight: validated.weight,
        lifecycle: validated.lifecycle,
        huntEligible: validated.huntEligible,
        travelEligible: validated.travelEligible,
        cooldownSeconds: validated.cooldownSeconds,
        artworkPath: validated.artworkPath,
        chainedEncounterSlug: validated.chainedEncounterSlug,
        choicesRequired: validated.choicesRequired,
        metadata: validated.metadata,
      };
      let id: number;
      await db.transaction(async (tx) => {
        if (priorRow) {
          id = priorRow.encounter.id;
          await repo.update(tx, id, values);
        } else {
          id = await repo.insert(tx, values);
        }
        await repo.replaceChildren(
          tx,
          id,
          validated.regions,
          validated.routes,
          validated.choices.map((c, i) => ({
            sortOrder: i,
            label: c.label,
            emoji: c.emoji,
            requirementsJson: c.requirements as unknown as Record<string, unknown>,
            checkJson: c.check as unknown as Record<string, unknown>,
            successEffectsJson: c.successEffects as unknown as Record<string, unknown>[],
            failureEffectsJson: c.failureEffects as unknown as Record<string, unknown>[],
          })),
        );
      });
      const row = await repo.loadBySlug(validated.slug);
      if (!row) throw new Error('upsert: encounter vanished after write');
      return hydrateEncounter(row);
    },
    async setLifecycle(id, lifecycle) {
      await db.transaction((tx) => repo.setLifecycle(tx, id, lifecycle));
    },
    async clone(id, newSlug) {
      const row = await repo.loadById(id);
      if (!row) throw new AdminEncounterValidationError(['encounter not found']);
      const original = hydrateEncounter(row);
      // `LoadedEncounter.regions` is widened `string[]` because DB rows are
      // untyped. Re-parse through EncounterInputSchema to narrow back, so the
      // clone starts life fully typed.
      const input = EncounterInputSchema.parse({
        slug: newSlug,
        name: `${original.name} (copy)`,
        description: original.description,
        type: original.type,
        rarity: original.rarity,
        weight: original.weight,
        lifecycle: 'draft',
        huntEligible: original.huntEligible,
        travelEligible: original.travelEligible,
        cooldownSeconds: original.cooldownSeconds,
        artworkPath: original.artworkPath,
        chainedEncounterSlug: original.chainedEncounterSlug,
        choicesRequired: original.choicesRequired,
        regions: original.regions,
        routes: original.routes,
        choices: original.choices.map((c) => ({
          label: c.label,
          emoji: c.emoji,
          requirements: c.requirements,
          check: c.check,
          successEffects: c.successEffects,
          failureEffects: c.failureEffects,
        })),
        metadata: original.metadata,
      });
      return this.upsert(input);
    },
    async remove(id) {
      const hasHistory = await repo.hasHistory(id);
      if (hasHistory) {
        return {
          ok: false,
          reason: 'This encounter has resolved history — disable instead of deleting.',
        };
      }
      await db.transaction((tx) => repo.deleteEncounter(tx, id));
      return { ok: true };
    },
  };
}
