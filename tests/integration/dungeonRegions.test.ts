/**
 * Region availability against a real database: a zone is listed and startable
 * only where it is open, the check is made by the service inside the start
 * transaction (never by the listing), and an active run does not care where
 * the player goes afterwards or what an admin later does to the zone.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonDailyUsage, dungeonRuns, players } from '../../src/db/schema';
import { createDungeonPlayService } from '../../src/modules/dungeons/dungeonPlayService';
import { dungeonRegionsFromContent } from '../../src/modules/dungeons/dungeonZoneStore';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { DEFAULT_REGION, REGIONS } from '../../src/modules/locations/regions';
import {
  DungeonRunActiveError,
  DungeonZoneInvalidError,
  DungeonZoneUnavailableError,
} from '../../src/shared/errors';
import { createDungeonWorld, playZoneDoc, walk, type DungeonWorld } from '../helpers/dungeonPlayFixtures';

let w: DungeonWorld;

/** Open in the starting region only. */
const VALLEY = 'region_valley';
/** Open in the Foothills only. */
const FOOTHILLS = 'region_foothills';
/** Open in the valley and the Thirstlands. */
const BOTH = 'region_both';
/** Disabled, though it names the valley. */
const CLOSED = 'region_closed';

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.zone(VALLEY);
  await w.zone(FOOTHILLS, (z) => {
    z.availableRegions = ['flaccid-foothills'];
  });
  await w.zone(BOTH, (z) => {
    z.availableRegions = ['waifu-valley', 'thirstlands'];
  });
  await w.zone(CLOSED, (z) => {
    z.enabled = false;
  });
});
afterAll(async () => {
  await w?.cleanup();
});

const travel = (playerId: number, region: string) =>
  w.t.db.update(players).set({ currentRegion: region }).where(eq(players.id, playerId));
const listed = async (playerId: number) => (await w.play.home(playerId)).zones.map((z) => z.key).sort();
const runsOf = (playerId: number) => w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId));
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e);

describe('the region catalogue', () => {
  it('is the loaded region content, by stable id and display name', () => {
    const regions = dungeonRegionsFromContent(w.content.current);
    expect(regions.map((r) => r.id).sort()).toEqual([...REGIONS].sort());
    expect(regions.find((r) => r.id === 'flaccid-foothills')).toMatchObject({ name: 'Flaccid Foothills', enabled: true });
    // A deployment with no region files still has the closed set of ids.
    expect(dungeonRegionsFromContent({ regions: [] }).map((r) => r.id)).toEqual([...REGIONS]);
  });
});

describe('authoring', () => {
  it('saves one region and several, and reads them back', async () => {
    expect((await w.zones.get(FOOTHILLS))!.zone.availableRegions).toEqual(['flaccid-foothills']);
    expect((await w.zones.get(BOTH))!).toMatchObject({ availableRegions: ['waifu-valley', 'thirstlands'] });
    expect((await w.zones.list()).find((z) => z.key === VALLEY)!.availableRegions).toEqual(['waifu-valley']);
  });

  it('refuses an unknown region, a duplicate, and an enabled zone with no region — by path, storing nothing', async () => {
    const attempt = async (key: string, regions: string[], enabled = true) => {
      const err = await refusal(
        w.zones.create(playZoneDoc(key, (z) => Object.assign(z, { availableRegions: regions, enabled })), 'test'),
      );
      expect(await w.zones.get(key), key).toBeNull();
      expect(err, key).toBeInstanceOf(DungeonZoneInvalidError);
      return (err as DungeonZoneInvalidError).issues.filter((i) => i.severity === 'error').map((i) => i.path);
    };
    expect(await attempt('bad_unknown', ['waifu-valley', 'sunken-mall'])).toEqual(['availableRegions[1]']);
    expect(await attempt('bad_duplicate', ['waifu-valley', 'waifu-valley'])).toEqual(['availableRegions[1]']);
    expect(await attempt('bad_nowhere', [])).toEqual(['availableRegions']);
    expect(await attempt('bad_shape', ['Waifu Valley'])).toEqual(['availableRegions[0]']);
  });

  it('lets a disabled draft be saved with no region, but not enabled until it has one', async () => {
    const draft = await w.zones.create(
      playZoneDoc('draft_nowhere', (z) => Object.assign(z, { availableRegions: [], enabled: false })),
      'test',
    );
    expect(draft.issues.map((i) => [i.path, i.severity])).toContainEqual(['availableRegions', 'warning']);
    const err = await refusal(w.zones.setEnabled('draft_nowhere', { enabled: true, expectedRevision: draft.revision }, 'test'));
    expect(err).toBeInstanceOf(DungeonZoneInvalidError);
    expect((await w.zones.get('draft_nowhere'))!.enabled).toBe(false);
  });
});

