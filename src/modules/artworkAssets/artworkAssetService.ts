/**
 * Managed artwork — images uploaded through Portal Admin.
 *
 * The `artwork_assets` row is the logical asset; the bytes live in the
 * {@link ArtworkStorage}. Authored content (a zone, an enemy) holds the
 * asset's **id**, so:
 *
 *   - **Upload** validates the bytes (`inspectImage`), stores them under a
 *     server-generated key, and creates the row.
 *   - **Replace** keeps the id: new bytes, new hash, `version + 1`. Everything
 *     that references the asset shows the replacement, and every URL / cache
 *     key derived from the hash changes with it.
 *   - **Disable** keeps the row and the bytes but takes the asset out of use:
 *     references fall back to shipped artwork. Always allowed; the caller is
 *     told what references it.
 *   - **Delete** is soft (the row stays for the audit trail, the bytes go) and
 *     is refused while anything references the asset.
 *
 * Git-shipped artwork under `assets/` is untouched by all of this and never
 * enters the table: a managed asset is an override, and when it is absent,
 * disabled or deleted the shipped `artworkPath` is what shows.
 *
 * Every change writes an `artwork_asset_events` row: who, which asset, the
 * old and new hash. Never the bytes.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  ARTWORK_ASSET_CATEGORIES,
  artworkAssetEvents,
  artworkAssets,
  combatEnemies,
  dungeonZones,
  type ArtworkAssetCategory,
  type ArtworkAssetEventAction,
  type ArtworkAssetMimeType,
  type ArtworkAssetRow,
  type ArtworkAssetStatus,
} from '../../db/schema';
import {
  ArtworkAssetInUseError,
  ArtworkUploadInvalidError,
  type ArtworkAssetReference,
} from '../../shared/errors';
import { artworkStorageKey, type ArtworkStorage } from './artworkStorage';
import { displayNameFromFilename, inspectImage, sanitizeOriginalFilename } from './imageInspection';
import type { SceneLayer } from './sceneComposition';

export const ARTWORK_ASSET_NAME_MAX_LENGTH = 100;
export const ARTWORK_ASSET_LIST_MAX_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isArtworkAssetId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isArtworkAssetCategory(value: unknown): value is ArtworkAssetCategory {
  return typeof value === 'string' && (ARTWORK_ASSET_CATEGORIES as readonly string[]).includes(value);
}

/** An asset as every caller sees it. No storage key: that never leaves the service. */
export interface ArtworkAsset {
  id: string;
  category: ArtworkAssetCategory;
  name: string;
  originalFilename: string;
  mimeType: ArtworkAssetMimeType;
  width: number;
  height: number;
  hasAlpha: boolean;
  fileSize: number;
  contentHash: string;
  version: number;
  status: ArtworkAssetStatus;
  uploadedBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  replacedAt: Date | null;
}

