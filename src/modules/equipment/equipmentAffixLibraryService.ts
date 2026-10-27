/**
 * Managed affix libraries — storage and lifecycle (Equipment 3.0).
 *
 * One `equipment_affix_libraries` row per library holds its metadata, draft
 * entries and the pointer to its published revision; every publish writes an
 * immutable `equipment_affix_library_revisions` row. The lifecycle is the
 * roll rules' own — draft (`expectedDraftRevision`), validate, publish,
 * history, rollback, export/import — under the same advisory lock and into
 * the same `equipment_admin_events` trail, but **versioned per library**:
 * affixes are flavour, and what a library *does* (which rarities draw from it)
 * is decided by the published roll rules, not here.
 *
 * Rules this service enforces:
 *
 *  - Keys and suffixes are unique across every library and the shipped
 *    catalogue (`affixLibraries.ts`); an affix key once published in another
 *    library stays reserved for it.
 *  - A library the **published rules** assign to a rarity can never be
 *    published (or rolled back) into a state that leaves a slot with no
 *    enabled affix: the assignment must be changed first.
 *  - Nothing here touches the shipped N/R/SR catalogue, which is only ever
 *    *shown* ({@link EquipmentAffixLibraryService.list}) as read-only.
 *
 * Owned copies are unaffected by any of this: a copy rolled from a managed
 * library keeps its suffix snapshot (`rolled_properties.affixSuffix`).
 */
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  equipmentAffixLibraries,
  equipmentAffixLibraryRevisions,
  type EquipmentAffixLibraryRevisionRow,
  type EquipmentAffixLibraryRow,
  type EquipmentConfigRevisionSource,
} from '../../db/schema';
import {
  EquipmentConfigConflictError,
  EquipmentConfigInvalidError,
  EquipmentConfigNotFoundError,
  EquipmentConfigStaleError,
  type EquipmentIssue,
} from '../../shared/errors';
import type { EquipmentAffixCatalogue } from './affixCatalogue';
import {
  buildAffixLibraryExport,
  LibraryKeySchema,
  LibraryMetaSchema,
  legacyAffixLibraries,
  legacyNamespace,
  libraryContentHash,
  ManagedAffixEntrySchema,
  readAffixLibraryExport,
  slotsCovered,
  validateLibraryEntries,
  type AffixLibraryExport,
  type AffixNamespace,
  type LibraryMeta,
  type ManagedAffixEntry,
  type ReadOnlyAffixLibrary,
} from './affixLibraries';
import { lockEquipmentConfig, readPublishedRollRules, recordEquipmentAdminEvent } from './equipmentRollRulesService';
import { assignedLibraries, contentHash, LEGACY_RULE_RARITIES, MANAGED_RULE_RARITIES, type ManagedRuleRarity } from './rollRules';
import { EQUIPMENT_SLOTS } from './vocabulary';

const subject = (key: string) => `affix library "${key}"`;

export interface ManagedLibrarySummary {
  key: string;
  name: string;
  description: string;
  readOnly: false;
  draftRevision: number;
  /** Null until first published. */
  publishedRevision: number | null;
  /** The draft differs from the published revision (or nothing is published yet). */
  dirty: boolean;
  draftEntryCount: number;
  publishedEntryCount: number;
  /** Rarities the published rules draw from this library. */
  assignedTo: ManagedRuleRarity[];
}

export interface ManagedLibraryDetail extends ManagedLibrarySummary {
  draftEntries: ManagedAffixEntry[];
  publishedEntries: ManagedAffixEntry[];
  updatedAt: Date;
  updatedBy: string | null;
}

export interface LibraryRevisionSummary {
  revision: number;
  contentHash: string;
  source: Exclude<EquipmentConfigRevisionSource, 'bootstrap'>;
  rolledBackFrom: number | null;
  entryCount: number;
  publishedBy: string | null;
  publishedAt: Date;
  current: boolean;
}

export interface LibraryValidation {
  ok: boolean;
  errors: EquipmentIssue[];
}

export interface LibraryPreview {
  draftRevision: number;
  publishedRevision: number | null;
  validation: LibraryValidation;
  changes: { path: string; before: unknown; after: unknown }[];
}

