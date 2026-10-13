import { DungeonDefinitionSchema } from '../content/dungeonDefinition';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../../db/client';
import { artworkAssets, dungeonSceneSprites, dungeonSceneSpriteEvents, dungeonRevisions } from '../../../db/schema';
import { AppError } from '../../../shared/errors';
import type { ArtworkAssetService } from '../../artworkAssets/artworkAssetService';
import { readDungeonContentDocuments } from '../dungeonContentService';
import { SceneSpriteInputSchema, SceneSpriteKeySchema, type SceneSpriteInput } from './sceneSpriteDefinition';

export interface SceneSpriteUsage {
  dungeonKey: string;
  name: string;
  source: string;
  roomId: string;
  actionId?: string;
  instanceId: string;
}
export interface SceneSpriteSummary extends SceneSpriteInput {
  key: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}
export interface SceneSpriteDetail extends SceneSpriteSummary {
  references: SceneSpriteUsage[];
  events: Array<{
    action: string;
    actor: string | null;
    createdAt: string;
    details: Record<string, unknown>;
  }>;
}
export class SceneSpriteError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message, message);
  }
}
export interface SceneSpriteService {
  list(tx?: DbOrTx): Promise<SceneSpriteSummary[]>;
  get(key: string): Promise<SceneSpriteDetail | null>;
  create(key: string, sprite: unknown, actor: string | null): Promise<SceneSpriteDetail>;
  update(key: string, sprite: unknown, expectedRevision: number, actor: string | null): Promise<SceneSpriteDetail>;
  archive(key: string, archived: boolean, expectedRevision: number, actor: string | null): Promise<SceneSpriteDetail>;
  delete(key: string, expectedRevision: number, actor: string | null): Promise<void>;
}

