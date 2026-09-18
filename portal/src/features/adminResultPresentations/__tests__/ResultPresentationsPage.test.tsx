/**
 * The Result Presentation Manager.
 *
 * The API module is spied, so these tests pin what the page shows and what it
 * asks the server to do. Canonical rules — which result types exist, their
 * labels, legal artwork modes and defaults — come only from the reference
 * double below, which is the point: the page must not carry its own copy. The
 * double therefore lists all eight keys, including the two added after Phase 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';

import * as api from '@/api/adminResultPresentations';
import type {
  ResultPresentationGroup,
  ResultPresentationReference,
  ResultPresentationVariant,
  ResultPresentationPreview,
} from '@/api/adminResultPresentations';
import type { ArtworkDirectory } from '@/api/adminArtwork';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import { NavList } from '@/components/layout/NavList';
import { routes } from '@/app/router';

import { ResultPresentationsPage } from '../ResultPresentationsPage';

const READ = ['presentations.read'];
const WRITE = ['presentations.read', 'presentations.write'];

const HUNT_KEYS: api.PresentationKeyReference[] = (
  [
    ['hunt.waifubux_find', 'WaifuBux Found', 'Uses the standard WaifuBux result screen.'],
    ['hunt.essence_find', 'Essence Found', 'Uses the standard Essence result screen.'],
    ['hunt.item_find', 'Item Found', 'Uses the standard item result screen.'],
    ['hunt.rare_item_find', 'Rare Item Found', 'Uses the standard rare find screen.'],
    ['hunt.nothing_found', 'Nothing Found', 'Uses a random line from the existing hunt flavor pool.'],
  ] as const
).map(([key, label, fallbackDescription]) => ({
  key,
  label,
  allowedArtworkModes: ['custom', 'none'],
  defaultArtworkMode: 'none',
  fallbackDescription,
  emptyFlavorDescription:
    key === 'hunt.nothing_found'
      ? 'No flavor text: players see a random line from the hunt flavor pool.'
      : 'No flavor text: players see only the standard result lines.',
}));

const REFERENCE: ResultPresentationReference = {
  keys: [
    ...HUNT_KEYS,
    {
      key: 'encounter.released',
      label: 'Waifumon Released',
      allowedArtworkModes: ['encountered', 'custom', 'none'],
      defaultArtworkMode: 'encountered',
      fallbackDescription: "Uses the standard release message and the encountered Waifumon's artwork.",
      emptyFlavorDescription: 'No flavor text: players see the standard release message.',
    },
    {
      key: 'world_encounter.back_to_hunting',
      label: 'Back to Hunting',
      allowedArtworkModes: ['custom', 'none'],
      defaultArtworkMode: 'none',
      fallbackDescription:
        'Uses the standard Back to Hunting screen: the region you are hunting in and your Energy, with the usual Hunt again and Back buttons.',
      emptyFlavorDescription:
        'No flavor text: players see the standard "you pick up the trail" line.',
    },
    {
      key: 'collection.converted_to_essence',
      label: 'Converted to Essence',
      allowedArtworkModes: ['encountered', 'custom', 'none'],
      defaultArtworkMode: 'encountered',
      fallbackDescription:
        "Uses the standard conversion result (her name, the Essence paid and your balance) with the converted Waifumon's artwork.",
      emptyFlavorDescription: 'No flavor text: players see only the standard conversion result.',
    },
  ],
  flavorTextMaxLength: 500,
  maxWeight: 1_000_000,
  supportedArtworkExtensions: ['png', 'webp', 'jpg', 'jpeg', 'gif'],
  previewSpecies: [
    { slug: 'alpha_girl', name: 'Alpha Girl', rarity: 'SR' },
    { slug: 'beta_girl', name: 'Beta Girl', rarity: 'N' },
  ],
  defaultPreviewSpeciesSlug: 'alpha_girl',
  sampleNotice: 'Sample gameplay values are shown below. They are not part of this variant.',
};

let nextId = 1;
function variant(overrides: Partial<ResultPresentationVariant> = {}): ResultPresentationVariant {
  return {
    id: nextId++,
    presentationKey: 'hunt.waifubux_find',
    enabled: true,
    weight: 1,
    flavorText: 'Coins glitter in the grass.',
    artworkMode: 'none',
    artworkPath: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function groupsWith(variants: ResultPresentationVariant[]): ResultPresentationGroup[] {
  return REFERENCE.keys.map((k) => {
    const mine = variants.filter((v) => v.presentationKey === k.key);
    const enabledCount = mine.filter((v) => v.enabled).length;
    return {
      key: k.key,
      label: k.label,
      variantCount: mine.length,
      enabledCount,
      usingFallback: enabledCount === 0,
      variants: mine,
    };
  });
}

function previewFor(request: api.PreviewRequest): ResultPresentationPreview {
  const release = request.variant.presentationKey === 'encounter.released';
  const species = release
    ? (REFERENCE.previewSpecies.find((s) => s.slug === request.previewSpeciesSlug) ?? null)
    : null;
  return {
    key: request.variant.presentationKey,
    label: 'x',
    screen: {
      title: release ? `👋 You let ${species?.name ?? 'her'} go` : '💰 WaifuBux Found',
      sections: [
        ...(request.variant.flavorText
          ? [{ kind: 'flavor' as const, text: request.variant.flavorText, sample: false }]
          : []),
        ...(release ? [] : [{ kind: 'mechanical' as const, text: '+**12** WaifuBux (balance: 1284)', sample: true }]),
      ],
      description: '',
      color: 0xff6fa5,
      footer: release ? null : 'Energy left: 18',
    },
    artwork:
      request.variant.artworkMode === 'custom'
        ? { mode: 'custom', path: request.variant.artworkPath ?? '', status: 'available' }
        : request.variant.artworkMode === 'encountered'
          ? { mode: 'encountered', species, available: true }
          : { mode: 'none' },
    artworkMode: request.variant.artworkMode,
    flavorSource: request.variant.flavorText ? 'authored' : 'none',
    flavorNote: null,
    sampleNotice: REFERENCE.sampleNotice,
    previewSpecies: species,
  };
}

function sessionState(permissions: readonly string[]): SessionState {
  const session: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Author',
    avatarUrl: null,
    permissions,
  };
  return { status: 'ready', session, error: null, configuredPlayerId: undefined, retry: () => {} };
}

function Wrap({ children, permissions, initial = '/admin/result-presentations' }: {
  children: ReactNode;
  permissions: readonly string[];
  initial?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

function renderPage(permissions: readonly string[] = WRITE, initial?: string) {
  return render(
    <Wrap permissions={permissions} {...(initial ? { initial } : {})}>
      <Routes>
        <Route path="/admin/result-presentations" element={<ResultPresentationsPage />} />
      </Routes>
    </Wrap>,
  );
}

let stored: ResultPresentationVariant[] = [];
const spies = {} as {
  list: MockInstance<typeof api.listResultPresentations>;
  create: MockInstance<typeof api.createResultPresentation>;
  update: MockInstance<typeof api.updateResultPresentation>;
  remove: MockInstance<typeof api.deleteResultPresentation>;
  preview: MockInstance<typeof api.previewResultPresentation>;
  browse: MockInstance<typeof api.browseResultPresentationArtwork>;
  search: MockInstance<typeof api.searchResultPresentationArtwork>;
};

/** The picker's view of the server's `results/` tree. */
const PICKER_TREE: Record<string, string[]> = {
  results: ['coins.webp'],
  'results/hunt/waifubux': ['purse-01.webp', 'suspicious-purse-03.webp'],
};

