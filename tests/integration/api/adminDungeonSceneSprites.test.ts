import { beforeAll, afterAll, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSessionService } from '../../../src/api/portalSession';
import { createSceneSpriteService } from '../../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createDungeonWorld, type DungeonWorld } from '../../helpers/dungeonWorld';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { transparentSprite } from '../../helpers/imageFixtures';
import { pixelAt, isNear, RED } from '../../helpers/imageFixtures';
let w: DungeonWorld, api: ZodFastify, assetId: string;
const csrf = 'test-csrf';
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const cookie = (role: string) => ({
  cookie: `wm_portal_session=${role}; wm_portal_csrf=${csrf}`,
  'x-portal-csrf': csrf,
});
beforeAll(async () => {
  w = await createDungeonWorld();
  const authorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({
      fetchOwnerId: async () => 'owner',
    }),
  });
  const portalAuthorization = {
    ...authorization,
    async computePermissionsFor(session: Parameters<typeof authorization.computePermissionsFor>[0]) {
      const base = await authorization.computePermissionsFor(session);
      const role = session?.discordUserId;
      return {
        ...base,
        permissions:
          role === 'writer'
            ? (['dungeons.read', 'dungeons.write'] as const)
            : role === 'reader'
              ? (['dungeons.read'] as const)
              : [],
      };
    },
    async has(session: Parameters<typeof authorization.has>[0], permission: Parameters<typeof authorization.has>[1]) {
      return (await this.computePermissionsFor(session)).permissions.includes(permission as never);
    },
  };
  const sessions = {
    getSession: async (token: string) =>
      ['reader', 'writer', 'player'].includes(token)
        ? {
            sessionDigest: 'test',
            discordUserId: token,
            discordUsername: null,
            discordAvatarUrl: null,
            playerId: 1,
            selectedGuildDbId: 1,
            selectedDiscordGuildId: 'guild',
            eligibleGuilds: [],
            csrfToken: csrf,
            expiresAt: new Date(Date.now() + 60000),
          }
        : null,
    toBrowserSession: () => ({ authenticated: false }),
    safeEquals: (a: string, b: string) => a === b,
    logout: async () => {},
  };
  api = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3135,
      token: TEST_TOKEN,
      adminBearer: true,
    },
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
      sessions: sessions as unknown as PortalSessionService,
      authorization: portalAuthorization,
    },
    ctx: {
      services: {
        ...w.app,
        dungeonContent: w.content,
        progressionCurrency: w.currencies,
        enemies: w.enemies,
        artworkAssets: w.assets,
        dungeonSceneSprites: createSceneSpriteService({
          db: w.t.db,
          assets: w.assets,
        }),
        sceneComposition: w.scenes,
      },
      getContent: () => w.app.content,
      assetsDir: w.artworkDir,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
  assetId = (
    await w.assets.upload(
      {
        bytes: await transparentSprite(100, 200),
        category: 'dungeon_scene_sprite',
      },
      'artist',
    )
  ).id;
});
afterAll(async () => {
  await api?.close();
  await w?.cleanup();
});
it('gates catalogue reads and writes independently and enforces CSRF', async () => {
  const url = '/api/v1/admin/dungeons/scene-sprites';
  expect((await api.inject({ method: 'GET', url, headers: cookie('player') })).statusCode).toBe(403);
  expect((await api.inject({ method: 'GET', url, headers: cookie('reader') })).statusCode).toBe(200);
  expect(
    (
      await api.inject({
        method: 'POST',
        url,
        headers: cookie('reader'),
        payload: { key: 'denied', sprite: { name: 'Denied', assetId } },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await api.inject({
        method: 'POST',
        url,
        headers: { cookie: 'wm_portal_session=writer' },
        payload: { key: 'denied', sprite: { name: 'Denied', assetId } },
      })
    ).statusCode,
  ).toBe(403);
});
it('creates, saves, archives and exposes the authenticated actor and conflict details', async () => {
  const url = '/api/v1/admin/dungeons/scene-sprites';
  const created = await api.inject({
    method: 'POST',
    url,
    headers: cookie('writer'),
    payload: { key: 'api_chest', sprite: { name: 'API Chest', assetId } },
  });
  expect(created.statusCode).toBe(200);
  const s = created.json().data;
  expect(s.events[0].actor).toBe('writer');
  const updated = await api.inject({
    method: 'PUT',
    url: `${url}/api_chest`,
    headers: bearer,
    payload: {
      expectedRevision: 1,
      sprite: {
        name: 'Updated',
        assetId,
        mirror: true,
        visualLayer: 'foreground',
      },
    },
  });
  expect(updated.statusCode).toBe(200);
  const stale = await api.inject({
    method: 'PUT',
    url: `${url}/api_chest`,
    headers: bearer,
    payload: { expectedRevision: 1, sprite: { name: 'Late', assetId } },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.details.currentRevision).toBe(2);
  const archived = await api.inject({
    method: 'PUT',
    url: `${url}/api_chest/archived`,
    headers: bearer,
    payload: { expectedRevision: 2, archived: true },
  });
  expect(archived.json().data).toMatchObject({ archived: true, mirror: true });
});
it('validates raw uploads through the existing image pipeline', async () => {
  const url = '/api/v1/admin/artwork/assets?category=dungeon_scene_sprite&filename=chest.png';
  const valid = await api.inject({
    method: 'POST',
    url,
    headers: { ...bearer, 'content-type': 'image/png' },
    payload: await transparentSprite(100, 200),
  });
  expect(valid.statusCode).toBe(200);
  expect(valid.json().data.asset.category).toBe('dungeon_scene_sprite');
  const invalid = await api.inject({
    method: 'POST',
    url,
    headers: { ...bearer, 'content-type': 'image/png' },
    payload: Buffer.from('not an image'),
  });
  expect(invalid.statusCode).toBe(400);
});

it('composes room and activity placements through the production preview endpoint and rejects out-of-bounds inputs', async () => {
  const url = '/api/v1/admin/dungeons/scene-preview';
  const preview = await api.inject({
    method: 'POST',
    url,
    headers: bearer,
    payload: {
      roomSprites: [{ id: 'one', spriteKey: 'api_chest', placement: { anchor: 'center', scaleBasisPoints: 5000 } }],
      activitySprites: [
        { id: 'two', spriteKey: 'api_chest', placement: { anchor: 'left', scaleBasisPoints: 3000 }, mirror: true },
      ],
      backgrounds: [],
    },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.headers['content-type']).toContain('image/webp');
  expect(isNear(await pixelAt(preview.rawPayload, 600, 337), RED)).toBe(true);
  expect(
    (
      await api.inject({
        method: 'POST',
        url,
        headers: bearer,
        payload: { roomSprites: [{ id: 'bad', spriteKey: 'api_chest', placement: { offsetX: 601 } }] },
      })
    ).statusCode,
  ).toBe(400);
});
