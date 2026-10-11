/**
 * A dungeon names managed artwork by category and content hash; the asset
 * manager's Replace keeps the asset and changes its hash. These cover what a
 * reference resolves to afterwards — for drafts, published revisions, running
 * dungeons, and a package moved to another environment — against a real
 * database and real (temporary) storage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtworkAsset } from '../../src/modules/artworkAssets/artworkAssetService';
import type { DungeonArtworkRef, DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { BLUE, GREEN, RED, solidImage } from '../helpers/imageFixtures';

let w: DungeonWorld;
/** A second environment: its own database and its own asset store. */
let other: DungeonWorld;
beforeAll(async () => {
  [w, other] = await Promise.all([createDungeonWorld(), createDungeonWorld()]);
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
});
afterAll(async () => {
  await Promise.all([w?.cleanup(), other?.cleanup()]);
});

let n = 0;
/** Bytes no other call returns: the size is part of the picture. */
const image = (color = BLUE) => solidImage(200 + ++n, 120, color);
const upload = (world: DungeonWorld, bytes: Buffer, category: ArtworkAsset['category'] = 'dungeon_background') =>
  world.assets.upload({ bytes, category, filename: `picture-${n}.png`, name: `Picture ${n}` }, 'test');
const refTo = (asset: Pick<ArtworkAsset, 'category' | 'contentHash' | 'name'>): Extract<DungeonArtworkRef, { kind: 'managed' }> => ({
  kind: 'managed',
  category: asset.category as 'dungeon_background',
  contentHash: asset.contentHash,
  name: asset.name,
});
const resolve = (ref: { category: string; contentHash: string }, world = w) => world.content.resolveManagedArtwork(ref);
/** Publish a one-fight dungeon whose scene background and room background are `ref`. */
async function publishWith(ref: DungeonArtworkRef, patch: (d: DungeonDefinitionInput) => void = () => {}): Promise<string> {
  const key = `art_${++n}`;
  await w.publish(
    singleRoomDungeon([{ id: 'guards', type: 'combat', waves: [{ enemy: { key: 'grunt' } }] }], (d) => {
      d.key = key;
      d.background = ref;
      d.rooms[0]!.background = ref;
      patch(d);
    }),
  );
  return key;
}
const missingArtwork = async (key: string, world = w) => (await world.content.get(key))!.issues.filter((i) => i.code === 'artwork_missing');
const bytesOf = async (assetId: string | null | undefined, world = w) => (await world.assets.readUsable(assetId))?.bytes ?? null;

