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
import type {
  EncounterDeleteReferences,
  WorldEncounterRepository,
} from './worldEncounterRepository';
import { listRewardableDefinitions } from '../equipment/equipmentRewardService';
import type { RewardableDefinition } from '../equipment/rewardSelector';
import { EncounterInputSchema, equipmentEffectIssues, type EncounterInput } from './types';
import { hydrateEncounter } from './hydrate';
import type { LoadedEncounter } from './types';

export interface WorldEncounterAdminService {
  list(): Promise<LoadedEncounter[]>;
  get(id: number): Promise<LoadedEncounter | null>;
  getBySlug(slug: string): Promise<LoadedEncounter | null>;
  /**
   * Create or replace the encounter identified by `input.slug`. Returns the
   * hydrated record after the write.
   *
   * With `createOnly`, an existing slug is refused with
   * {@link AdminEncounterSlugTakenError} instead of being replaced — the
   * semantics of every "create" (the Portal's POST, clone). Replacing by
   * slug stays available to callers that mean it (the legacy admin panel's
   * single save form, content import).
   */
  upsert(input: EncounterInput, opts?: { createOnly?: boolean }): Promise<LoadedEncounter>;
  /**
   * Activating runs the same reachability rule a save to `active` does, and
   * throws {@link AdminEncounterValidationError} when it fails. Draft and
   * disabled are always accepted.
   */
  setLifecycle(id: number, lifecycle: 'draft' | 'active' | 'disabled'): Promise<void>;
  clone(id: number, newSlug: string): Promise<LoadedEncounter>;
  /**
   * Refuses while anything references the encounter — history, a live or
   * closed play session, or another encounter continuing to it — and says
   * what, so the caller can explain. Nothing is written on a refusal.
   */
  remove(id: number): Promise<EncounterRemoveResult>;
}

export type EncounterDeleteBlockers = EncounterDeleteReferences;

export type EncounterRemoveResult =
  | { ok: true }
  | { ok: false; reason: string; blockers: EncounterDeleteBlockers };

/** True when any reference in `refs` stands in the way of a delete. */
export function hasDeleteBlockers(refs: EncounterDeleteBlockers): boolean {
  return (
    refs.referencedBy.length > 0 ||
    refs.historyCount > 0 ||
    refs.pendingCount > 0 ||
    refs.closedSessionCount > 0
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One readable sentence per kind of blocker, plus what to do about it. Used
 * as the refusal's `reason` (the legacy panel shows it verbatim) and as the
 * API's user message.
 */
export function describeDeleteBlockers(refs: EncounterDeleteBlockers): string {
  const parts: string[] = [];
  if (refs.referencedBy.length > 0) {
    const names = [...new Set(refs.referencedBy.map((r) => `"${r.name}"`))];
    parts.push(
      `${names.join(', ')} still continue${names.length === 1 ? 's' : ''} to it — remove ` +
        `${names.length === 1 ? 'that link' : 'those links'} first.`,
    );
  }
  if (refs.pendingCount > 0) {
    const queued =
      refs.queuedContinuationCount > 0
        ? ` (${refs.queuedContinuationCount} queued as a chain follow-up)`
        : '';
    parts.push(
      `${plural(refs.pendingCount, 'player has it open', 'players have it open')}${queued}.`,
    );
  }
  if (refs.historyCount > 0) {
    parts.push(`It has ${plural(refs.historyCount, 'recorded play', 'recorded plays')} in history.`);
  } else if (refs.closedSessionCount > 0) {
    parts.push(
      `It has ${plural(refs.closedSessionCount, 'past session', 'past sessions')} (expired or abandoned).`,
    );
  }
  const played = refs.historyCount + refs.closedSessionCount + refs.pendingCount;
  const advice = played > 0 ? ' Disable it instead — played encounters are kept for the record.' : '';
  return `This encounter cannot be deleted. ${parts.join(' ')}${advice}`;
}

export class AdminEncounterValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super('Validation failed');
    this.name = 'AdminEncounterValidationError';
    this.issues = issues;
  }
}

/** A create named a slug another encounter already has. Nothing was written. */
export class AdminEncounterSlugTakenError extends AdminEncounterValidationError {
  readonly slug: string;
  constructor(slug: string) {
    super([`An encounter with the slug "${slug}" already exists.`]);
    this.name = 'AdminEncounterSlugTakenError';
    this.slug = slug;
  }
}

/** Postgres `foreign_key_violation` — a row still references the encounter. */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23503' || e?.cause?.code === '23503';
}

const UNREACHABLE_ISSUE =
  'Unreachable: not hunt- or travel-eligible, and no other encounter chains into it. ' +
  'Enable a source, or add a trigger_encounter effect (or chainedEncounterSlug) ' +
  'pointing at this slug from the encounter that should lead here.';

