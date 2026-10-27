import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';
import * as api from '@/api/adminEquipmentRules';
import { PortalApiError } from '@/api/client';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { EquipmentRarityRulesPage } from '../EquipmentRarityRulesPage';
import { bundleFixture, exportFixture, libraryFixture, previewFixture } from './rulesFixtures';

const ALL = ['equipment.read', 'equipment.write', 'equipment.publish'];
let store: api.RulesBundle;
beforeEach(() => {
  store = bundleFixture();
  vi.spyOn(api, 'loadRules').mockImplementation(async () => structuredClone(store));
  vi.spyOn(api, 'saveDraft').mockImplementation(async (rules) => {
    store.draft = {
      ...store.draft,
      rules: structuredClone(rules),
      draftRevision: store.draft.draftRevision + 1,
      dirty: true,
    };
    return structuredClone(store.draft);
  });
  vi.spyOn(api, 'validateRules').mockImplementation(async (rules) => ({
    ok: true,
    errors: [],
    warnings: [],
    value: rules,
  }));
  vi.spyOn(api, 'previewRules').mockImplementation(async (rules) => ({
    ...previewFixture(store),
    validation: { ok: true, errors: [], warnings: [], value: rules },
  }));
  vi.spyOn(api, 'publishRules').mockImplementation(async () => {
    store.published = {
      ...store.published,
      rules: structuredClone(store.draft.rules),
      revision: store.published.revision + 1,
    };
    store.draft = { ...store.draft, publishedRevision: store.published.revision, dirty: false };
    return structuredClone(store.published);
  });
  vi.spyOn(api, 'rollbackRules').mockImplementation(async () => {
    store.published = { ...store.published, revision: 3, source: 'rollback' };
    store.draft = { ...store.draft, draftRevision: 6, publishedRevision: 3, dirty: false };
    return store.published;
  });
  vi.spyOn(api, 'exportRules').mockImplementation(async (kind) => ({ ...exportFixture(), kind }));
  vi.spyOn(api, 'previewImport').mockImplementation(async () => ({
    ...previewFixture(store),
    handEdited: true,
  }));
  vi.spyOn(api, 'importDraft').mockImplementation(async () => {
    store.draft = { ...store.draft, draftRevision: 6, dirty: true };
    return { ...structuredClone(store.draft), handEdited: true };
  });
});
afterEach(() => vi.restoreAllMocks());

function wrapper(permissions = ALL) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={['/admin/equipment/rarity-rules']}>
          <Suspense fallback={<p>Loading…</p>}>{children}</Suspense>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}
async function page(permissions = ALL) {
  const user = userEvent.setup();
  render(<EquipmentRarityRulesPage />, { wrapper: wrapper(permissions) });
  if (permissions.includes('equipment.read')) await screen.findByText('Draft revision 5');
  return user;
}
async function replace(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
}
const staleError = () =>
  new PortalApiError({
    status: 409,
    code: 'EQUIPMENT_CONFIG_STALE',
    message: 'Someone saved first.',
    details: { expectedRevision: 5, currentRevision: 6 },
  });

