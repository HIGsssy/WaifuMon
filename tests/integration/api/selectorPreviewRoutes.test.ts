/**
 * Portal support for Waifumon sighting selectors, over HTTP against a real
 * database: the selector preview, simulator sightings, and the reference data
 * the editor labels itself from.
 *
 * The species world is shrunk to four known species and hand-built pools (as
 * in `filteredWildEncounter.test.ts`), so every count is exact:
 *
 *   valleyLr — LR, pooled in waifu-valley
 *   valleyN  — N,  pooled in waifu-valley
 *   peaksLr  — LR, pooled in twin-peeks only
 *   globalUr — UR, in no pool, not region-exclusive
 *
 * Requires Docker/testcontainers (or `TEST_DATABASE_URL`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, notInArray } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSessionService } from '../../../src/api/portalSession';
import { regionEncounterPools, species, type SpeciesRow } from '../../../src/db/schema';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import type { Effect } from '../../../src/modules/worldEncounters/types';
import { bootstrapApp, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const T = 'trigger_waifumon_encounter' as const;

let t: TestDb;
let app: App;
let api: ZodFastify;
let valleyLr: SpeciesRow;
let valleyN: SpeciesRow;
let peaksLr: SpeciesRow;
let globalUr: SpeciesRow;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);

  const picked = await t.db
    .select()
    .from(species)
    .where(eq(species.enabled, true))
    .orderBy(species.id)
    .limit(4);
  await t.db.update(species).set({ enabled: false }).where(notInArray(species.id, picked.map((s) => s.id)));
  const shape = async (row: SpeciesRow, patch: Partial<SpeciesRow>) =>
    (await t.db.update(species).set({ tags: [], ...patch }).where(eq(species.id, row.id)).returning())[0]!;
  valleyLr = await shape(picked[0]!, { rarity: 'LR' });
  valleyN = await shape(picked[1]!, { rarity: 'N' });
  peaksLr = await shape(picked[2]!, { rarity: 'LR' });
  globalUr = await shape(picked[3]!, { rarity: 'UR' });
  await t.db.delete(regionEncounterPools);
  await t.db.insert(regionEncounterPools).values([
    { regionId: 'waifu-valley', speciesId: valleyLr.id, weight: 10 },
    { regionId: 'waifu-valley', speciesId: valleyN.id, weight: 10 },
    { regionId: 'twin-peeks', speciesId: peaksLr.id, weight: 10 },
  ]);

  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => 'nobody' }),
  });
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3131, token: TEST_TOKEN, adminBearer: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: {
        publicUrl: 'http://localhost',
        forwardedProto: 'http',
        discordClientId: 'x',
        discordClientSecret: 'x',
        sessionSecret: 'x',
        sessionTtlSeconds: 3600,
      },
      // Bearer-only suite: no cookie session is ever looked up.
      sessions: { getSession: async () => null } as unknown as PortalSessionService,
      authorization: portalAuthorization,
    },
    ctx: {
      services: app,
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

async function post<T>(url: string, payload: object): Promise<{ status: number; data: T }> {
  const res = await api.inject({ method: 'POST', url: `/api/v1${url}`, headers: AUTH, payload });
  return { status: res.statusCode, data: (res.json() as { data: T }).data };
}

interface PreviewData {
  mode: string;
  specific: { slug: string; name: string; found: boolean } | null;
  regions: Array<{ regionId: string; regionName: string; candidateCount: number; candidates: Array<{ slug: string }> }>;
  matchesAnywhere: boolean;
}

const preview = (body: object) => post<PreviewData>('/admin/encounters/selector-preview', body);
const huntIn = (regions: string[]) => ({ huntEligible: true, travelEligible: false, regions, routes: [] });

describe('POST /admin/encounters/selector-preview', () => {
  it('counts a region LR selector per region, with the candidates', async () => {
    const { status, data } = await preview({
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
      encounter: huntIn(['waifu-valley', 'twin-peeks']),
    });
    expect(status).toBe(200);
    expect(data.mode).toBe('random');
    expect(data.regions.map((r) => [r.regionId, r.candidateCount])).toEqual([
      ['waifu-valley', 1],
      ['twin-peeks', 1],
    ]);
    expect(data.regions[0]!.candidates.map((c) => c.slug)).toEqual([valleyLr.slug]);
    expect(data.regions[1]!.candidates.map((c) => c.slug)).toEqual([peaksLr.slug]);
    expect(data.regions[0]!.regionName).toBeTruthy();
    expect(data.matchesAnywhere).toBe(true);
  });

  it('counts a global selector, reaching species in no pool', async () => {
    const { data } = await preview({ selection: { mode: 'random', poolScope: 'global', rarities: ['UR'] } });
    // No encounter context → every enabled region is evaluated.
    expect(data.regions.length).toBeGreaterThanOrEqual(2);
    for (const r of data.regions) {
      expect(r.candidates.map((c) => c.slug)).toEqual([globalUr.slug]);
    }
  });

  it('reports zero in a region without widening, while other regions still match', async () => {
    const { data } = await preview({
      selection: { mode: 'random', poolScope: 'region', rarities: ['N'] },
      encounter: huntIn(['twin-peeks']),
    });
    expect(data.regions).toEqual([
      expect.objectContaining({ regionId: 'twin-peeks', candidateCount: 0, candidates: [] }),
    ]);
    expect(data.matchesAnywhere).toBe(true);
  });

  it('flags a selector that matches nowhere', async () => {
    const { data } = await preview({ selection: { mode: 'random', poolScope: 'global', rarities: ['EX'] } });
    expect(data.matchesAnywhere).toBe(false);
    expect(data.regions.every((r) => r.candidateCount === 0)).toBe(true);
  });

  it('evaluates a travel encounter in its destinations', async () => {
    const { data } = await preview({
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
      encounter: {
        huntEligible: false,
        travelEligible: true,
        regions: [],
        routes: [{ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' }],
      },
    });
    expect(data.regions.map((r) => r.regionId)).toEqual(['twin-peeks']);
    expect(data.regions[0]!.candidates.map((c) => c.slug)).toEqual([peaksLr.slug]);
  });

  it('resolves a specific species, and reports one that is not enabled', async () => {
    const found = await preview({ selection: { mode: 'specific', speciesSlug: valleyN.slug } });
    expect(found.data.specific).toMatchObject({ slug: valleyN.slug, found: true });

    const missing = await preview({ selection: { mode: 'specific', speciesSlug: 'no_such_species' } });
    expect(missing.data.specific).toMatchObject({ found: false });
    expect(missing.data.matchesAnywhere).toBe(false);
  });

  it('answers the legacy hunt draw without inventing a candidate set', async () => {
    const { data } = await preview({ selection: null });
    expect(data).toEqual({ mode: 'hunt_draw', specific: null, regions: [], matchesAnywhere: true });
  });

  it('refuses a non-canonical selector the same way a save would', async () => {
    const { status } = await preview({ selection: { mode: 'random', poolScope: 'region', races: ['Demon'] } });
    expect(status).toBe(400);
  });
});

describe('POST /admin/encounters/:id/simulate — sightings', () => {
  async function encounterWith(effects: Effect[]) {
    const saved = await app.worldEncounterAdmin.upsert({
      slug: 'sim_sighting',
      name: 'Sim Sighting',
      description: '',
      type: 'discovery',
      rarity: 'common',
      weight: 1,
      lifecycle: 'draft',
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      regions: ['waifu-valley'],
      routes: [],
      metadata: {},
      choices: [
        {
          label: 'Look',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: effects,
          failureEffects: [],
        },
      ],
    });
    return { id: saved.id, choiceId: saved.choices[0]!.id };
  }

  interface SimData {
    aggregate: { rolls: number; successes: number };
    sightings: Array<{
      outcome: string;
      regionId: string | null;
      candidateCount: number | null;
      selectedSpecies: { slug: string } | null;
      result: string;
    }>;
  }
  const simulate = (id: number, body: object) =>
    post<SimData>(`/admin/encounters/${id}/simulate`, body);

  it('samples the selector in the chosen region, with the real picker', async () => {
    const { id, choiceId } = await encounterWith([
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } } as Effect,
    ]);
    const { status, data } = await simulate(id, { choiceId, rolls: 10, regionId: 'twin-peeks' });
    expect(status).toBe(200);
    // Existing aggregate behaviour is untouched.
    expect(data.aggregate.rolls).toBe(10);
    expect(data.aggregate.successes).toBe(10);
    expect(data.sightings).toEqual([
      expect.objectContaining({
        outcome: 'success',
        regionId: 'twin-peeks',
        candidateCount: 1,
        result: 'selected',
        selectedSpecies: expect.objectContaining({ slug: peaksLr.slug }),
      }),
    ]);
  });

  it('defaults to the encounter’s own region and says which', async () => {
    const { id, choiceId } = await encounterWith([
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } } as Effect,
    ]);
    const { data } = await simulate(id, { choiceId, rolls: 1 });
    expect(data.sightings[0]).toMatchObject({ regionId: 'waifu-valley' });
    expect(data.sightings[0]!.selectedSpecies?.slug).toBe(valleyLr.slug);
  });

  it('never fabricates a species for a zero-candidate selector', async () => {
    const { id, choiceId } = await encounterWith([
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['N'] } } as Effect,
    ]);
    const { data } = await simulate(id, { choiceId, rolls: 1, regionId: 'twin-peeks' });
    expect(data.sightings[0]).toMatchObject({
      candidateCount: 0,
      selectedSpecies: null,
      result: 'no_matching_species',
    });
  });

  it('reports the legacy hunt draw and specific species honestly', async () => {
    const { id, choiceId } = await encounterWith([
      { type: T },
      { type: T, speciesSlug: globalUr.slug },
    ]);
    const { data } = await simulate(id, { choiceId, rolls: 1 });
    expect(data.sightings.map((s) => s.result)).toEqual(['hunt_draw', 'selected']);
    expect(data.sightings[0]!.selectedSpecies).toBeNull();
    expect(data.sightings[1]).toMatchObject({ regionId: null, candidateCount: 1 });
  });
});

describe('publishing an encounter that carries a random selector', () => {
  const BLOCKED =
    'This selector does not match any enabled Waifumon in any region where this encounter can run.';
  let n = 0;

  function input(effects: Effect[], lifecycle: 'draft' | 'active', regions: string[] = []) {
    n += 1;
    return {
      slug: `publish_gate_${n}`,
      name: 'Publish Gate',
      description: '',
      type: 'discovery',
      rarity: 'common',
      weight: 1,
      lifecycle,
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      regions,
      routes: [],
      metadata: {},
      choices: [
        {
          label: 'Look',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: effects,
          failureEffects: [],
        },
      ],
    };
  }

  async function send(method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object) {
    const res = await api.inject({ method, url: `/api/v1${url}`, headers: AUTH, payload });
    return { status: res.statusCode, body: res.body, json: res.json() as { data?: { id: number } } };
  }

  const dead = { type: T, selection: { mode: 'random', poolScope: 'global', rarities: ['EX'] } } as Effect;
  // N exists in waifu-valley only: zero in twin-peeks, but not everywhere.
  const partial = { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['N'] } } as Effect;

  it('saves a zero-candidates-everywhere selector as a draft', async () => {
    const res = await send('POST', '/admin/encounters', { input: input([dead], 'draft') });
    expect(res.status).toBe(200);
  });

  it('refuses to activate it, saying why', async () => {
    const created = await send('POST', '/admin/encounters', { input: input([dead], 'draft') });
    const id = created.json.data!.id;
    const res = await send('PATCH', `/admin/encounters/${id}/lifecycle`, { lifecycle: 'active' });
    expect(res.status).toBe(400);
    expect(res.body).toContain(BLOCKED);
  });

  it('refuses to create or update it straight into active', async () => {
    const created = await send('POST', '/admin/encounters', { input: input([dead], 'active') });
    expect(created.status).toBe(400);
    expect(created.body).toContain(BLOCKED);

    const draft = await send('POST', '/admin/encounters', { input: input([dead], 'draft') });
    const id = draft.json.data!.id;
    const updated = await send('PUT', `/admin/encounters/${id}`, { input: input([dead], 'active') });
    expect(updated.status).toBe(400);
  });

  it('publishes a selector with zero candidates in only some of its regions', async () => {
    const created = await send('POST', '/admin/encounters', {
      input: input([partial], 'draft', ['waifu-valley', 'twin-peeks']),
    });
    const res = await send('PATCH', `/admin/encounters/${created.json.data!.id}/lifecycle`, {
      lifecycle: 'active',
    });
    expect(res.status).toBe(200);
  });

  it('publishes a valid specific species', async () => {
    const res = await send('POST', '/admin/encounters', {
      input: input(
        [{ type: T, selection: { mode: 'specific', speciesSlug: valleyN.slug } } as Effect],
        'active',
      ),
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unchosen specific species even as a draft', async () => {
    const res = await send('POST', '/admin/encounters', {
      input: input([{ type: T, selection: { mode: 'specific' } } as unknown as Effect], 'draft'),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/encounters/reference', () => {
  it('carries region names and species rarities for the selector editor', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/v1/admin/encounters/reference', headers: AUTH });
    const data = (res.json() as { data: { regionNames: Record<string, string>; speciesRarities: string[]; races: string[] } }).data;
    expect(data.regionNames['waifu-valley']).toBeTruthy();
    expect(data.speciesRarities).toEqual(['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX']);
    // Canonical lowercase vocabularies — what the editor serializes.
    expect(data.races).toContain('demon');
  });
});