describe('the Delve listing', () => {
  it('shows only the enabled zones open where the player is standing', async () => {
    const { playerId } = await w.player();
    const home = await w.play.home(playerId);
    expect(home.region).toEqual({ id: DEFAULT_REGION, name: 'Waifu Valley' });
    expect(home.zones.map((z) => z.key).sort()).toEqual([BOTH, VALLEY]);

    await travel(playerId, 'flaccid-foothills');
    expect((await w.play.home(playerId)).region).toEqual({ id: 'flaccid-foothills', name: 'Flaccid Foothills' });
    expect(await listed(playerId)).toEqual([FOOTHILLS]);

    await travel(playerId, 'thirstlands');
    expect(await listed(playerId)).toEqual([BOTH]);
  });

  it('is empty — not an error — in a region with no zone', async () => {
    const { playerId } = await w.player();
    await travel(playerId, 'twin-peeks');
    const home = await w.play.home(playerId);
    expect(home).toMatchObject({ region: { id: 'twin-peeks', name: 'Twin Peeks' }, zones: [], activeRun: null });
    // The allowance is still reported: it is not tied to a region.
    expect(home.daily).toMatchObject({ limit: 3, remaining: 3 });
  });

  it('names the region from the catalogue the service was given', async () => {
    const named = createDungeonPlayService({
      db: w.t.db,
      runs: w.runs,
      allowance: w.allowance,
      featureUnlocks: w.svc.featureUnlocks,
      combatStats: w.stats,
      currencies: w.currencies,
      currency: w.app.currency,
      inventory: w.app.inventory,
      equipmentRewards: createEquipmentRewardService({ equipment: w.svc.equipment, getAffixes: w.svc.getAffixes, featureUnlocks: w.svc.featureUnlocks }),
      regionName: (id) => `The ${id}`,
    });
    const { playerId } = await w.player();
    expect((await named.home(playerId)).region.name).toBe('The waifu-valley');
  });
});

describe('starting a run', () => {
  it('succeeds in an allowed region and records where it was started', async () => {
    const { playerId } = await w.player();
    await travel(playerId, 'flaccid-foothills');
    const run = await w.play.start(playerId, FOOTHILLS);
    expect(run.status).toBe('active');
    const [started] = await w.play.history(run.id);
    expect(started).toMatchObject({ type: 'run_started', payload: { region: 'flaccid-foothills' } });
  });

  it('succeeds from each region of a zone open in several', async () => {
    for (const region of ['waifu-valley', 'thirstlands']) {
      const { playerId } = await w.player();
      await travel(playerId, region);
      expect((await w.play.start(playerId, BOTH)).status, region).toBe('active');
    }
  });

  it('is refused outside the allowed regions by the service itself — no run, no attempt spent', async () => {
    const { playerId } = await w.player();
    // The player never saw this zone listed; a forged or stale Start reaches the service anyway.
    const err = await refusal(w.play.start(playerId, FOOTHILLS));
    expect(err).toBeInstanceOf(DungeonZoneUnavailableError);
    expect(err).toMatchObject({ code: 'DUNGEON_ZONE_UNAVAILABLE', reason: 'region', userMessage: 'That Delve isn’t available in Waifu Valley.' });
    expect(await runsOf(playerId)).toHaveLength(0);
    expect(await w.t.db.select().from(dungeonDailyUsage).where(eq(dungeonDailyUsage.playerId, playerId))).toHaveLength(0);
    // The zone screen refuses the same way, so a stale button cannot even show Start.
    await expect(w.play.zone(playerId, FOOTHILLS)).rejects.toMatchObject({ reason: 'region' });

    await travel(playerId, 'thirstlands');
    await expect(w.play.start(playerId, VALLEY)).rejects.toMatchObject({ reason: 'region', userMessage: 'That Delve isn’t available in Thirstlands.' });
    await expect(w.play.start(playerId, FOOTHILLS)).rejects.toMatchObject({ reason: 'region' });
  });

  it('refuses a disabled zone as disabled and a missing one as missing, wherever the player is', async () => {
    const { playerId } = await w.player();
    await expect(w.play.start(playerId, CLOSED)).rejects.toMatchObject({ reason: 'disabled' });
    await expect(w.play.start(playerId, 'no_such_zone')).rejects.toMatchObject({ reason: 'missing' });
    expect(await listed(playerId)).not.toContain(CLOSED);
  });

  it('checks the region the player is in when the start lands, not when the screen was painted', async () => {
    const { playerId } = await w.player();
    expect(await listed(playerId)).toContain(VALLEY); // painted in the valley…
    await travel(playerId, 'twin-peeks'); // …then they left
    await expect(w.play.start(playerId, VALLEY)).rejects.toMatchObject({ reason: 'region' });
    await travel(playerId, 'waifu-valley');
    expect((await w.play.start(playerId, VALLEY)).status).toBe('active');
  });

  it('still puts an active run first: a second start anywhere is refused as that', async () => {
    const { playerId } = await w.player();
    await w.play.start(playerId, VALLEY);
    await travel(playerId, 'flaccid-foothills');
    await expect(w.play.start(playerId, FOOTHILLS)).rejects.toBeInstanceOf(DungeonRunActiveError);
  });
});

