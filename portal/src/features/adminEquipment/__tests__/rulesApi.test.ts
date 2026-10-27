import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as api from '@/api/adminEquipmentRules';
import { exportFixture, libraryFixture, rulesFixture } from './rulesFixtures';

afterEach(() => vi.restoreAllMocks());
describe('E3-E.1 HTTP integration', () => {
  it('reads slot eligibility only from published library entries, never draft entries', async () => {
    const get = vi.spyOn(client, 'getData');
    get.mockResolvedValueOnce({
      managed: [libraryFixture(), libraryFixture({ key: 'unpublished', publishedRevision: null })],
      legacy: [],
    });
    get.mockResolvedValueOnce({
      ...libraryFixture(),
      publishedEntries: [
        { key: 'active', enabled: true, suffix: 'of Tests', slots: ['attack'] },
        { key: 'inactive', enabled: false, suffix: 'of More Tests', slots: ['defense', 'health'] },
      ],
      draftEntries: [{ key: 'draft', enabled: true, slots: ['attack', 'defense', 'health'] }],
    });
    const result = await api.getLibraries();
    expect(result[0]!.coveredSlots).toEqual(['attack']);
    expect(result[1]!.coveredSlots).toEqual([]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith('/admin/equipment/affix-libraries/shared', undefined);
  });

  it('sends the existing revision and JSON envelope contracts unchanged', async () => {
    const get = vi.spyOn(client, 'getData').mockResolvedValue(exportFixture());
    const post = vi.spyOn(client, 'postData').mockResolvedValue({});
    const put = vi.spyOn(client, 'putData').mockResolvedValue({});
    const root = '/admin/equipment/rarity-rules';
    const rules = rulesFixture();
    const file = exportFixture();
    await api.saveDraft(rules, 8);
    expect(put).toHaveBeenCalledWith(`${root}/draft`, { rules, expectedDraftRevision: 8 });
    await api.validateRules(rules);
    expect(post).toHaveBeenLastCalledWith(`${root}/validate`, { rules });
    await api.previewRules(rules);
    expect(post).toHaveBeenLastCalledWith(`${root}/preview`, { rules });
    await api.publishRules(8);
    expect(post).toHaveBeenLastCalledWith(`${root}/publish`, { expectedDraftRevision: 8 });
    await api.rollbackRules(2, 8);
    expect(post).toHaveBeenLastCalledWith(`${root}/rollback`, {
      revision: 2,
      expectedDraftRevision: 8,
    });
    await api.previewImport(file, 8);
    expect(post).toHaveBeenLastCalledWith(`${root}/import/preview`, {
      file,
      expectedDraftRevision: 8,
    });
    await api.importDraft(file, 8);
    expect(post).toHaveBeenLastCalledWith(`${root}/import`, { file, expectedDraftRevision: 8 });
    await api.exportRules('draft');
    expect(get).toHaveBeenLastCalledWith(`${root}/export`, { params: { kind: 'draft' } });
    await api.exportRules('published');
    expect(get).toHaveBeenLastCalledWith(`${root}/export`, { params: { kind: 'published' } });
  });
});