export interface ArtworkAssetEvent {
  id: number;
  action: ArtworkAssetEventAction;
  actor: string | null;
  oldHash: string | null;
  newHash: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

/** One asset reference held by an authored entity, for the audit trail. */
export interface ArtworkReferenceSlot {
  field: string;
  assetId: string | null;
}

export interface ArtworkAssetListQuery {
  category?: ArtworkAssetCategory | undefined;
  /** Defaults to everything not deleted. */
  status?: ArtworkAssetStatus | undefined;
  /** Matches the name or the original file name. */
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ArtworkAssetService {
  upload(
    input: { bytes: Buffer; category: ArtworkAssetCategory; filename?: string | undefined; name?: string | undefined },
    actor: string | null,
  ): Promise<ArtworkAsset>;
  /** New bytes behind the same id. Null when the id names no live asset. */
  replace(
    id: string,
    input: { bytes: Buffer; filename?: string | undefined },
    actor: string | null,
  ): Promise<ArtworkAsset | null>;
  /** Rename or re-categorise. */
  update(
    id: string,
    patch: { name?: string | undefined; category?: ArtworkAssetCategory | undefined },
    actor: string | null,
  ): Promise<ArtworkAsset | null>;
  /** Disable or re-enable. Reports what references the asset. */
  setEnabled(
    id: string,
    enabled: boolean,
    actor: string | null,
  ): Promise<{ asset: ArtworkAsset; references: ArtworkAssetReference[] } | null>;
  /**
   * Soft-delete: the bytes are removed, the row is kept as `deleted`.
   * @throws {ArtworkAssetInUseError} while anything references the asset.
   */
  delete(id: string, actor: string | null): Promise<ArtworkAsset | null>;
  get(id: string, tx?: DbOrTx): Promise<ArtworkAsset | null>;
  /** Assets by id, deleted ones included (so a reference can be explained). */
  getMany(ids: readonly string[], tx?: DbOrTx): Promise<Map<string, ArtworkAsset>>;
  list(query?: ArtworkAssetListQuery): Promise<{ assets: ArtworkAsset[]; total: number }>;
  references(id: string, tx?: DbOrTx): Promise<ArtworkAssetReference[]>;
  events(id: string, limit?: number): Promise<ArtworkAssetEvent[]>;
  /** The bytes of an asset that is not deleted — for Admin previews. */
  read(id: string): Promise<{ asset: ArtworkAsset; bytes: Buffer } | null>;
  /** The bytes of an **active** asset — what player-facing screens may show. */
  readUsable(id: string | null | undefined): Promise<{ asset: ArtworkAsset; bytes: Buffer } | null>;
  /**
   * An active asset as a scene layer; null when it is not usable.
   * `includeDisabled` is for Admin previews, which may show a disabled asset.
   */
  layer(id: string | null | undefined, options?: { includeDisabled?: boolean }): Promise<SceneLayer | null>;
  /**
   * Record, in the caller's transaction, how an entity's asset references
   * changed. `entity` is e.g. `dungeon_zone:scrapheap_gauntlet`.
   */
  recordReferenceChanges(
    tx: DbOrTx,
    change: { entity: string; before: readonly ArtworkReferenceSlot[]; after: readonly ArtworkReferenceSlot[] },
    actor: string | null,
  ): Promise<void>;
}

export interface ArtworkAssetServiceDeps {
  db: Db;
  storage: ArtworkStorage;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

function toAsset(row: ArtworkAssetRow): ArtworkAsset {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    hasAlpha: row.hasAlpha,
    fileSize: row.fileSize,
    contentHash: row.contentHash,
    version: row.version,
    status: row.status,
    uploadedBy: row.uploadedBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    replacedAt: row.replacedAt,
  };
}

function cleanName(raw: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ARTWORK_ASSET_NAME_MAX_LENGTH);
  return name || fallback;
}

/** Every asset id a stored zone document references, with the field holding it. */
export function zoneDocumentAssetSlots(definition: unknown): ArtworkReferenceSlot[] {
  const doc = (definition ?? {}) as Record<string, unknown>;
  const id = (value: unknown) => (isArtworkAssetId(value) ? value.toLowerCase() : null);
  const slots: ArtworkReferenceSlot[] = [
    { field: 'artworkAssetId', assetId: id(doc.artworkAssetId) },
    { field: 'backgroundAssetId', assetId: id(doc.backgroundAssetId) },
  ];
  if (Array.isArray(doc.backgrounds)) {
    doc.backgrounds.forEach((entry, i) => {
      const entryId = (entry as { id?: unknown } | null)?.id;
      slots.push({
        field: `backgrounds[${typeof entryId === 'string' ? entryId : i}].assetId`,
        assetId: id((entry as { assetId?: unknown } | null)?.assetId),
      });
    });
  }
  // An authored room's own background, and its override of its enemy's art.
  const rooms = (doc.authored as { rooms?: unknown } | null | undefined)?.rooms;
  if (Array.isArray(rooms)) {
    rooms.forEach((entry, i) => {
      const room = (entry ?? {}) as { id?: unknown; backgroundAssetId?: unknown; scene?: unknown };
      const at = `authored.rooms[${typeof room.id === 'string' ? room.id : i}]`;
      const scene = (room.scene ?? {}) as { spriteAssetId?: unknown; artworkAssetId?: unknown };
      slots.push(
        { field: `${at}.backgroundAssetId`, assetId: id(room.backgroundAssetId) },
        { field: `${at}.scene.spriteAssetId`, assetId: id(scene.spriteAssetId) },
        { field: `${at}.scene.artworkAssetId`, assetId: id(scene.artworkAssetId) },
      );
    });
  }
  return slots;
}

export function createArtworkAssetService(deps: ArtworkAssetServiceDeps): ArtworkAssetService {
  const { db, storage } = deps;

  async function rowOf(tx: DbOrTx, id: string, lock = false): Promise<ArtworkAssetRow | undefined> {
    if (!isArtworkAssetId(id)) return undefined;
    const query = tx.select().from(artworkAssets).where(eq(artworkAssets.id, id.toLowerCase()));
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  async function record(
    tx: DbOrTx,
    assetId: string,
    action: ArtworkAssetEventAction,
    actor: string | null,
    extra: { oldHash?: string | null; newHash?: string | null; details?: Record<string, unknown> } = {},
  ): Promise<void> {
    await tx.insert(artworkAssetEvents).values({
      assetId,
      action,
      actor,
      oldHash: extra.oldHash ?? null,
      newHash: extra.newHash ?? null,
      details: extra.details ?? {},
    });
  }

  async function referencesOf(tx: DbOrTx, id: string): Promise<ArtworkAssetReference[]> {
    const wanted = id.toLowerCase();
    const out: ArtworkAssetReference[] = [];
    // Zones are a handful of documents; scanning them is simpler and safer
    // than a JSON path query that has to track the document shape.
    const zones = await tx
      .select({ key: dungeonZones.zoneKey, definition: dungeonZones.definition })
      .from(dungeonZones)
      .orderBy(asc(dungeonZones.zoneKey));
    for (const zone of zones) {
      for (const slot of zoneDocumentAssetSlots(zone.definition)) {
        if (slot.assetId !== wanted) continue;
        const name = (zone.definition as { name?: unknown }).name;
        out.push({ kind: 'dungeon_zone', key: zone.key, name: typeof name === 'string' ? name : null, field: slot.field });
      }
    }
    const enemies = await tx
      .select({
        key: combatEnemies.enemyKey,
        name: combatEnemies.name,
        artworkAssetId: combatEnemies.artworkAssetId,
        spriteAssetId: combatEnemies.spriteAssetId,
      })
      .from(combatEnemies)
      .where(or(eq(combatEnemies.artworkAssetId, wanted), eq(combatEnemies.spriteAssetId, wanted)))
      .orderBy(asc(combatEnemies.enemyKey));
    for (const enemy of enemies) {
      if (enemy.artworkAssetId === wanted) out.push({ kind: 'combat_enemy', key: enemy.key, name: enemy.name, field: 'artworkAssetId' });
      if (enemy.spriteAssetId === wanted) out.push({ kind: 'combat_enemy', key: enemy.key, name: enemy.name, field: 'spriteAssetId' });
    }
    return out;
  }

  async function removeStored(key: string): Promise<void> {
    try {
      await storage.delete(key);
    } catch (err) {
      // The row is already correct; an orphaned file is only wasted space.
      deps.logger?.warn({ tag: 'artwork-assets/orphan', storageKey: key, err }, 'could not remove a replaced artwork file');
    }
  }

  async function bytesOf(row: ArtworkAssetRow): Promise<Buffer | null> {
    const bytes = await storage.get(row.storageKey);
    if (!bytes) {
      deps.logger?.warn(
        { tag: 'artwork-assets/missing-file', assetId: row.id, storage: storage.description },
        'managed artwork row has no stored file — falling back. Was the artwork volume restored with the database?',
      );
    }
    return bytes;
  }

  return {
    async upload({ bytes, category, filename, name }, actor) {
      if (!isArtworkAssetCategory(category)) throw new ArtworkUploadInvalidError('Unknown artwork category.');
      const image = await inspectImage(bytes);
      const originalFilename = sanitizeOriginalFilename(filename);
      const id = randomUUID();
      const storageKey = artworkStorageKey({ category, assetId: id, contentHash: image.contentHash, extension: image.extension });
      await storage.put(storageKey, bytes);
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(artworkAssets)
            .values({
              id,
              category,
              name: cleanName(name, displayNameFromFilename(originalFilename)),
              originalFilename,
              mimeType: image.mimeType,
              width: image.width,
              height: image.height,
              hasAlpha: image.hasAlpha,
              fileSize: image.fileSize,
              storageKey,
              contentHash: image.contentHash,
              uploadedBy: actor,
              updatedBy: actor,
            })
            .returning();
          await record(tx, id, 'upload', actor, {
            newHash: image.contentHash,
            details: { category, mimeType: image.mimeType, width: image.width, height: image.height, fileSize: image.fileSize },
          });
          return toAsset(row!);
        });
      } catch (err) {
        await removeStored(storageKey);
        throw err;
      }
    },