function pickerFolder(path: string): ArtworkDirectory {
  const files = PICKER_TREE[path];
  if (!files) throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'That folder no longer exists.' });
  const parts = path.split('/');
  return {
    path,
    parent: parts.length === 1 ? null : parts.slice(0, -1).join('/'),
    breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
    directories: path === 'results' ? [{ name: 'hunt', path: 'results/hunt' }] : [],
    files: files.map((name) => ({ name, path: `${path}/${name}`, folder: path, extension: 'webp' })),
  };
}

beforeEach(() => {
  stored = [];
  const statics = URL as unknown as { createObjectURL?: () => string; revokeObjectURL?: () => void };
  statics.createObjectURL = () => 'blob:mock';
  statics.revokeObjectURL = () => {};
  vi.spyOn(api, 'getResultPresentationReference').mockResolvedValue(REFERENCE);
  spies.list = vi.spyOn(api, 'listResultPresentations').mockImplementation(async () => ({
    groups: groupsWith(stored),
  }));
  spies.create = vi.spyOn(api, 'createResultPresentation').mockImplementation(async (input) => {
    const created = variant(input);
    stored.push(created);
    return created;
  });
  spies.update = vi.spyOn(api, 'updateResultPresentation').mockImplementation(async (id, patch) => {
    const i = stored.findIndex((v) => v.id === id);
    stored[i] = { ...stored[i]!, ...patch };
    return stored[i]!;
  });
  spies.remove = vi.spyOn(api, 'deleteResultPresentation').mockImplementation(async (id) => {
    stored = stored.filter((v) => v.id !== id);
    return { id, deleted: true };
  });
  spies.preview = vi
    .spyOn(api, 'previewResultPresentation')
    .mockImplementation(async (request) => previewFor(request));
  vi.spyOn(api, 'resultPresentationArtworkBlob').mockResolvedValue(new Blob(['x']));
  spies.browse = vi
    .spyOn(api, 'browseResultPresentationArtwork')
    .mockImplementation(async (path) => pickerFolder(path ?? 'results'));
  spies.search = vi.spyOn(api, 'searchResultPresentationArtwork').mockResolvedValue({
    query: 'purse',
    results: [],
    truncated: false,
    limit: 100,
  });
  vi.spyOn(api, 'resultPresentationSpeciesArtworkBlob').mockResolvedValue(new Blob(['x']));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const card = (key: string) => screen.findByTestId(`result-type-${key}`);

describe('manager overview', () => {
  it('shows every result type the server lists, even with no variants', async () => {
    renderPage();
    for (const k of REFERENCE.keys) {
      const el = await card(k.key);
      expect(el).toHaveTextContent(k.label);
      expect(el).toHaveTextContent('0 variants · Built-in fallback');
      expect(el).toHaveTextContent(k.key);
    }
  });

  it('counts variants and enabled variants per result type', async () => {
    stored = [
      variant(),
      variant(),
      variant(),
      variant({ enabled: false }),
      variant({ presentationKey: 'encounter.released', artworkMode: 'encountered' }),
      variant({ presentationKey: 'encounter.released', artworkMode: 'encountered' }),
    ];
    renderPage();
    expect(await card('hunt.waifubux_find')).toHaveTextContent('4 variants · 3 enabled');
    expect(await card('encounter.released')).toHaveTextContent('2 variants · 2 enabled');
    expect(await card('hunt.nothing_found')).toHaveTextContent('0 variants · Built-in fallback');
  });

  it('includes the two newest result types, driven purely by reference data', async () => {
    renderPage();
    expect(REFERENCE.keys).toHaveLength(8);
    const back = await card('world_encounter.back_to_hunting');
    expect(back).toHaveTextContent('Back to Hunting');
    expect(back).toHaveTextContent('0 variants · Built-in fallback');
    const converted = await card('collection.converted_to_essence');
    expect(converted).toHaveTextContent('Converted to Essence');
    expect(converted).toHaveTextContent('0 variants · Built-in fallback');
  });

  it('explains the built-in fallback, and says when it is active', async () => {
    stored = [variant({ presentationKey: 'hunt.nothing_found', enabled: false })];
    renderPage(WRITE, '/admin/result-presentations?key=hunt.nothing_found');
    const panel = await screen.findByTestId('fallback-panel');
    expect(panel).toHaveTextContent('Uses a random line from the existing hunt flavor pool.');
    expect(within(panel).getByTestId('fallback-active')).toBeInTheDocument();
    expect(await card('hunt.nothing_found')).toHaveTextContent('1 variant · Built-in fallback');
  });

  it('shows the fallback as standby when a variant is enabled', async () => {
    stored = [variant()];
    renderPage();
    const panel = await screen.findByTestId('fallback-panel');
    expect(within(panel).queryByTestId('fallback-active')).toBeNull();
    expect(panel).toHaveTextContent('Used only when no variant is enabled');
  });
});

describe('variant list', () => {
  it('shows state, weight, approximate chance, excerpt and artwork', async () => {
    stored = [
      variant({ weight: 10, flavorText: 'Variant A text' }),
      variant({ weight: 5, flavorText: null, artworkMode: 'custom', artworkPath: 'results/coins.webp' }),
      variant({ weight: 5 }),
      variant({ weight: 99, enabled: false }),
    ];
    renderPage();
    const row1 = await screen.findByTestId('variant-row-1');
    expect(row1).toHaveTextContent('Enabled');
    expect(row1).toHaveTextContent('Weight 10');
    expect(within(row1).getByTestId('variant-chance')).toHaveTextContent('~50%');
    expect(within(row1).getByTestId('variant-excerpt')).toHaveTextContent('Variant A text');
    expect(within(row1).getByTestId('variant-artwork')).toHaveTextContent('No Artwork');

    const row2 = screen.getByTestId('variant-row-2');
    expect(within(row2).getByTestId('variant-chance')).toHaveTextContent('~25%');
    expect(within(row2).getByTestId('variant-excerpt')).toHaveTextContent(
      'No flavor text: players see only the standard result lines.',
    );
    expect(within(row2).getByTestId('variant-artwork')).toHaveTextContent('results/coins.webp');
    expect(await within(row2).findByTestId('presentation-artwork-image')).toBeInTheDocument();
    expect(api.resultPresentationArtworkBlob).toHaveBeenCalledWith('results/coins.webp');

    const row4 = screen.getByTestId('variant-row-4');
    expect(row4).toHaveTextContent('Disabled');
    expect(within(row4).getByTestId('variant-chance')).toHaveTextContent('Disabled');
    // Variants are numbered by position, never by database id.
    expect(row4).toHaveTextContent('Variant 4');
    expect(row4).not.toHaveTextContent(`#${stored[3]!.id}`);
  });

  it('marks encountered artwork without pretending there is a stored image', async () => {
    stored = [variant({ presentationKey: 'encounter.released', artworkMode: 'encountered', flavorText: null })];
    renderPage(WRITE, '/admin/result-presentations?key=encounter.released');
    const row = await screen.findByTestId('variant-row-1');
    expect(within(row).getByTestId('variant-artwork')).toHaveTextContent('Encountered Waifumon artwork');
    expect(within(row).queryByTestId(/presentation-artwork/)).toBeNull();
    expect(within(row).getByTestId('variant-excerpt')).toHaveTextContent(
      'No flavor text: players see the standard release message.',
    );
  });

  it('explains that percentages apply only after the result occurred', async () => {
    renderPage();
    expect(
      await screen.findByText(/apply only after this result type has already occurred/i),
    ).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('enables and disables without opening the editor', async () => {
    stored = [variant(), variant({ enabled: false })];
    const user = userEvent.setup();
    renderPage();
    const row2 = await screen.findByTestId('variant-row-2');
    await user.click(within(row2).getByRole('button', { name: 'Enable' }));
    expect(spies.update).toHaveBeenCalledWith(stored[1]!.id, { enabled: true });

    const row1 = screen.getByTestId('variant-row-1');
    await user.click(within(row1).getByRole('button', { name: 'Disable' }));
    // Not the last enabled one (the other was just enabled): no confirmation.
    await waitFor(() => expect(spies.update).toHaveBeenCalledWith(stored[0]!.id, { enabled: false }));
    expect(screen.queryByTestId('variant-editor')).toBeNull();
  });

  it('confirms before disabling the last enabled variant and says the fallback takes over', async () => {
    stored = [variant({ flavorText: 'Only one' })];
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByTestId('variant-row-1');
    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disable Variant 1?' });
    expect(within(dialog).getByTestId('fallback-warning')).toHaveTextContent(
      'Uses the standard WaifuBux result screen.',
    );
    expect(spies.update).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Disable Variant 1' }));
    await waitFor(() => expect(spies.update).toHaveBeenCalledWith(stored[0]!.id, { enabled: false }));
    expect(await screen.findByTestId('fallback-notice')).toHaveTextContent(
      'WaifuBux Found now uses the built-in fallback',
    );
  });

  it('confirms deletion, naming the variant, and deletes', async () => {
    stored = [variant({ flavorText: 'Keep me' }), variant({ flavorText: 'Delete me please' })];
    const user = userEvent.setup();
    renderPage();
    const row2 = await screen.findByTestId('variant-row-2');
    await user.click(within(row2).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Variant 2?' });
    expect(dialog).toHaveTextContent('Delete me please');
    expect(within(dialog).queryByTestId('fallback-warning')).toBeNull();
    expect(spies.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(spies.remove).not.toHaveBeenCalled();

    const doomedId = stored[1]!.id;
    await user.click(within(row2).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete Variant 2' }));
    await waitFor(() => expect(spies.remove).toHaveBeenCalledWith(doomedId));
    await waitFor(() => expect(screen.queryByText('Delete me please')).toBeNull());
  });

  it('warns when deleting the last enabled variant, and reports the fallback', async () => {
    stored = [variant({ flavorText: 'Last one' })];
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByTestId('variant-row-1');
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(screen.getByTestId('fallback-warning')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Variant 1' }));
    expect(await screen.findByTestId('fallback-notice')).toHaveTextContent('built-in fallback');
    expect(await screen.findByTestId('no-variants')).toBeInTheDocument();
  });
});

describe('editor', () => {
  it('creates a variant under the selected result type', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=hunt.item_find');
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getByTestId('editor-result-type')).toHaveTextContent('Item Found');
    await user.type(within(editor).getByLabelText(/Flavor text/), 'Tangled in brambles.');
    await user.clear(within(editor).getByLabelText('Weight'));
    await user.type(within(editor).getByLabelText('Weight'), '3');
    await user.click(within(editor).getByRole('button', { name: 'Create variant' }));
    await waitFor(() =>
      expect(spies.create).toHaveBeenCalledWith({
        presentationKey: 'hunt.item_find',
        enabled: true,
        weight: 3,
        flavorText: 'Tangled in brambles.',
        artworkMode: 'none',
        artworkPath: null,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('variant-editor')).toBeNull());
  });

  it('edits a variant without sending its result type', async () => {
    stored = [variant({ flavorText: 'Old words', weight: 2 })];
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByTestId('variant-row-1');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByTestId('variant-editor');
    const text = within(editor).getByLabelText(/Flavor text/);
    expect(text).toHaveValue('Old words');
    await user.clear(text);
    await user.type(text, 'New words');
    await user.click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(spies.update).toHaveBeenCalled());
    const [id, patch] = spies.update.mock.calls[0]!;
    expect(id).toBe(stored[0]!.id);
    expect(patch).toEqual({
      enabled: true,
      weight: 2,
      flavorText: 'New words',
      artworkMode: 'none',
      artworkPath: null,
    });
    expect(patch).not.toHaveProperty('presentationKey');
  });

  it('shows the result type as fixed information, not an input', async () => {
    stored = [variant()];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByTestId('variant-row-1')).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getByTestId('editor-result-type')).toHaveTextContent('fixed for this variant');
    expect(within(editor).queryByRole('combobox', { name: /result type/i })).toBeNull();
  });

  it('refuses a non-positive or non-integer weight', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const weight = screen.getByLabelText('Weight');
    for (const bad of ['0', '-2', '1.5', 'x']) {
      await user.clear(weight);
      await user.type(weight, bad);
      expect(screen.getByTestId('editor-local-error')).toHaveTextContent('Weight must be a whole number');
      expect(screen.getByRole('button', { name: 'Create variant' })).toBeDisabled();
    }
    expect(spies.create).not.toHaveBeenCalled();
  });

  it('limits flavor text to the server maximum and counts characters', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const text = screen.getByLabelText(/Flavor text/);
    expect(text).toHaveAttribute('maxLength', '500');
    await user.type(text, 'Hello');
    expect(screen.getByTestId('flavor-counter')).toHaveTextContent('5/500');
    expect(screen.getByText(/added automatically/)).toBeInTheDocument();
  });

  it('offers only the server’s artwork modes: two for a hunt find', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    const radios = within(editor).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual(['Custom Artwork', 'No Artwork']);
    expect(within(editor).getByRole('radio', { name: 'No Artwork' })).toBeChecked();
    expect(within(editor).queryByLabelText('Artwork path')).toBeNull();
  });

  it('offers three modes for a release and defaults a new one to the encountered Waifumon', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=encounter.released');
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'Encountered Waifumon',
      'Custom Artwork',
      'No Artwork',
    ]);
    expect(within(editor).getByRole('radio', { name: 'Encountered Waifumon' })).toBeChecked();
    expect(await within(editor).findByTestId('preview-encountered-note')).toBeInTheDocument();
  });

  it('shows the path field and a live artwork preview only for custom artwork', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    expect(within(editor).getByTestId('editor-local-error')).toHaveTextContent('needs an artwork path');
    expect(await within(editor).findByTestId('preview-waiting')).toBeInTheDocument();
    await user.type(within(editor).getByLabelText('Artwork path'), 'results/coins.webp');
    await waitFor(() =>
      expect(spies.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: expect.objectContaining({ artworkMode: 'custom', artworkPath: 'results/coins.webp' }),
        }),
        expect.anything(),
      ),
    );
    expect(await within(editor).findByTestId('presentation-artwork-image')).toBeInTheDocument();

    await user.click(within(editor).getByRole('radio', { name: 'No Artwork' }));
    expect(within(editor).queryByLabelText('Artwork path')).toBeNull();
  });

  it('shows the server’s path error inline without crashing', async () => {
    spies.preview.mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'bad',
        details: { issues: [{ path: 'artworkPath', message: 'artwork must not contain ".." path segments' }] },
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    await user.type(within(editor).getByLabelText('Artwork path'), '../x.png');
    expect(await within(editor).findByTestId('artwork-path-error')).toHaveTextContent('".." path segments');
    // The mode is left alone — a bad path never silently becomes "No Artwork".
    expect(within(editor).getByRole('radio', { name: 'Custom Artwork' })).toBeChecked();
  });

  it('reports a variant deleted elsewhere instead of recreating it', async () => {
    stored = [variant()];
    spies.update.mockRejectedValue(
      new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'That variant no longer exists.' }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByTestId('variant-row-1')).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
    expect(spies.create).not.toHaveBeenCalled();
  });

  it('shows the chance this form would have among enabled variants', async () => {
    stored = [variant({ weight: 10 })];
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const weight = screen.getByLabelText('Weight');
    await user.clear(weight);
    await user.type(weight, '10');
    expect(screen.getByTestId('editor-chance')).toHaveTextContent('~50% chance among 2 enabled variants');
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    expect(screen.getByTestId('editor-chance')).toHaveTextContent('Disabled');
  });
});

