/**
 * The encounter editor's artwork field uses the shared picker, bound to the
 * encounter routes (`encounters.read`, `encounters/`) — never the Result
 * Presentation ones. Picking fills the path and the existing preview; saving
 * is still the editor's ordinary Save.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import * as adminPresentations from '@/api/adminResultPresentations';
import type { AdminEncounter, AdminEncounterReference } from '@/api/adminEncounters';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { AdminEncounterEditorPage } from '../AdminEncounterEditorPage';

const REFERENCE: AdminEncounterReference = {
  regions: ['waifu-valley'],
  regionNames: { 'waifu-valley': 'Waifu Valley' },
  speciesRarities: ['N'],
  affinities: ['primal'],
  races: ['demon'],
  items: [],
  encounters: [],
  species: [],
  vendors: [],
  types: ['discovery'],
  rarities: ['common'],
  lifecycles: ['draft', 'active', 'disabled'],
};

const ENCOUNTER: AdminEncounter = {
  id: 5,
  slug: 'lost_cub',
  name: 'Lost Cub',
  description: '',
  type: 'discovery',
  rarity: 'common',
  weight: 1,
  lifecycle: 'draft',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 0,
  artworkPath: 'encounters/old_cub.webp',
  chainedEncounterSlug: null,
  choicesRequired: false,
  regions: [],
  routes: [],
  choices: [],
  metadata: {},
};

beforeEach(() => {
  const statics = URL as unknown as {
    createObjectURL?: () => string;
    revokeObjectURL?: () => void;
  };
  statics.createObjectURL = () => 'blob:mock';
  statics.revokeObjectURL = () => {};
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockResolvedValue(ENCOUNTER);
  vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob').mockResolvedValue(new Blob(['x']));
  vi.spyOn(adminEncounters, 'browseAdminEncounterArtwork').mockResolvedValue({
    path: 'encounters',
    parent: null,
    breadcrumbs: [{ name: 'encounters', path: 'encounters' }],
    directories: [],
    files: [
      {
        name: 'wv_lost_cub.webp',
        path: 'encounters/wv_lost_cub.webp',
        folder: 'encounters',
        extension: 'webp',
      },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: {
      playerId: 1,
      guildDbId: 1,
      displayName: 'Author',
      avatarUrl: null,
      permissions: ['admin.access', 'encounters.read', 'encounters.write'],
    },
    error: null,
  } as unknown as SessionState;
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={['/admin/encounters/5']}>
          <Routes>
            <Route path="/admin/encounters/:id" element={children} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

it('picks encounter artwork into the path field through the encounter routes', async () => {
  const presentationBrowse = vi.spyOn(adminPresentations, 'browseResultPresentationArtwork');
  const update = vi.spyOn(adminEncounters, 'updateAdminEncounter');
  const user = userEvent.setup();
  render(<AdminEncounterEditorPage />, { wrapper: Providers });
  await screen.findByText('Edit — Lost Cub');

  const field = screen.getByLabelText('Artwork path (relative to assets/)');
  expect(field).toHaveValue('encounters/old_cub.webp');
  await user.click(screen.getByRole('button', { name: 'Browse Artwork' }));
  await user.click(await screen.findByRole('button', { name: 'Use encounters/wv_lost_cub.webp' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(field).toHaveValue('encounters/wv_lost_cub.webp');
  await waitFor(() =>
    expect(adminEncounters.adminEncounterArtworkBlob).toHaveBeenCalledWith(
      'encounters/wv_lost_cub.webp',
    ),
  );
  expect(adminEncounters.browseAdminEncounterArtwork).toHaveBeenCalled();
  expect(presentationBrowse).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
