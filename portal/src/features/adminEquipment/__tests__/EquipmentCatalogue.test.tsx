/**
 * The Equipment Catalogue pages (E3-D): the list (six rarities, filters,
 * export, enable/disable with reward-impact confirmation, duplicate), the
 * editor (legacy restrictions, the high-rarity toggle and bonus ceiling, the
 * multiplier conversion, server issues at their fields, the stale refusal,
 * locks, artwork browsing, read-only), the import flow (preview, status
 * overrides, confirmation, stale apply) and the route/navigation gating.
 *
 * The API module is spied on; every rule the server enforces is represented
 * by what the stub returns, never re-implemented here.
 */
import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useRoutes, type RouteObject } from 'react-router';

import * as api from '@/api/adminEquipment';
import type {
  CatalogueDefinition,
  CatalogueDetail,
  ImportPreview,
  RewardImpact,
} from '@/api/adminEquipment';
import { PortalApiError } from '@/api/client';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

import { EquipmentCataloguePage } from '../EquipmentCataloguePage';
import { EquipmentCreatePage, EquipmentEditorPage } from '../EquipmentDefinitionEditorPage';
import { EquipmentImportPage } from '../EquipmentImportPage';

const ALL = ['admin.access', 'equipment.read', 'equipment.write'];
const READ_ONLY = ['admin.access', 'equipment.read'];

function definition(over: Partial<CatalogueDefinition> = {}): CatalogueDefinition {
  return {
    key: 'combat_knife',
    name: 'Combat Knife',
    description: 'Sharp.',
    slot: 'attack',
    rarity: 'R',
    multiplierMinBp: 6_000,
    multiplierMaxBp: 8_000,
    multiplierStepBp: 500,
    primarySpEligible: false,
    maxAdditionalBonuses: null,
    secondaryEffects: [],
    tags: [],
    regionId: null,
    artworkPath: null,
    enabled: true,
    shopRegions: [],
    buyPrice: null,
    priceCurrency: 'waifubux',
    revision: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    updatedBy: null,
    ownedCount: 0,
    instanceCount: 0,
    ...over,
  };
}

function detailOf(d: CatalogueDefinition, over: Partial<CatalogueDetail> = {}): CatalogueDetail {
  const high = ['SSR', 'UR', 'LR'].includes(d.rarity);
  return {
    definition: d,
    locks: {
      slotLocked: d.instanceCount > 0,
      rarityLocked: d.instanceCount > 0,
      instanceCount: d.instanceCount,
    },
    roll: high
      ? {
          mode: 'high',
          rarity: d.rarity,
          rulesRevision: 1,
          configured: false,
          rollable: false,
          issues: [
            {
              path: `rarities.${d.rarity}`,
              message: `the published rules configure no ${d.rarity} rolls`,
            },
          ],
          multiplier: {
            min: d.multiplierMinBp,
            max: d.multiplierMaxBp,
            step: d.multiplierStepBp,
            values: 5,
          },
          primarySpEligible: d.primarySpEligible,
          maxAdditionalBonuses: d.maxAdditionalBonuses,
          counts: [],
          families: [],
          primarySp: null,
          affix: { mode: 'none' },
          spRange: { min: 0, max: 0 },
        }
      : {
          mode: 'legacy',
          rarity: d.rarity,
          multiplier: {
            min: d.multiplierMinBp,
            max: d.multiplierMaxBp,
            step: d.multiplierStepBp,
            values: 5,
          },
          bonusChanceBp: 10_000,
          bonusCount: 1,
          families: [
            {
              stat: 'crit_chance_bp',
              label: 'Crit chance',
              unit: 'percent',
              min: 100,
              max: 300,
              step: 25,
            },
          ],
          affixPool: `${d.slot}.${d.rarity}`,
          enabledAffixes: 12,
          issues: [],
        },
    availability: {
      enabled: d.enabled,
      rollConfiguration: high ? 'unconfigured' : 'legacy',
      rollable: !high,
      rewardRarity: !high,
      summary: high
        ? 'No SSR roll rules are published, so it cannot be rolled yet.'
        : 'Enabled: reward sources whose selectors match it can hand it out.',
    },
    ...over,
  };
}