    async replace(id, { bytes, filename }, actor) {
      const image = await inspectImage(bytes);
      // A file written for a replacement that then fails to commit is removed again.
      let written: string | null = null;
      const result = await db
        .transaction(async (tx) => {
        const row = await rowOf(tx, id, true);
        if (!row || row.status === 'deleted') return null;
        const storageKey = artworkStorageKey({
          category: row.category,
          assetId: row.id,
          contentHash: image.contentHash,
          extension: image.extension,
        });
        await storage.put(storageKey, bytes);
        if (storageKey !== row.storageKey) written = storageKey;
        const now = new Date();
        const [updated] = await tx
          .update(artworkAssets)
          .set({
            originalFilename: filename === undefined ? row.originalFilename : sanitizeOriginalFilename(filename),
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            hasAlpha: image.hasAlpha,
            fileSize: image.fileSize,
            storageKey,
            contentHash: image.contentHash,
            version: sql`${artworkAssets.version} + 1`,
            updatedBy: actor,
            updatedAt: now,
            replacedAt: now,
          })
          .where(eq(artworkAssets.id, row.id))
          .returning();
        await record(tx, row.id, 'replace', actor, {
          oldHash: row.contentHash,
          newHash: image.contentHash,
          details: {
            fromVersion: row.version,
            toVersion: updated!.version,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            fileSize: image.fileSize,
          },
        });
        return { asset: toAsset(updated!), oldKey: row.storageKey, newKey: storageKey };
        })
        .catch(async (err: unknown) => {
          if (written) await removeStored(written);
          throw err;
        });
      if (!result) return null;
      if (result.oldKey !== result.newKey) await removeStored(result.oldKey);
      return result.asset;
    },

