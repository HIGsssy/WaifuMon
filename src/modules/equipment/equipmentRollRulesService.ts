/**
 * Equipment roll rules — the database-authoritative configuration's storage,
 * lifecycle and the one runtime read live grants make.
 *
 * ## Ownership
 *
 * `equipment_roll_config` (one row) holds the working draft and a pointer to
 * the published revision; `equipment_roll_config_revisions` holds every
 * published revision, immutable (a trigger refuses update/delete). The
 * database is authoritative from the first start on:
 *
 *  - **Bootstrap, once.** {@link bootstrapEquipmentRollRules} creates the row
 *    and revision 1 from the shipped `combatBonuses.json` (`legacy` block
 *    verbatim, no high-rarity rules) when — and only when — no row exists.
 *  - **Never overwritten.** A restart or content reload with a changed shipped
 *    file leaves the database alone and records `drift_detected` (once per
 *    distinct shipped content) — the Region Pools precedent.
 *  - **One live source.** Grants read the *published* revision only
 *    ({@link EquipmentRollRulesService.forGrant}); the draft is never read by
 *    gameplay, and the shipped file is never read by gameplay either.
 *
 * ## Lifecycle
 *
 * Draft → validate → preview → publish → (rollback). Every write takes the
 * equipment-configuration advisory lock and names the draft revision it
 * edited (`expectedDraftRevision`); a stale one is refused with
 * `EquipmentConfigStaleError`. Publish re-validates inside its transaction
 * against the live affix libraries, refuses an unchanged draft, writes an
 * immutable revision and moves the pointer atomically. Rollback republishes an
 * earlier revision's body as a new revision. Every action is an
 * `equipment_admin_events` row.
 *
 * ## Grant consistency
 *
 * `forGrant(tx)` reads the published pointer `FOR SHARE` inside the grant's
 * own transaction: a publish (which locks the row `FOR UPDATE`) waits for
 * grants in flight, and a grant that starts after a publish commits sees the
 * new revision. One grant therefore uses exactly one revision, across every
 * copy it creates. Bodies are immutable, so they are cached by revision id.
 *
 * ## Delayed rewards (E3-C)
 *
 * A reward promised now and paid later (a dungeon run, an expedition) takes
 * a pin when it is promised ({@link EquipmentRollRulesService.pinForReward}):
 * the published rules revision number and the published revision of every
 * affix library those rules assign. Its grant passes the pin back to
 * `forGrant`, which then reads exactly that rules revision (never the
 * pointer), and `affixLibraryForGrant` exactly that library revision. A
 * pinned revision that cannot be found fails closed
 * (`EquipmentRollPinMissingError`); it is never replaced by the latest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  equipmentAdminEvents,
  equipmentAffixLibraries,
  equipmentDefinitions,
  equipmentAffixLibraryRevisions,
  equipmentRollConfig,
  equipmentRollConfigRevisions,
  type EquipmentAdminEventAction,
  type EquipmentAdminSubjectKind,
  type EquipmentConfigRevisionSource,
  type EquipmentRollConfigRevisionRow,
} from '../../db/schema';
import {
  EquipmentConfigConflictError,
  EquipmentConfigInvalidError,
  EquipmentConfigNotFoundError,
  EquipmentConfigStaleError,
  EquipmentRollPinMissingError,
  EquipmentRulesUnavailableError,
  type EquipmentIssue,
} from '../../shared/errors';
import { slotsCovered, type ManagedAffixEntry } from './affixLibraries';
import { definitionRollPolicyIssues, type ResolvedAffixLibrary } from './highRarityRoll';
import {
  EQUIPMENT_COMBAT_BONUS_FILE,
  EquipmentCombatBonusFileSchema,
  type CombatBonusCatalogue,
  type EquipmentCombatBonusFile,
} from './combatBonuses';
import {
  assignedLibraries,
  bootstrapRollRules,
  buildRollRulesExport,
  contentHash,
  diffRollRules,
  legacyCombatBonusCatalogue,
  MANAGED_RULE_RARITIES,
  readRollRulesExport,
  RollRulesSchema,
  validateRollRules,
  type AffixLibraryFacts,
  type EquipmentRollPin,
  type RollRules,
  type RollRulesChange,
  type RollRulesExport,
  type RollRulesValidation,
} from './rollRules';

/** The actor recorded for startup work. */
export const EQUIPMENT_CONFIG_SYSTEM_ACTOR = 'system:bootstrap';
const RULES_SUBJECT = 'roll rules';
const RULES_EVENT_KEY = 'roll_rules';
const CONFIG_ROW_ID = 1;

