/**
 * Content Portability CP-1 — moving Equipment Catalogue definitions from one
 * environment (A, "staging") to another (B, "production") through the Admin
 * API, against two separate real databases seeded from the shipped content
 * and published roll rules.
 *
 *   - export scope: everything, exactly the selected keys (unknown keys
 *     reported), or the filter's matches — an empty scope is refused, never
 *     widened to the whole catalogue;
 *   - capacity: a supported-size package passes preview and apply over a real
 *     socket; over-limit bodies are a JSON 413 with nothing written; an
 *     export never produces a package its own importer would refuse;
 *   - destination safety: owned copies, enabled state and IDs survive;
 *   - artwork: paths B cannot serve are warned about, never block.
 *
 * Each environment has its own assets root under the OS temp directory, so
 * nothing here reads the repository's real artwork.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAPPED_ERROR_CODES } from '../../../src/api/errors';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { EQUIPMENT_IMPORT_BODY_LIMIT_BYTES } from '../../../src/api/routes/v1/admin/equipment';
import {
  equipmentDefinitions,
  equipmentEvents,
  equipmentImportLog,
  playerEquipment,
  playerLoadoutSlots,
} from '../../../src/db/schema';
import { locateArtworkFile } from '../../../src/modules/assets/artworkFile';
import { createEquipmentCatalogueService } from '../../../src/modules/equipment/equipmentCatalogueService';
import {
  EQUIPMENT_PACKAGE_MAX_BYTES,
  EQUIPMENT_PACKAGE_MAX_DEFINITIONS,
} from '../../../src/modules/equipment/equipmentPackage';
import {
  bootstrapEquipmentRollRules,
  createEquipmentRollRulesService,
  loadShippedCombatBonusFile,
} from '../../../src/modules/equipment/equipmentRollRulesService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../../src/modules/equipment/seed';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { REGIONS } from '../../../src/modules/locations/regions';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

type Json = Record<string, any>;

interface World {
  t: TestDb;
  app: App;
  api: ZodFastify;
  assetsDir: string;
  playerId: number;
  /** `http://127.0.0.1:<port>` — the server also listens, for requests over a real socket. */
  baseUrl: string;
}

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

async function makeWorld(name: string): Promise<World> {
  const t = await createTestDb();
  const rollRules = createEquipmentRollRulesService({ db: t.db });
  const app = await bootstrapApp(t, { equipmentRollRules: rollRules });
  await bootstrapEquipmentRollRules(t.db, loadShippedCombatBonusFile(CONTENT_DIR));
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  const { playerId } = await provisionPlayer(app, `g-${name}`, `u-${name}`);
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), `cp1-assets-${name}-`));

  const equipmentCatalogue = createEquipmentCatalogueService({
    db: t.db,
    definitions: app.gear.definitions,
    promotion: app.gear.promotion,
    rollRules,
    getAffixes: app.gear.getAffixes,
    getWorkshopConfig: () => app.content.equipmentWorkshop ?? null,
    artworkStatus: (relative) => locateArtworkFile(assetsDir, relative).status,
  });
  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => null }),
  });
  const api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: TEST_TOKEN, adminBearer: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: { ...app, equipmentCatalogue, equipmentDefinitions: app.gear.definitions },
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
  const baseUrl = await api.listen({ host: '127.0.0.1', port: 0 });
  return { t, app, api, assetsDir, playerId, baseUrl };
}

let A: World;
let B: World;

beforeAll(async () => {
  A = await makeWorld('a');
  B = await makeWorld('b');
}, 120_000);

afterAll(async () => {
  for (const w of [A, B]) {
    await w?.api.close();
    await w?.t.cleanup();
    if (w?.assetsDir) fs.rmSync(w.assetsDir, { recursive: true, force: true });
  }
});

