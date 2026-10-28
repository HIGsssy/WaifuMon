/**
 * The three Equipment Admin pages' data requests carry the `/v1` API prefix.
 *
 * The client's baseURL is `/api` and the Platform API mounts every route under
 * `/api/v1`, so each client path must start with `/v1`. Without it a request
 * reaches `/api/admin/equipment/...`, which no route serves, and the page shows
 * "Not found." Portal page routes (`libraryPath`) stay unprefixed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as catalogue from '@/api/adminEquipment';
import * as affixes from '@/api/adminEquipmentAffixes';
import * as rules from '@/api/adminEquipmentRules';

afterEach(() => vi.restoreAllMocks());

describe('Equipment Admin data-loading paths', () => {
  it('Equipment Catalogue loads definitions from the /v1 route', async () => {
    const get = vi.spyOn(client, 'getData').mockResolvedValue({});
    await catalogue.listCatalogue({});
    expect(get.mock.calls[0]![0]).toBe('/v1/admin/equipment/definitions');
    await catalogue.getCatalogueDefinition('combat_knife');
    expect(get.mock.calls[1]![0]).toBe('/v1/admin/equipment/definitions/combat_knife');
  });

  it('Rarity Rules loads the draft, the published configuration and libraries from /v1', async () => {
    const get = vi.spyOn(client, 'getData').mockResolvedValue({ managed: [] });
    await rules.getDraft();
    await rules.getPublished();
    await rules.getLibraries();
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      '/v1/admin/equipment/rarity-rules/draft',
      '/v1/admin/equipment/rarity-rules/published',
      '/v1/admin/equipment/affix-libraries',
    ]);
  });

  it('Affix Libraries loads managed and legacy libraries from /v1; page links stay Portal routes', async () => {
    const get = vi.spyOn(client, 'getData').mockResolvedValue({});
    await affixes.listLibraries();
    await affixes.getLibrary('legacy_n');
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      '/v1/admin/equipment/affix-libraries',
      '/v1/admin/equipment/affix-libraries/legacy_n',
    ]);
    expect(affixes.libraryPath('shared')).toBe('/admin/equipment/affix-libraries/shared');
  });
});
