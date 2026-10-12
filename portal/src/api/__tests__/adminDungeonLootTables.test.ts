import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { data } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import * as api from '../adminDungeonLootTables';

const base = '/api/v1/admin/dungeons/loot-tables';
const body: api.DungeonLootTableBody = { guaranteed: [], chances: [], pools: [] };
function record(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const seen: Array<{ url: URL; body: unknown }> = [];
  server.use(
    http[method](path, async ({ request }) => {
      seen.push({
        url: new URL(request.url),
        body: method === 'get' ? null : await request.json(),
      });
      return data({ ok: true });
    }),
  );
  return seen;
}
describe('dungeon loot-table client', () => {
  it('encodes filters, including false and untiered null, and forwards cancellation', async () => {
    const seen = record('get', base);
    await api.listDungeonLootTables(
      { includeArchived: false, tier: null, search: 'Boss & treasure' },
      new AbortController().signal,
    );
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({
      includeArchived: 'false',
      tier: 'null',
      search: 'Boss & treasure',
    });
  });
  it('uses each endpoint and preserves optimistic revisions and delete bodies', async () => {
    const list = record('get', base);
    const get = record('get', `${base}/hoard`);
    const create = record('post', base);
    const update = record('put', `${base}/hoard`);
    const archive = record('post', `${base}/hoard/archive`);
    const restore = record('post', `${base}/hoard/restore`);
    const remove = record('delete', `${base}/hoard`);
    const duplicate = record('post', `${base}/hoard/duplicate`);
    const usage = record('get', `${base}/hoard/where-used`);
    const history = record('get', `${base}/hoard/history`);
    const validate = record('post', `${base}/validate`);
    await api.listDungeonLootTables();
    await api.getDungeonLootTable('hoard');
    await api.createDungeonLootTable({ key: 'hoard', name: 'Hoard', body });
    await api.updateDungeonLootTable('hoard', { expectedRevision: 2, name: 'Saved' });
    await api.archiveDungeonLootTable('hoard', 3);
    await api.restoreDungeonLootTable('hoard', 4);
    await api.deleteDungeonLootTable('hoard', 5);
    await api.duplicateDungeonLootTable('hoard', { key: 'copy', name: 'Copy' });
    await api.getDungeonLootTableUsage('hoard');
    await api.getDungeonLootTableHistory('hoard', 12);
    await api.validateDungeonLootTable(body);
    for (const calls of [
      list,
      get,
      create,
      update,
      archive,
      restore,
      remove,
      duplicate,
      usage,
      history,
      validate,
    ])
      expect(calls).toHaveLength(1);
    expect(create[0]!.body).toEqual({ key: 'hoard', name: 'Hoard', body });
    expect(update[0]!.body).toEqual({ expectedRevision: 2, name: 'Saved' });
    expect(archive[0]!.body).toEqual({ expectedRevision: 3 });
    expect(restore[0]!.body).toEqual({ expectedRevision: 4 });
    expect(remove[0]!.body).toEqual({ expectedRevision: 5 });
    expect(duplicate[0]!.body).toEqual({ key: 'copy', name: 'Copy' });
    expect(history[0]!.url.searchParams.get('limit')).toBe('12');
    expect(validate[0]!.body).toEqual({ body });
  });
  it('propagates stale conflict metadata without retries or changing submitted edits', async () => {
    let count = 0;
    const details: api.DungeonLootTableConflict = {
      key: 'hoard',
      expectedRevision: 1,
      currentRevision: 2,
      updatedBy: 'editor',
      updatedAt: '2026-10-11T00:00:00.000Z',
    };
    server.use(
      http.put(`${base}/hoard`, () => {
        count++;
        return HttpResponse.json(
          { error: { code: 'DUNGEON_LOOT_TABLE_STALE', message: 'This table changed', details } },
          { status: 409 },
        );
      }),
    );
    const input = { expectedRevision: 1, name: 'Unsaved edits' };
    await expect(api.updateDungeonLootTable('hoard', input)).rejects.toMatchObject({
      code: 'DUNGEON_LOOT_TABLE_STALE',
      details,
    });
    expect(count).toBe(1);
    expect(input).toEqual({ expectedRevision: 1, name: 'Unsaved edits' });
  });
});