describe('an active run and travel', () => {
  it('stays playable to the end after the player leaves the region it was started in', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, VALLEY);
    const first = await w.play.resolveNode(playerId, run.id, run.node.id);
    expect(first.status).toBe('applied');

    await travel(playerId, 'twin-peeks');
    // Resume: the home shows the run, though nothing is startable here.
    const home = await w.play.home(playerId);
    expect(home).toMatchObject({ region: { id: 'twin-peeks' }, zones: [], activeRun: { id: run.id, status: 'active' } });
    expect((await w.play.activeRun(playerId))!.id).toBe(run.id);
    expect((await w.play.run(playerId, run.id)).currentHp).toBe(first.run.currentHp);

    // Move, rest, extract — every action works from elsewhere.
    // On to the first node that offers extraction (a rest deep enough to be one).
    const rest = await walk(w.play, playerId, first.run, { stopAt: (v) => v.canExtract });
    await travel(playerId, 'thirstlands');
    const out = await w.play.extract(playerId, run.id, rest.node.id);
    expect(out).toMatchObject({ status: 'applied', run: { status: 'extracted' } });
  });

  it('can be completed and abandoned from another region too', async () => {
    const finisher = await w.player();
    const finishing = await w.play.start(finisher.playerId, VALLEY);
    await travel(finisher.playerId, 'base-80085');
    expect((await walk(w.play, finisher.playerId, finishing)).status).toBe('completed');

    const quitter = await w.player();
    const quitting = await w.play.start(quitter.playerId, VALLEY);
    await travel(quitter.playerId, 'assteroid-belt');
    expect((await w.play.abandon(quitter.playerId, quitting.id))!.run.status).toBe('abandoned');
    // Free to start again — but only what is open where they now stand.
    await expect(w.play.start(quitter.playerId, VALLEY)).rejects.toMatchObject({ reason: 'region' });
  });

  it('is untouched by a later edit to where the zone is available, or by the zone being disabled', async () => {
    const key = 'region_moving';
    await w.zone(key);
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, key);
    const row = async () => (await runsOf(playerId))[0]!;
    const graphBefore = (await row()).graph;

    // An admin moves the zone to the Foothills, then switches it off.
    const current = (await w.zones.get(key))!;
    const moved = (await w.zones.update(key, { zone: { ...current.zone, availableRegions: ['flaccid-foothills'] }, expectedRevision: current.revision }, 'admin'))!;
    await w.zones.setEnabled(key, { enabled: false, expectedRevision: moved.revision }, 'admin');

    // The run is the same run: same graph, still active, and it plays out.
    expect((await row()).graph).toEqual(graphBefore);
    expect((await row()).zoneSnapshot).toMatchObject({ zone: { availableRegions: ['waifu-valley'] } });
    expect((await w.play.home(playerId)).activeRun?.id).toBe(run.id);
    expect((await walk(w.play, playerId, run)).status).toBe('completed');

    // New runs follow the edit: gone from the valley for everyone.
    expect(await listed(playerId)).not.toContain(key);
    await expect(w.play.start(playerId, key)).rejects.toBeInstanceOf(DungeonZoneUnavailableError);
  });

  it('a zone whose regions are widened becomes startable there without touching runs in progress', async () => {
    const key = 'region_widening';
    await w.zone(key);
    const away = await w.player();
    await travel(away.playerId, 'twin-peeks');
    await expect(w.play.start(away.playerId, key)).rejects.toMatchObject({ reason: 'region' });

    const current = (await w.zones.get(key))!;
    await w.zones.update(key, { zone: { ...current.zone, availableRegions: ['waifu-valley', 'twin-peeks'] }, expectedRevision: current.revision }, 'admin');
    expect(await listed(away.playerId)).toEqual([key]);
    expect((await w.play.start(away.playerId, key)).status).toBe('active');
  });
});
