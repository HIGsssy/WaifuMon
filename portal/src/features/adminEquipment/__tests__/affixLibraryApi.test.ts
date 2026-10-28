import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as api from '@/api/adminEquipmentAffixes';
import { entry, exportFixture, listFixture, managed, revisionsFixture } from './affixFixtures';
import { entryChanges, importContents, previewEntryChanges } from '../affixLibraryModel';

afterEach(() => vi.restoreAllMocks());
describe('affix-library HTTP contracts', () => {
  it('uses E3-E.1 endpoints and integer revisions without introducing an import preview', async () => {
    const get = vi.spyOn(client, 'getData').mockResolvedValue({});
    const post = vi.spyOn(client, 'postData').mockResolvedValue({});
    const put = vi.spyOn(client, 'putData').mockResolvedValue({});
    const root = '/v1/admin/equipment/affix-libraries';
    const meta = { name: 'Names', description: '' };
    const affixes = [entry()];
    const file = exportFixture();
    await api.listLibraries();
    expect(get).toHaveBeenLastCalledWith(root, undefined);
    await api.createLibrary({ key: 'names', ...meta });
    expect(post).toHaveBeenLastCalledWith(root, { key: 'names', ...meta });
    await api.saveMeta('names', meta, 5);
    expect(put).toHaveBeenLastCalledWith(`${root}/names/meta`, { meta, expectedDraftRevision: 5 });
    await api.saveEntries('names', affixes, 6);
    expect(put).toHaveBeenLastCalledWith(`${root}/names/draft`, {
      entries: affixes,
      expectedDraftRevision: 6,
    });
    await api.validateLibrary('names');
    expect(post).toHaveBeenLastCalledWith(`${root}/names/validate`);
    await api.previewLibrary('names');
    expect(post).toHaveBeenLastCalledWith(`${root}/names/preview`);
    await api.publishLibrary('names', 7);
    expect(post).toHaveBeenLastCalledWith(`${root}/names/publish`, { expectedDraftRevision: 7 });
    await api.rollbackLibrary('names', 2, 7);
    expect(post).toHaveBeenLastCalledWith(`${root}/names/rollback`, {
      revision: 2,
      expectedDraftRevision: 7,
    });
    await api.importLibrary(file);
    expect(post).toHaveBeenLastCalledWith(`${root}/import`, { file });
    await api.importLibrary(file, 7);
    expect(post).toHaveBeenLastCalledWith(`${root}/import`, { file, expectedDraftRevision: 7 });
    await api.exportLibrary('names', 'draft');
    expect(get).toHaveBeenLastCalledWith(`${root}/names/export`, { params: { kind: 'draft' } });
    await api.exportLibrary('names', 'published');
    expect(get).toHaveBeenLastCalledWith(`${root}/names/export`, { params: { kind: 'published' } });
    expect(post.mock.calls.some(([path]) => path.endsWith('/import/preview'))).toBe(false);
  });
  it('loads actual managed histories and avoids requesting nonexistent legacy histories', async () => {
    const get = vi
      .spyOn(client, 'getData')
      .mockResolvedValueOnce(managed())
      .mockResolvedValueOnce(revisionsFixture());
    expect((await api.loadLibrary('shared')).revisions).toEqual(revisionsFixture());
    const legacy = listFixture().legacy[0]!;
    get.mockResolvedValueOnce(legacy);
    expect(await api.loadLibrary(legacy.key)).toEqual({ library: legacy, revisions: [] });
    expect(get).toHaveBeenCalledTimes(3);
  });
});
describe('display-only file inspection and diffs', () => {
  it('describes additions, removals, slot/enabled changes and reordering from backend arrays', () => {
    const before = [entry('one'), entry('two', 'of Two'), entry('removed', 'of Removed')];
    const after = [
      { ...entry('two', 'of New Two'), slots: ['health'] as const, enabled: false },
      entry('one'),
      entry('new', 'of New'),
    ].map((e) => ({ ...e, slots: [...e.slots] }));
    const diff = entryChanges(before, after);
    expect(diff.added.map((e) => e.key)).toEqual(['new']);
    expect(diff.removed.map((e) => e.key)).toEqual(['removed']);
    expect(diff.changed[0]!.after).toMatchObject({ key: 'two', slots: ['health'], enabled: false });
    expect(diff.reordered).toBe(true);
    expect(
      previewEntryChanges({
        draftRevision: 2,
        publishedRevision: null,
        validation: { ok: true, errors: [] },
        changes: [{ path: 'entries', before: null, after: [entry()] }],
      })!.added,
    ).toEqual([entry()]);
  });
  it('does not mistake local JSON inspection for schema validation', () => {
    expect(
      importContents({ library: { key: 'example', name: 'Example' }, affixes: [{ invalid: true }] })
        ?.affixes,
    ).toEqual([{ invalid: true }]);
    expect(importContents({ filename: 'arbitrary.json' })).toBeNull();
  });
});