/**
 * Serialises every managed-configuration write — rules and affix libraries
 * alike, since each validates against the other — and two processes
 * bootstrapping at once. Grants never take it.
 */
const EQUIPMENT_CONFIG_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('equipment_config', 0))`;

export async function lockEquipmentConfig(tx: DbOrTx): Promise<void> {
  await tx.execute(EQUIPMENT_CONFIG_LOCK);
}

/** Append one audit event. */
export async function recordEquipmentAdminEvent(
  tx: DbOrTx,
  subjectKind: EquipmentAdminSubjectKind,
  subjectKey: string,
  action: EquipmentAdminEventAction,
  details: Record<string, unknown>,
  actor: string | null,
): Promise<void> {
  await tx.insert(equipmentAdminEvents).values({ subjectKind, subjectKey, action, actor, details });
}

// ── bootstrap ─────────────────────────────────────────────────────────────

/**
 * The shipped `content/equipment/combatBonuses.json`, validated — the
 * bootstrap source and the drift reference, never a live rule source. Null
 * when the file is not deployed; an invalid file throws, as at content load.
 */
export function loadShippedCombatBonusFile(contentDir: string): EquipmentCombatBonusFile | null {
  const file = path.join(contentDir, ...EQUIPMENT_COMBAT_BONUS_FILE.split('/'));
  if (!fs.existsSync(file)) return null;
  return EquipmentCombatBonusFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export interface RollRulesBootstrapResult {
  status: 'bootstrapped' | 'existing' | 'absent';
  /** The published revision number after the call; null when `absent`. */
  publishedRevision: number | null;
  /** The shipped legacy rules differ from the published ones (left as they are). */
  drift: boolean;
}

/**
 * Initialise the database-authoritative rules once, from the shipped
 * catalogue. Idempotent and safe to call on every start and content reload:
 * an existing configuration is never written. `shipped` null (no catalogue
 * deployed) bootstraps nothing — random gear then fails closed, as it does
 * without the file today.
 */
export async function bootstrapEquipmentRollRules(
  db: Db,
  shipped: EquipmentCombatBonusFile | null,
): Promise<RollRulesBootstrapResult> {
  return db.transaction(async (tx) => {
    await lockEquipmentConfig(tx);
    const [row] = await tx.select().from(equipmentRollConfig).where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
    if (!row) {
      if (!shipped) return { status: 'absent', publishedRevision: null, drift: false };
      const body = bootstrapRollRules(shipped);
      const hash = contentHash(body);
      const [revision] = await tx
        .insert(equipmentRollConfigRevisions)
        .values({
          number: 1,
          body: body as unknown as Record<string, unknown>,
          contentHash: hash,
          source: 'bootstrap',
          draftRevision: 1,
          publishedBy: EQUIPMENT_CONFIG_SYSTEM_ACTOR,
        })
        .returning();
      await tx.insert(equipmentRollConfig).values({
        id: CONFIG_ROW_ID,
        draftBody: body as unknown as Record<string, unknown>,
        draftRevision: 1,
        draftHash: hash,
        publishedRevisionId: revision!.id,
        updatedBy: EQUIPMENT_CONFIG_SYSTEM_ACTOR,
      });
      await recordEquipmentAdminEvent(
        tx,
        'roll_rules',
        RULES_EVENT_KEY,
        'bootstrapped',
        { revision: 1, contentHash: hash, legacyHash: contentHash(shipped) },
        EQUIPMENT_CONFIG_SYSTEM_ACTOR,
      );
      return { status: 'bootstrapped', publishedRevision: 1, drift: false };
    }

    const published = await revisionById(tx, row.publishedRevisionId);
    const rules = parseStoredRules(published);
    const drift = shipped != null && contentHash(shipped) !== contentHash(rules.legacy);
    if (drift) {
      // Record each distinct shipped content once, not on every restart.
      const shippedHash = contentHash(shipped);
      const [last] = await tx
        .select({ details: equipmentAdminEvents.details })
        .from(equipmentAdminEvents)
        .where(sql`${equipmentAdminEvents.subjectKind} = 'roll_rules' and ${equipmentAdminEvents.action} = 'drift_detected'`)
        .orderBy(desc(equipmentAdminEvents.id))
        .limit(1);
      if (last?.details.shippedLegacyHash !== shippedHash) {
        await recordEquipmentAdminEvent(
          tx,
          'roll_rules',
          RULES_EVENT_KEY,
          'drift_detected',
          { shippedLegacyHash: shippedHash, publishedLegacyHash: contentHash(rules.legacy), publishedRevision: published.number },
          EQUIPMENT_CONFIG_SYSTEM_ACTOR,
        );
      }
    }
    return { status: 'existing', publishedRevision: published.number, drift };
  });
}

// ── reads ─────────────────────────────────────────────────────────────────

async function revisionById(tx: DbOrTx, id: number): Promise<EquipmentRollConfigRevisionRow> {
  const [row] = await tx.select().from(equipmentRollConfigRevisions).where(eq(equipmentRollConfigRevisions.id, id));
  if (!row) throw new Error(`equipment roll rules revision id ${id} is missing`);
  return row;
}

/** A stored body is trusted only after it parses: a corrupted one fails loudly rather than rolling from it. */
function parseStoredRules(row: { body: unknown; number?: number }): RollRules {
  const parsed = RollRulesSchema.safeParse(row.body);
  if (!parsed.success) {
    throw new Error(`stored equipment roll rules${row.number ? ` revision ${row.number}` : ''} do not parse: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** The published rules and revision number, or null before bootstrap. For services that validate against them. */
