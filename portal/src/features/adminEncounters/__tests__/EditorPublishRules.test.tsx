/**
 * The encounter editor's Waifumon-sighting save rules.
 *
 *   - Specific Species with no species blocks every save (draft or publish),
 *     and `speciesSlug: ""` is never serialized.
 *   - A random selector that matches nothing in any enabled region — the
 *     server's `matchesAnywhere: false` — blocks publishing only. Drafts save.
 *   - Zero candidates in only some regions blocks nothing; the warning stays.
 *
 * The selector's candidate answer is always the (mocked) server preview —
 * nothing in these tests or the editor evaluates a selector.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import type {
  AdminEncounter,
  AdminEncounterReference,
  SelectorPreviewResponse,
} from '@/api/adminEncounters';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { AdminEncounterEditorPage } from '../AdminEncounterEditorPage';
import { draftFrom, toPayload, unchosenSpeciesIssues } from '../encounterDraft';
import { effectFromForm } from '../waifumonSelection';

const T = 'trigger_waifumon_encounter';
const BLOCKED =
  'This selector does not match any enabled Waifumon in any region where this encounter can run.';

const REFERENCE: AdminEncounterReference = {
  regions: ['waifu-valley', 'twin-peeks'],
  regionNames: { 'waifu-valley': 'Waifu Valley', 'twin-peeks': 'Twin Peeks' },
  speciesRarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'],
  affinities: ['primal'],
  races: ['demon'],
  items: [],
  encounters: [],
  species: [{ slug: 'lilith', name: 'Lilith', rarity: 'LR' }],
  vendors: [],
  types: ['discovery'],
  rarities: ['common'],
  lifecycles: ['draft', 'active', 'disabled'],
};

function encounter(effect: Record<string, unknown>, lifecycle: AdminEncounter['lifecycle']): AdminEncounter {
  return {
    id: 5,
    slug: 'lr_trail_end',
    name: 'Trail End',
    description: '',
    type: 'discovery',
    rarity: 'common',
    weight: 1,
    lifecycle,
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: ['waifu-valley', 'twin-peeks'],
    routes: [],
    choices: [
      {
        id: 50,
        sortOrder: 0,
        label: 'Follow',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [effect],
        failureEffects: [],
      },
    ],
    metadata: {},
  };
}

const region = (regionId: string, regionName: string, candidateCount: number) => ({
  regionId,
  regionName,
  candidateCount,
  candidates: Array.from({ length: candidateCount }, (_, i) => ({
    slug: `s${i}`,
    name: `Species ${i}`,
    rarity: 'LR',
  })),
});

const DEAD: SelectorPreviewResponse = {
  mode: 'random',
  specific: null,
  regions: [region('waifu-valley', 'Waifu Valley', 0), region('twin-peeks', 'Twin Peeks', 0)],
  matchesAnywhere: false,
};
const PARTIAL: SelectorPreviewResponse = {
  mode: 'random',
  specific: null,
  regions: [region('waifu-valley', 'Waifu Valley', 2), region('twin-peeks', 'Twin Peeks', 0)],
  matchesAnywhere: true,
};

let updateSpy: MockInstance<typeof adminEncounters.updateAdminEncounter>;
let previewSpy: MockInstance<typeof adminEncounters.previewSpeciesSelector>;

beforeEach(() => {
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  updateSpy = vi
    .spyOn(adminEncounters, 'updateAdminEncounter')
    .mockImplementation(async (_id, input) => ({ ...encounter({ type: T }, input.lifecycle), id: 5 }));
  previewSpy = vi.spyOn(adminEncounters, 'previewSpeciesSelector').mockResolvedValue(PARTIAL);
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
      permissions: ['admin.access', 'encounters.read', 'encounters.write', 'encounters.publish'],
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

async function open(effect: Record<string, unknown>, lifecycle: AdminEncounter['lifecycle']) {
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockResolvedValue(encounter(effect, lifecycle));
  const user = userEvent.setup();
  render(<AdminEncounterEditorPage />, { wrapper: Providers });
  await screen.findByText('Edit — Trail End');
  return user;
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const UNCHOSEN = { type: T, selection: { mode: 'specific' } };
const DEAD_SELECTOR = { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['EX'] } };
const PARTIAL_SELECTOR = { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } };

describe('Specific Species with no species chosen', () => {
  it('cannot Save, and says why', async () => {
    const user = await open(UNCHOSEN, 'draft');
    expect(screen.getByText('Pick a species to preview this sighting.')).toBeInTheDocument();
    expect(screen.getByTestId('save-blockers')).toHaveTextContent(
      'Choice #1, success effect #1: pick a species for this Waifumon sighting.',
    );
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('cannot Publish', async () => {
    await open(UNCHOSEN, 'active');
    expect(screen.getByLabelText('Lifecycle')).toHaveValue('active');
    expect(saveButton()).toBeDisabled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('never serializes speciesSlug: ""', () => {
    // The form writes an unchosen species as a bare `{ mode: 'specific' }`…
    const effect = effectFromForm({ mode: 'specific', speciesSlug: '' });
    expect(effect).toEqual({ type: T, selection: { mode: 'specific' } });
    expect(JSON.stringify(effect)).not.toContain('speciesSlug');
    // …and the draft reports it, which is what keeps it out of any payload.
    const draft = draftFrom(encounter(effect, 'draft'));
    expect(unchosenSpeciesIssues(draft)).toHaveLength(1);
    expect(JSON.stringify(toPayload(draft))).not.toContain('"speciesSlug":""');
  });

  it('switching to Specific in the editor does not produce an empty slug either', async () => {
    const user = await open(PARTIAL_SELECTOR, 'draft');
    await user.click(screen.getByRole('button', { name: 'Specific Species' }));
    expect(saveButton()).toBeDisabled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('a valid Specific Species', () => {
  it('can Save', async () => {
    const user = await open(UNCHOSEN, 'draft');
    await user.selectOptions(screen.getByLabelText('Species'), 'lilith');
    expect(screen.queryByTestId('save-blockers')).toBeNull();
    await user.click(saveButton());
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const payload = updateSpy.mock.calls[0]![1];
    expect(payload.choices[0]!.successEffects[0]).toEqual({
      type: T,
      selection: { mode: 'specific', speciesSlug: 'lilith' },
    });
  });

  it('can Publish', async () => {
    const user = await open({ type: T, selection: { mode: 'specific', speciesSlug: 'lilith' } }, 'draft');
    await user.selectOptions(screen.getByLabelText('Lifecycle'), 'active');
    await user.click(saveButton());
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy.mock.calls[0]![1].lifecycle).toBe('active');
  });
});

describe('a selector with zero candidates in every region', () => {
  // Braced: a function returned from beforeEach is run as teardown, and
  // returning the spy would call the restored, real API after the test.
  beforeEach(() => {
    previewSpy.mockResolvedValue(DEAD);
  });

  it('can Save as Draft', async () => {
    const user = await open(DEAD_SELECTOR, 'draft');
    expect(await screen.findByTestId('publish-blockers')).toHaveTextContent(BLOCKED);
    expect(screen.getByTestId('publish-blockers')).toHaveTextContent(/can save this encounter as a draft/);
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy.mock.calls[0]![1].lifecycle).toBe('draft');
  });

  it('cannot be published from draft: the active lifecycle is unavailable', async () => {
    await open(DEAD_SELECTOR, 'draft');
    await screen.findByTestId('publish-blockers');
    const active = screen.getByRole('option', { name: /active/ }) as HTMLOptionElement;
    expect(active.disabled).toBe(true);
    expect(active.textContent).toContain('(blocked)');
  });

  it('cannot be saved while active, and explains why', async () => {
    const user = await open(DEAD_SELECTOR, 'active');
    expect(await screen.findByTestId('publish-blockers')).toHaveTextContent(BLOCKED);
    expect(screen.getByTestId('publish-blockers')).toHaveTextContent(/cannot be published/);
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('asks the server, never deciding itself', async () => {
    await open(DEAD_SELECTOR, 'draft');
    await screen.findByTestId('publish-blockers');
    expect(previewSpy).toHaveBeenCalledWith({
      selection: DEAD_SELECTOR.selection,
      encounter: {
        huntEligible: true,
        travelEligible: false,
        regions: ['waifu-valley', 'twin-peeks'],
        routes: [],
      },
    });
  });
});

describe('a selector with zero candidates in only some regions', () => {
  it('stays publishable, and keeps the per-region warning', async () => {
    const user = await open(PARTIAL_SELECTOR, 'active');
    expect(
      await screen.findByText(/No Waifumon currently match this selector in\s+Twin Peeks/),
    ).toBeInTheDocument();
    expect(screen.getByText('Waifu Valley: 2 eligible')).toBeInTheDocument();
    expect(screen.queryByTestId('publish-blockers')).toBeNull();
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy.mock.calls[0]![1].lifecycle).toBe('active');
  });
});
