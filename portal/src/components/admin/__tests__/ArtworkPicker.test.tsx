/**
 * The shared artwork picker, against an in-memory {@link ArtworkSource}.
 *
 * The source double answers like the server does — one folder per call,
 * breadcrumbs and parent included, search over relative paths — so these
 * tests pin the picker's own behaviour: navigation, search, selection,
 * cancel, and the failure states an author can hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ArtworkDirectory, ArtworkFile, ArtworkSource } from '@/api/adminArtwork';
import { PortalApiError } from '@/api/client';

import { ArtworkPickerDialog } from '../ArtworkPicker';

const TREE: Record<string, { dirs: string[]; files: string[] }> = {
  results: { dirs: ['hunt'], files: ['nothing1.webp', 'rarefind.webp'] },
  'results/hunt': { dirs: ['essence', 'waifubux'], files: ['forest-glade.webp'] },
  'results/hunt/waifubux': { dirs: [], files: ['purse-01.webp', 'suspicious-purse-03.webp'] },
  'results/hunt/essence': { dirs: [], files: ['purse-01.webp'] },
};

const file = (folder: string, name: string): ArtworkFile => ({
  name,
  path: `${folder}/${name}`,
  folder,
  extension: 'webp',
});

function listing(path: string): ArtworkDirectory {
  const node = TREE[path];
  if (!node) {
    throw new PortalApiError({
      status: 404,
      code: 'NOT_FOUND',
      message: 'That folder no longer exists.',
    });
  }
  const parts = path.split('/');
  return {
    path,
    parent: parts.length === 1 ? null : parts.slice(0, -1).join('/'),
    breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
    directories: node.dirs.map((d) => ({ name: d, path: `${path}/${d}` })),
    files: node.files.map((f) => file(path, f)),
  };
}

const ALL_FILES = Object.entries(TREE).flatMap(([folder, node]) =>
  node.files.map((f) => file(folder, f)),
);

function makeSource() {
  return {
    scope: 'test',
    browse: vi.fn(async (path: string | undefined) => listing(path ?? 'results')),
    search: vi.fn(async (query: string) => {
      const q = query.toLowerCase();
      const results = ALL_FILES.filter((f) => f.path.toLowerCase().includes(q));
      return { query, results, truncated: false, limit: 100 };
    }),
    loadImage: vi.fn(async (_path: string) => new Blob(['x'])),
  } satisfies ArtworkSource;
}

let source: ReturnType<typeof makeSource>;
let onSelect: ReturnType<typeof vi.fn<(path: string) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  source = makeSource();
  onSelect = vi.fn<(path: string) => void>();
  onClose = vi.fn<() => void>();
  const statics = URL as unknown as {
    createObjectURL?: () => string;
    revokeObjectURL?: () => void;
  };
  statics.createObjectURL = () => 'blob:mock';
  statics.revokeObjectURL = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPicker(selectedPath: string | null = null, open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ArtworkPickerDialog
        open={open}
        onClose={onClose}
        onSelect={onSelect}
        source={source}
        selectedPath={selectedPath}
      />
    </QueryClientProvider>,
  );
}

const grid = () => screen.findByTestId('artwork-grid');
const crumbs = () => within(screen.getByTestId('artwork-breadcrumbs')).getAllByRole('listitem');

describe('browsing', () => {
  it('is closed until opened', () => {
    renderPicker(null, false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(source.browse).not.toHaveBeenCalled();
  });

  it('opens on the top-level folder, folders first, then image cards', async () => {
    renderPicker();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Browse artwork')).toBeInTheDocument();
    const cards = within(await grid()).getAllByRole('button');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Open folder hunt',
      'Use results/nothing1.webp',
      'Use results/rarefind.webp',
    ]);
    expect(source.browse).toHaveBeenCalledWith(undefined, expect.anything());
    expect(crumbs().map((c) => c.textContent)).toEqual(['results']);
    expect(screen.getByRole('button', { name: 'Up one folder' })).toBeDisabled();
  });

  it('shows each image with its name and folder', async () => {
    renderPicker();
    const card = await screen.findByTestId('artwork-file-results/nothing1.webp');
    expect(card).toHaveTextContent('nothing1.webp');
    expect(card).toHaveTextContent('results/');
    expect(await within(card).findByTestId('artwork-thumbnail-image')).toHaveAttribute(
      'alt',
      'nothing1.webp',
    );
    expect(source.loadImage).toHaveBeenCalledWith('results/nothing1.webp');
  });

  it('navigates into folders, up, and back through breadcrumbs', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByRole('button', { name: 'Open folder hunt' }));
    await user.click(await screen.findByRole('button', { name: 'Open folder waifubux' }));
    expect(
      await screen.findByTestId('artwork-file-results/hunt/waifubux/purse-01.webp'),
    ).toBeInTheDocument();
    expect(crumbs().map((c) => c.textContent?.replace('/', '').trim())).toEqual([
      'results',
      'hunt',
      'waifubux',
    ]);

    await user.click(screen.getByRole('button', { name: 'Up one folder' }));
    expect(await screen.findByRole('button', { name: 'Open folder essence' })).toBeInTheDocument();
    expect(source.browse).toHaveBeenLastCalledWith('results/hunt', expect.anything());

    await user.click(
      within(screen.getByTestId('artwork-breadcrumbs')).getByRole('button', { name: 'results' }),
    );
    expect(await screen.findByTestId('artwork-file-results/rarefind.webp')).toBeInTheDocument();
  });

  it('says so when a folder has no artwork', async () => {
    TREE['results/empty'] = { dirs: [], files: [] };
    TREE.results!.dirs.push('empty');
    try {
      const user = userEvent.setup();
      renderPicker();
      await user.click(await screen.findByRole('button', { name: 'Open folder empty' }));
      expect(await screen.findByText('This folder has no artwork.')).toBeInTheDocument();
    } finally {
      delete TREE['results/empty'];
      TREE.results!.dirs.pop();
    }
  });
});

describe('selection', () => {
  it('returns the chosen file’s relative path and closes', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByRole('button', { name: 'Open folder hunt' }));
    await user.click(
      await screen.findByRole('button', { name: 'Use results/hunt/forest-glade.webp' }),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('results/hunt/forest-glade.webp');
    expect(onClose).toHaveBeenCalled();
  });

  it('opens on the current file’s folder and marks it', async () => {
    renderPicker('results/hunt/waifubux/suspicious-purse-03.webp');
    const current = await screen.findByTestId(
      'artwork-file-results/hunt/waifubux/suspicious-purse-03.webp',
    );
    expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(current).toHaveTextContent('Current');
    expect(screen.getByTestId('artwork-file-results/hunt/waifubux/purse-01.webp')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(source.browse).toHaveBeenCalledWith('results/hunt/waifubux', expect.anything());
    expect(screen.getByTestId('artwork-browser-current')).toHaveTextContent(
      'results/hunt/waifubux/suspicious-purse-03.webp',
    );
  });

  it('falls back to the top level when the current file’s folder has gone', async () => {
    renderPicker('results/moved/purse-03.webp');
    expect(await screen.findByTestId('artwork-browser-fallback')).toHaveTextContent(
      'results/moved',
    );
    expect(await screen.findByTestId('artwork-file-results/nothing1.webp')).toBeInTheDocument();
    expect(screen.queryByTestId('artwork-browser-error')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancel closes without choosing', async () => {
    const user = userEvent.setup();
    renderPicker('results/nothing1.webp');
    await grid();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape closes without choosing', async () => {
    const user = userEvent.setup();
    renderPicker();
    await grid();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  it('searches after typing settles and shows result cards with their folders', async () => {
    const user = userEvent.setup();
    renderPicker();
    await grid();
    await user.type(screen.getByLabelText('Search artwork'), 'purse');
    const results = await screen.findByTestId('artwork-search-results');
    const cards = within(results).getAllByRole('button');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Use results/hunt/waifubux/purse-01.webp',
      'Use results/hunt/waifubux/suspicious-purse-03.webp',
      'Use results/hunt/essence/purse-01.webp',
    ]);
    // Duplicate names are told apart by folder.
    expect(cards[0]).toHaveTextContent('results/hunt/waifubux/');
    expect(cards[2]).toHaveTextContent('results/hunt/essence/');
    expect(screen.getByTestId('artwork-search-summary')).toHaveTextContent('3 matches for “purse”');
    // Debounced: one request for the settled text, not one per keystroke.
    expect(source.search).toHaveBeenCalledTimes(1);
    expect(source.search).toHaveBeenCalledWith('purse', expect.anything());
  });

  it('selecting a search result behaves like selecting a browsed file', async () => {
    const user = userEvent.setup();
    renderPicker();
    await grid();
    await user.type(screen.getByLabelText('Search artwork'), 'suspicious');
    await user.click(
      await screen.findByRole('button', {
        name: 'Use results/hunt/waifubux/suspicious-purse-03.webp',
      }),
    );
    expect(onSelect).toHaveBeenCalledWith('results/hunt/waifubux/suspicious-purse-03.webp');
    expect(onClose).toHaveBeenCalled();
  });

  it('says when nothing matches, and when results were truncated', async () => {
    const user = userEvent.setup();
    renderPicker();
    await grid();
    await user.type(screen.getByLabelText('Search artwork'), 'thirstlands');
    expect(await screen.findByTestId('artwork-search-summary')).toHaveTextContent(
      'No artwork matches “thirstlands”',
    );

    source.search.mockResolvedValueOnce({
      query: 'webp',
      results: ALL_FILES.slice(0, 2),
      truncated: true,
      limit: 2,
    });
    await user.clear(screen.getByLabelText('Search artwork'));
    await user.type(screen.getByLabelText('Search artwork'), 'webp');
    expect(await screen.findByTestId('artwork-search-summary')).toHaveTextContent(
      /first 2 matches.*more exist/,
    );
  });

  it('clearing the search returns to the folder that was open', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByRole('button', { name: 'Open folder hunt' }));
    await screen.findByRole('button', { name: 'Open folder essence' });
    await user.type(screen.getByLabelText('Search artwork'), 'purse');
    await screen.findByTestId('artwork-search-results');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByLabelText('Search artwork')).toHaveValue('');
    expect(await screen.findByRole('button', { name: 'Open folder essence' })).toBeInTheDocument();
    expect(screen.queryByTestId('artwork-search-results')).toBeNull();
  });

  it('shows a search failure without losing the browser', async () => {
    source.search.mockRejectedValue(
      new PortalApiError({ status: 500, code: 'INTERNAL', message: 'Something broke.' }),
    );
    const user = userEvent.setup();
    renderPicker();
    await grid();
    await user.type(screen.getByLabelText('Search artwork'), 'purse');
    expect(await screen.findByTestId('artwork-search-error')).toHaveTextContent('Something broke.');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await grid()).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows an API failure and still lets the author go elsewhere', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByRole('button', { name: 'Open folder hunt' }));
    await screen.findByRole('button', { name: 'Open folder essence' });
    source.browse.mockRejectedValueOnce(
      new PortalApiError({ status: 500, code: 'INTERNAL', message: 'Server exploded.' }),
    );
    await user.click(screen.getByRole('button', { name: 'Open folder essence' }));
    const error = await screen.findByTestId('artwork-browser-error');
    expect(error).toHaveTextContent('Server exploded.');
    await user.click(within(error).getByRole('button', { name: 'Go to the top level' }));
    expect(await screen.findByTestId('artwork-file-results/rarefind.webp')).toBeInTheDocument();
  });

  it('explains a permission refusal', async () => {
    source.browse.mockRejectedValue(
      new PortalApiError({ status: 403, code: 'PORTAL_PERMISSION_DENIED', message: 'nope' }),
    );
    renderPicker();
    expect(await screen.findByTestId('artwork-browser-error')).toHaveTextContent(
      'You do not have permission to browse this artwork.',
    );
  });

  it('a broken thumbnail is a placeholder in its own card; the rest still work', async () => {
    source.loadImage.mockImplementation(async (path: string) => {
      if (path === 'results/nothing1.webp') {
        throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'Artwork not found' });
      }
      return new Blob(['x']);
    });
    const user = userEvent.setup();
    renderPicker();
    const broken = await screen.findByTestId('artwork-file-results/nothing1.webp');
    expect(await within(broken).findByTestId('artwork-thumbnail-missing')).toHaveTextContent(
      'Preview unavailable',
    );
    const fine = screen.getByTestId('artwork-file-results/rarefind.webp');
    expect(await within(fine).findByTestId('artwork-thumbnail-image')).toBeInTheDocument();
    // Still selectable, and navigation still works.
    await user.click(broken);
    expect(onSelect).toHaveBeenCalledWith('results/nothing1.webp');
  });
});

describe('lazy thumbnails', () => {
  it('defers loading until a card nears the viewport', async () => {
    const observed: Element[] = [];
    let trigger: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          trigger = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
    try {
      renderPicker();
      const card = await screen.findByTestId('artwork-file-results/nothing1.webp');
      expect(within(card).getByTestId('artwork-thumbnail-deferred')).toBeInTheDocument();
      expect(source.loadImage).not.toHaveBeenCalled();
      expect(observed.length).toBeGreaterThan(0);
      act(() => trigger!([{ isIntersecting: true }]));
      await waitFor(() => expect(source.loadImage).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