/** Where a rarity's affixes come from, per the published rules. */
export type RarityAffixSource =
  | { mode: 'legacy'; rarity: 'N' | 'R' | 'SR' }
  | { mode: 'none' }
  | { mode: 'library'; library: string; libraryRevision: number; entries: ManagedAffixEntry[] }
  /** The rarity has no published rule (random rolls of it stay disabled). */
  | { mode: 'unconfigured' };

export interface EquipmentAffixLibraryService {
  /** Managed libraries, then the shipped catalogue's read-only libraries. */
  list(): Promise<{ managed: ManagedLibrarySummary[]; legacy: ReadOnlyAffixLibrary[] }>;
  get(key: string): Promise<ManagedLibraryDetail>;
  create(input: { key: string } & Partial<LibraryMeta>, opts: { actor: string | null }): Promise<ManagedLibraryDetail>;
  /** Rename or re-describe. Part of the draft: published with the next publish. */
  updateMeta(key: string, meta: unknown, opts: { expectedDraftRevision: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  /** Replace the draft entries. */
  saveDraft(key: string, entries: unknown, opts: { expectedDraftRevision: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  /** Add an entry, or replace the one with the same key. */
  upsertEntry(key: string, entry: unknown, opts: { expectedDraftRevision: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  validate(key: string): Promise<LibraryValidation>;
  preview(key: string): Promise<LibraryPreview>;
  publish(key: string, opts: { expectedDraftRevision: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  revisions(key: string): Promise<LibraryRevisionSummary[]>;
  rollback(key: string, revision: number, opts: { expectedDraftRevision: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  export(key: string, kind: 'published' | 'draft', now?: Date): Promise<AffixLibraryExport>;
  /**
   * Import an export file into its library's draft — creating the library
   * when its key is new. Never publishes. An existing library needs its
   * current `expectedDraftRevision`.
   */
  importDraft(raw: unknown, opts: { expectedDraftRevision?: number; actor: string | null }): Promise<ManagedLibraryDetail>;
  /** The affix source a rarity's random rolls would use under the published rules. */
  resolveAssignment(rarity: string, tx?: DbOrTx): Promise<RarityAffixSource>;
}

export function createEquipmentAffixLibraryService(deps: {
  db: Db;
  /** The shipped N/R/SR catalogue, read live. */
  getLegacyAffixes(): EquipmentAffixCatalogue;
}): EquipmentAffixLibraryService {
  const { db } = deps;

  async function row(tx: DbOrTx, key: string, lock = false): Promise<EquipmentAffixLibraryRow> {
    const query = tx.select().from(equipmentAffixLibraries).where(eq(equipmentAffixLibraries.key, key));
    const [found] = lock ? await query.for('update') : await query;
    if (!found) throw new EquipmentConfigNotFoundError(subject(key));
    return found;
  }

  async function publishedRevision(tx: DbOrTx, lib: EquipmentAffixLibraryRow): Promise<EquipmentAffixLibraryRevisionRow | null> {
    if (lib.publishedRevisionId == null) return null;
    const [rev] = await tx
      .select()
      .from(equipmentAffixLibraryRevisions)
      .where(eq(equipmentAffixLibraryRevisions.id, lib.publishedRevisionId));
    return rev ?? null;
  }

  const draftHashOf = (lib: Pick<EquipmentAffixLibraryRow, 'name' | 'description'>, entries: readonly ManagedAffixEntry[]) =>
    libraryContentHash({ name: lib.name, description: lib.description }, entries);

  async function assignments(tx: DbOrTx): Promise<Map<string, ManagedRuleRarity[]>> {
    const published = await readPublishedRollRules(tx);
    return published ? assignedLibraries(published.rules) : new Map();
  }

  async function detail(tx: DbOrTx, lib: EquipmentAffixLibraryRow, assigned?: Map<string, ManagedRuleRarity[]>): Promise<ManagedLibraryDetail> {
    const rev = await publishedRevision(tx, lib);
    const draftEntries = lib.draftEntries as ManagedAffixEntry[];
    const publishedEntries = (rev?.entries ?? []) as ManagedAffixEntry[];
    return {
      key: lib.key,
      name: lib.name,
      description: lib.description,
      readOnly: false,
      draftRevision: lib.draftRevision,
      publishedRevision: rev?.number ?? null,
      dirty: rev == null || rev.contentHash !== lib.draftHash,
      draftEntryCount: draftEntries.length,
      publishedEntryCount: publishedEntries.length,
      assignedTo: (assigned ?? (await assignments(tx))).get(lib.key) ?? [],
      draftEntries,
      publishedEntries,
      updatedAt: lib.updatedAt,
      updatedBy: lib.updatedBy,
    };
  }

  /**
   * Every key and suffix this library must not reuse: the shipped catalogue's,
   * and every other library's — its draft, its published entries, and (keys
   * only) anything it ever published.
   */
  async function namespaceExcluding(tx: DbOrTx, key: string): Promise<AffixNamespace> {
    const legacy = legacyNamespace(deps.getLegacyAffixes());
    const keys = new Map(legacy.keys);
    const suffixes = new Map(legacy.suffixes);
    const others = await tx.select().from(equipmentAffixLibraries).where(ne(equipmentAffixLibraries.key, key));
    const history = await tx
      .select({ libraryKey: equipmentAffixLibraryRevisions.libraryKey, id: equipmentAffixLibraryRevisions.id, entries: equipmentAffixLibraryRevisions.entries })
      .from(equipmentAffixLibraryRevisions)
      .where(ne(equipmentAffixLibraryRevisions.libraryKey, key));
    for (const rev of history) {
      for (const e of rev.entries as ManagedAffixEntry[]) keys.set(e.key, `affix library "${rev.libraryKey}"`);
    }
    for (const other of others) {
      const owner = `affix library "${other.key}"`;
      const current = [
        ...(other.draftEntries as ManagedAffixEntry[]),
        ...((history.find((h) => h.id === other.publishedRevisionId)?.entries ?? []) as ManagedAffixEntry[]),
      ];
      for (const e of current) {
        keys.set(e.key, owner);
        suffixes.set(e.suffix.toLowerCase(), owner);
      }
    }
    return { keys, suffixes };
  }

  function assertFresh(key: string, current: number, expected: number): void {
    if (current !== expected) throw new EquipmentConfigStaleError(subject(key), expected, current);
  }

  /** Entry errors, plus — for a library the published rules use — slot coverage. */
  async function publishIssues(tx: DbOrTx, key: string, entries: unknown): Promise<{ entries: ManagedAffixEntry[] | null; errors: EquipmentIssue[] }> {
    const checked = validateLibraryEntries(entries, await namespaceExcluding(tx, key));
    if (!checked.value) return { entries: null, errors: checked.errors };
    const errors = [...checked.errors];
    const usedBy = (await assignments(tx)).get(key) ?? [];
    if (usedBy.length > 0) {
      const covered = slotsCovered(checked.value);
      const missing = EQUIPMENT_SLOTS.filter((slot) => !covered.has(slot));
      if (missing.length > 0) {
        errors.push({
          path: 'entries',
          message:
            `the published rules draw ${usedBy.join(', ')} affixes from this library; ` +
            `it must keep an enabled affix for ${missing.join(', ')} gear — change the assignment first`,
        });
      }
    }
    return { entries: checked.value, errors };
  }

  async function writeDraft(
    key: string,
    opts: { expectedDraftRevision: number; actor: string | null },
    change: (lib: EquipmentAffixLibraryRow) => { entries: unknown; meta?: LibraryMeta },
    action: 'draft_saved' | 'draft_imported' | 'updated',
    transaction?: DbOrTx,
  ): Promise<ManagedLibraryDetail> {
    const apply = async (tx: DbOrTx) => {
      await lockEquipmentConfig(tx);
      const lib = await row(tx, key, true);
      assertFresh(key, lib.draftRevision, opts.expectedDraftRevision);
      const next = change(lib);
      const meta = next.meta ?? { name: lib.name, description: lib.description };
      const checked = validateLibraryEntries(next.entries, await namespaceExcluding(tx, key));
      if (!checked.value || !checked.ok) throw new EquipmentConfigInvalidError(subject(key), checked.errors);
      const hash = draftHashOf(meta, checked.value);
      const [updated] = await tx
        .update(equipmentAffixLibraries)
        .set({
          name: meta.name,
          description: meta.description,
          draftEntries: checked.value as unknown as Record<string, unknown>[],
          draftRevision: lib.draftRevision + 1,
          draftHash: hash,
          updatedAt: new Date(),
          updatedBy: opts.actor,
        })
        .where(eq(equipmentAffixLibraries.key, key))
        .returning();
      await recordEquipmentAdminEvent(
        tx,
        'affix_library',
        key,
        action,
        { draftRevision: lib.draftRevision + 1, contentHash: hash, entryCount: checked.value.length },
        opts.actor,
      );
      return detail(tx, updated!);
    };
    return transaction ? apply(transaction) : db.transaction(apply);
  }

  async function publishEntries(
    tx: DbOrTx,
    lib: EquipmentAffixLibraryRow,
    content: { name: string; description: string; entries: ManagedAffixEntry[] },
    meta: { source: 'editor' | 'import' | 'rollback'; actor: string | null; rolledBackFrom: number | null; draftRevision: number },
  ): Promise<EquipmentAffixLibraryRevisionRow> {
    const [last] = await tx
      .select({ number: equipmentAffixLibraryRevisions.number })
      .from(equipmentAffixLibraryRevisions)
      .where(eq(equipmentAffixLibraryRevisions.libraryKey, lib.key))
      .orderBy(desc(equipmentAffixLibraryRevisions.number))
      .limit(1);
    const [rev] = await tx
      .insert(equipmentAffixLibraryRevisions)
      .values({
        libraryKey: lib.key,
        number: (last?.number ?? 0) + 1,
        name: content.name,
        description: content.description,
        entries: content.entries as unknown as Record<string, unknown>[],
        contentHash: draftHashOf(content, content.entries),
        source: meta.source,
        rolledBackFrom: meta.rolledBackFrom,
        draftRevision: meta.draftRevision,
        publishedBy: meta.actor,
      })
      .returning();
    return rev!;
  }

  async function createIn(tx: DbOrTx, key: string, meta: LibraryMeta, actor: string | null): Promise<EquipmentAffixLibraryRow> {
    const [existing] = await tx.select().from(equipmentAffixLibraries).where(eq(equipmentAffixLibraries.key, key));
    if (existing) throw new EquipmentConfigConflictError(subject(key), 'a library with this key already exists');
    const [created] = await tx
      .insert(equipmentAffixLibraries)
      .values({
        key,
        name: meta.name,
        description: meta.description,
        draftEntries: [],
        draftRevision: 1,
        draftHash: draftHashOf(meta, []),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    await recordEquipmentAdminEvent(tx, 'affix_library', key, 'created', { name: meta.name }, actor);
    return created!;
  }

  function parseKey(key: unknown): string {
    const parsed = LibraryKeySchema.safeParse(key);
    if (!parsed.success) {
      throw new EquipmentConfigInvalidError(subject(String(key)), parsed.error.issues.map((i) => ({ path: 'key', message: i.message })));
    }
    return parsed.data;
  }

  function parseMeta(key: string, raw: unknown): LibraryMeta {
    const parsed = LibraryMetaSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EquipmentConfigInvalidError(
        subject(key),
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'library', message: i.message })),
      );
    }
    return parsed.data;
  }

  return {
    async list() {
      const rows = await db.select().from(equipmentAffixLibraries).orderBy(asc(equipmentAffixLibraries.key));
      const assigned = await assignments(db);
      const managed: ManagedLibrarySummary[] = [];
      for (const lib of rows) {
        const { draftEntries: _d, publishedEntries: _p, updatedAt: _u, updatedBy: _b, ...summary } = await detail(db, lib, assigned);
        managed.push(summary);
      }
      return { managed, legacy: legacyAffixLibraries(deps.getLegacyAffixes()) };
    },

    async get(key) {
      return detail(db, await row(db, key));
    },

    async create(input, opts) {
      const key = parseKey(input.key);
      const meta = parseMeta(key, { name: input.name ?? key, description: input.description ?? '' });
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        return detail(tx, await createIn(tx, key, meta, opts.actor));
      });
    },

    updateMeta(key, raw, opts) {
      const meta = parseMeta(key, raw);
      return writeDraft(key, opts, (lib) => ({ entries: lib.draftEntries, meta }), 'updated');
    },

    saveDraft(key, entries, opts) {
      return writeDraft(key, opts, () => ({ entries }), 'draft_saved');
    },

    upsertEntry(key, entry, opts) {
      const parsed = ManagedAffixEntrySchema.safeParse(entry);
      if (!parsed.success) {
        throw new EquipmentConfigInvalidError(
          subject(key),
          parsed.error.issues.map((i) => ({ path: ['entry', ...i.path].join('.'), message: i.message })),
        );
      }
      return writeDraft(
        key,
        opts,
        (lib) => {
          const current = lib.draftEntries as ManagedAffixEntry[];
          const at = current.findIndex((e) => e.key === parsed.data.key);
          const entries = at === -1 ? [...current, parsed.data] : current.map((e, i) => (i === at ? parsed.data : e));
          return { entries };
        },
        'draft_saved',
      );
    },

    async validate(key) {
      const lib = await row(db, key);
      const { errors } = await publishIssues(db, key, lib.draftEntries);
      return { ok: errors.length === 0, errors };
    },

    async preview(key) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const lib = await row(tx, key);
        const published = await publishedRevision(tx, lib);
        const { errors } = await publishIssues(tx, key, lib.draftEntries);
        const changes = (['name', 'description', 'entries'] as const).flatMap((field) => {
          const before = published?.[field] ?? null;
          const after = field === 'entries' ? lib.draftEntries : lib[field];
          return contentHash(before) === contentHash(after) ? [] : [{ path: field, before, after }];
        });
        return {
          draftRevision: lib.draftRevision,
          publishedRevision: published?.number ?? null,
          validation: { ok: errors.length === 0, errors },
          changes,
        };
      });
    },

    async publish(key, opts) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const lib = await row(tx, key, true);
        assertFresh(key, lib.draftRevision, opts.expectedDraftRevision);
        const current = await publishedRevision(tx, lib);
        if (current && current.contentHash === lib.draftHash) {
          throw new EquipmentConfigConflictError(subject(key), 'the draft is identical to the published library; there is nothing to publish');
        }
        const { entries, errors } = await publishIssues(tx, key, lib.draftEntries);
        if (!entries || errors.length > 0) throw new EquipmentConfigInvalidError(subject(key), errors);
        const rev = await publishEntries(
          tx,
          lib,
          { name: lib.name, description: lib.description, entries },
          { source: 'editor', actor: opts.actor, rolledBackFrom: null, draftRevision: lib.draftRevision },
        );
        const [updated] = await tx
          .update(equipmentAffixLibraries)
          .set({ publishedRevisionId: rev.id, updatedAt: new Date() })
          .where(eq(equipmentAffixLibraries.key, key))
          .returning();
        await recordEquipmentAdminEvent(
          tx,
          'affix_library',
          key,
          'published',
          { revision: rev.number, previousRevision: current?.number ?? null, contentHash: rev.contentHash, entryCount: entries.length },
          opts.actor,
        );
        return detail(tx, updated!);
      });
    },

    async revisions(key) {
      const lib = await row(db, key);
      const rows = await db
        .select()
        .from(equipmentAffixLibraryRevisions)
        .where(eq(equipmentAffixLibraryRevisions.libraryKey, key))
        .orderBy(desc(equipmentAffixLibraryRevisions.number));
      const numberById = new Map(rows.map((r) => [r.id, r.number]));
      return rows.map((r) => ({
        revision: r.number,
        contentHash: r.contentHash,
        source: r.source,
        rolledBackFrom: r.rolledBackFrom == null ? null : (numberById.get(r.rolledBackFrom) ?? null),
        entryCount: (r.entries as unknown[]).length,
        publishedBy: r.publishedBy,
        publishedAt: r.publishedAt,
        current: r.id === lib.publishedRevisionId,
      }));
    },

    async rollback(key, target, opts) {
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const lib = await row(tx, key, true);
        assertFresh(key, lib.draftRevision, opts.expectedDraftRevision);
        const [source] = await tx
          .select()
          .from(equipmentAffixLibraryRevisions)
          .where(and(eq(equipmentAffixLibraryRevisions.libraryKey, key), eq(equipmentAffixLibraryRevisions.number, target)));
        if (!source) throw new EquipmentConfigNotFoundError(`${subject(key)} revision ${target}`);
        const current = await publishedRevision(tx, lib);
        if (source.id === lib.publishedRevisionId) {
          throw new EquipmentConfigConflictError(subject(key), `revision ${target} is already the published revision`);
        }
        // Re-checked against today's other libraries and assignments.
        const { entries, errors } = await publishIssues(tx, key, source.entries);
        if (!entries || errors.length > 0) throw new EquipmentConfigInvalidError(subject(key), errors);
        const content = { name: source.name, description: source.description, entries };
        const rev = await publishEntries(tx, lib, content, {
          source: 'rollback',
          actor: opts.actor,
          rolledBackFrom: source.id,
          draftRevision: lib.draftRevision + 1,
        });
        const [updated] = await tx
          .update(equipmentAffixLibraries)
          .set({
            name: source.name,
            description: source.description,
            draftEntries: entries as unknown as Record<string, unknown>[],
            draftRevision: lib.draftRevision + 1,
            draftHash: rev.contentHash,
            publishedRevisionId: rev.id,
            updatedAt: new Date(),
            updatedBy: opts.actor,
          })
          .where(eq(equipmentAffixLibraries.key, key))
          .returning();
        await recordEquipmentAdminEvent(
          tx,
          'affix_library',
          key,
          'rolled_back',
          { revision: rev.number, restoredRevision: source.number, previousRevision: current?.number ?? null },
          opts.actor,
        );
        return detail(tx, updated!);
      });
    },

    async export(key, kind, now = new Date()) {
      const lib = await row(db, key);
      if (kind === 'draft') {
        return buildAffixLibraryExport(lib, lib.draftEntries as ManagedAffixEntry[], {
          kind,
          revision: lib.draftRevision,
          exportedAt: now.toISOString(),
        });
      }
      const rev = await publishedRevision(db, lib);
      if (!rev) throw new EquipmentConfigNotFoundError(`${subject(key)} published revision`);
      return buildAffixLibraryExport(
        { key, name: rev.name, description: rev.description },
        rev.entries as ManagedAffixEntry[],
        { kind, revision: rev.number, exportedAt: now.toISOString() },
      );
    },

    async importDraft(raw, opts) {
      const read = readAffixLibraryExport(raw);
      if (!read.ok) throw new EquipmentConfigInvalidError('affix library import', read.issues);
      const key = read.library.key;
      const meta: LibraryMeta = { name: read.library.name, description: read.library.description };
      return db.transaction(async (tx) => {
        await lockEquipmentConfig(tx);
        const [existing] = await tx.select().from(equipmentAffixLibraries).where(eq(equipmentAffixLibraries.key, key));
        let expected = opts.expectedDraftRevision;
        if (!existing) {
          if (expected !== undefined) throw new EquipmentConfigNotFoundError(subject(key));
          // Validate before creating, so a refused file leaves no empty library
          // behind; `writeDraft` re-validates under the lock.
          const checked = validateLibraryEntries(read.affixes, await namespaceExcluding(tx, key));
          if (!checked.ok) throw new EquipmentConfigInvalidError(subject(key), checked.errors);
          await createIn(tx, key, meta, opts.actor);
          expected = 1;
        } else if (expected === undefined) {
          throw new EquipmentConfigConflictError(
            subject(key),
            `the library already exists; import into it with its current draft revision (${existing.draftRevision})`,
          );
        }
        return writeDraft(key, { expectedDraftRevision: expected!, actor: opts.actor }, () => ({ entries: read.affixes, meta }), 'draft_imported', tx);
      });
    },

    async resolveAssignment(rarity, tx = db) {
      if ((LEGACY_RULE_RARITIES as readonly string[]).includes(rarity)) {
        return { mode: 'legacy', rarity: rarity as 'N' | 'R' | 'SR' };
      }
      if (!(MANAGED_RULE_RARITIES as readonly string[]).includes(rarity)) return { mode: 'unconfigured' };
      const published = await readPublishedRollRules(tx);
      const rule = published?.rules.rarities[rarity as ManagedRuleRarity];
      if (!rule) return { mode: 'unconfigured' };
      if (rule.affixes.mode === 'none') return { mode: 'none' };
      const lib = await row(tx, rule.affixes.library);
      const rev = await publishedRevision(tx, lib);
      if (!rev) throw new EquipmentConfigNotFoundError(`${subject(lib.key)} published revision`);
      return {
        mode: 'library',
        library: lib.key,
        libraryRevision: rev.number,
        entries: (rev.entries as ManagedAffixEntry[]).filter((e) => e.enabled),
      };
    },
  };
}

