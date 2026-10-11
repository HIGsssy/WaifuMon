import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { data } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import * as api from '../adminDungeons';
import { starterDungeon } from '@/features/adminDungeons/dungeonModel';
function record(method: 'get' | 'post' | 'put', path: string) {
  const seen: Array<{ url: string; body: unknown }> = [];
  server.use(
    http[method](path, async ({ request }) => {
      const url = new URL(request.url);
      seen.push({
        url: url.pathname + url.search,
        body: method === 'get' ? null : await request.json(),
      });
      return data({ ok: true });
    }),
  );
  return seen;
}
const base = '/api/v1/admin/dungeons';
describe('Phase 1A dungeon API contracts', () => {
  it('uses the authenticated import endpoints and preserves exact apply input', async () => {
    const pkg = {
      format: 'waifumon-dungeon-package',
      schemaVersion: 1,
      dungeon: starterDungeon('tunnels', 'Tunnels', []),
    };
    const plan = record('post', base + '/import/plan');
    await api.planDungeonImport(pkg);
    expect(plan[0]!.body).toEqual({ package: pkg });
    const apply = record('post', base + '/import/apply');
    const input: api.DungeonImportApplyInput = {
      package: pkg,
      requestId: 'one-operation',
      expectedPlanHash: 'reviewed-hash',
      expectedRevision: 4,
      decisions: {
        dungeon: 'replace',
        enemies: { slime: 'create' },
        allowMissingDependencies: false,
      },
    };
    await api.applyDungeonImport(input);
    await api.applyDungeonImport(input);
    expect(apply.map((c) => c.body)).toEqual([input, input]);
    const history = record('get', base + '/definitions/tunnels/import-history');
    await api.getDungeonImportHistory('tunnels');
    expect(history).toHaveLength(1);
  });
  it('propagates stale revisions without retrying or overwriting', async () => {
    let attempts = 0;
    server.use(
      http.put(base + '/definitions/tunnels/draft', () => {
        attempts++;
        return HttpResponse.json(
          { error: { code: 'DUNGEON_DRAFT_STALE', message: 'A newer draft exists' } },
          { status: 409 },
        );
      }),
    );
    await expect(
      api.saveDungeonDraft('tunnels', {
        definition: starterDungeon('tunnels', 'Tunnels', []),
        expectedRevision: 4,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DUNGEON_DRAFT_STALE' });
    expect(attempts).toBe(1);
  });
  it('reads definitions, detail, revisions, history and reference from supported endpoints', async () => {
    const calls = [
      ['/definitions', () => api.listDungeons()],
      ['/definitions/tunnels', () => api.getDungeon('tunnels')],
      ['/definitions/tunnels/revisions', () => api.listDungeonRevisions('tunnels')],
      ['/definitions/tunnels/revisions/2', () => api.getDungeonRevision('tunnels', 2)],
      ['/definitions/tunnels/history', () => api.getDungeonHistory('tunnels')],
      ['/reference', () => api.getDungeonReference()],
    ] as const;
    for (const [path, call] of calls) {
      const seen = record('get', base + path);
      await expect(call()).resolves.toEqual({ ok: true });
      expect(seen).toEqual([{ url: base + path, body: null }]);
    }
  });
  it('creates and validates with definition, and saves definition/layout with expectedRevision', async () => {
    const definition = starterDungeon('tunnels', 'Tunnels', ['waifu-valley']);
    const layout = { rooms: { entrance: { x: 1, y: 2 } }, notes: [] };
    const create = record('post', base + '/definitions');
    await api.createDungeon(definition, layout);
    expect(create[0]!.body).toEqual({ definition, layout });
    const validate = record('post', base + '/validate');
    await api.validateDungeon(definition);
    expect(validate[0]!.body).toEqual({ definition });
    const save = record('put', base + '/definitions/tunnels/draft');
    await api.saveDungeonDraft('tunnels', { definition, layout, expectedRevision: 4 });
    expect(save[0]!.body).toEqual({ definition, layout, expectedRevision: 4 });
  });
  it('keeps enable, publish and rollback operations distinct', async () => {
    const enable = record('put', base + '/definitions/tunnels/enabled');
    await api.setDungeonEnabled('tunnels', false);
    expect(enable[0]!.body).toEqual({ enabled: false });
    const publish = record('post', base + '/definitions/tunnels/publish');
    await api.publishDungeon('tunnels', 4);
    expect(publish[0]!.body).toEqual({ expectedRevision: 4 });
    const rollback = record('post', base + '/definitions/tunnels/rollback');
    await api.rollbackDungeon('tunnels', 2);
    expect(rollback[0]!.body).toEqual({ revision: 2 });
  });
  it('exports drafts, publication and numbered revisions using mutually exclusive query parameters', async () => {
    const seen = record('get', base + '/definitions/tunnels/export');
    await api.exportDungeonPackage('tunnels');
    await api.exportDungeonPackage('tunnels', 'published');
    await api.exportDungeonPackage('tunnels', { revision: 2 });
    expect(seen.map((c) => c.url)).toEqual([
      base + '/definitions/tunnels/export?origin=draft',
      base + '/definitions/tunnels/export?origin=published',
      base + '/definitions/tunnels/export?revision=2',
    ]);
  });
  it('preserves settings, currency, and shipped artwork routes', async () => {
    const settings = record('get', base + '/settings');
    await api.getDungeonSettings();
    expect(settings).toHaveLength(1);
    const update = record('put', base + '/settings');
    await api.updateDungeonSettings({ dailyRunLimit: 5 });
    expect(update[0]!.body).toEqual({ dailyRunLimit: 5 });
    record('get', base + '/currencies');
    await api.listProgressionCurrencies();
    const currency = record('put', base + '/currencies/tokens');
    const metadata = {
      singularName: 'Token',
      pluralName: 'Tokens',
      description: '',
      icon: null,
      enabled: true,
    };
    await api.updateProgressionCurrency('tokens', metadata, 3);
    expect(currency[0]!.body).toEqual({ ...metadata, expectedRevision: 3 });
    const browse = record('get', base + '/artwork/browse');
    await api.browseDungeonArtwork('dungeons');
    expect(browse[0]!.url).toBe(base + '/artwork/browse?path=dungeons');
    const search = record('get', base + '/artwork/search');
    await api.searchDungeonArtwork('tunnel');
    expect(search[0]!.url).toBe(base + '/artwork/search?q=tunnel');
  });
});
