/** Catalogue visuals frozen alongside the content in the existing dungeon revision. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../../db/client';
import { artworkAssets, dungeonSceneSprites } from '../../../db/schema';
import type { ArtworkStorage } from '../../artworkAssets/artworkStorage';
import {
  sceneSpriteSites,
  sceneSpriteKeys,
  type SpriteDocument,
  SceneSpriteInputSchema,
  SceneSpriteVisualSchema,
  resolveSceneSpriteInstance,
  type SceneSpriteInstance,
  type SceneSpriteVisual,
} from './sceneSpriteDefinition';

const FrozenSceneSpriteSchema = SceneSpriteVisualSchema.extend({
  name: z.string(),
  artworkCategory: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const SnapshotSchema = z
  .object({
    version: z.literal(1),
    sprites: z.record(FrozenSceneSpriteSchema),
    hash: z.string(),
  })
  .strict();
export type SceneSpriteSnapshot = z.infer<typeof SnapshotSchema>;
export type SceneSpriteCatalogue = ReadonlyMap<
  string,
  z.infer<typeof FrozenSceneSpriteSchema> & {
    archived: boolean;
    usable: boolean;
  }
>;
export async function sceneSpriteCatalogue(
  tx: DbOrTx,
  storage?: Pick<ArtworkStorage, 'exists'>,
  lock = false,
): Promise<SceneSpriteCatalogue> {
  if (lock) await tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE MODE`);
  const rows = await tx
    .select({ sprite: dungeonSceneSprites, asset: artworkAssets })
    .from(dungeonSceneSprites)
    .leftJoin(artworkAssets, eq(artworkAssets.id, dungeonSceneSprites.assetId));
  if (lock)
    for (const id of [...new Set(rows.map((r) => r.sprite.assetId))].sort())
      await tx.select({ id: artworkAssets.id }).from(artworkAssets).where(eq(artworkAssets.id, id)).for('share');
  // Re-read after the asset locks: a replacement completed while waiting must not be frozen with its old hash.
  const lockedRows = lock
    ? await tx
        .select({ sprite: dungeonSceneSprites, asset: artworkAssets })
        .from(dungeonSceneSprites)
        .leftJoin(artworkAssets, eq(artworkAssets.id, dungeonSceneSprites.assetId))
    : rows;
  const out = new Map<
    string,
    z.infer<typeof FrozenSceneSpriteSchema> & {
      archived: boolean;
      usable: boolean;
    }
  >();
  for (const { sprite, asset } of lockedRows) {
    const parsed = SceneSpriteInputSchema.safeParse(sprite.definition);
    if (!parsed.success || !asset) continue;
    out.set(sprite.spriteKey, {
      assetId: sprite.assetId,
      name: parsed.data.name,
      artworkCategory: asset.category,
      contentHash: asset.contentHash,
      placement: parsed.data.placement,
      mirror: parsed.data.mirror,
      visualLayer: parsed.data.visualLayer,
      archived: sprite.archivedAt !== null,
      usable: asset.status === 'active' && (!storage || (await storage.exists(asset.storageKey))),
    });
  }
  return out;
}
function hashOf(sprites: SceneSpriteSnapshot['sprites']): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(sprites).sort(([a], [b]) => a.localeCompare(b)))))
    .digest('hex');
}
export function freezeSceneSprites(
  definition: SpriteDocument,
  catalogue: SceneSpriteCatalogue,
): SceneSpriteSnapshot | null {
  const keys = sceneSpriteKeys(definition);
  if (!keys.length) return null;
  const sprites = Object.fromEntries(
    keys.map((key) => {
      const s = catalogue.get(key);
      if (!s || s.archived || !s.usable) throw new Error(`Scene sprite ${key} cannot be published.`);
      return [key, FrozenSceneSpriteSchema.strip().parse(s)];
    }),
  );
  return { version: 1, sprites, hash: hashOf(sprites) };
}
export function readSceneSpriteSnapshot(raw: unknown): SceneSpriteSnapshot | null {
  const parsed = SnapshotSchema.safeParse(raw);
  return parsed.success && parsed.data.hash === hashOf(parsed.data.sprites) ? parsed.data : null;
}
export async function pinnedSceneSpriteCatalogue(
  tx: DbOrTx,
  raw: unknown,
  storage?: Pick<ArtworkStorage, 'exists'>,
): Promise<SceneSpriteCatalogue> {
  const snapshot = readSceneSpriteSnapshot(raw);
  const out = new Map<
    string,
    z.infer<typeof FrozenSceneSpriteSchema> & {
      archived: boolean;
      usable: boolean;
    }
  >();
  for (const [key, sprite] of Object.entries(snapshot?.sprites ?? {})) {
    const [asset] = await tx.select().from(artworkAssets).where(eq(artworkAssets.id, sprite.assetId));
    out.set(key, {
      ...sprite,
      archived: false,
      usable:
        !!asset &&
        asset.status === 'active' &&
        asset.contentHash === sprite.contentHash &&
        (!storage || (await storage.exists(asset.storageKey))),
    });
  }
  return out;
}
export interface SceneSpriteRenderVisual extends SceneSpriteVisual {
  contentHash: string;
}
export function sceneSpritesForRoom(
  definition: SpriteDocument,
  roomId: string,
  actionId: string | undefined,
  raw: unknown,
): SceneSpriteRenderVisual[] {
  const snapshot = readSceneSpriteSnapshot(raw);
  if (!snapshot) return [];
  return sceneSpriteSites(definition)
    .filter((s) => s.roomId === roomId && (!s.actionId || s.actionId === actionId))
    .flatMap((site) =>
      site.instances.flatMap((instance) => {
        const sprite = snapshot.sprites[instance.spriteKey];
        return sprite
          ? [
              {
                ...resolveSceneSpriteInstance(sprite, instance),
                contentHash: sprite.contentHash,
              },
            ]
          : [];
      }),
    );
}