describe('rarity authoring', () => {
  it('shows draft/publication state and read-only N/R/SR counts, ranges, slots and affix source', async () => {
    const user = await page();
    expect(screen.getByText('Published revision 2')).toBeInTheDocument();
    for (const [rarity, chance, count] of [
      ['N', '65', '1'],
      ['R', '100', '1'],
      ['SR', '100', '2'],
    ]) {
      await user.selectOptions(screen.getByLabelText('Rarity'), rarity!);
      expect(screen.getByText(`${rarity} — read-only legacy rules`)).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(`${chance}% chance of ${count} additional`)),
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole('cell', { name: 'Attack, Defense, Health' }).length,
      ).toBeGreaterThan(0);
      expect(
        screen.getByText(new RegExp(`Affix source: shipped ${rarity} affixes`)),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('1 additional bonus (%)')).not.toBeInTheDocument();
    }
  });

  it('starts unconfigured UR/LR rules with blank fields, without illustrative balance defaults', async () => {
    const user = await page();
    for (const rarity of ['UR', 'LR']) {
      await user.selectOptions(screen.getByLabelText('Rarity'), rarity);
      await user.click(screen.getByLabelText(`Configure ${rarity} rolls`));
      expect(screen.getByLabelText('1 additional bonus (%)')).toHaveValue('');
      expect(screen.getByText(/Total: incomplete/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled();
    }
  });

  it('preserves precision and family order on save and never publishes implicitly', async () => {
    const user = await page();
    await replace(user, '1 additional bonus (%)', '69.99');
    expect(screen.getByText(/Total: 99.99%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled();
    await replace(user, '2 additional bonuses (%)', '30.01');
    expect(screen.getByText(/Total: 100%/)).toBeInTheDocument();
    expect(screen.getByText('Unsaved local changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await screen.findByText('Draft revision 6');
    expect(api.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        rarities: expect.objectContaining({
          SSR: expect.objectContaining({ bonusCountWeightsBp: [0, 6999, 3001, 0] }),
        }),
      }),
      5,
    );
    expect(api.publishRules).not.toHaveBeenCalled();
    expect(screen.getByText(/Draft saved. Published rules are unchanged/)).toBeInTheDocument();
    expect(store.draft.rules.legacy).toEqual(bundleFixture().draft.rules.legacy);
  });

  it('edits primary SP, flat SP and slot eligibility using whole points and exact percentages', async () => {
    const user = await page();
    await user.selectOptions(screen.getByLabelText('Configuration section'), 'primary');
    await user.click(screen.getByLabelText('Configure primary SP'));
    for (const [label, value] of [
      ['Primary SP chance (%)', '12.34'],
      ['Minimum primary SP (SP)', '5'],
      ['Maximum primary SP (SP)', '15'],
      ['Primary SP step (SP)', '5'],
    ])
      await replace(user, label!, value!);
    await user.selectOptions(screen.getByLabelText('Configuration section'), 'families');
    expect(screen.getByLabelText('Critical chance minimum (%)')).toHaveValue('1.01');
    await replace(user, 'Critical chance minimum (%)', '1.02');
    await user.click(screen.getByLabelText('Critical chance Health'));
    await user.click(screen.getByLabelText('Include Flat SP'));
    for (const [label, value] of [
      ['Flat SP minimum (SP)', '3'],
      ['Flat SP maximum (SP)', '9'],
      ['Flat SP step (SP)', '3'],
    ])
      await replace(user, label!, value!);
    await user.click(screen.getByLabelText('Flat SP Attack'));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalled());
    const rule = vi.mocked(api.saveDraft).mock.calls[0]![0].rarities.SSR!;
    expect(rule.primarySp).toEqual({ chanceBp: 1234, min: 5, max: 15, step: 5 });
    expect(rule.families[0]).toMatchObject({ minValue: 102, slots: ['attack', 'defense'] });
    expect(rule.families[2]).toMatchObject({
      stat: 'flat_sp',
      minValue: 3,
      maxValue: 9,
      step: 3,
      slots: ['attack'],
    });
  });

  it('exposes SP safety ceilings without clamping entered values', async () => {
    vi.mocked(api.validateRules).mockResolvedValue({
      ok: false,
      value: null,
      errors: [
        { path: 'flatSpLimits.perItemMax', message: 'Per-copy equipment SP cannot exceed 200.' },
      ],
      warnings: [],
    });
    const user = await page();
    await user.click(screen.getByText('Equipment SP safety limits'));
    await replace(user, 'Per-equipment-copy maximum (SP)', '201');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() =>
      expect(api.validateRules).toHaveBeenCalledWith(
        expect.objectContaining({ flatSpLimits: { perItemMax: 201, perLoadoutMax: 400 } }),
      ),
    );
    expect(screen.getByLabelText('Per-equipment-copy maximum (SP)')).toHaveValue('201');
  });

  it('supports affixless rules with no libraries and selects only published slot-complete libraries', async () => {
    store.libraries = [
      libraryFixture(),
      libraryFixture({
        key: 'draft_only',
        name: 'Draft names',
        publishedRevision: null,
        coveredSlots: [],
      }),
      libraryFixture({ key: 'missing_slots', name: 'Attack only', coveredSlots: ['attack'] }),
    ];
    const user = await page();
    await user.selectOptions(screen.getByLabelText('Configuration section'), 'affixes');
    expect(screen.getByLabelText('Affix library')).toHaveValue('');
    expect(screen.getByRole('option', { name: /Draft names/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: /Attack only/ })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Affix library'), 'shared');
    expect(
      screen.getByText(/Assigned: Shared relic names, published revision 2/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() =>
      expect(api.saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          rarities: expect.objectContaining({
            SSR: expect.objectContaining({ affixes: { mode: 'library', library: 'shared' } }),
          }),
        }),
        5,
      ),
    );
  });

  it('displays missing assigned libraries as unavailable rather than silently replacing them', async () => {
    store.draft.rules.rarities.SSR!.affixes = { mode: 'library', library: 'missing' };
    const user = await page();
    await user.selectOptions(screen.getByLabelText('Configuration section'), 'affixes');
    expect(screen.getByLabelText('Affix library')).toHaveValue('missing');
    expect(screen.getByText(/This assignment is unavailable/)).toBeInTheDocument();
  });

  it('inspects published rules without losing local draft edits', async () => {
    const user = await page();
    await replace(user, '1 additional bonus (%)', '60');
    await user.selectOptions(screen.getByLabelText('Configuration to inspect'), 'published');
    expect(screen.getByLabelText('1 additional bonus (%)')).toHaveValue('75');
    expect(screen.getByLabelText('1 additional bonus (%)')).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Configuration to inspect'), 'draft');
    expect(screen.getByLabelText('1 additional bonus (%)')).toHaveValue('60');
  });

  it('shows field-specific backend errors and advisory warnings', async () => {
    vi.mocked(api.validateRules).mockResolvedValue({
      ok: false,
      value: null,
      errors: [
        {
          path: 'rarities.SSR.bonusCountWeightsBp',
          message: 'Not enough distinct families for Health.',
        },
      ],
      warnings: [{ path: 'flatSpLimits', message: 'A loadout can reach the SP ceiling.' }],
    });
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    expect(
      (await screen.findAllByText(/Not enough distinct families for Health/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/A loadout can reach the SP ceiling/)).toBeInTheDocument();
  });
});

describe('publication and independent permissions', () => {
  it('requires reviewed validation and explicit confirmation before publishing a saved integer revision', async () => {
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('SSR additional bonus chances — changed')).toBeInTheDocument();
    expect(within(dialog).getByText(/1 bonuses: 75%/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publication' }));
    await screen.findByText('Rules published successfully.');
    expect(api.publishRules).toHaveBeenCalledExactlyOnceWith(5);
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByText('Published revision 3')).toBeInTheDocument();
  });

  it('refuses publication from an unsaved review and from a failed backend validation', async () => {
    const user = await page();
    await replace(user, '1 additional bonus (%)', '69');
    await replace(user, '2 additional bonuses (%)', '31');
    await user.click(screen.getByRole('button', { name: 'Review Changes' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/These changes are unsaved/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await screen.findByText('Draft revision 6');
    vi.mocked(api.previewRules).mockResolvedValue({
      ...previewFixture(store),
      validation: {
        ok: false,
        value: null,
        errors: [
          { path: 'rarities.SSR', message: 'Enabled definition would have no reachable count.' },
        ],
        warnings: [],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
    expect(api.publishRules).not.toHaveBeenCalled();
  });

  it('keeps read-only controls disabled; write does not allow publication', async () => {
    await page(['equipment.read']);
    expect(screen.getByLabelText('1 additional bonus (%)')).toBeDisabled();
    for (const name of [
      'Save Draft',
      'Validate',
      'Publish…',
      'Import JSON',
      'Roll back to revision 1',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review Changes' })).toBeEnabled();
  });

  it('allows read plus publish without write', async () => {
    const user = await page(['equipment.read', 'equipment.publish']);
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    expect(screen.getByLabelText('1 additional bonus (%)')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publication' }));
    await waitFor(() => expect(api.publishRules).toHaveBeenCalledWith(5));
    expect(api.validateRules).not.toHaveBeenCalled();
    expect(api.saveDraft).not.toHaveBeenCalled();
  });

  it('allows a writer to save but not publish or roll back', async () => {
    const user = await page(['equipment.read', 'equipment.write']);
    await replace(user, '1 additional bonus (%)', '69');
    await replace(user, '2 additional bonuses (%)', '31');
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Roll back to revision 1' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await screen.findByText('Draft revision 6');
  });

  it('does not infer read permission for a write-only user', async () => {
    await page(['equipment.write']);
    expect(screen.getByRole('alert')).toHaveTextContent('equipment.read is required');
    expect(api.loadRules).not.toHaveBeenCalled();
  });

  it('does not fetch or infer read permission for a publish-only user', async () => {
    await page(['equipment.publish']);
    expect(screen.getByRole('alert')).toHaveTextContent('equipment.read is required');
    expect(api.loadRules).not.toHaveBeenCalled();
  });

  it('preserves local values on stale save and reloads only after discard confirmation', async () => {
    vi.mocked(api.saveDraft).mockRejectedValue(staleError());
    const user = await page();
    await replace(user, '1 additional bonus (%)', '69');
    await replace(user, '2 additional bonuses (%)', '31');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await screen.findByText(/This configuration changed while you were editing/);
    expect(screen.getByLabelText('1 additional bonus (%)')).toHaveValue('69');
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reload current draft' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('replaces your unsaved local values');
    store.draft.draftRevision = 7;
    await user.click(screen.getByRole('button', { name: 'Discard local changes and reload' }));
    await screen.findByText('Draft revision 7');
    expect(screen.getByLabelText('1 additional bonus (%)')).toHaveValue('70');
  });

  it('invalidates stale reviews and never automatically retries a stale publication', async () => {
    vi.mocked(api.publishRules).mockRejectedValue(staleError());
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publication' }));
    await screen.findByText(/This configuration changed while you were editing/);
    expect(api.publishRules).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();
  });

  it('detects a remote publication even if the integer draft revision has not changed', async () => {
    vi.mocked(api.previewRules).mockResolvedValue({ ...previewFixture(), publishedRevision: 3 });
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Review Changes' }));
    await screen.findByText(/This configuration changed while you were editing/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('JSON and history workflows', () => {
  it('uploads a rules export without changing the file contents', async () => {
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Import JSON' }));
    const file = new File([JSON.stringify(exportFixture())], 'rules.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(exportFixture()) });
    await user.upload(screen.getByLabelText('Upload rules JSON'), file);
    await waitFor(() =>
      expect(screen.getByLabelText('Rules JSON')).toHaveValue(JSON.stringify(exportFixture())),
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await waitFor(() => expect(api.previewImport).toHaveBeenCalledWith(exportFixture(), 5));
  });

  it('invalidates a stale import and prevents applying the old preview again', async () => {
    vi.mocked(api.importDraft).mockRejectedValue(staleError());
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Import JSON' }));
    await user.click(screen.getByLabelText('Rules JSON'));
    await user.paste(JSON.stringify(exportFixture()));
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/This file was edited after export/);
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply import to draft' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Apply import to draft' }),
      ).not.toBeInTheDocument(),
    );
    expect(api.importDraft).toHaveBeenCalledTimes(1);
  });
  it('previews and confirms an import into the draft only', async () => {
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Import JSON' }));
    await user.click(screen.getByLabelText('Rules JSON'));
    await user.paste(JSON.stringify(exportFixture()));
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/This file was edited after export/);
    expect(api.importDraft).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply import to draft' }));
    await screen.findByText(/Import saved to the draft only/);
    expect(api.previewImport).toHaveBeenCalledWith(exportFixture(), 5);
    expect(api.importDraft).toHaveBeenCalledWith(exportFixture(), 5);
    expect(api.publishRules).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON locally and blocks an import with backend legacy issues', async () => {
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Import JSON' }));
    await user.type(screen.getByLabelText('Rules JSON'), 'invalid');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(api.previewImport).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Rules JSON'));
    await user.click(screen.getByLabelText('Rules JSON'));
    await user.paste(JSON.stringify(exportFixture()));
    vi.mocked(api.previewImport).mockResolvedValue({
      ...previewFixture(),
      handEdited: true,
      validation: {
        ok: false,
        value: null,
        errors: [{ path: 'legacy', message: 'N/R/SR rules are immutable.' }],
        warnings: [],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/N\/R\/SR rules are immutable/);
    expect(screen.getByRole('button', { name: 'Apply import to draft' })).toBeDisabled();
  });

  it('exports explicit draft and published JSON using the server documents', async () => {
    const original = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const user = await page();
      await user.click(screen.getByRole('button', { name: 'Export draft' }));
      await user.click(screen.getByRole('button', { name: 'Export published' }));
      expect(api.exportRules).toHaveBeenCalledWith('draft');
      expect(api.exportRules).toHaveBeenCalledWith('published');
      expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      URL.createObjectURL = original;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('lists history metadata and requires rollback confirmation with the loaded draft revision', async () => {
    const user = await page();
    expect(screen.getByRole('cell', { name: '2 (current)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Future unpinned equipment grants');
    expect(dialog).toHaveTextContent('Existing owned equipment remains unchanged');
    expect(screen.getByRole('button', { name: 'Confirm rollback' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await screen.findByText('Rollback published as a new revision.');
    expect(api.rollbackRules).toHaveBeenCalledWith(1, 5);
  });

  it('shows rollback dependency refusals without losing the local configuration', async () => {
    vi.mocked(api.rollbackRules).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_CONFIG_INVALID',
        message: 'Referenced library is unavailable.',
        details: {
          issues: [{ path: 'rarities.SSR.affixes', message: 'Referenced library is unavailable.' }],
        },
      }),
    );
    const user = await page();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('Referenced library is unavailable.'),
    );
    expect(screen.getByText('Draft revision 5')).toBeInTheDocument();
  });

  it('registers the specific route and permission-aware navigation beneath equipment', async () => {
    const tree = routes[0]!.children!.find((r) =>
      r.children?.some((c) => c.path === 'admin/equipment'),
    )!;
    const route = tree.children!.find((r) => r.path === 'admin/equipment/rarity-rules')!;
    expect(route).toBeDefined();
    expect(
      NAV_ITEMS.find((i) => i.to === '/admin/equipment/rarity-rules')?.requiresPermission,
    ).toBe('equipment.read');
    function RenderRoute() {
      return useRoutes([{ ...route, path: '/admin/equipment/rarity-rules' }] as RouteObject[]);
    }
    render(<RenderRoute />, { wrapper: wrapper(['equipment.publish']) });
    expect(await screen.findByText(/equipment.read is required/)).toBeInTheDocument();
  });
});