describe('replacing a managed image a dungeon uses', () => {
  it('keeps resolving through one replacement and through several, without touching the published revision', async () => {
    const [v1, v2, v3] = [await image(), await image(GREEN), await image(RED)];
    const asset = await upload(w, v1);
    const original = refTo(asset);
    const key = await publishWith(original);
    const published = async () => {
      const found = await w.content.published(w.t.db, key);
      if (typeof found === 'string') throw new Error(found);
      return found;
    };
    const before = await published();
    expect(await resolve(original)).toBe(asset.id);

    const second = (await w.assets.replace(asset.id, { bytes: v2 }, 'test'))!;
    expect(second.id).toBe(asset.id);
    expect(second.contentHash).not.toBe(asset.contentHash);
    expect(await resolve(original)).toBe(asset.id);
    expect(await bytesOf(await resolve(original))).toEqual(v2);

    const third = (await w.assets.replace(asset.id, { bytes: v3 }, 'test'))!;
    // Every hash the asset has held still means the asset — and shows what it holds now.
    for (const ref of [original, refTo(second), refTo(third)]) expect(await resolve(ref)).toBe(asset.id);
    expect(await bytesOf(await resolve(original))).toEqual(v3);
    expect(await missingArtwork(key)).toEqual([]);

    // The revision is the one that was published, byte for byte: still naming the first hash.
    const after = await published();
    expect(after.revision.id).toBe(before.revision.id);
    expect(after.definition).toEqual(before.definition);
    expect(after.definition.background).toEqual(original);
    expect((await w.content.get(key))!.draft.background).toEqual(original);

    // A run started now gets the asset, so the newest picture.
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, key);
    expect(run.dungeon.background.assetId).toBe(asset.id);
    expect(run.roomBackground.assetId).toBe(asset.id);
    // Nothing is held in memory: a restarted process answers the same from the database.
    const restarted = w.restartedRuns();
    expect((await restarted.run(playerId, run.id)).roomBackground.assetId).toBe(asset.id);
    expect((await restarted.dungeon(playerId, key)).dungeon.background.assetId).toBe(asset.id);
  });

  it('moves every dungeon naming the image together, and guards the asset for all of them', async () => {
    const asset = await upload(w, await image());
    const original = refTo(asset);
    const first = await publishWith(original);
    const replaced = (await w.assets.replace(asset.id, { bytes: await image(GREEN) }, 'test'))!;
    // One published before the replacement, one after still naming the old bytes, one naming the new.
    const second = await publishWith(original);
    const third = await publishWith(refTo(replaced));
    for (const key of [first, second, third]) expect(await missingArtwork(key)).toEqual([]);
    expect(await resolve(original)).toBe(asset.id);
    expect(await resolve(refTo(replaced))).toBe(asset.id);

    const users = new Set((await w.assets.references(asset.id)).map((r) => r.key));
    expect([first, second, third].every((key) => users.has(key))).toBe(true);
    await expect(w.assets.delete(asset.id, 'test')).rejects.toThrow();
    expect((await w.assets.get(asset.id))!.status).toBe('active');
  });

  it('a run in progress keeps the asset it started with: a replacement shows, a disable hides', async () => {
    const [v1, v2] = [await image(), await image(GREEN)];
    const asset = await upload(w, v1);
    const key = await publishWith(refTo(asset));
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, key);
    expect(run.roomBackground.assetId).toBe(asset.id);

    await w.assets.replace(asset.id, { bytes: v2 }, 'test');
    const during = await w.runs.run(playerId, run.id);
    expect(during.dungeon.revision).toBe(run.dungeon.revision);
    expect(during.roomBackground.assetId).toBe(asset.id);
    expect(await bytesOf(during.roomBackground.assetId)).toEqual(v2);

    // Disabled: the run still names the asset, which now yields nothing — the screen falls through.
    await w.assets.setEnabled(asset.id, false, 'test');
    expect((await w.runs.run(playerId, run.id)).roomBackground.assetId).toBe(asset.id);
    expect(await bytesOf(asset.id)).toBeNull();
    // A run started meanwhile has no picture to pin, and does not gain one later.
    const late = await w.player();
    const blind = await w.runs.start(late.playerId, key);
    expect(blind.roomBackground.assetId).toBeNull();
    await w.assets.setEnabled(asset.id, true, 'test');
    expect(await bytesOf((await w.runs.run(playerId, run.id)).roomBackground.assetId)).toEqual(v2);
    expect((await w.runs.run(late.playerId, blind.id)).roomBackground.assetId).toBeNull();
  });
});

