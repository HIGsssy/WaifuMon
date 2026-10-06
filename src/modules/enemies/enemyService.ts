/**
 * The Enemy Catalogue: combat enemies as first-class managed content.
 *
 * `combat_enemies` is authoritative. `content/combat/enemies.json` is the
 * shipped default, seeded at startup (`enemyStore.ts`); from then on enemies
 * are authored in Portal Admin and referenced **by key** from dungeon zones,
 * Combat Trials and anything later. No system owns them.
 *
 * This service is both sides of that:
 *
 *   - **authoring** — list, get, create, validate, update, enable/disable,
 *     duplicate, delete, references, export. Every write is optimistic
 *     (`expectedRevision`), validated, and recorded in the artwork asset
 *     reference trail;
 *   - **runtime** — {@link EnemyCatalogueService.definitions} and
 *     {@link EnemyCatalogueService.snapshot} hand the combat systems plain
 *     validated `CombatEnemyDefinition`s. Nothing administrative (hashes,
 *     revisions, who edited what) leaves through them.
 *
 * Disable, don't delete. A disabled enemy keeps its row and every reference
 * to it; it is only withdrawn from *new* use (see `docs/enemies.md`). Delete
 * exists for a mistake nobody references, and is refused otherwise.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../db/client';
import { combatEnemies, type CombatEnemyRow } from '../../db/schema';
import {
  EnemyInUseError,
  EnemyInvalidError,
  EnemyKeyTakenError,
  EnemyStaleError,
  type EnemyIssueDetail,
  type EnemyReference,
} from '../../shared/errors';
import type { ArtworkAssetService } from '../artworkAssets/artworkAssetService';
import { resolveEnemyVisual, type EnemyVisual, type ManagedEnemyArtwork } from '../artworkAssets/enemyArtworkService';
import { SpritePlacementSchema, type SpritePlacement } from '../artworkAssets/scenePlacement';
import {
  COMBAT_ENEMY_FILE,
  COMBAT_ENEMY_FILE_FORMAT,
  COMBAT_ENEMY_FILE_VERSION,
  COMBAT_ENEMY_KEY_MAX_LENGTH,
  COMBAT_ENEMY_KEY_PATTERN,
  CombatEnemyDefinitionSchema,
  type CombatEnemyDefinition,
} from '../combat/enemyDefinitions';
import { collectEnemyReferences, type EnemyReferenceSource } from './enemyReferences';
import {
  combatEnemyHash,
  enemyColumnsOf,
  enemyDefinitionOf,
  readCombatEnemyRow,
  readCombatEnemyRows,
  type ShippedCombatEnemy,
} from './enemyStore';

export type EnemyIssue = EnemyIssueDetail;
export type EnemyOrigin = 'shipped' | 'edited' | 'custom';

/**
 * Keys a new enemy may not take: they are path segments of the admin routes
 * and of the Portal's pages, so an enemy named one of them could not be opened.
 */
export const RESERVED_ENEMY_KEYS: ReadonlySet<string> = new Set([
  'new',
  'export',
  'import',
  'validate',
  'reference',
  'references',
]);

/** What a picker row needs — and all a picker gets. */
export interface EnemyRef {
  key: string;
  name: string;
  enabled: boolean;
  attack: number;
  defense: number;
  hp: number;
  tags: string[];
  /** The artwork in effect: managed where set, shipped otherwise. */
  visual: EnemyVisual;
}

