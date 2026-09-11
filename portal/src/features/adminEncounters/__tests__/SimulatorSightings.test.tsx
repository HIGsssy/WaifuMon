/**
 * The simulator's Waifumon sighting output.
 *
 * The page renders what the server's live selector returned: the selected
 * species comes from the response, never from the Portal, and a zero-candidate
 * result shows "No matching species" with no species name at all. The region
 * picked on the page is what the server is asked to sample in.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import type {
  AdminEncounter,
  AdminEncounterReference,
  SimulateResponse,
  SimulatedSighting,
} from '@/api/adminEncounters';

import { AdminEncounterPreviewPage } from '../AdminEncounterPreviewPage';

const T = 'trigger_waifumon_encounter';

const ENCOUNTER: AdminEncounter = {
  id: 7,
  slug: 'lr_trail_end',
  name: 'Trail End',
  description: '',
  type: 'discovery',
  rarity: 'common',
  weight: 1,
  lifecycle: 'draft',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 0,
  artworkPath: null,
  chainedEncounterSlug: null,
  choicesRequired: true,
  regions: ['thirstlands'],
  routes: [],
  choices: [
    {
      id: 70,
      sortOrder: 0,
      label: 'Follow the tracks',
      emoji: null,
      requirements: {},
      check: { type: 'none' },
      successEffects: [{ type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } }],
      failureEffects: [],
    },
  ],
  metadata: {},
};

const REFERENCE = {
  regions: ['waifu-valley', 'thirstlands'],
  regionNames: { 'waifu-valley': 'Waifu Valley', thirstlands: 'Thirstlands' },
  speciesRarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'],
  affinities: ['primal'],
  races: ['demon'],
  items: [],
  encounters: [],
  species: [{ slug: 'sand_queen', name: 'Sand Queen', rarity: 'LR' }],
  vendors: [],
  types: [],
  rarities: [],
  lifecycles: [],
} satisfies AdminEncounterReference;

function response(sighting: Partial<SimulatedSighting>): SimulateResponse {
  return {
    encounter: ENCOUNTER,
    choiceId: 70,
    aggregate: {
      rolls: 1000,
      successes: 1000,
      failures: 0,
      successRate: 1,
      expectedSuccessRate: 1,
      successRateDeviation: 0,
      successRateStdError: 0,
      waifubuxGained: 0,
      waifubuxLost: 0,
      netWaifubux: 0,
      netWaifubuxPerRoll: 0,
      expectedNetWaifubuxPerRoll: 0,
      essenceGained: 0,
      essenceLost: 0,
      netEssence: 0,
      affectionGranted: 0,
      itemFrequency: {},
      followUpFrequency: { [T]: 1000 },
      seed: 1,
    } as SimulateResponse['aggregate'],
    sightings: [
      {
        outcome: 'success',
        effect: ENCOUNTER.choices[0]!.successEffects[0]!,
        regionId: 'thirstlands',
        candidateCount: 3,
        selectedSpecies: { slug: 'sand_queen', name: 'Sand Queen', rarity: 'LR' },
        result: 'selected',
        ...sighting,
      },
    ],
  };
}

let simulateSpy: MockInstance<typeof adminEncounters.simulateAdminEncounter>;
beforeEach(() => {
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockResolvedValue(ENCOUNTER);
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  simulateSpy = vi.spyOn(adminEncounters, 'simulateAdminEncounter').mockResolvedValue(response({}));
});
afterEach(() => vi.restoreAllMocks());

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/encounters/7/preview']}>
        <Routes>
          <Route path="/admin/encounters/:id/preview" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function run(region?: string) {
  const user = userEvent.setup();
  render(<AdminEncounterPreviewPage />, { wrapper: Providers });
  await screen.findByText('Preview — Trail End');
  await user.selectOptions(screen.getByLabelText('Choice'), '70');
  if (region) {
    await waitFor(() => expect(screen.getByRole('option', { name: 'Thirstlands' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Sighting region'), region);
  }
  await user.click(screen.getByRole('button', { name: /^Run .* rolls$/ }));
  return within(await screen.findByTestId('sim-sightings'));
}

describe('simulator sightings', () => {
  it('shows the selection, region, eligible count and the backend-selected species', async () => {
    const card = await run();
    expect(card.getByText('Random LR Waifumon from current region')).toBeInTheDocument();
    expect(card.getByText('Thirstlands')).toBeInTheDocument();
    expect(card.getByText('3')).toBeInTheDocument();
    expect(card.getByText('Selected species')).toBeInTheDocument();
    expect(card.getByText('Sand Queen (LR)')).toBeInTheDocument();
  });

  it('asks the server to sample in the region the author picked', async () => {
    await run('thirstlands');
    expect(simulateSpy).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ choiceId: 70, regionId: 'thirstlands' }),
    );
  });

  it('shows "No matching species" and no species name when nothing matches', async () => {
    simulateSpy.mockResolvedValue(
      response({ candidateCount: 0, selectedSpecies: null, result: 'no_matching_species' }),
    );
    const card = await run();
    expect(card.getByText('0')).toBeInTheDocument();
    expect(card.getByText(/No matching species/)).toBeInTheDocument();
    expect(card.queryByText('Selected species')).toBeNull();
    expect(card.queryByText(/Sand Queen/)).toBeNull();
  });

  it('leaves the existing aggregate output in place', async () => {
    await run();
    expect(screen.getByText('Outcome distribution')).toBeInTheDocument();
    expect(screen.getByText('Follow-ups fired')).toBeInTheDocument();
  });
});