export async function readPublishedRollRules(tx: DbOrTx): Promise<{ revision: number; rules: RollRules } | null> {
  const [row] = await tx.select().from(equipmentRollConfig).where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
  if (!row) return null;
  const revision = await revisionById(tx, row.publishedRevisionId);
  return { revision: revision.number, rules: parseStoredRules(revision) };
}

/** Managed libraries as rules validation sees them: published, and which slots their published entries cover. */
export async function readAffixLibraryFacts(tx: DbOrTx): Promise<Map<string, AffixLibraryFacts>> {
  const rows = await tx
    .select({ key: equipmentAffixLibraries.key, entries: equipmentAffixLibraryRevisions.entries })
    .from(equipmentAffixLibraries)
    .leftJoin(equipmentAffixLibraryRevisions, eq(equipmentAffixLibraryRevisions.id, equipmentAffixLibraries.publishedRevisionId));
  return new Map(
    rows.map((r) => [
      r.key,
      { published: r.entries != null, slotsCovered: slotsCovered((r.entries ?? []) as ManagedAffixEntry[]) },
    ]),
  );
}

export interface PublishedRollRules {
  /** The published revision number — what a grant records for diagnostics. */
  revision: number;
  contentHash: string;
  publishedAt: Date;
  publishedBy: string | null;
  source: EquipmentConfigRevisionSource;
  rules: RollRules;
}