describe('Browse Artwork', () => {
  async function openNewEditor(key?: string) {
    const user = userEvent.setup();
    renderPage(WRITE, key ? `/admin/result-presentations?key=${key}` : undefined);
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    return { user, editor: screen.getByTestId('variant-editor') };
  }

  it('is offered only for Custom Artwork', async () => {
    const { user, editor } = await openNewEditor();
    expect(within(editor).queryByRole('button', { name: 'Browse Artwork' })).toBeNull();
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    expect(within(editor).getByRole('button', { name: 'Browse Artwork' })).toBeInTheDocument();
    await user.click(within(editor).getByRole('radio', { name: 'No Artwork' }));
    expect(within(editor).queryByRole('button', { name: 'Browse Artwork' })).toBeNull();
  });

  it('is not offered for the encountered Waifumon', async () => {
    const { user, editor } = await openNewEditor('encounter.released');
    expect(within(editor).getByRole('radio', { name: 'Encountered Waifumon' })).toBeChecked();
    expect(within(editor).queryByRole('button', { name: 'Browse Artwork' })).toBeNull();
    // The preview Waifumon selector is separate and still there.
    expect(within(editor).getByRole('combobox', { name: 'Preview Waifumon' })).toBeInTheDocument();
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    expect(within(editor).getByRole('button', { name: 'Browse Artwork' })).toBeInTheDocument();
  });

  it.each(REFERENCE.keys.filter((k) => k.allowedArtworkModes.includes('custom')).map((k) => k.key))(
    'is offered for every key the reference allows custom artwork on: %s',
    async (key) => {
      const { user, editor } = await openNewEditor(key);
      await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
      expect(within(editor).getByRole('button', { name: 'Browse Artwork' })).toBeInTheDocument();
    },
  );

  it('selecting a file fills the path, updates the previews and saves nothing', async () => {
    {
      const { user, editor } = await openNewEditor();
      await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
      await user.click(within(editor).getByRole('button', { name: 'Browse Artwork' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(await within(dialog).findByRole('button', { name: 'Use results/coins.webp' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(within(editor).getByLabelText('Artwork path')).toHaveValue('results/coins.webp');
      // The existing artwork preview loads the picked file…
      expect(await within(editor).findByTestId('presentation-artwork-image')).toBeInTheDocument();
      expect(api.resultPresentationArtworkBlob).toHaveBeenCalledWith('results/coins.webp');
      // …and the unsaved-variant preview is asked about it.
      await waitFor(() =>
        expect(spies.preview).toHaveBeenLastCalledWith(
          expect.objectContaining({
            variant: expect.objectContaining({ artworkMode: 'custom', artworkPath: 'results/coins.webp' }),
          }),
          expect.anything(),
        ),
      );
      expect(spies.create).not.toHaveBeenCalled();
      expect(spies.update).not.toHaveBeenCalled();
    }
  });

  it('opens on the folder of the existing path and marks the file', async () => {
    stored = [
      variant({ artworkMode: 'custom', artworkPath: 'results/hunt/waifubux/suspicious-purse-03.webp' }),
    ];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByTestId('variant-row-1')).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Browse Artwork' }));
    const current = await screen.findByTestId('artwork-file-results/hunt/waifubux/suspicious-purse-03.webp');
    expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(spies.browse).toHaveBeenCalledWith('results/hunt/waifubux', expect.anything());
  });

  it('keeps a moved file’s path until the author picks something, and cancelling changes nothing', async () => {
    stored = [variant({ artworkMode: 'custom', artworkPath: 'results/old/gone.webp' })];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByTestId('variant-row-1')).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Browse Artwork' }));
    expect(await screen.findByTestId('artwork-browser-fallback')).toHaveTextContent('results/old');
    expect(await screen.findByTestId('artwork-file-results/coins.webp')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Artwork path')).toHaveValue('results/old/gone.webp');
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('manual path entry still works alongside the browser', async () => {
    const { user, editor } = await openNewEditor();
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    await user.type(within(editor).getByLabelText('Artwork path'), 'results/typed.webp');
    expect(within(editor).getByLabelText('Artwork path')).toHaveValue('results/typed.webp');
    expect(spies.browse).not.toHaveBeenCalled();
  });

  it('saving a picked path is an ordinary save (presentations.write)', async () => {
    const { user, editor } = await openNewEditor();
    await user.click(within(editor).getByRole('radio', { name: 'Custom Artwork' }));
    await user.click(within(editor).getByRole('button', { name: 'Browse Artwork' }));
    await user.click(await screen.findByRole('button', { name: 'Use results/coins.webp' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(editor).getByRole('button', { name: 'Create variant' }));
    await waitFor(() =>
      expect(spies.create).toHaveBeenCalledWith(
        expect.objectContaining({ artworkMode: 'custom', artworkPath: 'results/coins.webp' }),
      ),
    );
  });
});

describe('the two newest result types', () => {
  it('offers Back to Hunting only custom/no artwork, defaulting to none', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=world_encounter.back_to_hunting');
    expect(await screen.findByTestId('fallback-panel')).toHaveTextContent(
      'the region you are hunting in and your Energy',
    );
    await user.click(screen.getByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(
      ['Custom Artwork', 'No Artwork'],
    );
    expect(within(editor).getByRole('radio', { name: 'No Artwork' })).toBeChecked();
    // No Waifumon on this screen, so no preview picker either.
    expect(within(editor).queryByRole('combobox', { name: 'Preview Waifumon' })).toBeNull();
  });

  it('offers a conversion her artwork by default, with the preview picker', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=collection.converted_to_essence');
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(
      ['Encountered Waifumon', 'Custom Artwork', 'No Artwork'],
    );
    expect(within(editor).getByRole('radio', { name: 'Encountered Waifumon' })).toBeChecked();
    expect(within(editor).getByRole('combobox', { name: 'Preview Waifumon' })).toHaveValue(
      'alpha_girl',
    );
    await waitFor(() =>
      expect(spies.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: expect.objectContaining({ presentationKey: 'collection.converted_to_essence' }),
          previewSpeciesSlug: 'alpha_girl',
        }),
        expect.anything(),
      ),
    );

    // The preview selection is never part of what gets saved.
    await user.click(within(editor).getByRole('button', { name: 'Create variant' }));
    await waitFor(() => expect(spies.create).toHaveBeenCalled());
    expect(spies.create.mock.calls[0]![0]).toEqual({
      presentationKey: 'collection.converted_to_essence',
      enabled: true,
      weight: 1,
      flavorText: null,
      artworkMode: 'encountered',
      artworkPath: null,
    });
  });

  it('creates a Back to Hunting variant with authored prose only', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=world_encounter.back_to_hunting');
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    await user.type(screen.getByLabelText(/Flavor text/), 'The trail is warm again.');
    await user.click(screen.getByRole('button', { name: 'Create variant' }));
    await waitFor(() =>
      expect(spies.create).toHaveBeenCalledWith({
        presentationKey: 'world_encounter.back_to_hunting',
        enabled: true,
        weight: 1,
        flavorText: 'The trail is warm again.',
        artworkMode: 'none',
        artworkPath: null,
      }),
    );
  });
});

describe('live preview', () => {
  it('updates from unsaved changes and never saves', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const editor = screen.getByTestId('variant-editor');
    await user.type(within(editor).getByLabelText(/Flavor text/), 'Fresh words');
    await waitFor(() =>
      expect(within(editor).getByTestId('preview-flavor')).toHaveTextContent('Fresh words'),
    );
    expect(spies.preview).toHaveBeenLastCalledWith(
      {
        variant: {
          presentationKey: 'hunt.waifubux_find',
          flavorText: 'Fresh words',
          artworkMode: 'none',
          artworkPath: null,
        },
      },
      expect.anything(),
    );
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('marks gameplay values as sample data', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    expect(await screen.findByTestId('preview-sample-notice')).toHaveTextContent(
      'Sample gameplay values are shown below. They are not part of this variant.',
    );
    expect(await screen.findByTestId('preview-sample-section')).toHaveTextContent('Sample');
    expect(screen.getByTestId('preview-footer')).toHaveTextContent('Energy left: 18');
    // No working controls inside the preview.
    expect(within(screen.getByTestId('presentation-preview')).queryByRole('button')).toBeNull();
  });

  it('lets a release preview pick a Waifumon, used only for the preview', async () => {
    const user = userEvent.setup();
    renderPage(WRITE, '/admin/result-presentations?key=encounter.released');
    await user.click(await screen.findByRole('button', { name: 'New variant' }));
    const select = screen.getByRole('combobox', { name: 'Preview Waifumon' });
    expect(select).toHaveValue('alpha_girl');
    await waitFor(() =>
      expect(spies.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ previewSpeciesSlug: 'alpha_girl' }),
        expect.anything(),
      ),
    );
    expect(await screen.findByTestId('preview-waifumon-artwork-image')).toBeInTheDocument();

    await user.selectOptions(select, 'beta_girl');
    await waitFor(() => expect(screen.getByTestId('preview-title')).toHaveTextContent('You let Beta Girl go'));
    expect(api.resultPresentationSpeciesArtworkBlob).toHaveBeenLastCalledWith('beta_girl');

    await user.click(screen.getByRole('button', { name: 'Create variant' }));
    await waitFor(() => expect(spies.create).toHaveBeenCalled());
    const saved = spies.create.mock.calls[0]![0];
    expect(saved).not.toHaveProperty('previewSpeciesSlug');
    expect(JSON.stringify(saved)).not.toContain('beta_girl');
  });
});

describe('authorization in the UI', () => {
  it('read-only authors see no write controls and a read-only editor', async () => {
    stored = [variant()];
    const user = userEvent.setup();
    renderPage(READ);
    const row = await screen.findByTestId('variant-row-1');
    expect(screen.queryByRole('button', { name: 'New variant' })).toBeNull();
    expect(within(row).queryByRole('button', { name: /Disable|Enable|Delete/ })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'View' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).queryByRole('button', { name: /Save|Create/ })).toBeNull();
    expect(within(editor).getByLabelText(/Flavor text/)).toBeDisabled();
  });

  it('read-only authors cannot open the picker on a field they cannot change', async () => {
    stored = [variant({ artworkMode: 'custom', artworkPath: 'results/coins.webp' })];
    const user = userEvent.setup();
    renderPage(READ);
    await user.click(within(await screen.findByTestId('variant-row-1')).getByRole('button', { name: 'View' }));
    const editor = screen.getByTestId('variant-editor');
    expect(within(editor).getByLabelText('Artwork path')).toBeDisabled();
    expect(within(editor).queryByRole('button', { name: 'Browse Artwork' })).toBeNull();
    expect(spies.browse).not.toHaveBeenCalled();
  });

  it('hides the navigation entry without presentations.read', () => {
    const { unmount } = render(
      <Wrap permissions={['admin.access', 'encounters.read', 'encounters.write']}>
        <NavList />
      </Wrap>,
    );
    expect(screen.queryByRole('link', { name: /Result Presentations/ })).toBeNull();
    unmount();
    render(
      <Wrap permissions={READ}>
        <NavList />
      </Wrap>,
    );
    expect(screen.getByRole('link', { name: /Result Presentations/ })).toHaveAttribute(
      'href',
      '/admin/result-presentations',
    );
  });

  it('guards the route on presentations.read', () => {
    const findRoute = (list: typeof routes): (typeof routes)[number] | undefined => {
      for (const r of list) {
        if (r.path === 'admin/result-presentations') return r;
        const nested = r.children ? findRoute(r.children) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const route = findRoute(routes);
    expect(route).toBeDefined();
    render(
      <Wrap permissions={['admin.access', 'encounters.read', 'encounters.publish']}>
        {route!.element}
      </Wrap>,
    );
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(api.getResultPresentationReference).not.toHaveBeenCalled();
  });
});