    async update(id, patch, actor) {
      if (patch.category !== undefined && !isArtworkAssetCategory(patch.category)) {
        throw new ArtworkUploadInvalidError('Unknown artwork category.');
      }
      return db.transaction(async (tx) => {
        const row = await rowOf(tx, id, true);
        if (!row || row.status === 'deleted') return null;
        const name = patch.name === undefined ? row.name : cleanName(patch.name, row.name);
        const category = patch.category ?? row.category;
        if (name === row.name && category === row.category) return toAsset(row);
        const [updated] = await tx
          .update(artworkAssets)
          .set({ name, category, updatedBy: actor, updatedAt: new Date() })
          .where(eq(artworkAssets.id, row.id))
          .returning();
        await record(tx, row.id, 'update', actor, {
          details: {
            ...(name !== row.name ? { name: { from: row.name, to: name } } : {}),
            ...(category !== row.category ? { category: { from: row.category, to: category } } : {}),
          },
        });
        return toAsset(updated!);
      });
    },

    async setEnabled(id, enabled, actor) {
      return db.transaction(async (tx) => {
        const row = await rowOf(tx, id, true);
        if (!row || row.status === 'deleted') return null;
        const references = await referencesOf(tx, row.id);
        const status: ArtworkAssetStatus = enabled ? 'active' : 'disabled';
        if (row.status === status) return { asset: toAsset(row), references };
        const [updated] = await tx
          .update(artworkAssets)
          .set({ status, updatedBy: actor, updatedAt: new Date() })
          .where(eq(artworkAssets.id, row.id))
          .returning();
        await record(tx, row.id, enabled ? 'enable' : 'disable', actor, {
          oldHash: row.contentHash,
          newHash: row.contentHash,
          details: { referenceCount: references.length },
        });
        return { asset: toAsset(updated!), references };
      });
    },

    async delete(id, actor) {
      const result = await db.transaction(async (tx) => {
        const row = await rowOf(tx, id, true);
        if (!row || row.status === 'deleted') return null;
        const references = await referencesOf(tx, row.id);
        if (references.length > 0) throw new ArtworkAssetInUseError(row.id, references);
        const now = new Date();
        const [updated] = await tx
          .update(artworkAssets)
          .set({ status: 'deleted', deletedAt: now, updatedBy: actor, updatedAt: now })
          .where(eq(artworkAssets.id, row.id))
          .returning();
        await record(tx, row.id, 'delete', actor, { oldHash: row.contentHash });
        return { asset: toAsset(updated!), key: row.storageKey };
      });
      if (!result) return null;
      await removeStored(result.key);
      return result.asset;
    },

