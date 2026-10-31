/**
 * Enemy packages with artwork (Content Portability CP-3) in the Portal: the
 * list's selection and package export, and the import page's review —
 * outcomes in words, activation overrides, artwork reuse/add, an explicit
 * Update/Keep decision per changed enemy, Apply Import and its confirmation,
 * the receipt, refusals and an unsafe package's issues.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import * as dungeonApi from '@/api/adminDungeons';
import * as api from '@/api/adminEnemies';
import type { EnemyImportEntry, EnemyImportPreview, EnemyImportResult } from '@/api/adminEnemies';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

import { EnemiesListPage } from '../EnemiesListPage';
import { EnemyImportPage } from '../EnemyImportPage';
import { enemyDetailFixture } from './enemyFixtures';

const ALL = ['enemies.read', 'enemies.write', 'artwork.read', 'artwork.write', 'dungeons.read'];

function renderAt(path: string, permissions = ALL) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(
    <Routes>
      <Route path="/admin/enemies" element={<EnemiesListPage />} />
      <Route path="/admin/enemies/import" element={<EnemyImportPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

beforeEach(() => {
  stubObjectUrls();
  vi.spyOn(dungeonApi, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
  vi.spyOn(artworkApi, 'artworkAssetBlob').mockImplementation(async () => new Blob(['asset']));
  vi.spyOn(api, 'listEnemies').mockResolvedValue({
    enemies: [
      enemyDetailFixture({ key: 'scrapyard_drone', name: 'Scrapyard Drone' }),
      enemyDetailFixture({ key: 'alley_bruiser', name: 'Alley Bruiser', enabled: false }),
      enemyDetailFixture({ key: 'rust_hound', name: 'Rust Hound' }),
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('exporting a package from the list', () => {
  it('exports everything, or exactly the ticked enemies, and downloads the zip', async () => {
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    const spy = vi
      .spyOn(api, 'exportEnemyPackage')
      .mockResolvedValue({ blob: new Blob(['zip']), filename: 'enemies-selected-20261029-120000.zip' });
    const user = renderAt('/admin/enemies');
    await screen.findAllByTestId('enemy-row');
    expect(screen.queryByRole('button', { name: /selected with artwork/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Rust Hound' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Alley Bruiser' }));
    await user.click(screen.getByRole('button', { name: 'Export 2 selected with artwork' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ scope: 'selected', keys: ['alley_bruiser', 'rust_hound'] }));
    expect(await screen.findByTestId('enemy-package-notice')).toHaveTextContent('enemies-selected-20261029-120000.zip');
    expect(downloaded).toBe('enemies-selected-20261029-120000.zip');

    await user.click(screen.getByRole('button', { name: 'Export all with artwork' }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ scope: 'all' }));
  });

  it('shows why an export was refused, enemy by enemy', async () => {
    vi.spyOn(api, 'exportEnemyPackage').mockRejectedValue(
      new PortalApiError({
        status: 422,
        code: 'ENEMY_EXPORT_REFUSED',
        message: 'Some enemies need artwork that cannot be packaged from this server, so nothing was exported.',
        details: { reason: 'artwork_unavailable', issues: [{ path: 'rust_hound.artwork', message: 'shipped full artwork x.webp is missing on this server' }] },
      }),
    );
    const user = renderAt('/admin/enemies');
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Export all with artwork' }));
    const error = await screen.findByTestId('enemy-package-error');
    expect(error).toHaveTextContent('rust_hound.artwork');
    expect(error).toHaveTextContent('missing on this server');
  });

  it('offers package export only with artwork access, and import only with write access', async () => {
    renderAt('/admin/enemies', ['enemies.read']);
    await screen.findAllByTestId('enemy-row');
    expect(screen.queryByRole('button', { name: 'Export all with artwork' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^Select / })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import package' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });
});

const slot = (kind: 'create' | 'reuse' | 'none' | 'shipped_file', notes: string[] = []) => ({
  source: kind === 'none' ? ('none' as const) : ('managed' as const),
  destination:
    kind === 'create'
      ? ({ kind: 'create', asset: 'asset-001' } as const)
      : kind === 'reuse'
        ? ({ kind: 'reuse', asset: 'asset-002', assetId: 'b-asset-1' } as const)
        : kind === 'shipped_file'
          ? ({ kind: 'shipped_file', path: 'combat/x.webp' } as const)
          : ({ kind: 'none' } as const),
  notes,
});
const entry = (over: Partial<EnemyImportEntry> & { key: string; name: string; outcome: EnemyImportEntry['outcome'] }): EnemyImportEntry => ({
  changedFields: [],
  activation: null,
  references: [],
  issues: [],
  artwork: slot('create'),
  sprite: slot('reuse'),
  ...over,
});
const PREVIEW: EnemyImportPreview = {
  package: {
    format: 'waifumon-enemy-package',
    version: 1,
    exportedAt: '2026-10-29T12:00:00.000Z',
    scope: 'selected',
    sourceEnvironment: 'staging',
    packageHash: 'abc',
    warnings: [],
  },
  entries: [
    entry({
      key: 'new_one',
      name: 'New One',
      outcome: 'create',
      activation: { packageEnabled: true, enabled: false, reason: 'new_enemies_start_disabled' },
      artwork: slot('create', ['combat/new_one.webp is not on this server; the packaged copy is used as managed artwork']),
    }),
    entry({ key: 'tuned', name: 'Tuned', outcome: 'update', changedFields: ['attack', 'spriteAssetId'] }),
    entry({
      key: 'guard',
      name: 'Guard',
      outcome: 'conflict',
      changedFields: ['hp'],
      references: [{ kind: 'dungeon_zone', key: 'hall', name: 'The Hall', usage: 'room "Hall"' }],
      activation: { packageEnabled: false, enabled: true, reason: 'existing_status_kept' },
    }),
    entry({ key: 'same', name: 'Same', outcome: 'unchanged', artwork: slot('none'), sprite: slot('shipped_file') }),
  ],
  assets: [
    { id: 'asset-001', file: 'artwork/asset-001.webp', category: 'enemy_art', sha256: 'a'.repeat(64), bytes: 2048, mimeType: 'image/webp', width: 64, height: 48, name: 'x', action: 'create', reuse: [], usedBy: [{ key: 'new_one', slot: 'artwork' }] },
    { id: 'asset-002', file: 'artwork/asset-002.png', category: 'enemy_sprite', sha256: 'b'.repeat(64), bytes: 1024, mimeType: 'image/png', width: 32, height: 32, name: 'y', action: 'reuse', reuse: ['b-asset-1'], usedBy: [{ key: 'tuned', slot: 'sprite' }] },
  ],
  counts: { create: 1, update: 1, conflict: 1, unchanged: 1, invalid: 0 },
  decisionKeys: ['guard', 'tuned'],
  ok: true,
  planHash: 'sha256:plan',
};
const zipFile = () => new File(['PK'], 'enemies.zip', { type: 'application/zip' });
const applyAndConfirm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Apply Import' }));
  await user.click(within(await screen.findByTestId('enemy-import-confirm')).getByRole('button', { name: 'Confirm import' }));
};

describe('importing a package', () => {
  it('reviews in plain words, requires a decision per changed enemy, and applies exactly the previewed plan', async () => {
    const previewSpy = vi.spyOn(api, 'previewEnemyPackage').mockResolvedValue(PREVIEW);
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue({
      importId: 9,
      requestId: 'r',
      replayed: false,
      created: ['new_one'],
      updated: ['guard'],
      skipped: ['tuned'],
      unchanged: ['same'],
      assets: { created: [{ asset: 'asset-001', assetId: 'new-id', category: 'enemy_art' }], reused: [{ asset: 'asset-002', assetId: 'b-asset-1' }] },
    });
    const user = renderAt('/admin/enemies/import');
    await user.upload(await screen.findByLabelText('Enemy package file'), zipFile());
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));

    const preview = await screen.findByTestId('enemy-import-preview');
    expect(within(preview).getByTestId('enemy-import-counts')).toHaveTextContent('1 new · 2 changed · 1 unchanged');
    expect(preview).toHaveTextContent('Images: 1 to add, 1 already here.');
    const rows = within(preview).getAllByTestId('enemy-import-entry');
    expect(rows[0]).toHaveTextContent('Full artwork: new image added');
    expect(rows[0]).toHaveTextContent('the packaged copy is used as managed artwork');
    expect(rows[0]).toHaveTextContent('Enabled in the package, but new enemies arrive disabled.');
    expect(rows[1]).toHaveTextContent('Changes attack, sprite.');
    expect(rows[1]).toHaveTextContent('Sprite: uses an image this server already has');
    expect(within(rows[2]!).getByTestId('enemy-import-conflict')).toHaveTextContent('Used here by The Hall');
    expect(rows[2]).toHaveTextContent('Stays enabled here');
    expect(rows[3]).toHaveTextContent('Sprite: already on this server');

    // No import until every changed enemy has a decision — and the page says which.
    const undecided = within(preview).getByTestId('enemy-import-undecided');
    expect(undecided).toHaveTextContent('2 enemies');
    expect(undecided).toHaveTextContent('Guard, Tuned');
    expect(within(preview).getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Keep Existing Tuned' }));
    await user.click(screen.getByRole('radio', { name: 'Update Guard' }));
    expect(within(preview).getByTestId('enemy-import-ready')).toHaveTextContent('1 new, 1 updated, 1 kept, 1 unchanged');
    expect(applySpy).not.toHaveBeenCalled();
    await user.click(within(preview).getByRole('button', { name: 'Apply Import' }));

    // Applying needs an explicit confirmation of what is about to happen.
    const confirm = await screen.findByTestId('enemy-import-confirm');
    expect(confirm).toHaveTextContent('1 new, arriving disabled');
    expect(confirm).toHaveTextContent('1 updated, keeping their enabled state: Guard');
    expect(confirm).toHaveTextContent('1 kept as they are: Tuned');
    expect(confirm).toHaveTextContent('1 image added');
    expect(applySpy).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Confirm import' }));

    // Decisions follow `decisionKeys` order: guard (update), tuned (keep).
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    const [, request] = applySpy.mock.calls[0]!;
    expect(request).toMatchObject({ expectedPlanHash: 'sha256:plan', decisions: 'us' });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const result = await screen.findByTestId('enemy-import-result');
    expect(result).toHaveTextContent('1 new, 1 updated, 1 kept as they were, 1 unchanged');
    expect(result).toHaveTextContent('Images: 1 added, 1 reused.');
    expect(within(result).getByRole('link', { name: 'new_one' })).toHaveAttribute('href', '/admin/enemies/new_one');
  });

  it('a stale apply imports nothing and offers a fresh check', async () => {
    const previewSpy = vi.spyOn(api, 'previewEnemyPackage').mockResolvedValue({ ...PREVIEW, decisionKeys: [], entries: [PREVIEW.entries[0]!], counts: { create: 1, update: 0, conflict: 0, unchanged: 0, invalid: 0 } });
    vi.spyOn(api, 'applyEnemyPackage').mockRejectedValue(new PortalApiError({ status: 409, code: 'ENEMY_IMPORT_STALE', message: 'stale' }));
    const user = renderAt('/admin/enemies/import');
    await user.upload(await screen.findByLabelText('Enemy package file'), zipFile());
    await applyAndConfirm(user);
    const stale = await screen.findByTestId('enemy-import-stale');
    expect(stale).toHaveTextContent('nothing was imported');
    // That plan can only be refused again, so the action waits for the fresh check.
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    expect(screen.queryByTestId('enemy-import-ready')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));
  });

  it('lists why an unsafe or broken package was refused', async () => {
    vi.spyOn(api, 'previewEnemyPackage').mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'ENEMY_PACKAGE_INVALID',
        message: 'bad',
        details: { issues: [{ path: 'archive', message: 'entry "../evil" has a ".." path segment' }] },
      }),
    );
    const user = renderAt('/admin/enemies/import');
    await user.upload(await screen.findByLabelText('Enemy package file'), zipFile());
    expect(await screen.findByTestId('package-issues')).toHaveTextContent('".." path segment');
    expect(screen.queryByTestId('enemy-import-preview')).not.toBeInTheDocument();
  });

  it('a package with an invalid enemy cannot be imported', async () => {
    vi.spyOn(api, 'previewEnemyPackage').mockResolvedValue({
      ...PREVIEW,
      ok: false,
      decisionKeys: [],
      entries: [entry({ key: 'new', name: 'Reserved', outcome: 'invalid', issues: [{ path: 'new', message: '"new" is a reserved key and cannot be created' }] })],
      counts: { create: 0, update: 0, conflict: 0, unchanged: 0, invalid: 1 },
    });
    const user = renderAt('/admin/enemies/import');
    await user.upload(await screen.findByLabelText('Enemy package file'), zipFile());
    expect(await screen.findByTestId('enemy-import-refused')).toBeInTheDocument();
    expect(screen.getByText('"new" is a reserved key and cannot be created')).toBeInTheDocument();
    expect(screen.getByTestId('enemy-import-refused')).toHaveTextContent('Reserved');
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
  });

  const RECEIPT: EnemyImportResult = {
    importId: 1,
    requestId: 'r',
    replayed: false,
    created: [],
    updated: [],
    skipped: [],
    unchanged: [],
    assets: { created: [], reused: [] },
  };
  /** A preview of just these entries, with counts and decision keys the server would send. */
  const planOf = (...entries: EnemyImportEntry[]): EnemyImportPreview => {
    const counts = { create: 0, update: 0, conflict: 0, unchanged: 0, invalid: 0 };
    for (const e of entries) counts[e.outcome] += 1;
    return {
      ...PREVIEW,
      entries,
      counts,
      ok: counts.invalid === 0,
      decisionKeys: entries.filter((e) => e.outcome === 'update' || e.outcome === 'conflict').map((e) => e.key).sort(),
    };
  };
  const NEW = PREVIEW.entries[0]!;
  const TUNED = PREVIEW.entries[1]!;
  const GUARD = PREVIEW.entries[2]!;
  const SAME = PREVIEW.entries[3]!;
  const reviewOf = async (plan: EnemyImportPreview, permissions = ALL) => {
    vi.spyOn(api, 'previewEnemyPackage').mockResolvedValue(plan);
    const user = renderAt('/admin/enemies/import', permissions);
    await user.upload(await screen.findByLabelText('Enemy package file'), zipFile());
    await screen.findByTestId('enemy-import-preview');
    return user;
  };

  it('an all-new package has nothing to decide, and applies with no decisions', async () => {
    const user = await reviewOf(planOf(NEW));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue({ ...RECEIPT, created: ['new_one'] });
    expect(screen.queryByTestId('enemy-import-undecided')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeEnabled();
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0]![1]).toMatchObject({ expectedPlanHash: 'sha256:plan', decisions: '' });
    expect(await screen.findByTestId('enemy-import-result')).toHaveTextContent('1 new, 0 updated');
  });

  it('one unresolved conflict names exactly that enemy and keeps Apply disabled, whatever else is decided', async () => {
    const user = await reviewOf(planOf(NEW, TUNED, GUARD, SAME));
    await user.click(screen.getByRole('radio', { name: 'Update Tuned' }));
    const undecided = screen.getByTestId('enemy-import-undecided');
    expect(undecided).toHaveTextContent('1 enemy before applying: Guard.');
    expect(undecided).not.toHaveTextContent('Tuned');
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    expect(screen.getAllByText('Decision needed')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Go to next decision' }));
    expect(screen.getByRole('radio', { name: 'Update Guard' })).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Keep Existing Guard' }));
    expect(screen.queryByText('Decision needed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Go to next decision' })).not.toBeInTheDocument();
  });

  it.each([
    ['Update', 'u'],
    ['Keep Existing', 's'],
  ])('%s sends its decision', async (choice, sent) => {
    const user = await reviewOf(planOf(GUARD));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue(RECEIPT);
    await user.click(screen.getByRole('radio', { name: `${choice} Guard` }));
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0]![1].decisions).toBe(sent);
  });

  // The staging dead end: every conflict kept and nothing new used to mean no action at all.
  it('keeping every conflict still applies, and the receipt says what was kept', async () => {
    const user = await reviewOf(planOf(TUNED, GUARD, SAME));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue({ ...RECEIPT, skipped: ['guard', 'tuned'], unchanged: ['same'] });
    await user.click(screen.getByRole('radio', { name: 'Keep Existing Tuned' }));
    await user.click(screen.getByRole('radio', { name: 'Keep Existing Guard' }));
    expect(screen.getByTestId('enemy-import-nothing')).toHaveTextContent('no enemy will change. 2 kept, 1 unchanged');
    await user.click(screen.getByRole('button', { name: 'Apply Import' }));
    const confirm = await screen.findByTestId('enemy-import-confirm');
    expect(confirm).toHaveTextContent('No enemy will change');
    // Their new artwork stays out of the count: only written enemies add images.
    expect(confirm).not.toHaveTextContent('added');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0]![1].decisions).toBe('ss');
    const result = await screen.findByTestId('enemy-import-result');
    expect(result).toHaveTextContent('0 new, 0 updated, 2 kept as they were, 1 unchanged');
    expect(within(result).getByTestId('enemy-import-kept')).toHaveTextContent('guard, tuned');
  });

  it('a package identical to this server still completes', async () => {
    const user = await reviewOf(planOf(SAME));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue({ ...RECEIPT, unchanged: ['same'] });
    expect(screen.getByTestId('enemy-import-nothing')).toBeInTheDocument();
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('enemy-import-result')).toHaveTextContent('1 unchanged');
  });

  it('cancelling the confirmation applies nothing and keeps the decisions', async () => {
    const user = await reviewOf(planOf(GUARD));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage');
    await user.click(screen.getByRole('radio', { name: 'Update Guard' }));
    await user.click(screen.getByRole('button', { name: 'Apply Import' }));
    await user.click(within(await screen.findByTestId('enemy-import-confirm')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('enemy-import-confirm')).not.toBeInTheDocument());
    expect(applySpy).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Update Guard' })).toBeChecked();
  });

  it('a double click on Confirm submits once, and a running import cannot be started or changed', async () => {
    let finish!: (r: EnemyImportResult) => void;
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const user = await reviewOf(planOf(GUARD));
    await user.click(screen.getByRole('radio', { name: 'Update Guard' }));
    await user.click(screen.getByRole('button', { name: 'Apply Import' }));
    const confirmButton = within(await screen.findByTestId('enemy-import-confirm')).getByRole('button', { name: 'Confirm import' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled());
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'Update Guard' })).toBeDisabled();
    finish({ ...RECEIPT, updated: ['guard'] });
    expect(await screen.findByTestId('enemy-import-result')).toHaveTextContent('1 updated');
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it('a retry of the same decisions reuses its request id; changed decisions are a new request', async () => {
    const failure = new PortalApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'The server failed' });
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockRejectedValue(failure);
    const user = await reviewOf(planOf(GUARD));
    await user.click(screen.getByRole('radio', { name: 'Update Guard' }));
    await applyAndConfirm(user);
    expect(await screen.findByTestId('enemy-import-error')).toHaveTextContent('The server failed');
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(2));
    expect(applySpy.mock.calls[1]![1].requestId).toBe(applySpy.mock.calls[0]![1].requestId);
    await user.click(screen.getByRole('radio', { name: 'Keep Existing Guard' }));
    expect(screen.queryByTestId('enemy-import-error')).not.toBeInTheDocument();
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(3));
    expect(applySpy.mock.calls[2]![1].requestId).not.toBe(applySpy.mock.calls[0]![1].requestId);
  });

  it('a backend rejection stays on the review and shows each reason', async () => {
    vi.spyOn(api, 'applyEnemyPackage').mockRejectedValue(
      new PortalApiError({
        status: 422,
        code: 'ENEMY_IMPORT_REJECTED',
        message: 'Refused',
        details: { issues: [{ path: 'new.tags', message: 'the same tag is listed twice' }] },
      }),
    );
    const user = await reviewOf(planOf(NEW));
    await applyAndConfirm(user);
    const error = await screen.findByTestId('enemy-import-error');
    expect(error).toHaveTextContent('Refused');
    expect(error).toHaveTextContent('the same tag is listed twice');
    expect(screen.getByTestId('enemy-import-preview')).toBeInTheDocument();
  });

  it('a request still running says to wait; one that no longer matches asks for a fresh check', async () => {
    const applySpy = vi
      .spyOn(api, 'applyEnemyPackage')
      .mockRejectedValueOnce(new PortalApiError({ status: 409, code: 'ENEMY_IMPORT_REQUEST_CONFLICT', message: 'busy', details: { inProgress: true } }))
      .mockRejectedValueOnce(new PortalApiError({ status: 409, code: 'ENEMY_IMPORT_REQUEST_CONFLICT', message: 'other', details: { inProgress: false } }));
    const user = await reviewOf(planOf(NEW));
    await applyAndConfirm(user);
    expect(await screen.findByTestId('enemy-import-running')).toHaveTextContent('will not be applied twice');
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    await applyAndConfirm(user);
    await screen.findByRole('button', { name: 'Check again' });
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    expect(applySpy).toHaveBeenCalledTimes(2);
  });

  it('without artwork.write the review is readable but cannot apply, and says why before the attempt', async () => {
    const user = await reviewOf(planOf(GUARD), ['enemies.read', 'enemies.write']);
    const applySpy = vi.spyOn(api, 'applyEnemyPackage');
    await user.click(screen.getByRole('radio', { name: 'Update Guard' }));
    expect(screen.getByTestId('enemy-import-no-permission')).toHaveTextContent('artwork.write');
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('a server-side permission refusal shows its reason', async () => {
    vi.spyOn(api, 'applyEnemyPackage').mockRejectedValue(
      new PortalApiError({ status: 403, code: 'PORTAL_PERMISSION_DENIED', message: 'You do not have permission to do that.' }),
    );
    const user = await reviewOf(planOf(NEW));
    await applyAndConfirm(user);
    expect(await screen.findByTestId('enemy-import-error')).toHaveTextContent('You do not have permission to do that.');
  });

  it('an enemy keyed like an Object.prototype member still needs its own decision', async () => {
    const odd = entry({ key: 'constructor', name: 'Constructor', outcome: 'update', changedFields: ['hp'] });
    const user = await reviewOf(planOf(odd));
    const applySpy = vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue(RECEIPT);
    expect(screen.getByTestId('enemy-import-undecided')).toHaveTextContent('Constructor');
    expect(screen.getByRole('button', { name: 'Apply Import' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Update Constructor' }));
    await applyAndConfirm(user);
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0]![1].decisions).toBe('u');
  });

  it('the receipt offers the catalogue, and Import another can take the same file again', async () => {
    const user = await reviewOf(planOf(NEW));
    vi.spyOn(api, 'applyEnemyPackage').mockResolvedValue({ ...RECEIPT, created: ['new_one'] });
    await applyAndConfirm(user);
    const result = await screen.findByTestId('enemy-import-result');
    expect(result).toHaveFocus();
    expect(within(result).getByRole('link', { name: 'Back to Enemy Catalogue' })).toHaveAttribute('href', '/admin/enemies');
    await user.click(within(result).getByRole('button', { name: 'Import another' }));
    await waitFor(() => expect(screen.queryByTestId('enemy-import-result')).not.toBeInTheDocument());
    await user.upload(screen.getByLabelText('Enemy package file'), zipFile());
    await screen.findByTestId('enemy-import-preview');
    expect(api.previewEnemyPackage).toHaveBeenCalledTimes(2);
  });
});
