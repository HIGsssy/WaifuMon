import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import * as api from '@/api/adminEquipmentAffixes';
import * as rulesApi from '@/api/adminEquipmentRules';
import { PortalApiError } from '@/api/client';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { AffixLibrariesPage, AffixLibraryCreatePage } from '../AffixLibrariesPage';
import { AffixLibraryEditorPage } from '../AffixLibraryEditorPage';
import { AffixLibraryImportPage } from '../AffixLibraryImportPage';
import { bundleFixture } from './rulesFixtures';
import {
  exportFixture,
  listFixture,
  managed,
  previewFixture,
  revisionsFixture,
} from './affixFixtures';

const ALL = ['equipment.read', 'equipment.write', 'equipment.publish'];
const ROOT = '/admin/equipment/affix-libraries';
let library: api.ManagedLibrary;
let history: api.LibraryRevision[];
let queryClient: QueryClient;
const clone = <T,>(value: T): T => structuredClone(value);
beforeEach(() => {
  // Data-router navigation constructs a Node Request with a jsdom signal, which
  // undici refuses. These mocked-HTTP tests exercise router blockers, not fetch
  // cancellation; omit that incompatible signal only in this test file.
  const NativeRequest = globalThis.Request;
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: null });
      }
    },
  );
  library = managed();
  history = revisionsFixture();
  vi.spyOn(api, 'listLibraries').mockImplementation(async () => listFixture(library));
  vi.spyOn(api, 'loadLibrary').mockImplementation(async (key) => ({
    library: key.startsWith('legacy_')
      ? listFixture().legacy.find((l) => l.key === key)!
      : clone(library),
    revisions: key.startsWith('legacy_') ? [] : clone(history),
  }));
  vi.spyOn(api, 'getHistory').mockImplementation(async () => clone(history));
  vi.spyOn(api, 'saveMeta').mockImplementation(async (_key, meta) => {
    library = { ...library, ...meta, draftRevision: library.draftRevision + 1, dirty: true };
    return clone(library);
  });
  vi.spyOn(api, 'saveEntries').mockImplementation(async (_key, entries) => {
    library = {
      ...library,
      draftEntries: clone(entries),
      draftEntryCount: entries.length,
      draftRevision: library.draftRevision + 1,
      dirty: true,
    };
    return clone(library);
  });
  vi.spyOn(api, 'createLibrary').mockImplementation(async (input) => {
    library = managed({
      ...input,
      draftRevision: 1,
      publishedRevision: null,
      assignedTo: [],
      draftEntries: [],
      publishedEntries: [],
      draftEntryCount: 0,
      publishedEntryCount: 0,
    });
    return clone(library);
  });
  vi.spyOn(api, 'validateLibrary').mockResolvedValue({ ok: true, errors: [] });
  vi.spyOn(api, 'previewLibrary').mockImplementation(async () => previewFixture(library));
  vi.spyOn(api, 'publishLibrary').mockImplementation(async () => {
    library = {
      ...library,
      publishedRevision: (library.publishedRevision ?? 0) + 1,
      publishedEntries: clone(library.draftEntries),
      publishedEntryCount: library.draftEntries.length,
      dirty: false,
    };
    history = [
      {
        ...revisionsFixture()[0]!,
        revision: library.publishedRevision!,
        current: true,
        entryCount: library.publishedEntryCount,
      },
      ...history.map((r) => ({ ...r, current: false })),
    ];
    return clone(library);
  });
  vi.spyOn(api, 'rollbackLibrary').mockImplementation(async (_key, revision) => {
    library = {
      ...library,
      draftRevision: library.draftRevision + 1,
      publishedRevision: 3,
      dirty: false,
    };
    history = [
      {
        ...revisionsFixture()[0]!,
        revision: 3,
        current: true,
        source: 'rollback',
        rolledBackFrom: revision,
      },
      ...history.map((r) => ({ ...r, current: false })),
    ];
    return clone(library);
  });
  vi.spyOn(api, 'exportLibrary').mockImplementation(async (_key, kind) => ({
    ...exportFixture(),
    kind,
  }));
  vi.spyOn(api, 'importLibrary').mockImplementation(async (file) => {
    const value = file as api.LibraryExport;
    library = managed({
      ...value.library,
      draftEntries: clone(value.affixes),
      draftEntryCount: value.affixes.length,
      draftRevision: value.library.key === 'shared' ? 6 : 2,
      publishedRevision: value.library.key === 'shared' ? 2 : null,
      publishedEntries: value.library.key === 'shared' ? library.publishedEntries : [],
      publishedEntryCount: value.library.key === 'shared' ? 2 : 0,
      assignedTo: value.library.key === 'shared' ? ['SSR', 'UR'] : [],
    });
    return clone(library);
  });
  const rules = bundleFixture().draft;
  rules.rules.rarities.SSR!.affixes = { mode: 'library', library: 'shared' };
  vi.spyOn(rulesApi, 'getDraft').mockResolvedValue(rules);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAt(path = `${ROOT}/shared`, permissions = ALL, actual = false) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const featureRoutes = routes[0]!
    .children!.find((r) => r.children?.some((c) => c.path === 'admin/equipment'))!
    .children!.filter((r) => r.path?.startsWith('admin/equipment/affix-libraries'))
    .map((r) => ({ ...r, path: `/${r.path}` }));
  const router = createMemoryRouter(
    actual
      ? featureRoutes
      : [
          { path: ROOT, element: <AffixLibrariesPage /> },
          { path: `${ROOT}/new`, element: <AffixLibraryCreatePage /> },
          { path: `${ROOT}/import`, element: <AffixLibraryImportPage /> },
          { path: `${ROOT}/:libraryKey`, element: <AffixLibraryEditorPage /> },
          { path: '/admin/equipment', element: <p>Catalogue destination</p> },
          { path: '/admin/equipment/rarity-rules', element: <p>Rarity Rules destination</p> },
        ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <Suspense fallback={<p>Loading page…</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
async function editor(permissions = ALL) {
  const user = renderAt(`${ROOT}/shared`, permissions);
  if (permissions.includes('equipment.read')) await screen.findByText(/Draft revision 5/);
  return user;
}
async function replace(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  await user.type(input, text);
}
const stale = () =>
  new PortalApiError({
    status: 409,
    code: 'EQUIPMENT_CONFIG_STALE',
    message: 'Someone saved first.',
    details: { expectedRevision: 5, currentRevision: 6 },
  });
async function inspectImport(user: ReturnType<typeof userEvent.setup>, key = 'shared') {
  await screen.findByRole('button', { name: 'Inspect file contents' });
  await user.click(screen.getByLabelText('Library JSON'));
  await user.paste(JSON.stringify(exportFixture(key)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Inspect file contents' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'Inspect file contents' }));
}

describe('library catalogue', () => {
  it('lists managed/legacy source, entry counts, publication state and published assignments', async () => {
    renderAt(ROOT);
    await screen.findByRole('link', { name: 'Shared Names' });
    expect(screen.getByText('Published revision 2')).toBeInTheDocument();
    expect(screen.getByText('3 draft / 2 published')).toBeInTheDocument();
    expect(screen.getByText('SSR, UR')).toBeInTheDocument();
    expect(screen.getByText('Legacy N · read-only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New Affix Library' })).toBeInTheDocument();
  });
  it('searches and filters by source, publication and assignment', async () => {
    const user = renderAt(ROOT);
    await screen.findByRole('link', { name: 'Shared Names' });
    await user.selectOptions(screen.getByLabelText('Library source'), 'legacy');
    expect(screen.queryByRole('link', { name: 'Shared Names' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Library source'), 'managed');
    await user.selectOptions(screen.getByLabelText('Publication status'), 'unpublished');
    expect(screen.getByRole('link', { name: 'Unpublished Names' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Publication status'), 'all');
    await user.selectOptions(screen.getByLabelText('Rarity assignment'), 'UR');
    expect(screen.queryByRole('link', { name: 'Unpublished Names' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search libraries'), 'no match');
    expect(screen.getByText('No libraries match these filters.')).toBeInTheDocument();
  });
  it('supports empty and failed catalogue responses', async () => {
    vi.mocked(api.listLibraries).mockResolvedValue({ managed: [], legacy: [] });
    renderAt(ROOT);
    await screen.findByText('No affix libraries are available.');
    expect(screen.getByText(/No managed libraries yet/)).toBeInTheDocument();
  });
  it('reports catalogue errors with a retry action', async () => {
    vi.mocked(api.listLibraries).mockRejectedValue(new Error('Library service unavailable.'));
    renderAt(ROOT);
    await screen.findByText('Library service unavailable.');
  });
  it('opens shipped libraries without editing, import, export or publication controls', async () => {
    renderAt(`${ROOT}/legacy_n`);
    await screen.findByText('Shipped N affixes');
    expect(screen.getByText('of the Desperate Swings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish library/ })).not.toBeInTheDocument();
    expect(api.getHistory).not.toHaveBeenCalled();
    expect(api.saveEntries).not.toHaveBeenCalled();
    expect(rulesApi.getDraft).not.toHaveBeenCalled();
  });
});

describe('creation and local entry editing', () => {
  it('creates only on explicit submission, starts unpublished and navigates to the editor', async () => {
    const user = renderAt(`${ROOT}/new`);
    expect(api.createLibrary).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Library key'), 'new_names');
    await user.type(screen.getByLabelText('Display name'), 'New Names');
    await user.type(screen.getByLabelText('Description'), 'Prepared library');
    await user.click(screen.getByRole('button', { name: 'Create unpublished library' }));
    await screen.findByText('Unpublished — no active library revision');
    expect(api.createLibrary).toHaveBeenCalledExactlyOnceWith({
      key: 'new_names',
      name: 'New Names',
      description: 'Prepared library',
    });
    expect(api.publishLibrary).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows backend key errors when creating a reserved or invalid library', async () => {
    vi.mocked(api.createLibrary).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_CONFIG_INVALID',
        message: 'Legacy keys are reserved.',
        details: { issues: [{ path: 'key', message: 'Legacy keys are reserved.' }] },
      }),
    );
    const user = renderAt(`${ROOT}/new`);
    await user.type(screen.getByLabelText('Library key'), 'legacy_n');
    await user.type(screen.getByLabelText('Display name'), 'Invalid');
    await user.click(screen.getByRole('button', { name: 'Create unpublished library' }));
    await waitFor(() =>
      expect(screen.getAllByText(/Legacy keys are reserved/).length).toBeGreaterThan(0),
    );
  });
  it('adds entries with exact suffix text and slot eligibility, then saves the complete ordered array', async () => {
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    await user.type(screen.getByLabelText('Affix key'), 'delta');
    await user.type(screen.getByLabelText('Rendered suffix'), 'of Delta');
    await user.click(screen.getByLabelText('Defense'));
    await user.click(screen.getByRole('button', { name: 'Apply local entry' }));
    expect(screen.getByText(/Unsaved local changes/)).toBeInTheDocument();
    expect(api.saveEntries).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await screen.findByText(/Draft revision 6/);
    expect(api.saveEntries).toHaveBeenCalledWith(
      'shared',
      [
        ...managed().draftEntries,
        { key: 'delta', suffix: 'of Delta', slots: ['defense'], enabled: true },
      ],
      5,
    );
    expect(api.publishLibrary).not.toHaveBeenCalled();
  });
  it('edits existing suffixes without renaming the stable key', async () => {
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Edit alpha' }));
    expect(screen.getByLabelText('Affix key')).toHaveAttribute('readonly');
    await replace(user, 'Rendered suffix', 'of Renamed Alpha');
    await user.click(screen.getByLabelText('Health'));
    await user.click(screen.getByRole('button', { name: 'Apply local entry' }));
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await waitFor(() =>
      expect(api.saveEntries).toHaveBeenCalledWith(
        'shared',
        expect.arrayContaining([
          expect.objectContaining({
            key: 'alpha',
            suffix: 'of Renamed Alpha',
            slots: ['attack', 'defense'],
          }),
        ]),
        5,
      ),
    );
  });
  it('duplicates with a new key, toggles enabled state and removes only after confirmation', async () => {
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Duplicate alpha' }));
    expect(screen.getByLabelText('Affix key')).toHaveValue('');
    await user.type(screen.getByLabelText('Affix key'), 'alpha_copy');
    await replace(user, 'Rendered suffix', 'of Alpha Copy');
    await user.click(screen.getByRole('button', { name: 'Apply local entry' }));
    await user.click(screen.getByRole('button', { name: 'Disable alpha_copy' }));
    await user.click(screen.getByRole('button', { name: 'Remove gamma' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Existing owned equipment keeps its suffix snapshot',
    );
    await user.click(screen.getByRole('button', { name: 'Remove from local draft' }));
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await waitFor(() => expect(api.saveEntries).toHaveBeenCalled());
    const entries = vi.mocked(api.saveEntries).mock.calls[0]![1];
    expect(entries.map((e) => e.key)).toEqual(['alpha', 'beta', 'alpha_copy']);
    expect(entries[2]!.enabled).toBe(false);
  });
  it('preserves order when reordering with a filtered view', async () => {
    const user = await editor();
    await user.type(screen.getByLabelText('Search entries'), 'gamma');
    await user.click(screen.getByRole('button', { name: 'Move gamma up' }));
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await waitFor(() => expect(api.saveEntries).toHaveBeenCalled());
    expect(vi.mocked(api.saveEntries).mock.calls[0]![1].map((e) => e.key)).toEqual([
      'alpha',
      'gamma',
      'beta',
    ]);
  });
  it('chains metadata and entry revisions correctly while preserving partial unsaved edits', async () => {
    const user = await editor();
    await replace(user, 'Display name', 'Renamed Names');
    await user.click(screen.getByRole('button', { name: 'Disable alpha' }));
    await user.click(screen.getByRole('button', { name: 'Save metadata' }));
    await screen.findByText(/Draft revision 6/);
    expect(screen.getByText(/Entries: unsaved changes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish library…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await screen.findByText(/Draft revision 7/);
    expect(api.saveMeta).toHaveBeenCalledWith(
      'shared',
      { name: 'Renamed Names', description: 'Test-only library' },
      5,
    );
    expect(api.saveEntries).toHaveBeenCalledWith('shared', expect.any(Array), 6);
  });
  it('preserves unsaved metadata when saving entries first', async () => {
    const user = await editor();
    await replace(user, 'Display name', 'Unsaved Metadata');
    await user.click(screen.getByRole('button', { name: 'Disable alpha' }));
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await screen.findByText(/Draft revision 6/);
    expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved Metadata');
    expect(screen.getByRole('button', { name: 'Save metadata' })).toBeEnabled();
  });

  it('prevents double submission while a metadata save is pending', async () => {
    let finish!: (library: api.ManagedLibrary) => void;
    vi.mocked(api.saveMeta).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = await editor();
    await replace(user, 'Display name', 'Saved Once');
    await user.dblClick(screen.getByRole('button', { name: 'Save metadata' }));
    expect(api.saveMeta).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(managed({ name: 'Saved Once', draftRevision: 6 }));
    });
    await screen.findByText(/Draft revision 6/);
  });
  it('preserves local values on stale save and requires explicit discard/reload', async () => {
    vi.mocked(api.saveMeta).mockRejectedValue(stale());
    const user = await editor();
    await replace(user, 'Display name', 'Local Names');
    await user.click(screen.getByRole('button', { name: 'Save metadata' }));
    await screen.findByText(/This library changed while you were editing/);
    expect(screen.getByLabelText('Display name')).toHaveValue('Local Names');
    expect(api.saveMeta).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reload current draft' }));
    library.draftRevision = 8;
    await user.click(screen.getByRole('button', { name: 'Discard local edits and reload' }));
    await screen.findByText(/Draft revision 8/);
    expect(screen.getByLabelText('Display name')).toHaveValue('Shared Names');
  });
  it('warns before navigating away with unsaved edits and can keep editing', async () => {
    const user = await editor();
    await replace(user, 'Display name', 'Keep These Edits');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Equipment administration' })).getByRole(
        'link',
        { name: 'Rarity Rules' },
      ),
    );
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Keep These Edits');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Equipment administration' })).getByRole(
        'link',
        { name: 'Rarity Rules' },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Discard local changes and leave' }));
    await screen.findByText('Rarity Rules destination');
  });
});

describe('validation, publication and compatibility', () => {
  it('shows published and draft rarity assignments separately and retains snapshot guidance', async () => {
    await editor();
    expect(screen.getByText('Used by (published rules): SSR, UR')).toBeInTheDocument();
    await screen.findByText('Draft rule assignments: SSR');
    expect(
      screen.getByText(/existing owned equipment keeps its displayed name/),
    ).toBeInTheDocument();
  });
  it('shows server namespace conflicts and assigned-library coverage failures', async () => {
    vi.mocked(api.saveEntries).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_CONFIG_INVALID',
        message: 'Affix key is already used by the shipped affix catalogue.',
        details: {
          issues: [
            {
              path: 'entries[0].key',
              message: 'Affix key is already used by the shipped affix catalogue.',
            },
          ],
        },
      }),
    );
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Disable alpha' }));
    await user.click(screen.getByRole('button', { name: 'Save entries' }));
    await waitFor(() =>
      expect(
        screen.getAllByText(/already used by the shipped affix catalogue/).length,
      ).toBeGreaterThan(0),
    );
  });
  it('blocks publication of a saved assigned library missing required slots', async () => {
    vi.mocked(api.previewLibrary).mockResolvedValue({
      ...previewFixture(),
      validation: {
        ok: false,
        errors: [
          {
            path: 'entries',
            message:
              'The published rules draw SSR, UR affixes from this library; keep an enabled affix for Health.',
          },
        ],
      },
    });
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Publish library…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('SSR, UR');
    expect(within(dialog).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
    expect(api.publishLibrary).not.toHaveBeenCalled();
  });
  it('reviews readable entry changes and requires explicit publication confirmation', async () => {
    const user = await editor();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Publish library…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Added 1 · Changed 2 · Removed 0');
    expect(dialog).toHaveTextContent('Disabled');
    expect(dialog).toHaveTextContent('of Original Alpha');
    expect(within(dialog).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm publication' }));
    await screen.findByText(/Library published. Existing owned equipment names are unchanged/);
    expect(api.publishLibrary).toHaveBeenCalledExactlyOnceWith('shared', 5);
    expect(screen.getByText('Published revision 3')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'equipment'] });
  });
  it('does not preview, validate or publish unsaved local changes', async () => {
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Disable alpha' }));
    for (const name of ['Validate saved draft', 'Review Changes', 'Publish library…'])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(api.previewLibrary).not.toHaveBeenCalled();
  });

  it('allows an unassigned empty library to be published when the backend validates it', async () => {
    history = [];
    library = managed({
      assignedTo: [],
      publishedRevision: null,
      publishedEntries: [],
      draftEntries: [],
      draftEntryCount: 0,
      publishedEntryCount: 0,
    });
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Publish library…' }));
    await screen.findByRole('dialog');
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm publication' }));
    await waitFor(() => expect(api.publishLibrary).toHaveBeenCalledWith('shared', 5));
  });

  it('shows metadata, removed-entry and slot-eligibility changes from the backend preview', async () => {
    vi.mocked(api.previewLibrary).mockResolvedValue({
      ...previewFixture(),
      changes: [
        { path: 'name', before: 'Original Name', after: 'Reviewed Name' },
        { path: 'description', before: 'Old description', after: 'New description' },
        {
          path: 'entries',
          before: managed().publishedEntries,
          after: [{ ...managed().publishedEntries[0]!, slots: ['health'] }],
        },
      ],
    });
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Review Changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Original Name → Reviewed Name');
    expect(dialog).toHaveTextContent('Old description → New description');
    expect(dialog).toHaveTextContent('Removed beta');
    expect(dialog).toHaveTextContent('slots Attack, Defense, Health → Health');
  });
  it('rejects a stale review even when the draft revision is unchanged by a remote publication', async () => {
    vi.mocked(api.previewLibrary).mockResolvedValue({ ...previewFixture(), publishedRevision: 3 });
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Review Changes' }));
    await screen.findByText(/This library changed while you were editing/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('handles publication refusal without automatically retrying', async () => {
    vi.mocked(api.publishLibrary).mockRejectedValue(stale());
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Publish library…' }));
    await screen.findByRole('dialog');
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm publication' }));
    await screen.findByText(/This library changed while you were editing/);
    expect(api.publishLibrary).toHaveBeenCalledTimes(1);
  });
  it('confirms rollback with the loaded revision, leaving rarity assignments unchanged', async () => {
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('assignments are revalidated and are not changed');
    expect(screen.getByRole('button', { name: 'Confirm rollback' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await screen.findByText(/Rollback published as a new library revision/);
    expect(api.rollbackLibrary).toHaveBeenCalledWith('shared', 1, 5);
    expect(library.assignedTo).toEqual(['SSR', 'UR']);
  });
  it('shows rollback dependency errors and stale conflicts', async () => {
    vi.mocked(api.rollbackLibrary)
      .mockRejectedValueOnce(
        new PortalApiError({
          status: 400,
          code: 'EQUIPMENT_CONFIG_INVALID',
          message: 'SSR needs a Health entry.',
          details: { issues: [{ path: 'entries', message: 'SSR needs a Health entry.' }] },
        }),
      )
      .mockRejectedValueOnce(stale());
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('SSR needs a Health entry.'),
    );
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm rollback' })).toBeDisabled(),
    );
    expect(api.rollbackLibrary).toHaveBeenCalledTimes(2);
  });

  it('closes a successful rollback before refreshing history so a read failure cannot resubmit it', async () => {
    vi.mocked(api.getHistory).mockRejectedValue(new Error('History refresh unavailable.'));
    const user = await editor();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    await screen.findByText('History refresh unavailable.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.rollbackLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Published revision 3')).toBeInTheDocument();
  });
});

describe('import and export', () => {
  it('inspects a new-library file locally and imports atomically into an unpublished draft', async () => {
    const user = renderAt(`${ROOT}/import`);
    await inspectImport(user, 'new_import');
    expect(api.importLibrary).not.toHaveBeenCalled();
    expect(screen.getByText(/This inspection is not a validation result/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Import to draft only' }));
    await screen.findByText('Imported to draft revision 2');
    expect(api.importLibrary).toHaveBeenCalledWith(exportFixture('new_import'), undefined);
    expect(api.validateLibrary).toHaveBeenCalledWith('new_import');
    expect(api.publishLibrary).not.toHaveBeenCalled();
    expect(screen.getByText(/still unpublished/)).toBeInTheDocument();
  });
  it('requires confirmation and the existing integer revision before replacing a draft', async () => {
    const user = renderAt(`${ROOT}/import?library=shared`);
    await inspectImport(user);
    expect(screen.getByRole('button', { name: 'Import to draft only' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Import to draft only' }));
    await screen.findByText('Imported to draft revision 6');
    expect(api.importLibrary).toHaveBeenCalledWith(exportFixture(), 5);
    expect(screen.getByText(/published revision 2 unchanged/)).toBeInTheDocument();
  });
  it('uploads JSON, rejects syntax errors and delegates invalid-entry validation to the backend', async () => {
    const user = renderAt(`${ROOT}/import`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inspect file contents' })).toBeDisabled(),
    );
    await user.type(screen.getByLabelText('Library JSON'), 'invalid json');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inspect file contents' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Inspect file contents' }));
    expect(api.importLibrary).not.toHaveBeenCalled();
    const file = new File([JSON.stringify(exportFixture())], 'names.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({ ...exportFixture(), affixes: [{ key: 'bad', slots: [], enabled: true }] }),
    });
    await user.upload(screen.getByLabelText('Upload library JSON'), file);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inspect file contents' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Inspect file contents' }));
    await screen.findByText('Invalid / missing suffix');
    vi.mocked(api.importLibrary).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'EQUIPMENT_CONFIG_INVALID',
        message: 'Suffix is required.',
        details: { issues: [{ path: 'entries.0.suffix', message: 'Suffix is required.' }] },
      }),
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Import to draft only' }));
    await waitFor(() =>
      expect(screen.getAllByText(/Suffix is required/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Imported to draft revision/)).not.toBeInTheDocument();
  });
  it('preserves file contents after a stale import and requires reinspection/confirmation', async () => {
    vi.mocked(api.importLibrary).mockRejectedValueOnce(stale());
    const user = renderAt(`${ROOT}/import`);
    await inspectImport(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Import to draft only' }));
    await screen.findByText(/The destination draft changed/);
    expect(screen.getByLabelText('Library JSON')).toHaveValue(JSON.stringify(exportFixture()));
    expect(api.importLibrary).toHaveBeenCalledTimes(1);
    library.draftRevision = 7;
    await user.click(screen.getByRole('button', { name: 'Reload destination revision' }));
    await waitFor(() =>
      expect(screen.getByRole('checkbox')).toHaveAccessibleName(/Replace draft revision 7/),
    );
    expect(screen.getByRole('button', { name: 'Import to draft only' })).toBeDisabled();
  });
  it('blocks imports over legacy keys and imports targeting a different editor library', async () => {
    const user = renderAt(`${ROOT}/import`);
    await inspectImport(user, 'legacy_n');
    expect(screen.getByText(/Import cannot replace a legacy library/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import to draft only' })).not.toBeInTheDocument();
    expect(api.importLibrary).not.toHaveBeenCalled();
  });
  it('exports saved draft and published envelopes rather than unsaved local values', async () => {
    const createUrl = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const user = await editor();
      await replace(user, 'Display name', 'Not Saved');
      await user.click(screen.getByRole('button', { name: 'Export draft' }));
      await user.click(screen.getByRole('button', { name: 'Export published' }));
      expect(api.exportLibrary).toHaveBeenCalledWith('shared', 'draft');
      expect(api.exportLibrary).toHaveBeenCalledWith('shared', 'published');
      expect(api.saveMeta).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revoke;
    }
  });
});

describe('permissions and routes', () => {
  it('keeps read-only users out of every mutation', async () => {
    await editor(['equipment.read']);
    expect(screen.getByLabelText('Display name')).toBeDisabled();
    for (const name of [
      'Add entry',
      'Save entries',
      'Save metadata',
      'Validate saved draft',
      'Publish library…',
      'Roll back to revision 1',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review Changes' })).toBeEnabled();
    expect(
      screen.queryByRole('link', { name: 'Import into this library' }),
    ).not.toBeInTheDocument();
  });
  it('allows read/write draft edits without publish or rollback authority', async () => {
    const user = await editor(['equipment.read', 'equipment.write']);
    await user.click(screen.getByRole('button', { name: 'Disable alpha' }));
    expect(screen.getByRole('button', { name: 'Save entries' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Publish library…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Roll back to revision 1' })).toBeDisabled();
  });
  it('allows read/publish to review and publish without write or validate permission', async () => {
    const user = await editor(['equipment.read', 'equipment.publish']);
    expect(screen.getByRole('button', { name: 'Validate saved draft' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Publish library…' }));
    await screen.findByRole('dialog');
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm publication' }));
    await waitFor(() => expect(api.publishLibrary).toHaveBeenCalled());
    expect(api.saveEntries).not.toHaveBeenCalled();
    expect(api.validateLibrary).not.toHaveBeenCalled();
  });
  it('never fetches library data or assignments for a caller without read permission', async () => {
    renderAt(`${ROOT}/shared`, ['equipment.write', 'equipment.publish']);
    expect(screen.getByRole('alert')).toHaveTextContent('equipment.read is required');
    expect(api.loadLibrary).not.toHaveBeenCalled();
    expect(rulesApi.getDraft).not.toHaveBeenCalled();
  });
  it('orders specific routes before editor keys and gates the sidebar entry on read', async () => {
    expect(NAV_ITEMS.find((i) => i.to === ROOT)?.requiresPermission).toBe('equipment.read');
    const user = renderAt(`${ROOT}/new`, ALL, true);
    expect(await screen.findByRole('heading', { name: 'New Affix Library' })).toBeInTheDocument();
    expect(api.loadLibrary).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Equipment administration' })).getByRole(
        'link',
        { name: 'Affix Libraries' },
      ),
    );
    await screen.findByRole('link', { name: 'Shared Names' });
  });
});