const KNIFE = definition();
const RELIC = definition({
  key: 'relic_blade',
  name: 'Relic Blade',
  rarity: 'SSR',
  enabled: false,
  revision: 1,
  multiplierMinBp: 11_000,
  multiplierMaxBp: 13_000,
});
const PIPE = definition({
  key: 'rusty_pipe',
  name: 'Rusty Pipe',
  rarity: 'N',
  enabled: false,
  revision: 2,
});
const OWNED = definition({
  key: 'owned_ring',
  name: 'Owned Ring',
  rarity: 'SR',
  ownedCount: 4,
  instanceCount: 5,
});

const WORKSHOP_IMPACT: RewardImpact = {
  rewardRarity: true,
  automatic: [
    {
      source: 'workshop_recipe',
      key: 'standard_rebuild',
      name: 'Standard Rebuild',
      location: 'any slot',
      selector: 'Any N Equipment',
      when: 'immediately',
    },
  ],
  deferred: [],
};

let store: Record<string, CatalogueDefinition>;
const notFound = () =>
  new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'Not found.' });

beforeEach(() => {
  stubObjectUrls();
  store = { combat_knife: KNIFE, relic_blade: RELIC, rusty_pipe: PIPE, owned_ring: OWNED };
  vi.spyOn(api, 'listCatalogue').mockImplementation(async (query) => {
    const rows = Object.values(store).filter((d) => !query.rarity || d.rarity === query.rarity);
    return {
      definitions: rows,
      total: rows.length,
      page: 1,
      pageSize: 25,
      counts: {
        total: 4,
        enabled: 2,
        disabled: 2,
        byRarity: { N: 1, R: 1, SR: 1, SSR: 1, UR: 0, LR: 0 },
      },
    };
  });
  vi.spyOn(api, 'getCatalogueDefinition').mockImplementation(async (key) => {
    const d = store[key];
    if (!d) throw notFound();
    return detailOf(d);
  });
  vi.spyOn(api, 'getCatalogueHistory').mockResolvedValue({ events: [], imports: [] });
  vi.spyOn(api, 'getRewardImpact').mockImplementation(async (key) =>
    ['N', 'R', 'SR'].includes(store[key]!.rarity)
      ? WORKSHOP_IMPACT
      : { rewardRarity: false, automatic: [], deferred: [] },
  );
  vi.spyOn(api, 'setCatalogueDefinitionEnabled').mockImplementation(async (key, enabled) => {
    store[key] = { ...store[key]!, enabled, revision: store[key]!.revision + 1 };
    return detailOf(store[key]!);
  });
  vi.spyOn(api, 'createCatalogueDefinition').mockImplementation(async (input) => {
    store[input.key] = definition({ ...input, enabled: false, revision: 1 });
    return detailOf(store[input.key]!);
  });
  vi.spyOn(api, 'updateCatalogueDefinition').mockImplementation(async (key, input) => {
    store[key] = { ...store[key]!, ...input, revision: store[key]!.revision + 1 };
    return detailOf(store[key]!);
  });
  vi.spyOn(api, 'duplicateCatalogueDefinition').mockImplementation(async (key, body) => {
    store[body.key] = {
      ...store[key]!,
      key: body.key,
      name: body.name ?? `${store[key]!.name} (copy)`,
      enabled: false,
      revision: 1,
    };
    return detailOf(store[body.key]!);
  });
  vi.spyOn(api, 'exportCatalogue').mockResolvedValue({
    format: 'waifumon-equipment',
    version: 3,
    exportedAt: null,
    label: null,
    definitions: [],
  });
  vi.spyOn(api, 'validateCatalogueDefinition').mockResolvedValue({ issues: [] });
  vi.spyOn(api, 'previewEquipmentRoll').mockImplementation(async (target, opts) => {
    const d = 'key' in target ? store[target.key]! : definition(target.definition);
    const detail = detailOf(d);
    return {
      analysis: detail.roll,
      availability: detail.availability,
      samples:
        opts?.seed !== undefined
          ? [
              {
                displayName: `${d.name} of Tests`,
                rolledMultiplierBp: d.multiplierMinBp,
                affixKey: 'x',
                combatBonuses: [],
                primarySp: 0,
                totalFlatSp: 0,
              },
            ]
          : null,
      seed: opts?.seed ?? null,
      sampleError: null,
    };
  });
  vi.spyOn(api, 'browseEquipmentArtwork').mockResolvedValue({
    path: 'equipment',
    parent: null,
    breadcrumbs: [],
    directories: [],
    files: [
      { name: 'relic.webp', path: 'equipment/relic.webp', folder: 'equipment', extension: '.webp' },
    ],
  });
  vi.spyOn(api, 'equipmentArtworkBlob').mockResolvedValue(new Blob(['x'], { type: 'image/webp' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapperFor(path: string, permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={<p>Loading page…</p>}>{children}</Suspense>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

function renderAt(path: string, permissions = ALL) {
  const user = userEvent.setup();
  render(
    <Routes>
      <Route path="/admin/equipment" element={<EquipmentCataloguePage />} />
      <Route path="/admin/equipment/new" element={<EquipmentCreatePage />} />
      <Route path="/admin/equipment/import" element={<EquipmentImportPage />} />
      <Route path="/admin/equipment/:key" element={<EquipmentEditorPage />} />
    </Routes>,
    { wrapper: wrapperFor(path, permissions) },
  );
  return user;
}

const row = (name: string) => {
  const found = screen
    .getAllByTestId('catalogue-row')
    .find((r) => within(r).queryByRole('link', { name }) !== null);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};

// ── list ────────────────────────────────────────────────────────────────────

describe('the catalogue list', () => {
  it('shows every definition with rarity, status and counts, and offers all six rarities', async () => {
    renderAt('/admin/equipment');
    expect(await screen.findByRole('link', { name: 'Relic Blade' })).toBeInTheDocument();
    expect(screen.getAllByTestId('catalogue-row')).toHaveLength(4);
    expect(screen.getByTestId('catalogue-counts')).toHaveTextContent(
      '4 definitions · 2 enabled · 2 disabled',
    );
    expect(within(row('Relic Blade')).getByText('Disabled')).toBeInTheDocument();
    expect(within(row('Combat Knife')).getByText('Enabled')).toBeInTheDocument();
    const options = within(screen.getByLabelText('Filter by rarity'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Any rarity', 'N', 'R', 'SR', 'SSR', 'UR', 'LR']);
  });

  it('sends the filters to the server', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Relic Blade' });
    await user.selectOptions(screen.getByLabelText('Filter by rarity'), 'SSR');
    await waitFor(() =>
      expect(api.listCatalogue).toHaveBeenLastCalledWith(
        expect.objectContaining({ rarity: 'SSR', page: 1 }),
        expect.anything(),
      ),
    );
    await user.selectOptions(screen.getByLabelText('Filter by slot'), 'defense');
    await waitFor(() =>
      expect(api.listCatalogue).toHaveBeenLastCalledWith(
        expect.objectContaining({ rarity: 'SSR', slot: 'defense' }),
        expect.anything(),
      ),
    );
  });

  it('exports everything, or just the selection', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Relic Blade' });
    await user.click(screen.getByRole('button', { name: 'Export all' }));
    await waitFor(() => expect(api.exportCatalogue).toHaveBeenCalledWith({}));
    await user.click(screen.getByLabelText('Select Relic Blade'));
    await user.click(screen.getByRole('button', { name: 'Export 1 selected' }));
    await waitFor(() =>
      expect(api.exportCatalogue).toHaveBeenLastCalledWith({ keys: ['relic_blade'] }),
    );
  });

  it('read-only: no create, import, enable or duplicate', async () => {
    renderAt('/admin/equipment', READ_ONLY);
    await screen.findByRole('link', { name: 'Relic Blade' });
    expect(screen.queryByRole('link', { name: 'Create equipment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable Rusty Pipe' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Relic Blade' })).toBeInTheDocument();
  });
});

// ── enable / disable / duplicate ────────────────────────────────────────────

describe('enabling, disabling and duplicating', () => {
  it('enabling N/R/SR gear lists the automatic rewards and needs an explicit tick', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Rusty Pipe' });
    await user.click(screen.getByRole('button', { name: 'Enable Rusty Pipe' }));
    const dialog = await screen.findByTestId('enable-dialog');
    expect(await within(dialog).findByTestId('impact-row')).toHaveTextContent('Standard Rebuild');
    const enable = within(dialog).getByRole('button', { name: 'Enable' });
    expect(enable).toBeDisabled();
    await user.click(within(dialog).getByLabelText('I understand it joins these rewards'));
    await user.click(enable);
    await waitFor(() =>
      expect(api.setCatalogueDefinitionEnabled).toHaveBeenCalledWith('rusty_pipe', true, 2, true),
    );
  });

  it('enabling SSR gear needs no tick, and says it is still not obtainable', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Relic Blade' });
    await user.click(screen.getByRole('button', { name: 'Enable Relic Blade' }));
    const dialog = await screen.findByTestId('enable-dialog');
    expect(dialog).toHaveTextContent('does not make it obtainable');
    const enable = within(dialog).getByRole('button', { name: 'Enable' });
    await waitFor(() => expect(enable).toBeEnabled());
    await user.click(enable);
    await waitFor(() =>
      expect(api.setCatalogueDefinitionEnabled).toHaveBeenCalledWith('relic_blade', true, 1, false),
    );
  });

  it('disabling skips the impact check', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Combat Knife' });
    await user.click(screen.getByRole('button', { name: 'Disable Combat Knife' }));
    await user.click(
      within(await screen.findByTestId('enable-dialog')).getByRole('button', { name: 'Disable' }),
    );
    await waitFor(() =>
      expect(api.setCatalogueDefinitionEnabled).toHaveBeenCalledWith(
        'combat_knife',
        false,
        3,
        false,
      ),
    );
    expect(api.getRewardImpact).not.toHaveBeenCalled();
  });

  it('duplicates under a new key and opens the copy', async () => {
    const user = renderAt('/admin/equipment');
    await screen.findByRole('link', { name: 'Relic Blade' });
    await user.click(screen.getByRole('button', { name: 'Duplicate Relic Blade' }));
    const dialog = await screen.findByTestId('duplicate-dialog');
    const key = within(dialog).getByLabelText('Key of the copy');
    await user.clear(key);
    await user.type(key, 'Bad Key');
    expect(within(dialog).getByRole('button', { name: 'Duplicate' })).toBeDisabled();
    await user.clear(key);
    await user.type(key, 'relic_blade_two');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(api.duplicateCatalogueDefinition).toHaveBeenCalledWith('relic_blade', {
        key: 'relic_blade_two',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Equipment — Relic Blade (copy)' }),
    ).toBeInTheDocument();
  });
});

// ── editor ──────────────────────────────────────────────────────────────────

describe('the editor', () => {
  it('N/R/SR show the legacy restriction instead of the high-rarity settings', async () => {
    renderAt('/admin/equipment/new');
    expect(await screen.findByTestId('legacy-notice')).toHaveTextContent(
      'Primary SP and a bonus maximum are available on SSR, UR and LR equipment only',
    );
    expect(screen.queryByLabelText('Primary SP eligible')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Maximum additional bonuses')).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Rarity'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['N', 'R', 'SR', 'SSR', 'UR', 'LR']);
  });

  it('creates SSR gear with its roll policy, converting multipliers, always as disabled', async () => {
    const user = renderAt('/admin/equipment/new');
    await user.type(await screen.findByLabelText('Display name'), 'Relic Spear');
    expect(screen.getByLabelText('Equipment key')).toHaveValue('relic_spear');
    await user.selectOptions(screen.getByLabelText('Rarity'), 'SSR');
    await user.click(screen.getByLabelText('Primary SP eligible'));
    await user.selectOptions(screen.getByLabelText('Maximum additional bonuses'), '2');
    expect(screen.getByTestId('max-bonus-hint')).toHaveTextContent('A ceiling, not a guarantee');
    for (const [label, value] of [
      ['Minimum multiplier', '1.1'],
      ['Maximum multiplier', '1.3'],
      ['Step', '0.05'],
    ] as const) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(screen.getByRole('button', { name: 'Create (disabled)' }));
    await waitFor(() =>
      expect(api.createCatalogueDefinition).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'relic_spear',
          rarity: 'SSR',
          primarySpEligible: true,
          maxAdditionalBonuses: 2,
          multiplierMinBp: 11_000,
          multiplierMaxBp: 13_000,
          multiplierStepBp: 500,
          enabled: false,
        }),
      ),
    );
    expect(
      await screen.findByRole('heading', { name: 'Equipment — Relic Spear' }),
    ).toBeInTheDocument();
  });

  it('switching back to a legacy rarity sends the default policy', async () => {
    const user = renderAt('/admin/equipment/new');
    await user.type(await screen.findByLabelText('Display name'), 'Back And Forth');
    await user.selectOptions(screen.getByLabelText('Rarity'), 'UR');
    await user.click(screen.getByLabelText('Primary SP eligible'));
    await user.selectOptions(screen.getByLabelText('Rarity'), 'R');
    await user.click(screen.getByRole('button', { name: 'Create (disabled)' }));
    await waitFor(() =>
      expect(api.createCatalogueDefinition).toHaveBeenCalledWith(
        expect.objectContaining({
          rarity: 'R',
          primarySpEligible: false,
          maxAdditionalBonuses: null,
        }),
      ),
    );
  });

  it('shows server refusals at their fields', async () => {
    vi.mocked(api.updateCatalogueDefinition).mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_INVALID',
        message: 'bad',
        details: {
          issues: [{ path: 'multiplierStepBp', message: 'must divide the range evenly' }],
        },
      }),
    );
    const user = renderAt('/admin/equipment/combat_knife');
    await user.clear(await screen.findByLabelText('Step'));
    await user.type(screen.getByLabelText('Step'), '0.03');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('issues-strength')).toHaveTextContent(
      'must divide the range evenly',
    );
  });

  it('a stale save shows who saved first and offers a reload', async () => {
    vi.mocked(api.updateCatalogueDefinition).mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'EQUIPMENT_DEFINITION_STALE',
        message: 'stale',
        details: { expectedRevision: 3, currentRevision: 4, updatedBy: '777' },
      }),
    );
    const user = renderAt('/admin/equipment/combat_knife');
    await user.type(await screen.findByLabelText('Display name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const banner = await screen.findByTestId('stale-banner');
    expect(banner).toHaveTextContent('revision 4 (saved by 777)');
    expect(api.updateCatalogueDefinition).toHaveBeenCalledWith(
      'combat_knife',
      expect.objectContaining({ name: 'Combat Knife!' }),
      3,
    );
  });

  it('locks slot and rarity once copies exist, and explains why', async () => {
    renderAt('/admin/equipment/owned_ring');
    expect(await screen.findByLabelText('Rarity')).toBeDisabled();
    expect(screen.getByLabelText('Slot')).toBeDisabled();
    expect(screen.getByTestId('lock-notice')).toHaveTextContent('5 copies exist');
  });

  it('separates enabled, rollable and rewardable for SSR gear', async () => {
    renderAt('/admin/equipment/relic_blade');
    const card = await screen.findByTestId('availability');
    expect(within(card).getByTestId('availability-rolls')).toHaveTextContent(
      'No published rules for this rarity — cannot roll',
    );
    expect(within(card).getByTestId('availability-rewards')).toHaveTextContent(
      'no reward source can grant this rarity yet',
    );
  });

  it('previews rolls from the server with a seed', async () => {
    const user = renderAt('/admin/equipment/combat_knife');
    await screen.findByLabelText('Display name');
    await user.clear(screen.getByLabelText('Sample seed'));
    await user.type(screen.getByLabelText('Sample seed'), '42');
    await user.click(screen.getByRole('button', { name: 'Roll samples' }));
    expect(await screen.findByTestId('sample-roll')).toHaveTextContent('Combat Knife of Tests');
    expect(api.previewEquipmentRoll).toHaveBeenCalledWith(
      { key: 'combat_knife' },
      { seed: 42, count: 5 },
    );
    expect(screen.getByTestId('preview-legacy')).toHaveTextContent('Standard R rules');
  });

  it('browses equipment artwork and fills the path', async () => {
    const user = renderAt('/admin/equipment/relic_blade');
    await user.click(await screen.findByRole('button', { name: 'Browse artwork' }));
    await user.click(await screen.findByRole('button', { name: /relic\.webp/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Artwork path')).toHaveValue('equipment/relic.webp'),
    );
  });

  it('is read-only without equipment.write', async () => {
    renderAt('/admin/equipment/combat_knife', READ_ONLY);
    expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });
});

// ── import ──────────────────────────────────────────────────────────────────

const PREVIEW: ImportPreview = {
  entries: [
    { key: 'new_n', action: 'create', changedFields: [] },
    { key: 'combat_knife', action: 'update', changedFields: ['name'] },
  ],
  issues: [],
  counts: { create: 1, update: 1, unchanged: 0 },
  ok: true,
  planHash: 'sha256:plan',
  statusNotes: [
    {
      key: 'new_n',
      packageEnabled: true,
      enabled: false,
      reason: 'new_definitions_start_disabled',
    },
  ],
  rewardImpact: [{ key: 'new_n', impact: WORKSHOP_IMPACT }],
};

describe('importing', () => {
  const pkg = JSON.stringify({ format: 'waifumon-equipment', version: 3, definitions: [] });

  it('refuses text that is not JSON before calling the server', async () => {
    const user = renderAt('/admin/equipment/import');
    await user.click(await screen.findByLabelText('Package JSON'));
    await user.paste('{ not json');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(await screen.findByText(/That is not valid JSON/)).toBeInTheDocument();
  });

  it('previews, shows overrides and reward impact, and applies only once confirmed', async () => {
    vi.spyOn(api, 'previewEquipmentImport').mockResolvedValue(PREVIEW);
    const applySpy = vi.spyOn(api, 'applyEquipmentImport').mockResolvedValue({
      plan: { entries: PREVIEW.entries, issues: [], counts: PREVIEW.counts, ok: true },
      logId: 7,
      planHash: PREVIEW.planHash,
      statusNotes: PREVIEW.statusNotes,
    });
    const user = renderAt('/admin/equipment/import');
    await user.click(await screen.findByLabelText('Package JSON'));
    await user.paste(pkg);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    const preview = await screen.findByTestId('import-preview');
    expect(within(preview).getByTestId('import-counts')).toHaveTextContent(
      '1 new · 1 updated · 0 unchanged',
    );
    expect(within(preview).getByTestId('import-status-notes')).toHaveTextContent(
      'new equipment arrives disabled',
    );
    expect(within(preview).getByTestId('import-reward-impact')).toHaveTextContent(
      'Standard Rebuild',
    );
    const importButton = within(preview).getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    await user.click(within(preview).getByLabelText('Confirm import'));
    await user.click(importButton);
    await waitFor(() =>
      expect(applySpy).toHaveBeenCalledWith(JSON.parse(pkg), 'sha256:plan', undefined),
    );
    expect(await screen.findByTestId('import-result')).toHaveTextContent('import #7');
  });

  it('a refused plan cannot be applied', async () => {
    vi.spyOn(api, 'previewEquipmentImport').mockResolvedValue({
      ...PREVIEW,
      ok: false,
      issues: [{ path: 'definitions[1].rarity', message: 'its rarity cannot change' }],
    });
    const user = renderAt('/admin/equipment/import');
    await user.click(await screen.findByLabelText('Package JSON'));
    await user.paste(pkg);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(await screen.findByTestId('import-refusals')).toHaveTextContent(
      'its rarity cannot change',
    );
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('a stale apply asks for a new preview', async () => {
    vi.spyOn(api, 'previewEquipmentImport').mockResolvedValue(PREVIEW);
    vi.spyOn(api, 'applyEquipmentImport').mockRejectedValue(
      new PortalApiError({ status: 409, code: 'EQUIPMENT_IMPORT_STALE', message: 'stale' }),
    );
    const user = renderAt('/admin/equipment/import');
    await user.click(await screen.findByLabelText('Package JSON'));
    await user.paste(pkg);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(await screen.findByLabelText('Confirm import'));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByTestId('import-stale')).toHaveTextContent('Preview it again');
  });

  it('shows package validation issues by path', async () => {
    vi.spyOn(api, 'previewEquipmentImport').mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_INVALID',
        message: 'bad',
        details: { issues: [{ path: 'definitions[0].rarity', message: 'Invalid enum value' }] },
      }),
    );
    const user = renderAt('/admin/equipment/import');
    await user.click(await screen.findByLabelText('Package JSON'));
    await user.paste(pkg);
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(await screen.findByTestId('package-issues')).toHaveTextContent('definitions[0].rarity');
  });
});

// ── routes and navigation ───────────────────────────────────────────────────

function flatten(table: RouteObject[]): RouteObject[] {
  return table.flatMap((route) =>
    route.path === undefined && route.children ? flatten(route.children) : [route],
  );
}
const ADMIN_ROUTES = flatten(routes).filter((route) => route.path?.startsWith('admin/'));
function Routed() {
  return useRoutes(ADMIN_ROUTES);
}

describe('routes and navigation', () => {
  it('registers the catalogue, create, import and edit routes behind equipment permissions', async () => {
    render(<Routed />, { wrapper: wrapperFor('/admin/equipment/import', ALL) });
    expect(await screen.findByRole('heading', { name: 'Import equipment' })).toBeInTheDocument();
  });

  it('a reader cannot open the create page', async () => {
    render(<Routed />, { wrapper: wrapperFor('/admin/equipment/new', READ_ONLY) });
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(api.createCatalogueDefinition).not.toHaveBeenCalled();
  });

  it('adds a navigation entry gated on equipment.read', () => {
    expect(NAV_ITEMS.find((item) => item.to === '/admin/equipment')).toMatchObject({
      label: 'Admin — Equipment',
      requiresPermission: 'equipment.read',
    });
  });
});