export interface DraftRollRules {
  draftRevision: number;
  contentHash: string;
  rules: RollRules;
  /** The published revision the draft would replace. */
  publishedRevision: number;
  /** The draft differs from the published configuration. */
  dirty: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface RollRulesRevisionSummary {
  revision: number;
  contentHash: string;
  source: EquipmentConfigRevisionSource;
  rolledBackFrom: number | null;
  publishedBy: string | null;
  publishedAt: Date;
  /** The revision live grants read now. */
  current: boolean;
}

export interface RollRulesPreview {
  /** Validation of the draft against the live libraries. */
  validation: RollRulesValidation;
  /** What publishing the draft would change, field by field. */
  changes: RollRulesChange[];
  draftRevision: number;
  publishedRevision: number;
}

/** What one grant rolls from — a single published revision. */
export interface GrantRollRules {
  revision: number;
  /** The frozen N/R/SR catalogue, for the unchanged legacy roll. */
  combatBonuses: CombatBonusCatalogue;
  rules: RollRules;
  /**
   * Set when the grant was pinned: the library revisions the pin recorded,
   * which `affixLibraryForGrant` must use. Null for a live (unpinned) grant.
   */
  pinnedLibraries: Readonly<Record<string, number>> | null;
}

export interface EquipmentRollRulesService {
  published(): Promise<PublishedRollRules>;
  draft(): Promise<DraftRollRules>;
  /** Replace the draft. Schema-checked and N/R/SR-immutable; never reaches live grants. */
  saveDraft(rules: unknown, opts: { expectedDraftRevision: number; actor: string | null }): Promise<DraftRollRules>;
  /** Validate the given document, or the saved draft, against the live libraries. */
  validate(rules?: unknown): Promise<RollRulesValidation>;
  preview(rules?: unknown): Promise<RollRulesPreview>;
  publish(opts: { expectedDraftRevision: number; actor: string | null }): Promise<PublishedRollRules>;
  revisions(): Promise<RollRulesRevisionSummary[]>;
  /** Publish an earlier revision's body again, as a new revision; the draft becomes it too. */
  rollback(revision: number, opts: { expectedDraftRevision: number; actor: string | null }): Promise<PublishedRollRules>;
  export(kind: 'published' | 'draft', now?: Date): Promise<RollRulesExport>;
  /** Validate an export file and make it the draft. Never publishes. */
  importDraft(raw: unknown, opts: { expectedDraftRevision: number; actor: string | null }): Promise<DraftRollRules & { handEdited: boolean }>;
  /**
   * The rules a grant rolls from, inside its transaction: the published
   * revision (pointer read `FOR SHARE`), or — with a pin — exactly the pinned
   * revision. A missing pinned revision throws `EquipmentRollPinMissingError`.
   */
  forGrant(tx: DbOrTx, pin?: EquipmentRollPin | null): Promise<GrantRollRules>;
  /**
   * One managed library's entries for a grant: the published revision (row
   * read `FOR SHARE`, so a library publish waits for the grant), or the
   * revision the grant's pin recorded. Null when an unpinned grant names a
   * library that does not exist or has never been published — the roll then
   * fails closed. A pinned revision that is missing throws.
   */
  affixLibraryForGrant(tx: DbOrTx, rules: GrantRollRules, libraryKey: string): Promise<ResolvedAffixLibrary | null>;
  /**
   * The pin a delayed reward stores when it is promised: the published rules
   * revision and the published revision of every library those rules assign.
   * Null when the database has no rules yet (the grant will fail closed then
   * anyway).
   */
  pinForReward(tx: DbOrTx): Promise<EquipmentRollPin | null>;
  /** The published flat SP limits, for the live per-loadout clamp; null before bootstrap. */
  flatSpLimits(tx: DbOrTx): Promise<RollRules['flatSpLimits'] | null>;
}

export function createEquipmentRollRulesService(deps: { db: Db }): EquipmentRollRulesService {
  const { db } = deps;
  /** Published bodies by revision id. Revisions are immutable, so an entry never goes stale. */
  const cache = new Map<number, GrantRollRules>();
  /** The same, by revision number, for pinned grants. */
  const pinnedCache = new Map<number, GrantRollRules>();

  function grantEntry(revision: EquipmentRollConfigRevisionRow): GrantRollRules {
    const rules = parseStoredRules(revision);
    return { revision: revision.number, rules, combatBonuses: legacyCombatBonusCatalogue(rules), pinnedLibraries: null };
  }

  async function libraryForGrant(tx: DbOrTx, rules: GrantRollRules, libraryKey: string): Promise<ResolvedAffixLibrary | null> {
    if (rules.pinnedLibraries) {
      const number = rules.pinnedLibraries[libraryKey];
      if (number === undefined) {
        throw new EquipmentRollPinMissingError(`affix library "${libraryKey}" (the pin records no revision of it)`);
      }
      const [rev] = await tx
        .select()
        .from(equipmentAffixLibraryRevisions)
        .where(and(eq(equipmentAffixLibraryRevisions.libraryKey, libraryKey), eq(equipmentAffixLibraryRevisions.number, number)));
      if (!rev) throw new EquipmentRollPinMissingError(`affix library "${libraryKey}" revision ${number}`);
      return { key: libraryKey, revision: rev.number, entries: rev.entries as ManagedAffixEntry[] };
    }
    const [lib] = await tx
      .select()
      .from(equipmentAffixLibraries)
      .where(eq(equipmentAffixLibraries.key, libraryKey))
      .for('share');
    if (lib?.publishedRevisionId == null) return null;
    const [rev] = await tx
      .select()
      .from(equipmentAffixLibraryRevisions)
      .where(eq(equipmentAffixLibraryRevisions.id, lib.publishedRevisionId));
    return rev ? { key: libraryKey, revision: rev.number, entries: rev.entries as ManagedAffixEntry[] } : null;
  }

  async function configRow(tx: DbOrTx, lock: 'update' | 'share' | null) {
    const query = tx.select().from(equipmentRollConfig).where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
    const [row] = lock === 'update' ? await query.for('update') : lock === 'share' ? await query.for('share') : await query;
    if (!row) throw new EquipmentRulesUnavailableError();
    return row;
  }

  function toPublished(row: EquipmentRollConfigRevisionRow): PublishedRollRules {
    return {
      revision: row.number,
      contentHash: row.contentHash,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      source: row.source,
      rules: parseStoredRules(row),
    };
  }

  async function readPublished(tx: DbOrTx): Promise<PublishedRollRules> {
    const row = await configRow(tx, null);
    return toPublished(await revisionById(tx, row.publishedRevisionId));
  }

  async function readDraft(tx: DbOrTx): Promise<DraftRollRules> {
    const row = await configRow(tx, null);
    const published = await revisionById(tx, row.publishedRevisionId);
    return {
      draftRevision: row.draftRevision,
      contentHash: row.draftHash,
      rules: parseStoredRules({ body: row.draftBody }),
      publishedRevision: published.number,
      dirty: row.draftHash !== published.contentHash,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  function assertFresh(current: number, expected: number): void {
    if (current !== expected) throw new EquipmentConfigStaleError(RULES_SUBJECT, expected, current);
  }

  async function validateAgainstLive(tx: DbOrTx, raw: unknown): Promise<RollRulesValidation> {
    const row = await configRow(tx, null);
    const published = parseStoredRules(await revisionById(tx, row.publishedRevisionId));
    const validation = validateRollRules(raw, { publishedLegacy: published.legacy, libraries: await readAffixLibraryFacts(tx) });
    if (!validation.value) return validation;
    // Every enabled SSR/UR/LR definition must still be able to roll under
    // the new rules: its own maximum must leave a count with positive weight.
    const definitions = await tx
      .select({
        key: equipmentDefinitions.key,
        rarity: equipmentDefinitions.rarity,
        maxAdditionalBonuses: equipmentDefinitions.maxAdditionalBonuses,
      })
      .from(equipmentDefinitions)
      .where(and(eq(equipmentDefinitions.enabled, true), inArray(equipmentDefinitions.rarity, [...MANAGED_RULE_RARITIES])));
    const errors = [...validation.errors];
    for (const definition of definitions) {
      for (const issue of definitionRollPolicyIssues(definition, validation.value)) {
        errors.push({ path: `rarities.${definition.rarity}.bonusCountWeightsBp`, message: issue.message });
      }
    }
    return { ...validation, ok: errors.length === 0, errors };
  }

  async function writeDraft(
    raw: unknown,
    opts: { expectedDraftRevision: number; actor: string | null },
    action: 'draft_saved' | 'draft_imported',
  ): Promise<DraftRollRules> {
    return db.transaction(async (tx) => {
      await lockEquipmentConfig(tx);
      const row = await configRow(tx, 'update');
      assertFresh(row.draftRevision, opts.expectedDraftRevision);
      const published = parseStoredRules(await revisionById(tx, row.publishedRevisionId));
      // Draft-level rules only: shape, and N/R/SR untouched. Library and
      // feasibility rules are publish-time (`validate` reports them early).
      const checked = validateRollRules(raw, { publishedLegacy: published.legacy });
      const blocking = checked.value ? checked.errors.filter((e) => e.path === 'legacy') : checked.errors;
      if (!checked.value || blocking.length > 0) throw new EquipmentConfigInvalidError(RULES_SUBJECT, blocking);
      const hash = contentHash(checked.value);
      await tx
        .update(equipmentRollConfig)
        .set({
          draftBody: checked.value as unknown as Record<string, unknown>,
          draftRevision: row.draftRevision + 1,
          draftHash: hash,
          updatedAt: sql`now()`,
          updatedBy: opts.actor,
        })
        .where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
      await recordEquipmentAdminEvent(
        tx,
        'roll_rules',
        RULES_EVENT_KEY,
        action,
        { draftRevision: row.draftRevision + 1, contentHash: hash },
        opts.actor,
      );
      return readDraft(tx);
    });
  }

  async function publishBody(
    tx: DbOrTx,
    rules: RollRules,
    meta: { source: EquipmentConfigRevisionSource; actor: string | null; draftRevision: number; rolledBackFrom: number | null },
  ): Promise<EquipmentRollConfigRevisionRow> {
    const [last] = await tx
      .select({ number: equipmentRollConfigRevisions.number })
      .from(equipmentRollConfigRevisions)
      .orderBy(desc(equipmentRollConfigRevisions.number))
      .limit(1);
    const [revision] = await tx
      .insert(equipmentRollConfigRevisions)
      .values({
        number: (last?.number ?? 0) + 1,
        body: rules as unknown as Record<string, unknown>,
        contentHash: contentHash(rules),
        source: meta.source,
        rolledBackFrom: meta.rolledBackFrom,
        draftRevision: meta.draftRevision,
        publishedBy: meta.actor,
      })
      .returning();
    return revision!;
  }

  return {
    published: () => readPublished(db),

    draft: () => readDraft(db),

    saveDraft: (rules, opts) => writeDraft(rules, opts, 'draft_saved'),

    async validate(rules) {
      const raw = rules === undefined ? (await configRow(db, null)).draftBody : rules;
      return validateAgainstLive(db, raw);
    },

    async preview(rules) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const row = await configRow(tx, null);
        const published = await revisionById(tx, row.publishedRevisionId);
        const validation = await validateAgainstLive(tx, rules === undefined ? row.draftBody : rules);
        return {
          validation,
          changes: validation.value ? diffRollRules(parseStoredRules(published), validation.value) : [],
          draftRevision: row.draftRevision,
          publishedRevision: published.number,
        };
      });
    },

    async publish(opts) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const row = await configRow(tx, 'update');
        assertFresh(row.draftRevision, opts.expectedDraftRevision);
        const current = await revisionById(tx, row.publishedRevisionId);
        if (row.draftHash === current.contentHash) {
          throw new EquipmentConfigConflictError(RULES_SUBJECT, 'the draft is identical to the published rules; there is nothing to publish');
        }
        const validation = await validateAgainstLive(tx, row.draftBody);
        if (!validation.ok || !validation.value) throw new EquipmentConfigInvalidError(RULES_SUBJECT, validation.errors);
        const revision = await publishBody(tx, validation.value, {
          source: 'editor',
          actor: opts.actor,
          draftRevision: row.draftRevision,
          rolledBackFrom: null,
        });
        await tx
          .update(equipmentRollConfig)
          .set({ publishedRevisionId: revision.id, updatedAt: sql`now()` })
          .where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
        await recordEquipmentAdminEvent(
          tx,
          'roll_rules',
          RULES_EVENT_KEY,
          'published',
          {
            revision: revision.number,
            previousRevision: current.number,
            contentHash: revision.contentHash,
            changes: diffRollRules(parseStoredRules(current), validation.value).map((c) => c.path),
            warnings: validation.warnings,
          },
          opts.actor,
        );
        return toPublished(revision);
      });
    },

    async revisions() {
      const row = await configRow(db, null);
      const rows = await db.select().from(equipmentRollConfigRevisions).orderBy(desc(equipmentRollConfigRevisions.number));
      const numberById = new Map(rows.map((r) => [r.id, r.number]));
      return rows.map((r) => ({
        revision: r.number,
        contentHash: r.contentHash,
        source: r.source,
        rolledBackFrom: r.rolledBackFrom == null ? null : (numberById.get(r.rolledBackFrom) ?? null),
        publishedBy: r.publishedBy,
        publishedAt: r.publishedAt,
        current: r.id === row.publishedRevisionId,
      }));
    },

    async rollback(target, opts) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const row = await configRow(tx, 'update');
        assertFresh(row.draftRevision, opts.expectedDraftRevision);
        const [old] = await tx
          .select()
          .from(equipmentRollConfigRevisions)
          .where(eq(equipmentRollConfigRevisions.number, target));
        if (!old) throw new EquipmentConfigNotFoundError(`${RULES_SUBJECT} revision ${target}`);
        const current = await revisionById(tx, row.publishedRevisionId);
        if (old.id === current.id) {
          throw new EquipmentConfigConflictError(RULES_SUBJECT, `revision ${target} is already the published revision`);
        }
        // Re-validated against today's libraries: a library the old rules
        // name may have changed since.
        const validation = await validateAgainstLive(tx, old.body);
        if (!validation.ok || !validation.value) throw new EquipmentConfigInvalidError(RULES_SUBJECT, validation.errors);
        const revision = await publishBody(tx, validation.value, {
          source: 'rollback',
          actor: opts.actor,
          draftRevision: row.draftRevision + 1,
          rolledBackFrom: old.id,
        });
        await tx
          .update(equipmentRollConfig)
          .set({
            publishedRevisionId: revision.id,
            draftBody: validation.value as unknown as Record<string, unknown>,
            draftRevision: row.draftRevision + 1,
            draftHash: revision.contentHash,
            updatedAt: sql`now()`,
            updatedBy: opts.actor,
          })
          .where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
        await recordEquipmentAdminEvent(
          tx,
          'roll_rules',
          RULES_EVENT_KEY,
          'rolled_back',
          { revision: revision.number, restoredRevision: old.number, previousRevision: current.number },
          opts.actor,
        );
        return toPublished(revision);
      });
    },

    async export(kind, now = new Date()) {
      if (kind === 'published') {
        const published = await readPublished(db);
        return buildRollRulesExport(published.rules, { kind, revision: published.revision, exportedAt: now.toISOString() });
      }
      const draft = await readDraft(db);
      return buildRollRulesExport(draft.rules, { kind, revision: draft.draftRevision, exportedAt: now.toISOString() });
    },

    async importDraft(raw, opts) {
      const read = readRollRulesExport(raw);
      if (read.issues.length > 0) throw new EquipmentConfigInvalidError(RULES_SUBJECT, read.issues);
      const draft = await writeDraft(read.config, opts, 'draft_imported');
      return { ...draft, handEdited: read.handEdited };
    },

    async forGrant(tx, pin) {
      if (pin) {
        let entry = pinnedCache.get(pin.rulesRevision);
        if (!entry) {
          const [revision] = await tx
            .select()
            .from(equipmentRollConfigRevisions)
            .where(eq(equipmentRollConfigRevisions.number, pin.rulesRevision));
          if (!revision) throw new EquipmentRollPinMissingError(`roll rules revision ${pin.rulesRevision}`);
          entry = grantEntry(revision);
          pinnedCache.set(pin.rulesRevision, entry);
        }
        return { ...entry, pinnedLibraries: pin.affixLibraryRevisions };
      }
      const row = await configRow(tx, 'share');
      const cached = cache.get(row.publishedRevisionId);
      if (cached) return cached;
      const entry = grantEntry(await revisionById(tx, row.publishedRevisionId));
      cache.set(row.publishedRevisionId, entry);
      return entry;
    },

    affixLibraryForGrant: libraryForGrant,

    async pinForReward(tx) {
      const [row] = await tx.select().from(equipmentRollConfig).where(eq(equipmentRollConfig.id, CONFIG_ROW_ID)).for('share');
      if (!row) return null;
      const revision = await revisionById(tx, row.publishedRevisionId);
      const live = grantEntry(revision);
      const affixLibraryRevisions: Record<string, number> = {};
      for (const key of [...assignedLibraries(live.rules).keys()].sort()) {
        const library = await libraryForGrant(tx, live, key);
        // Publish validation keeps every assigned library published; one that
        // is not stays out of the pin, and the grant refuses it as it would live.
        if (library) affixLibraryRevisions[key] = library.revision;
      }
      return { rulesRevision: revision.number, affixLibraryRevisions };
    },

    async flatSpLimits(tx) {
      const [row] = await tx.select().from(equipmentRollConfig).where(eq(equipmentRollConfig.id, CONFIG_ROW_ID));
      if (!row) return null;
      let entry = cache.get(row.publishedRevisionId);
      if (!entry) {
        entry = grantEntry(await revisionById(tx, row.publishedRevisionId));
        cache.set(row.publishedRevisionId, entry);
      }
      return entry.rules.flatSpLimits;
    },
  };
}

/** Issues as a flat list, for logs. */
export function describeIssues(issues: readonly EquipmentIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}