describe('references that must not resolve', () => {
  it('nothing for bytes never stored here, a disabled asset or a deleted one', async () => {
    expect(await resolve({ category: 'dungeon_background', contentHash: 'e'.repeat(64) })).toBeNull();

    const asset = await upload(w, await image());
    const original = refTo(asset);
    const replaced = (await w.assets.replace(asset.id, { bytes: await image(GREEN) }, 'test'))!;
    const key = await publishWith(original);
    await w.assets.setEnabled(asset.id, false, 'test');
    expect(await resolve(original)).toBeNull();
    expect(await resolve(refTo(replaced))).toBeNull();
    expect(await missingArtwork(key)).toHaveLength(1);
    // Disabled is still in use: the reference comes back when it is re-enabled, so it cannot be deleted.
    await expect(w.assets.delete(asset.id, 'test')).rejects.toThrow();
    await w.assets.setEnabled(asset.id, true, 'test');
    expect(await resolve(original)).toBe(asset.id);

    const unused = await upload(w, await image());
    const unusedBefore = refTo(unused);
    const unusedAfter = (await w.assets.replace(unused.id, { bytes: await image(RED) }, 'test'))!;
    await w.assets.delete(unused.id, 'test');
    expect(await resolve(unusedBefore)).toBeNull();
    expect(await resolve(refTo(unusedAfter))).toBeNull();
  });

  it('refuses to move an asset to another category while a dungeon names it, by current or earlier bytes', async () => {
    const asset = await upload(w, await image());
    const original = refTo(asset);
    const replaced = (await w.assets.replace(asset.id, { bytes: await image(GREEN) }, 'test'))!;
    // Unreferenced, it moves freely — and back.
    expect((await w.assets.update(asset.id, { category: 'dungeon_zone' }, 'test'))!.category).toBe('dungeon_zone');
    expect((await w.assets.update(asset.id, { category: 'dungeon_background' }, 'test'))!.category).toBe('dungeon_background');

    // One dungeon names the bytes it held before the replacement, another the current ones.
    const byOld = await publishWith(original);
    const move = () => w.assets.update(asset.id, { category: 'dungeon_zone' }, 'test');
    await expect(move()).rejects.toMatchObject({ code: 'ARTWORK_ASSET_IN_USE', references: [expect.objectContaining({ key: byOld }), expect.anything(), expect.anything(), expect.anything()] });
    const byNew = await publishWith(refTo(replaced));
    const refusal = await move().catch((err: { references: { kind: string; key: string }[] }) => err);
    expect(new Set((refusal as { references: { key: string }[] }).references.map((r) => r.key))).toEqual(new Set([byOld, byNew]));
    // Disabled is no way round it: the references come back with the asset.
    await w.assets.setEnabled(asset.id, false, 'test');
    await expect(move()).rejects.toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    await w.assets.setEnabled(asset.id, true, 'test');

    // Nothing moved, nothing orphaned; a rename is still allowed.
    expect((await w.assets.get(asset.id))!.category).toBe('dungeon_background');
    expect((await w.assets.update(asset.id, { name: 'Renamed' }, 'test'))!.name).toBe('Renamed');
    for (const ref of [original, refTo(replaced)]) expect(await resolve(ref)).toBe(asset.id);
    for (const key of [byOld, byNew]) expect(await missingArtwork(key)).toEqual([]);
  });

  it('never crosses categories, and never picks between assets that once held the same bytes', async () => {
    const shared = await image();
    const older = await upload(w, shared);
    const newer = await upload(w, shared);
    const ref = refTo(older);
    expect(newer.contentHash).toBe(older.contentHash);
    // The same bytes filed under another category are another reference.
    expect(await resolve({ category: 'dungeon_zone', contentHash: ref.contentHash })).toBeNull();
    // Two assets hold the bytes: the oldest, always.
    expect(await resolve(ref)).toBe(older.id);

    // One is replaced: the other still holds exactly those bytes, so it is the picture.
    await w.assets.replace(older.id, { bytes: await image(GREEN) }, 'test');
    expect(await resolve(ref)).toBe(newer.id);
    // Both replaced: the reference stays with the asset that held the bytes last…
    const newerNow = (await w.assets.replace(newer.id, { bytes: await image(RED) }, 'test'))!;
    expect(await resolve(ref)).toBe(newer.id);
    // …and with no other: switching it off does not hand the dungeon the other asset's new picture.
    await w.assets.setEnabled(newer.id, false, 'test');
    expect(await resolve(ref)).toBeNull();
    await w.assets.setEnabled(newer.id, true, 'test');
    expect(await resolve(ref)).toBe(newer.id);
    // The delete guard follows the same ownership: only the asset the reference can mean is held.
    const key = await publishWith(ref);
    expect((await w.assets.references(newer.id)).some((r) => r.key === key)).toBe(true);
    expect((await w.assets.references(older.id)).some((r) => r.key === key)).toBe(false);

    // The exact bytes uploaded again win over any history.
    const exact = await upload(w, shared);
    expect(await resolve(ref)).toBe(exact.id);
    expect(await resolve(refTo(newerNow))).toBe(newer.id);
    await w.assets.setEnabled(exact.id, false, 'test');
    expect(await resolve(ref)).toBe(newer.id);
  });
});