export interface EnemySummary extends EnemyRef {
  description: string;
  /** Shipped artwork paths: the fallback when no managed artwork is set. */
  artworkPath: string | null;
  spriteArtworkPath: string | null;
  /** Managed artwork (uploaded through the Portal); local to this environment. */
  artworkAssetId: string | null;
  spriteAssetId: string | null;
  /** The authored placement; null means the system default. */
  spritePlacement: SpritePlacement | null;
  revision: number;
  /** `shipped`: as Git has it. `edited`: a shipped enemy changed here. `custom`: created here. */
  origin: EnemyOrigin;
  /** Whether the row equals this build's shipped enemy; null when this build ships none of that key. */
  matchesShipped: boolean | null;
  /** How many places name this enemy. */
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface EnemyDetail extends EnemySummary {
  references: EnemyReference[];
  /** Problems with the stored enemy against this server right now. */
  issues: EnemyIssue[];
  /** This build's shipped enemy of the same key, to show what an edit changed. */
  shipped: CombatEnemyDefinition | null;
}

/** What an admin may set. The key is fixed at creation. */
export interface EnemyInput {
  name: string;
  description?: string | undefined;
  enabled: boolean;
  attack: number;
  defense: number;
  hp: number;
  tags?: string[] | undefined;
  /** Omitted keeps the current value (null for a new enemy). */
  artworkPath?: string | null | undefined;
  spriteArtworkPath?: string | null | undefined;
  artworkAssetId?: string | null | undefined;
  spriteAssetId?: string | null | undefined;
  spritePlacement?: SpritePlacement | null | undefined;
}

export interface EnemyExport {
  /** Where the document belongs in Git, relative to the content directory. */
  file: string;
  /** A complete, valid `enemies.json`: commit it and the seed adopts these rows as shipped. */
  document: {
    format: typeof COMBAT_ENEMY_FILE_FORMAT;
    version: typeof COMBAT_ENEMY_FILE_VERSION;
    enemies: CombatEnemyDefinition[];
  };
  /**
   * Managed artwork the document does NOT carry. The ids name uploads in this
   * environment's asset store and mean nothing anywhere else.
   */
  environmentLocal: {
    note: string;
    managedArtwork: { key: string; artworkAssetId: string | null; spriteAssetId: string | null }[];
  };
}

/** What a dungeon run freezes at its start. */
export interface EnemyRuntimeSnapshot {
  definitions: CombatEnemyDefinition[];
  /** Managed artwork by enemy key, for the enemies that have any. */
  artwork: Record<string, ManagedEnemyArtwork>;
}

export interface EnemyCatalogueService {
  list(): Promise<EnemySummary[]>;
  get(key: string): Promise<EnemyDetail | null>;
  /** Picker rows, in list order, disabled enemies included (the caller decides what to offer). */
  reference(tx?: DbOrTx): Promise<EnemyRef[]>;
  /** Dry run: every issue creating (`creating`) or saving this enemy would raise. Writes nothing. */
  validate(input: { key: string; enemy: unknown; creating: boolean }): Promise<EnemyIssue[]>;
  /** @throws {EnemyInvalidError | EnemyKeyTakenError} */
  create(key: string, input: unknown, actor: string | null): Promise<EnemyDetail>;
  /** Null for an unknown key. @throws {EnemyInvalidError | EnemyStaleError} */
  update(key: string, input: { enemy: unknown; expectedRevision: number }, actor: string | null): Promise<EnemyDetail | null>;
  setEnabled(key: string, input: { enabled: boolean; expectedRevision: number }, actor: string | null): Promise<EnemyDetail | null>;
  /**
   * A copy under a new key. It starts **disabled** and is a Portal enemy
   * (`custom`), whatever the source was. Null for an unknown source.
   */
  duplicate(
    sourceKey: string,
    input: { key: string; name?: string | undefined; copyArtwork?: boolean | undefined },
    actor: string | null,
  ): Promise<EnemyDetail | null>;
  references(key: string): Promise<EnemyReference[] | null>;
  /**
   * Hard delete, for an enemy nothing names and Git does not ship.
   * @returns false for an unknown key.
   * @throws {EnemyInUseError | EnemyStaleError}
   */
  delete(key: string, input: { expectedRevision: number }, actor: string | null): Promise<boolean>;
  export(): Promise<EnemyExport>;

