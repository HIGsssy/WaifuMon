import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { install, renderAt } from './dungeonFixtures';
beforeEach(() => {
  install();
  stubObjectUrls();
});
it('displays read-only import history and actual decisions', async () => {
  vi.mocked(api.getDungeonImportHistory).mockResolvedValue({
    imports: [
      {
        id: 4,
        packageId: 'pkg-4',
        packageHash: 'hash',
        sourceEnvironment: 'staging',
        dungeonKey: 'tunnels',
        actor: 'Author',
        importedAt: '2026-10-10T12:00:00Z',
        decisions: {
          dungeon: 'replace',
          enemies: { slime: 'use_existing' },
          allowMissingDependencies: true,
        },
        result: { result: 'replaced', draftRevision: 5 },
      },
    ],
  });
  const user = userEvent.setup();
  renderAt(undefined, ['dungeons.read']);
  await user.click(await screen.findByRole('button', { name: 'History & export' }));
  await screen.findByText('Package: pkg-4');
  expect(screen.getByText('Result: replaced · Draft revision 5')).toBeInTheDocument();
  expect(screen.getByText('Enemy slime: use_existing')).toBeInTheDocument();
  expect(screen.getByText(/Accept missing dependencies: Yes/)).toBeInTheDocument();
});
it('shows history errors and lets administrators retry reads', async () => {
  vi.mocked(api.getDungeonImportHistory)
    .mockRejectedValueOnce(
      new PortalApiError({ status: 503, code: 'UNAVAILABLE', message: 'History unavailable' }),
    )
    .mockResolvedValueOnce({ imports: [] });
  const user = userEvent.setup();
  renderAt();
  await user.click(await screen.findByRole('button', { name: 'History & export' }));
  await screen.findByText('History unavailable');
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('No imports yet.');
});
it('downloads untouched server packages with distinct origins and feedback', async () => {
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download);
  });
  const user = userEvent.setup();
  renderAt();
  await user.click(await screen.findByRole('button', { name: 'History & export' }));
  await user.click(await screen.findByRole('button', { name: 'Export saved draft' }));
  await screen.findByText('Download started: tunnels.draft.dungeon.json');
  await user.click(screen.getByRole('button', { name: 'Export current published package' }));
  await screen.findByText('Download started: tunnels.published.dungeon.json');
  await user.click(screen.getByRole('button', { name: 'Export revision 1' }));
  await screen.findByText('Download started: tunnels.published-r1.dungeon.json');
  expect(clicks).toEqual([
    'tunnels.draft.dungeon.json',
    'tunnels.published.dungeon.json',
    'tunnels.published-r1.dungeon.json',
  ]);
  await waitFor(() => expect(api.exportDungeonPackage).toHaveBeenCalledTimes(3));
  expect(vi.mocked(api.exportDungeonPackage).mock.calls.map((c) => c[1])).toEqual([
    'draft',
    'published',
    { revision: 1 },
  ]);
});