describe('a dungeon package and replaced artwork', () => {
  it('exports the reference as saved and resolves it elsewhere only from that environment’s own assets', async () => {
    const [v1, v2] = [await image(), await image(GREEN)];
    const asset = await upload(w, v1);
    const original = refTo(asset);
    const key = await publishWith(original);
    const replaced = (await w.assets.replace(asset.id, { bytes: v2 }, 'test'))!;

    // Export after the replacement still carries the hash the dungeon was saved with — no id, no history.
    for (const origin of ['draft', 'published'] as const) {
      const pkg = await w.content.exportPackage(key, origin, 'test');
      expect(pkg.assets).toEqual([original]);
      expect(pkg.dungeon.background).toEqual(original);
      expect(JSON.stringify(pkg)).not.toContain(asset.id);
      expect(JSON.stringify(pkg)).not.toContain(replaced.contentHash);
      expect(readDungeonPackage(JSON.parse(JSON.stringify(pkg))).issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
    const pkg = await w.content.exportPackage(key, 'published', 'test');
    // The dungeon's own pictures only; a bundled enemy's shipped art is reported on its own path.
    const plan = async () =>
      (await other.content.planImport(pkg)).issues.filter((i) => i.code.startsWith('artwork_') && ['dungeon.artwork', 'assets'].includes(i.path));

    // Elsewhere, with only an unrelated image: reported missing, never matched to it.
    const unrelated = await upload(other, await image(RED));
    expect((await plan()).map((i) => i.code)).toEqual(['artwork_missing']);
    expect(await resolve(original, other)).toBeNull();
    const first = await other.content.planImport(pkg);
    const applied = await other.content.applyImport(
      {
        package: pkg,
        requestId: '11111111-1111-4111-8111-111111111111',
        expectedPlanHash: first.planHash!,
        expectedRevision: first.target!.expectedRevision,
        decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false },
      },
      'test',
    );
    expect(applied.result).toBe('created');
    expect((await other.content.get(key))!.draft.background).toEqual(original);
    expect(await missingArtwork(key, other)).toHaveLength(1);

    // The limitation: the *current* picture uploaded there does not satisfy the old hash.
    const current = await upload(other, v2);
    expect(current.contentHash).toBe(replaced.contentHash);
    expect((await plan()).map((i) => i.code)).toEqual(['artwork_missing']);

    // The bytes the dungeon names, uploaded there, do.
    const same = await upload(other, v1);
    expect(await plan()).toEqual([]);
    expect(await resolve(original, other)).toBe(same.id);
    expect(await missingArtwork(key, other)).toEqual([]);

    // Replaced there in turn: it follows that environment's asset, and the import review says so.
    await other.assets.replace(same.id, { bytes: await image(RED) }, 'test');
    const followed = await plan();
    expect(followed.map((i) => [i.code, i.severity])).toEqual([['artwork_replaced', 'warning']]);
    expect(followed[0]!.message).toContain(same.name);
    expect(await resolve(original, other)).toBe(same.id);
    expect(await resolve(original, other)).not.toBe(unrelated.id);
    // A reviewed plan goes stale when the picture behind it changes again.
    const reviewed = await other.content.planImport(pkg);
    await other.assets.replace(same.id, { bytes: await image(BLUE) }, 'test');
    expect((await other.content.planImport(pkg)).planHash).not.toBe(reviewed.planHash);
  });
});