  // ── runtime ───────────────────────────────────────────────────────────────
  /** Every enemy, enabled or not, as the combat systems read them. */
  definitions(tx?: DbOrTx): Promise<CombatEnemyDefinition[]>;
  definition(key: string, tx?: DbOrTx): Promise<CombatEnemyDefinition | null>;
  snapshot(tx?: DbOrTx): Promise<EnemyRuntimeSnapshot>;
}

export interface EnemyCatalogueServiceDeps {
  db: Db;
  /** This build's shipped enemies. */
  getShipped: () => readonly ShippedCombatEnemy[];
  /** Every system that names enemies. */
  referenceSources?: readonly EnemyReferenceSource[] | undefined;
  /** Managed artwork: validates the ids an enemy names and keeps the reference trail. */
  assets?: Pick<ArtworkAssetService, 'getMany' | 'recordReferenceChanges'> | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assetId = z.string().regex(UUID, 'must be an artwork asset id').nullable();

/**
 * The editable part of an enemy: the definition without its key, plus the
 * managed artwork. The artwork fields are optional so a caller that does not
 * touch them (a stats-only save) leaves them as they are.
 */
const EnemyInputSchema = CombatEnemyDefinitionSchema.omit({ key: true, artworkPath: true, spriteArtworkPath: true, spritePlacement: true })
  .extend({
    artworkPath: CombatEnemyDefinitionSchema.shape.artworkPath.removeDefault().optional(),
    spriteArtworkPath: CombatEnemyDefinitionSchema.shape.spriteArtworkPath.removeDefault().optional(),
    spritePlacement: SpritePlacementSchema.nullable().optional(),
    artworkAssetId: assetId.optional(),
    spriteAssetId: assetId.optional(),
  })
  .strict();

const keySchema = z
  .string()
  .min(1, 'a key is required')
  .max(COMBAT_ENEMY_KEY_MAX_LENGTH)
  .regex(COMBAT_ENEMY_KEY_PATTERN, 'must be lower_snake_case (letters, digits, single underscores)');

const zodPath = (path: readonly (string | number)[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');

const error = (path: string, message: string): EnemyIssue => ({ path, message, severity: 'error' });
const warning = (path: string, message: string): EnemyIssue => ({ path, message, severity: 'warning' });
const hasErrors = (issues: readonly EnemyIssue[]) => issues.some((i) => i.severity === 'error');

/** Everything a write stores: the portable definition and the managed artwork beside it. */
interface ResolvedEnemy {
  definition: CombatEnemyDefinition;
  artworkAssetId: string | null;
  spriteAssetId: string | null;
}

function managedOf(row: Pick<CombatEnemyRow, 'artworkAssetId' | 'spriteAssetId'>): ManagedEnemyArtwork {
  // The placement lives in the definition now; the managed layer adds only ids.
  return { artworkAssetId: row.artworkAssetId, spriteAssetId: row.spriteAssetId, spritePlacement: null };
}

export function createEnemyCatalogueService(deps: EnemyCatalogueServiceDeps): EnemyCatalogueService {
  const { db } = deps;
  const sources = () => deps.referenceSources ?? [];
  const shippedFor = (key: string) => deps.getShipped().find((e) => e.key === key);

  function originOf(row: CombatEnemyRow): EnemyOrigin {
    if (row.seedHash === null) return 'custom';
    return row.contentHash === row.seedHash ? 'shipped' : 'edited';
  }

  function refOf(row: CombatEnemyRow, definition = enemyDefinitionOf(row)): EnemyRef {
    return {
      key: row.enemyKey,
      name: definition.name,
      enabled: definition.enabled,
      attack: definition.attack,
      defense: definition.defense,
      hp: definition.hp,
      tags: definition.tags,
      visual: resolveEnemyVisual(definition, managedOf(row)),
    };
  }

  function summaryOf(row: CombatEnemyRow, usageCount: number): EnemySummary {
    const definition = enemyDefinitionOf(row);
    const shipped = shippedFor(row.enemyKey);
    return {
      ...refOf(row, definition),
      description: definition.description,
      artworkPath: definition.artworkPath,
      spriteArtworkPath: definition.spriteArtworkPath,
      artworkAssetId: row.artworkAssetId,
      spriteAssetId: row.spriteAssetId,
      spritePlacement: definition.spritePlacement,
      revision: row.revision,
      origin: originOf(row),
      matchesShipped: shipped ? shipped.hash === row.contentHash : null,
      usageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /** Problems with the managed artwork an enemy names. */
  async function assetIssues(tx: DbOrTx, enemy: Pick<ResolvedEnemy, 'artworkAssetId' | 'spriteAssetId'>): Promise<EnemyIssue[]> {
    const slots = [
      ['artworkAssetId', enemy.artworkAssetId, 'full artwork'],
      ['spriteAssetId', enemy.spriteAssetId, 'sprite'],
    ] as const;
    const ids = slots.flatMap(([, id]) => (id ? [id] : []));
    if (ids.length === 0 || !deps.assets) return [];
    const assets = await deps.assets.getMany(ids, tx);
    const issues: EnemyIssue[] = [];
    for (const [field, id, what] of slots) {
      if (!id) continue;
      const asset = assets.get(id.toLowerCase());
      if (!asset || asset.status === 'deleted') {
        issues.push(error(field, `The ${what} no longer exists — choose another, or clear it.`));
      } else if (asset.status !== 'active') {
        issues.push(warning(field, `The ${what} "${asset.name}" is disabled, so the shipped artwork (if any) shows instead.`));
      }
    }
    return issues;
  }

  async function detailOf(tx: DbOrTx, row: CombatEnemyRow): Promise<EnemyDetail> {
    const references = (await collectEnemyReferences(tx, sources())).get(row.enemyKey) ?? [];
    const issues = await assetIssues(tx, row);
    if (!row.enabled && references.length > 0) {
      issues.push(
        warning(
          'enabled',
          `This enemy is disabled but still named in ${references.length} place${references.length === 1 ? '' : 's'}. ` +
            'Those references are kept; see Usage for what each one does meanwhile.',
        ),
      );
    }
    return {
      ...summaryOf(row, references.length),
      references,
      issues,
      shipped: shippedFor(row.enemyKey)?.definition ?? null,
    };
  }

  /** Parse an input against the enemy it edits (or none). Collects, never throws. */
  function resolve(
    key: string,
    input: unknown,
    current: CombatEnemyRow | undefined,
  ): { enemy: ResolvedEnemy | null; issues: EnemyIssue[] } {
    const issues: EnemyIssue[] = [];
    const parsedKey = keySchema.safeParse(key);
    if (!parsedKey.success) {
      for (const issue of parsedKey.error.issues) issues.push(error('key', issue.message));
    } else if (!current && RESERVED_ENEMY_KEYS.has(key)) {
      issues.push(error('key', `"${key}" is reserved — choose another key`));
    }
    const parsed = EnemyInputSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push(error(zodPath(issue.path), issue.message));
      return { enemy: null, issues };
    }
    if (hasErrors(issues)) return { enemy: null, issues };
    const data = parsed.data;
    const keep = current ? enemyDefinitionOf(current) : null;
    const definition = CombatEnemyDefinitionSchema.parse({
      key,
      name: data.name,
      description: data.description,
      attack: data.attack,
      defense: data.defense,
      hp: data.hp,
      enabled: data.enabled,
      tags: data.tags,
      artworkPath: data.artworkPath !== undefined ? data.artworkPath : (keep?.artworkPath ?? null),
      spriteArtworkPath:
        data.spriteArtworkPath !== undefined ? data.spriteArtworkPath : (keep?.spriteArtworkPath ?? null),
      spritePlacement: data.spritePlacement !== undefined ? data.spritePlacement : (keep?.spritePlacement ?? null),
    });
    if (new Set(definition.tags).size !== definition.tags.length) {
      issues.push(error('tags', 'the same tag is listed twice'));
    }
    return {
      enemy: {
        definition,
        artworkAssetId:
          data.artworkAssetId !== undefined ? (data.artworkAssetId?.toLowerCase() ?? null) : (current?.artworkAssetId ?? null),
        spriteAssetId:
          data.spriteAssetId !== undefined ? (data.spriteAssetId?.toLowerCase() ?? null) : (current?.spriteAssetId ?? null),
      },
      issues,
    };
  }

  /** Validate for a write, or throw with every issue. */
  async function assertWritable(
    tx: DbOrTx,
    key: string,
    input: unknown,
    current: CombatEnemyRow | undefined,
  ): Promise<ResolvedEnemy> {
    const { enemy, issues } = resolve(key, input, current);
    if (enemy) issues.push(...(await assetIssues(tx, enemy)));
    if (!enemy || hasErrors(issues)) throw new EnemyInvalidError(issues);
    return enemy;
  }

  function assertRevision(row: CombatEnemyRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new EnemyStaleError(row.enemyKey, expectedRevision, row.revision, row.updatedBy, row.updatedAt);
    }
  }

  const slotsOf = (e: Pick<ResolvedEnemy, 'artworkAssetId' | 'spriteAssetId'> | null) => [
    { field: 'artworkAssetId', assetId: e?.artworkAssetId ?? null },
    { field: 'spriteAssetId', assetId: e?.spriteAssetId ?? null },
  ];

  /** The conditional write every edit goes through. */
  async function writeRow(tx: DbOrTx, row: CombatEnemyRow, enemy: ResolvedEnemy, actor: string | null): Promise<CombatEnemyRow> {
    const [updated] = await tx
      .update(combatEnemies)
      .set({
        ...enemyColumnsOf(enemy.definition),
        artworkAssetId: enemy.artworkAssetId,
        spriteAssetId: enemy.spriteAssetId,
        contentHash: combatEnemyHash(enemy.definition),
        revision: sql`${combatEnemies.revision} + 1`,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(combatEnemies.enemyKey, row.enemyKey))
      .returning();
    await deps.assets?.recordReferenceChanges(
      tx,
      { entity: `combat_enemy:${row.enemyKey}`, before: slotsOf(row), after: slotsOf(enemy) },
      actor,
    );
    return updated!;
  }

  async function insertRow(tx: DbOrTx, enemy: ResolvedEnemy, actor: string | null): Promise<CombatEnemyRow> {
    const key = enemy.definition.key;
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${combatEnemies.position}), -1) + 1` })
      .from(combatEnemies);
    const [inserted] = await tx
      .insert(combatEnemies)
      .values({
        enemyKey: key,
        ...enemyColumnsOf(enemy.definition),
        artworkAssetId: enemy.artworkAssetId,
        spriteAssetId: enemy.spriteAssetId,
        contentHash: combatEnemyHash(enemy.definition),
        // An enemy that ships in Git but was missing here (only before the
        // seed has run) is tracked against the shipped copy from the start.
        seedHash: shippedFor(key)?.hash ?? null,
        position: Number(next),
        updatedBy: actor,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw new EnemyKeyTakenError(key);
    await deps.assets?.recordReferenceChanges(
      tx,
      { entity: `combat_enemy:${key}`, before: [], after: slotsOf(enemy) },
      actor,
    );
    return inserted;
  }

  return {
    async list() {
      const rows = await readCombatEnemyRows(db);
      const references = await collectEnemyReferences(db, sources());
      return rows.map((row) => summaryOf(row, references.get(row.enemyKey)?.length ?? 0));
    },

    async get(key) {
      const row = await readCombatEnemyRow(db, key);
      return row ? detailOf(db, row) : null;
    },

    async reference(tx = db) {
      return (await readCombatEnemyRows(tx)).map((row) => refOf(row));
    },

    async validate({ key, enemy: input, creating }) {
      const current = creating ? undefined : await readCombatEnemyRow(db, key);
      const { enemy, issues } = resolve(key, input, current);
      if (creating && !issues.some((i) => i.path === 'key') && (await readCombatEnemyRow(db, key))) {
        issues.push(error('key', 'another enemy already uses that key'));
      }
      if (enemy) issues.push(...(await assetIssues(db, enemy)));
      return issues;
    },

    async create(key, input, actor) {
      return db.transaction(async (tx) => {
        const enemy = await assertWritable(tx, key, input, undefined);
        return detailOf(tx, await insertRow(tx, enemy, actor));
      });
    },

    async update(key, { enemy: input, expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readCombatEnemyRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const enemy = await assertWritable(tx, key, input, row);
        return detailOf(tx, await writeRow(tx, row, enemy, actor));
      });
    },

    async setEnabled(key, { enabled, expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readCombatEnemyRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        // Nothing else is re-validated: switching an enemy off must work even
        // when its artwork has since been deleted, and so must switching it on.
        const definition = { ...enemyDefinitionOf(row), enabled };
        return detailOf(
          tx,
          await writeRow(tx, row, { definition, artworkAssetId: row.artworkAssetId, spriteAssetId: row.spriteAssetId }, actor),
        );
      });
    },

    async duplicate(sourceKey, input, actor) {
      return db.transaction(async (tx) => {
        const source = await readCombatEnemyRow(tx, sourceKey);
        if (!source) return null;
        const from = enemyDefinitionOf(source);
        const copyArtwork = input.copyArtwork !== false;
        const enemy = await assertWritable(
          tx,
          input.key,
          {
            name: input.name ?? `${from.name} (copy)`.slice(0, 100),
            description: from.description,
            // Disabled until someone has looked at it: a copy is a draft.
            enabled: false,
            attack: from.attack,
            defense: from.defense,
            hp: from.hp,
            tags: from.tags,
            artworkPath: copyArtwork ? from.artworkPath : null,
            spriteArtworkPath: copyArtwork ? from.spriteArtworkPath : null,
            spritePlacement: copyArtwork ? from.spritePlacement : null,
            artworkAssetId: copyArtwork ? source.artworkAssetId : null,
            spriteAssetId: copyArtwork ? source.spriteAssetId : null,
          },
          undefined,
        );
        return detailOf(tx, await insertRow(tx, enemy, actor));
      });
    },

    async references(key) {
      const row = await readCombatEnemyRow(db, key);
      if (!row) return null;
      return (await collectEnemyReferences(db, sources())).get(key) ?? [];
    },

    async delete(key, { expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readCombatEnemyRow(tx, key, true);
        if (!row) return false;
        assertRevision(row, expectedRevision);
        const references = (await collectEnemyReferences(tx, sources())).get(key) ?? [];
        // A shipped enemy would simply be re-inserted by the next seed.
        const shipped = shippedFor(key) !== undefined;
        if (references.length > 0 || shipped) throw new EnemyInUseError(key, references, shipped);
        await tx.delete(combatEnemies).where(eq(combatEnemies.enemyKey, key));
        await deps.assets?.recordReferenceChanges(
          tx,
          { entity: `combat_enemy:${key}`, before: slotsOf(row), after: [] },
          actor,
        );
        return true;
      });
    },

    async export() {
      const rows = await readCombatEnemyRows(db);
      return {
        file: COMBAT_ENEMY_FILE,
        document: {
          format: COMBAT_ENEMY_FILE_FORMAT,
          version: COMBAT_ENEMY_FILE_VERSION,
          enemies: rows.map(enemyDefinitionOf),
        },
        environmentLocal: {
          note:
            'Managed artwork is stored in this environment only and is not part of the document. ' +
            'After importing these enemies elsewhere, upload and attach their artwork there.',
          managedArtwork: rows
            .filter((row) => row.artworkAssetId !== null || row.spriteAssetId !== null)
            .map((row) => ({ key: row.enemyKey, artworkAssetId: row.artworkAssetId, spriteAssetId: row.spriteAssetId })),
        },
      };
    },

    async definitions(tx = db) {
      return (await readCombatEnemyRows(tx)).map(enemyDefinitionOf);
    },

    async definition(key, tx = db) {
      const row = await readCombatEnemyRow(tx, key);
      return row ? enemyDefinitionOf(row) : null;
    },

    async snapshot(tx = db) {
      const rows = await readCombatEnemyRows(tx);
      return {
        definitions: rows.map(enemyDefinitionOf),
        artwork: Object.fromEntries(
          rows
            .filter((row) => row.artworkAssetId !== null || row.spriteAssetId !== null)
            .map((row) => [row.enemyKey, managedOf(row)]),
        ),
      };
    },
  };
}