/** Postgres `unique_violation` — a concurrent create won the slug first. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
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
  chainTargets: Set<string>,
  equipmentDefinitions: readonly RewardableDefinition[] | undefined,
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
      if (effect.type === 'give_equipment' && equipmentDefinitions) {
        issues.push(...equipmentEffectIssues(effect, equipmentDefinitions).map((m) => `choice[${i}] ${m}`));
      }
    }
  }
  if (input.choicesRequired && input.choices.length === 0) {
    issues.push('choicesRequired=true but no choices defined.');
  }
  // Reachability, not eligibility.
  //
  // The rule this replaces was `!huntEligible && !travelEligible` → reject,
  // which is wrong for a chain target: an encounter reached only through a
  // `trigger_encounter` follow-up deliberately carries neither flag, because
  // its *parent* already gated where it can occur. The shipped
  // `tv_bandit_aftermath` is exactly that shape, and under the old rule it
  // could not be saved through the Portal editor at all — opening shipped
  // content and pressing Save was rejected.
  //
  // What the rule is actually protecting against is authoring an encounter
  // nothing can ever reach, so that is what it now checks.
  //
  // Only for `active`. Draft and disabled encounters never spawn and are
  // skipped as follow-ups, so their Hunt/Travel flags are inert — requiring
  // one just to save a half-built chain node made authors tick a box they
  // did not want. Activation (`setLifecycle`) re-runs the rule, so an
  // unreachable encounter still cannot go live by either path.
  if (
    input.lifecycle === 'active' &&
    !input.huntEligible &&
    !input.travelEligible &&
    !chainTargets.has(input.slug)
  ) {
    issues.push(UNREACHABLE_ISSUE);
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
  /**
   * Slugs some other encounter chains into. Defaults to empty, which is the
   * conservative answer: with no chain information, only hunt/travel
   * eligibility can make an encounter reachable.
   */
  chainTargets: Set<string> = new Set(),
  /**
   * Every equipment definition, enabled or not. When given, a
   * `give_equipment` selector must name real, enabled, matching definitions
   * and match at least one — the same rule the reward path enforces at
   * runtime. Omitted only by callers that cannot read the database.
   */
  equipmentDefinitions?: readonly RewardableDefinition[],
): EncounterInput {
  const parsed = EncounterInputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AdminEncounterValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  const cross = crossValidate(parsed.data, itemSlugs, existingSlugs, chainTargets, equipmentDefinitions);
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
  async function chainTargets(): Promise<Set<string>> {
    return repo.chainTargetSlugs();
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
    async upsert(input, opts = {}) {
      const items = await itemSlugs();
      const existing = await existingSlugs();
      if (opts.createOnly && existing.has(input.slug)) {
        throw new AdminEncounterSlugTakenError(input.slug);
      }
      const validated = parseEncounterInput(
        input,
        items,
        existing,
        await chainTargets(),
        await listRewardableDefinitions(db),
      );
      const priorRow = opts.createOnly ? null : await repo.loadBySlug(validated.slug);
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
      try {
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
              outcomeText: c.outcomeText ?? null,
              successText: c.successText ?? null,
              failureText: c.failureText ?? null,
            })),
          );
        });
      } catch (err) {
        if (opts.createOnly && isUniqueViolation(err)) {
          throw new AdminEncounterSlugTakenError(validated.slug);
        }
        throw err;
      }
      const row = await repo.loadBySlug(validated.slug);
      if (!row) throw new Error('upsert: encounter vanished after write');
      return hydrateEncounter(row);
    },
    async setLifecycle(id, lifecycle) {
      if (lifecycle === 'active') {
        const row = await repo.loadById(id);
        const e = row?.encounter;
        if (e && !e.huntEligible && !e.travelEligible && !(await chainTargets()).has(e.slug)) {
          throw new AdminEncounterValidationError([UNREACHABLE_ISSUE]);
        }
      }
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
          outcomeText: c.outcomeText ?? null,
          successText: c.successText ?? null,
          failureText: c.failureText ?? null,
        })),
        metadata: original.metadata,
      });
      // A clone is a create: a taken slug is refused, never overwritten.
      return this.upsert(input, { createOnly: true });
    },
    async remove(id) {
      const row = await repo.loadById(id);
      // Deleting what is already gone is a no-op, as it always was.
      if (!row) return { ok: true };
      const refusal = async (): Promise<EncounterRemoveResult | null> => {
        const blockers = await repo.deleteReferences(id, row.encounter.slug);
        return hasDeleteBlockers(blockers)
          ? { ok: false, reason: describeDeleteBlockers(blockers), blockers }
          : null;
      };
      const before = await refusal();
      if (before) return before;
      try {
        await db.transaction((tx) => repo.deleteEncounter(tx, id));
      } catch (err) {
        // A player can open the encounter between the audit and the DELETE.
        // The foreign key catches that; re-audit so the refusal names it
        // rather than surfacing the raw constraint error as a 500.
        if (isForeignKeyViolation(err)) {
          const after = await refusal();
          if (after) return after;
        }
        throw err;
      }
      return { ok: true };
    },
  };
}