export function createSceneSpriteService(deps: {
  db: Db;
  assets: Pick<ArtworkAssetService, 'recordReferenceChanges' | 'readUsable'>;
}): SceneSpriteService {
  const { db } = deps;
  type Row = typeof dungeonSceneSprites.$inferSelect;
  const summary = (row: Row): SceneSpriteSummary => ({
    ...SceneSpriteInputSchema.parse(row.definition),
    key: row.spriteKey,
    revision: row.revision,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  });
  // Same table lock in every mutation; publication takes SHARE before snapshotting.
  const lock = (tx: DbOrTx) => tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE ROW EXCLUSIVE MODE`);
  async function rowOf(tx: DbOrTx, key: string, expectedRevision?: number): Promise<Row> {
    const [row] = await tx.select().from(dungeonSceneSprites).where(eq(dungeonSceneSprites.spriteKey, key));
    if (!row) throw new SceneSpriteError('NOT_FOUND', 'This scene sprite no longer exists.');
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      throw new SceneSpriteError('SCENE_SPRITE_STALE', 'Someone saved this sprite first. Reload it before saving.', {
        currentRevision: row.revision,
      });
    return row;
  }
  async function validate(tx: DbOrTx, key: string, input: unknown): Promise<SceneSpriteInput> {
    const parsedKey = SceneSpriteKeySchema.safeParse(key);
    const parsed = SceneSpriteInputSchema.safeParse(input);
    const issues = [
      ...(!parsedKey.success
        ? parsedKey.error.issues.map((i) => ({
            path: 'key',
            message: i.message,
          }))
        : []),
      ...(!parsed.success
        ? parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          }))
        : []),
    ];
    if (!parsed.success || issues.length)
      throw new SceneSpriteError('SCENE_SPRITE_INVALID', 'Check the sprite properties.', { issues });
    const [asset] = await tx.select().from(artworkAssets).where(eq(artworkAssets.id, parsed.data.assetId)).for('share');
    if (!asset || asset.status !== 'active' || !(await deps.assets.readUsable(asset.id)))
      throw new SceneSpriteError('SCENE_SPRITE_INVALID', 'Choose active artwork for this sprite.', {
        issues: [
          {
            path: 'assetId',
            message: 'Choose active artwork for this sprite.',
          },
        ],
      });
    return parsed.data;
  }
  async function references(tx: DbOrTx, key: string): Promise<SceneSpriteUsage[]> {
    const result: SceneSpriteUsage[] = [];
    const docs: Array<{
      dungeonKey: string;
      name: string;
      source: string;
      definition: ReturnType<typeof DungeonDefinitionSchema.parse>;
    }> = (await readDungeonContentDocuments(tx)).filter((doc) => doc.source === 'draft');
    // Historical revisions remain rollback targets, even with no active run.
    for (const row of await tx.select().from(dungeonRevisions)) {
      const parsed = DungeonDefinitionSchema.safeParse(row.content);
      if (parsed.success)
        docs.push({
          dungeonKey: row.dungeonKey,
          name: parsed.data.name,
          source: `revision ${row.number}`,
          definition: parsed.data,
        });
    }
    for (const doc of docs)
      for (const room of doc.definition.rooms) {
        const scan = (instances: readonly { id: string; spriteKey: string }[] | undefined, actionId?: string) => {
          for (const instance of instances ?? [])
            if (instance.spriteKey === key)
              result.push({
                dungeonKey: doc.dungeonKey,
                name: doc.name,
                source: doc.source,
                roomId: room.id,
                ...(actionId ? { actionId } : {}),
                instanceId: instance.id,
              });
        };
        scan(
          (
            room as typeof room & {
              sceneSprites?: { id: string; spriteKey: string }[];
            }
          ).sceneSprites,
        );
        for (const action of room.actions)
          scan(
            (
              action as typeof action & {
                sceneSprites?: { id: string; spriteKey: string }[];
              }
            ).sceneSprites,
            action.id,
          );
      }
    return result;
  }
  async function detail(tx: DbOrTx, row: Row): Promise<SceneSpriteDetail> {
    const events = await tx
      .select()
      .from(dungeonSceneSpriteEvents)
      .where(eq(dungeonSceneSpriteEvents.spriteKey, row.spriteKey))
      .orderBy(desc(dungeonSceneSpriteEvents.id))
      .limit(50);
    return {
      ...summary(row),
      references: await references(tx, row.spriteKey),
      events: events.map((e) => ({
        action: e.action,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
        details: e.details,
      })),
    };
  }
  async function audit(
    tx: DbOrTx,
    key: string,
    action: (typeof dungeonSceneSpriteEvents.$inferInsert)['action'],
    actor: string | null,
    details: Record<string, unknown>,
  ) {
    await tx.insert(dungeonSceneSpriteEvents).values({ spriteKey: key, action, actor, details });
  }
  const slots = (row?: Row) => (row ? [{ field: 'assetId', assetId: row.assetId }] : []);
  return {
    async list(tx = db) {
      return (await tx.select().from(dungeonSceneSprites).orderBy(asc(dungeonSceneSprites.spriteKey))).map(summary);
    },
    async get(key) {
      const [row] = await db.select().from(dungeonSceneSprites).where(eq(dungeonSceneSprites.spriteKey, key));
      return row ? detail(db, row) : null;
    },
    async create(key, input, actor) {
      return db.transaction(async (tx) => {
        await lock(tx);
        const sprite = await validate(tx, key, input);
        const [existing] = await tx.select().from(dungeonSceneSprites).where(eq(dungeonSceneSprites.spriteKey, key));
        if (existing) throw new SceneSpriteError('SCENE_SPRITE_KEY_TAKEN', 'That sprite identifier is already in use.');
        const [row] = await tx
          .insert(dungeonSceneSprites)
          .values({
            spriteKey: key,
            definition: sprite,
            assetId: sprite.assetId,
            updatedBy: actor,
          })
          .returning();
        await audit(tx, key, 'created', actor, { revision: 1, sprite });
        await deps.assets.recordReferenceChanges(
          tx,
          {
            entity: `dungeon_scene_sprite:${key}`,
            before: [],
            after: slots(row),
          },
          actor,
        );
        return detail(tx, row!);
      });
    },
    async update(key, input, expectedRevision, actor) {
      return db.transaction(async (tx) => {
        await lock(tx);
        const old = await rowOf(tx, key, expectedRevision);
        const sprite = await validate(tx, key, input);
        const [row] = await tx
          .update(dungeonSceneSprites)
          .set({
            definition: sprite,
            assetId: sprite.assetId,
            revision: old.revision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonSceneSprites.spriteKey, key))
          .returning();
        await audit(tx, key, 'updated', actor, {
          revision: row!.revision,
          before: old.definition,
          sprite,
        });
        await deps.assets.recordReferenceChanges(
          tx,
          {
            entity: `dungeon_scene_sprite:${key}`,
            before: slots(old),
            after: slots(row),
          },
          actor,
        );
        return detail(tx, row!);
      });
    },
    async archive(key, archived, expectedRevision, actor) {
      return db.transaction(async (tx) => {
        await lock(tx);
        const old = await rowOf(tx, key, expectedRevision);
        const [row] = await tx
          .update(dungeonSceneSprites)
          .set({
            archivedAt: archived ? new Date() : null,
            revision: old.revision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonSceneSprites.spriteKey, key))
          .returning();
        await audit(tx, key, archived ? 'archived' : 'restored', actor, {
          revision: row!.revision,
        });
        return detail(tx, row!);
      });
    },
    async delete(key, expectedRevision, actor) {
      await db.transaction(async (tx) => {
        await lock(tx);
        const row = await rowOf(tx, key, expectedRevision);
        const used = await references(tx, key);
        if (used.length)
          throw new SceneSpriteError('SCENE_SPRITE_IN_USE', 'This sprite is used by a dungeon. Archive it instead.', {
            references: used,
          });
        await deps.assets.recordReferenceChanges(
          tx,
          {
            entity: `dungeon_scene_sprite:${key}`,
            before: slots(row),
            after: [],
          },
          actor,
        );
        await tx.delete(dungeonSceneSprites).where(eq(dungeonSceneSprites.spriteKey, key));
        await audit(tx, key, 'deleted', actor, {
          revision: row.revision,
          sprite: row.definition,
        });
      });
    },
  };
}