    async get(id, tx = db) {
      const row = await rowOf(tx, id);
      return row ? toAsset(row) : null;
    },

    async getMany(ids, tx = db) {
      const wanted = [...new Set(ids.filter(isArtworkAssetId).map((i) => i.toLowerCase()))];
      if (wanted.length === 0) return new Map();
      const rows = await tx.select().from(artworkAssets).where(inArray(artworkAssets.id, wanted));
      return new Map(rows.map((row) => [row.id, toAsset(row)]));
    },

    async list(query = {}) {
      const filters: SQL[] = [query.status ? eq(artworkAssets.status, query.status) : ne(artworkAssets.status, 'deleted')];
      if (query.category) filters.push(eq(artworkAssets.category, query.category));
      const search = query.search?.trim();
      if (search) {
        const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        filters.push(or(ilike(artworkAssets.name, like), ilike(artworkAssets.originalFilename, like))!);
      }
      const where = and(...filters);
      const limit = Math.min(Math.max(query.limit ?? 60, 1), ARTWORK_ASSET_LIST_MAX_LIMIT);
      const rows = await db
        .select()
        .from(artworkAssets)
        .where(where)
        .orderBy(desc(artworkAssets.updatedAt), asc(artworkAssets.id))
        .limit(limit)
        .offset(Math.max(query.offset ?? 0, 0));
      const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(artworkAssets).where(where);
      return { assets: rows.map(toAsset), total: count?.n ?? 0 };
    },

    async references(id, tx = db) {
      return isArtworkAssetId(id) ? referencesOf(tx, id) : [];
    },

    async events(id, limit = 50) {
      if (!isArtworkAssetId(id)) return [];
      const rows = await db
        .select()
        .from(artworkAssetEvents)
        .where(eq(artworkAssetEvents.assetId, id.toLowerCase()))
        .orderBy(desc(artworkAssetEvents.id))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        oldHash: r.oldHash,
        newHash: r.newHash,
        details: r.details,
        createdAt: r.createdAt,
      }));
    },

    async read(id) {
      const row = await rowOf(db, id);
      if (!row || row.status === 'deleted') return null;
      const bytes = await bytesOf(row);
      return bytes ? { asset: toAsset(row), bytes } : null;
    },

    async readUsable(id) {
      if (!id) return null;
      const row = await rowOf(db, id);
      if (!row || row.status !== 'active') return null;
      const bytes = await bytesOf(row);
      return bytes ? { asset: toAsset(row), bytes } : null;
    },

    async layer(id, options = {}) {
      if (!id) return null;
      const row = await rowOf(db, id);
      if (!row || row.status === 'deleted') return null;
      if (row.status !== 'active' && !options.includeDisabled) return null;
      return { hash: row.contentHash, load: () => bytesOf(row) };
    },

    async recordReferenceChanges(tx, { entity, before, after }, actor) {
      const previous = new Map(before.map((s) => [s.field, s.assetId]));
      const next = new Map(after.map((s) => [s.field, s.assetId]));
      const changed: { field: string; from: string | null; to: string | null }[] = [];
      for (const field of new Set([...previous.keys(), ...next.keys()])) {
        const from = previous.get(field) ?? null;
        const to = next.get(field) ?? null;
        if (from !== to) changed.push({ field, from, to });
      }
      if (changed.length === 0) return;
      // An event row needs a real asset; an id that names none has no trail to add to.
      const ids = [...new Set(changed.flatMap((c) => [c.from, c.to]).filter((v): v is string => v !== null))];
      const known = new Set(
        (await tx.select({ id: artworkAssets.id }).from(artworkAssets).where(inArray(artworkAssets.id, ids))).map((r) => r.id),
      );
      for (const { field, from, to } of changed) {
        const details = { entity, field, from, to };
        if (from && known.has(from)) await record(tx, from, 'reference_removed', actor, { details });
        if (to && known.has(to)) await record(tx, to, 'reference_added', actor, { details });
      }
    },
  };
}