const call = (w: World, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  w.api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (w: World, url: string): Promise<Json> => {
  const res = await call(w, 'GET', url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
};
const detail = (w: World, key: string) => data(w, `/admin/equipment/definitions/${key}`);
const authoring = (d: Json) => {
  const { revision: _r, createdAt: _c, updatedAt: _u, updatedBy: _b, ownedCount: _o, instanceCount: _i, ...input } = d.definition;
  return input;
};
const rowCount = async (w: World) => (await w.t.db.select({ n: sql<number>`count(*)::int` }).from(equipmentDefinitions))[0]!.n;
const importLogCount = async (w: World) => (await w.t.db.select({ n: sql<number>`count(*)::int` }).from(equipmentImportLog))[0]!.n;

const gear = (key: string, rarity: string, over: Json = {}) => ({
  key,
  name: key.replace(/_/g, ' '),
  slot: 'attack',
  rarity,
  multiplierMinBp: ['N', 'R', 'SR'].includes(rarity) ? 4_000 : 11_000,
  multiplierMaxBp: ['N', 'R', 'SR'].includes(rarity) ? 6_000 : 13_000,
  multiplierStepBp: 500,
  ...over,
});

/** The largest definition the schema accepts with plain-text fields. */
const maximal = (i: number) => ({
  key: `cp1_big_${String(i).padStart(4, '0')}_${'x'.repeat(50)}`,
  name: `Big ${i} `.padEnd(80, 'n'),
  description: 'd'.repeat(1000),
  slot: 'attack',
  rarity: 'LR',
  multiplierMinBp: 11_000,
  multiplierMaxBp: 13_000,
  multiplierStepBp: 500,
  secondaryEffects: [],
  primarySpEligible: true,
  maxAdditionalBonuses: 3,
  tags: Array.from({ length: 20 }, (_, t) => `t${t}`.padEnd(40, 'x')),
  regionId: REGIONS[0],
  artworkPath: `equipment/${'a'.repeat(180)}${String(i).padStart(4, '0')}.webp`,
  enabled: false,
  shopRegions: [...REGIONS],
  buyPrice: 999_999_999,
  priceCurrency: 'waifubux',
});
const pkgOf = (definitions: unknown[], label = 'cp1') => ({ format: 'waifumon-equipment', version: 3, label, definitions });

/** Over a real socket, as the Portal's browser would reach it through Nginx. */
async function post(w: World, url: string, body: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${w.baseUrl}/api/v1${url}`, {
    method: 'POST',
    headers: { ...AUTH_BEARER, 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, json: (await res.json()) as Json };
}

// ── export scope ────────────────────────────────────────────────────────────

describe('export scope', () => {
  beforeAll(async () => {
    // A's authored high-rarity gear: created disabled, like every Catalogue create.
    for (const [key, rarity] of [
      ['cp1_ssr_blade', 'SSR'],
      ['cp1_ur_aegis', 'UR'],
      ['cp1_lr_halo', 'LR'],
    ] as const) {
      const res = await call(A, 'POST', '/admin/equipment/definitions', {
        definition: gear(key, rarity, {
          slot: rarity === 'UR' ? 'defense' : 'attack',
          ...(rarity === 'UR' ? { multiplierMinBp: 11_000, multiplierMaxBp: 13_000 } : {}),
          primarySpEligible: rarity !== 'SSR',
          maxAdditionalBonuses: rarity === 'LR' ? 2 : null,
          tags: ['cp1'],
          description: `${rarity} test gear`,
        }),
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it('a full export holds every definition, every authorable rarity, disabled ones included', async () => {
    const all = await data(A, '/admin/equipment/export');
    expect(all).toMatchObject({ format: 'waifumon-equipment', version: 3 });
    expect(all.definitions).toHaveLength(await rowCount(A));
    expect(new Set(all.definitions.map((d: Json) => d.rarity))).toEqual(new Set(['N', 'R', 'SR', 'SSR', 'UR', 'LR']));
    expect(all.definitions.filter((d: Json) => d.key.startsWith('cp1_')).every((d: Json) => d.enabled === false)).toBe(true);
    expect(all.definitions.map((d: Json) => d.key)).toEqual([...all.definitions.map((d: Json) => d.key)].sort());
  });

  it('a filter that matches nothing is refused — never widened to the whole catalogue', async () => {
    for (const url of [
      '/admin/equipment/export?q=zz_no_such_gear_zz',
      '/admin/equipment/export?rarity=LR&slot=health',
      '/admin/equipment/export?keys=',
      '/admin/equipment/export?keys=%20,%20',
    ]) {
      const res = await call(A, 'GET', url);
      expect(res.statusCode, url).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'EQUIPMENT_EXPORT_REFUSED', details: { reason: 'empty' } });
    }
  });

  it('the lower-level exporter treats an empty key list as an empty package', async () => {
    const pkg = await A.app.gear.promotion.exportPackage({ keys: [] });
    expect(pkg.definitions).toEqual([]);
  });

  it('a filter exports only its matches', async () => {
    const lr = await data(A, '/admin/equipment/export?rarity=LR');
    expect(lr.definitions.map((d: Json) => d.key)).toEqual(['cp1_lr_halo']);
    const disabled = await data(A, '/admin/equipment/export?status=disabled');
    expect(disabled.definitions.map((d: Json) => d.key).sort()).toEqual(['cp1_lr_halo', 'cp1_ssr_blade', 'cp1_ur_aegis']);
  });

  it('a selection exports exactly the requested keys', async () => {
    const keys = ['rusty_pipe', 'railcarbine', 'cp1_ssr_blade', 'cp1_ur_aegis', 'cp1_lr_halo'];
    const pkg = await data(A, `/admin/equipment/export?keys=${keys.join(',')},rusty_pipe`);
    expect(pkg.definitions.map((d: Json) => d.key)).toEqual([...keys].sort());
  });

  it('unknown selected keys are reported by name and nothing is exported', async () => {
    const res = await call(A, 'GET', '/admin/equipment/export?keys=rusty_pipe,cp1_nope_b,cp1_nope_a');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      code: 'EQUIPMENT_EXPORT_KEYS_NOT_FOUND',
      details: { missingKeys: ['cp1_nope_a', 'cp1_nope_b'] },
    });
    expect(res.json().error.message).toContain('cp1_nope_a');
  });

  it('a stored row the importer would refuse is named, not exported', async () => {
    // EX is never authorable; a hand-inserted row must not produce a package
    // that fails on import.
    await A.t.db.insert(equipmentDefinitions).values({
      key: 'cp1_ex_row',
      name: 'Hand inserted',
      slot: 'attack',
      rarity: 'EX',
      multiplierMinBp: 11_000,
      multiplierMaxBp: 11_000,
      multiplierStepBp: 500,
      enabled: false,
    } as typeof equipmentDefinitions.$inferInsert);
    try {
      const res = await call(A, 'GET', '/admin/equipment/export?keys=cp1_ex_row,rusty_pipe');
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.reason).toBe('unportable');
      expect(res.json().error.details.issues.map((i: Json) => i.path)).toContain('cp1_ex_row.rarity');
    } finally {
      await A.t.db.delete(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'cp1_ex_row'));
    }
  });

  it('the new export refusals have considered HTTP statuses', () => {
    expect(MAPPED_ERROR_CODES).toEqual(expect.arrayContaining(['EQUIPMENT_EXPORT_KEYS_NOT_FOUND', 'EQUIPMENT_EXPORT_REFUSED']));
  });
});

// ── A → B ───────────────────────────────────────────────────────────────────

describe('moving definitions from A to B', () => {
  it('disabled SSR/UR/LR definitions round-trip field for field, arriving disabled with B’s own IDs', async () => {
    const keys = ['cp1_lr_halo', 'cp1_ssr_blade', 'cp1_ur_aegis'];
    const pkg = await data(A, `/admin/equipment/export?keys=${keys.join(',')}`);
    const preview = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview).toMatchObject({ ok: true, counts: { create: 3, update: 0, unchanged: 0 } });
    const applied = await call(B, 'POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash });
    expect(applied.statusCode, applied.body).toBe(200);

    for (const key of keys) {
      const [a, b] = [await detail(A, key), await detail(B, key)];
      expect(authoring(b)).toEqual(authoring(a));
      expect(b.definition.enabled).toBe(false);
    }
    // Re-exporting from B gives the same definitions back.
    const back = await data(B, `/admin/equipment/export?keys=${keys.join(',')}`);
    expect(back.definitions).toEqual(pkg.definitions);
  });

  it('an owned SR copy survives a definition update unchanged, and the definition keeps its ID', async () => {
    const key = 'railcarbine';
    const rolledMultiplierBp = (await detail(B, key)).definition.multiplierMinBp;
    const granted = await B.t.db.transaction((tx) =>
      B.app.gear.equipment.grantEquipment(tx, {
        playerId: B.playerId,
        definitionKey: key,
        source: { type: 'admin' },
        roll: { kind: 'fixed', rolledMultiplierBp, affixKey: null },
      }),
    );
    const copyId = granted.newInstanceIds[0]!;
    const [before] = await B.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
    const owned = async () => ({
      copy: await B.t.db.select().from(playerEquipment).where(eq(playerEquipment.id, copyId)),
      slots: await B.t.db.select().from(playerLoadoutSlots).orderBy(asc(playerLoadoutSlots.loadoutId)),
      events: await B.t.db.select().from(equipmentEvents).where(eq(equipmentEvents.playerId, B.playerId)).orderBy(asc(equipmentEvents.id)),
    });
    const ownedBefore = await owned();

    // A retunes the SR: new text and a narrower range.
    const sr = await detail(A, key);
    const changed = { ...authoring(sr), name: 'Railcarbine Mk II', description: 'Retuned on staging.', multiplierMaxBp: sr.definition.multiplierMinBp };
    expect((await call(A, 'PUT', `/admin/equipment/definitions/${key}`, { definition: changed, expectedRevision: sr.definition.revision })).statusCode).toBe(200);
    const pkg = await data(A, `/admin/equipment/export?keys=${key}`);
    const preview = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview.entries).toEqual([{ key, action: 'update', changedFields: expect.arrayContaining(['name', 'description', 'multiplierMaxBp']) }]);
    expect((await call(B, 'POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash })).statusCode).toBe(200);

    const [after] = await B.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
    expect(after!.id).toBe(before!.id);
    expect(after).toMatchObject({ name: 'Railcarbine Mk II', revision: before!.revision + 1 });
    expect(await owned()).toEqual(ownedBefore);
  });

  it('a slot change on owned SR gear refuses the whole package', async () => {
    const pkg = pkgOf([gear('cp1_rides_along', 'N'), { ...authoring(await detail(B, 'railcarbine')), slot: 'defense' }]);
    const preview = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview.ok).toBe(false);
    const res = await call(B, 'POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash });
    expect(res.statusCode).toBe(400);
    expect((await call(B, 'GET', '/admin/equipment/definitions/cp1_rides_along')).statusCode).toBe(404);
  });

  it('B keeps its own enabled state; new definitions arrive disabled whatever the file says', async () => {
    // A disables a seed definition B has enabled, and authors a new one marked enabled.
    const knife = await detail(A, 'combat_knife');
    expect((await call(A, 'PUT', `/admin/equipment/definitions/combat_knife/enabled`, { enabled: false, expectedRevision: knife.definition.revision })).statusCode).toBe(200);
    const pkg = await data(A, '/admin/equipment/export?keys=combat_knife');
    expect(pkg.definitions[0].enabled).toBe(false);
    pkg.definitions.push(gear('cp1_new_enabled', 'N', { enabled: true }));

    const preview = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview.statusNotes).toEqual(
      expect.arrayContaining([
        { key: 'combat_knife', packageEnabled: false, enabled: true, reason: 'existing_status_kept' },
        { key: 'cp1_new_enabled', packageEnabled: true, enabled: false, reason: 'new_definitions_start_disabled' },
      ]),
    );
    expect((await call(B, 'POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash })).statusCode).toBe(200);
    expect((await detail(B, 'combat_knife')).definition.enabled).toBe(true);
    expect((await detail(B, 'cp1_new_enabled')).definition.enabled).toBe(false);
  });
});

// ── artwork ─────────────────────────────────────────────────────────────────

describe('artwork prerequisites', () => {
  it('warns about artwork B cannot serve, without blocking the import or changing its plan', async () => {
    fs.mkdirSync(path.join(B.assetsDir, 'equipment'), { recursive: true });
    fs.writeFileSync(path.join(B.assetsDir, 'equipment', 'present.webp'), 'not checked for content');
    const pkg = pkgOf([
      gear('cp1_art_present', 'N', { artworkPath: 'equipment/present.webp' }),
      gear('cp1_art_missing', 'N', { artworkPath: 'equipment/missing.webp' }),
      gear('cp1_art_shared', 'R', { artworkPath: 'equipment/missing.webp' }),
      gear('cp1_art_none', 'N'),
    ]);
    const preview = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview.ok).toBe(true);
    expect(preview.artwork).toEqual({
      checked: true,
      warnings: [
        { key: 'cp1_art_missing', artworkPath: 'equipment/missing.webp', status: 'missing' },
        { key: 'cp1_art_shared', artworkPath: 'equipment/missing.webp', status: 'missing' },
      ],
    });
    // Supplying the file changes the warning, not the plan.
    fs.writeFileSync(path.join(B.assetsDir, 'equipment', 'missing.webp'), 'x');
    const again = (await call(B, 'POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(again.artwork.warnings).toEqual([]);
    expect(again.planHash).toBe(preview.planHash);
    fs.rmSync(path.join(B.assetsDir, 'equipment', 'missing.webp'));
    const applied = await call(B, 'POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash });
    expect(applied.statusCode, applied.body).toBe(200);
  });
});

// ── capacity ────────────────────────────────────────────────────────────────

describe('capacity', () => {
  it('the import routes accept the largest package an export may produce, plus its wrapper', () => {
    expect(EQUIPMENT_IMPORT_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(EQUIPMENT_PACKAGE_MAX_BYTES + 1024);
    // A full package of the largest valid plain-text definitions fits the export ceiling.
    const full = pkgOf(Array.from({ length: EQUIPMENT_PACKAGE_MAX_DEFINITIONS }, (_, i) => maximal(i)));
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(EQUIPMENT_PACKAGE_MAX_BYTES);
  });

  it('a 1,000-definition package of maximal definitions previews and applies over a real socket', async () => {
    const pkg = pkgOf(Array.from({ length: EQUIPMENT_PACKAGE_MAX_DEFINITIONS }, (_, i) => maximal(i)), 'cp1 large');
    const body = JSON.stringify({ package: pkg });
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024); // far past the old 64 KB and nginx's 1 MB

    const preview = await post(B, '/admin/equipment/import/preview', body);
    expect(preview.status, JSON.stringify(preview.json).slice(0, 500)).toBe(200);
    expect(preview.json.data).toMatchObject({ ok: true, counts: { create: 1000, update: 0, unchanged: 0 } });
    // Artwork for these is not on B: one warning each, still applicable.
    expect(preview.json.data.artwork.warnings).toHaveLength(1000);

    const applied = await post(B, '/admin/equipment/import/apply', JSON.stringify({ package: pkg, expectedPlanHash: preview.json.data.planHash, sourceFilename: 'large.json' }));
    expect(applied.status, JSON.stringify(applied.json).slice(0, 500)).toBe(200);
    const stored = await B.t.db.select({ key: equipmentDefinitions.key, enabled: equipmentDefinitions.enabled }).from(equipmentDefinitions).where(inArray(equipmentDefinitions.key, (pkg.definitions as Json[]).map((d) => d.key as string)));
    expect(stored).toHaveLength(1000);
    expect(stored.every((r) => r.enabled === false)).toBe(true);
  }, 120_000);

  it('an export past the importer’s definition ceiling is refused, never truncated; a smaller scope still exports', async () => {
    expect(await rowCount(B)).toBeGreaterThan(EQUIPMENT_PACKAGE_MAX_DEFINITIONS);
    const res = await call(B, 'GET', '/admin/equipment/export');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'EQUIPMENT_EXPORT_REFUSED', details: { reason: 'too_large' } });
    expect(res.json().error.message).toContain(`${EQUIPMENT_PACKAGE_MAX_DEFINITIONS}`);

    const sr = await data(B, '/admin/equipment/export?rarity=SR');
    expect(sr.definitions.length).toBeLessThanOrEqual(EQUIPMENT_PACKAGE_MAX_DEFINITIONS);
    // What B exports, B can import back.
    const preview = await post(B, '/admin/equipment/import/preview', JSON.stringify({ package: sr }));
    expect(preview.status).toBe(200);
    expect(preview.json.data.counts.unchanged).toBe(sr.definitions.length);
  }, 120_000);

  it('a body over the route limit is a JSON 413 naming the limit, and nothing is written', async () => {
    const before = { rows: await rowCount(B), logs: await importLogCount(B) };
    const pkg = pkgOf([gear('cp1_too_big', 'N', { description: 'x'.repeat(900) })]);
    const padded = JSON.stringify({ package: { ...pkg, label: 'p'.repeat(EQUIPMENT_IMPORT_BODY_LIMIT_BYTES) } });
    for (const url of ['/admin/equipment/import/preview', '/admin/equipment/import/apply']) {
      const res = await post(B, url, padded);
      expect(res.status, url).toBe(413);
      expect(res.json.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: EQUIPMENT_IMPORT_BODY_LIMIT_BYTES } });
    }
    expect({ rows: await rowCount(B), logs: await importLogCount(B) }).toEqual(before);
  });

  it('more definitions than a package may hold are refused by path, and nothing is written', async () => {
    const before = { rows: await rowCount(B), logs: await importLogCount(B) };
    const pkg = pkgOf(Array.from({ length: EQUIPMENT_PACKAGE_MAX_DEFINITIONS + 1 }, (_, i) => gear(`cp1_over_${i}`, 'N')));
    const res = await post(B, '/admin/equipment/import/apply', JSON.stringify({ package: pkg, expectedPlanHash: 'sha256:any' }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'EQUIPMENT_INVALID' });
    expect(res.json.error.details.issues[0].path).toBe('definitions');
    expect({ rows: await rowCount(B), logs: await importLogCount(B) }).toEqual(before);
  });

  it('a caller without access is refused before a large body is read', async () => {
    const body = JSON.stringify({ package: pkgOf([]), pad: 'p'.repeat(EQUIPMENT_IMPORT_BODY_LIMIT_BYTES) });
    const res = await fetch(`${B.baseUrl}/api/v1/admin/equipment/import/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });
});
