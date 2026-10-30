import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import type { DungeonSpeciesAccessReview } from '@/api/dungeonSpeciesTypes';
import { SpeciesAccessSheet } from '../SpeciesAccessSheet';
import { approveEncounterSpeciesAccess } from '../dungeonSpeciesModel';
import { fixture, install, renderAt, renderWith } from './dungeonFixtures';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());

const names = [
  'Recovery Wing Valkyrie',
  'Ridge Wolf Girl',
  'Showroom Demo Unit',
  'Yukata Attendant',
  'Glint Moth',
  'Skyline Gondolier',
  'Trailhead Marshal',
  'Vent Diver',
];
const slugs = names.map((n) => n.toLowerCase().replaceAll(' ', '_'));
const catalogue: api.DungeonSpeciesRef[] = slugs.map((slug, n) => ({
  slug,
  name: names[n]!,
  rarity: 'N',
  race: 'human',
  affinity: 'switch',
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: true,
  dungeonAccess: [],
  permitted: false,
  unavailableReason: 'not_permitted',
  dungeonPolicyAllowed: true,
  perPlayerLimit: null,
  directRescue: { available: false, reason: 'not_permitted' },
}));
const reviewRows = (): DungeonSpeciesAccessReview[] =>
  slugs.map((species) => ({
    species,
    authorization: 'none',
    perPlayerLimit: null,
    captureReason: 'not_permitted',
    directReason: null,
    canAdd: true,
    references: [
      {
        roomId: 'entrance',
        roomName: 'Entrance',
        actionId: 'meet',
        actionName: 'Wild Encounter',
        direct: false,
        poolId: 'p',
        poolName: 'master dungeon pool N R',
        sharedPoolKey: 'master_dungeon_pool_n_r',
      },
    ],
  }));
function draft() {
  const d = fixture().draft;
  d.speciesPools = [
    { id: 'p', name: 'Master', sharedPoolKey: 'master_dungeon_pool_n_r', entries: [] },
  ];
  d.rooms[0]!.actions = [
    {
      id: 'meet',
      type: 'wild_encounter',
      source: { kind: 'pool', poolId: 'p' },
      intro: '',
      capture: { maxAttempts: 3, allowGuaranteedItems: true },
    },
  ];
  return d;
}
let rows: DungeonSpeciesAccessReview[];
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  rows = reviewRows();
  stubObjectUrls();
  vi.spyOn(api, 'getDungeonSpecies').mockResolvedValue({ species: catalogue });
  vi.spyOn(api, 'dungeonSpeciesArtworkBlob').mockResolvedValue(new Blob(['art']));
  vi.mocked(api.validateDungeon).mockImplementation(async (definition) => ({
    definition,
    contentHash: 'hash',
    publishable: false,
    issues: [],
    speciesAccessReview: rows.map((row) => {
      const own = definition.speciesPolicies?.find((p) => p.species === row.species);
      return own
        ? {
            ...row,
            authorization: 'dungeon',
            perPlayerLimit: own.perPlayerLimit,
            captureReason: null,
            canAdd: false,
          }
        : row;
    }),
  }));
});
function Harness({
  initial = draft(),
  disabled = false,
}: {
  initial?: api.DungeonDefinition;
  disabled?: boolean;
}) {
  const [definition, setDefinition] = useState(initial);
  const [open, setOpen] = useState(true);
  return (
    <>
      {open && (
        <SpeciesAccessSheet
          definition={definition}
          disabled={disabled}
          issues={[]}
          onChange={setDefinition}
          onClose={() => setOpen(false)}
        />
      )}
      <output data-testid="draft">{JSON.stringify(definition)}</output>
    </>
  );
}
const current = (): api.DungeonDefinition => JSON.parse(screen.getByTestId('draft').textContent!);
const review = () =>
  within(screen.getByRole('region', { name: 'Encounter Species Access review' }));
async function ready() {
  await screen.findByRole('region', { name: 'Encounter Species Access review' });
}

it('shows eight shared species with names, thumbnails and provenance; requires limit and explicit approval, edits only draft', async () => {
  const initial = draft();
  initial.speciesPolicies = [
    { species: 'existing_elsewhere', perPlayerLimit: 7, directRescue: true },
  ];
  const before = structuredClone(initial),
    user = userEvent.setup();
  renderWith(<Harness initial={initial} />);
  await ready();
  expect(review().getAllByTestId('species-access-review-row')).toHaveLength(8);
  for (const name of names) expect(review().getByText(name)).toBeVisible();
  expect(review().getAllByText(/Shared pool “master dungeon pool N R”/)).toHaveLength(8);
  await waitFor(() => expect(api.dungeonSpeciesArtworkBlob).toHaveBeenCalled());
  expect(review().getByRole('button', { name: 'Add 8 access entries to draft' })).toBeDisabled();
  await user.click(review().getByRole('checkbox', { name: /I approve/ }));
  expect(review().getByRole('button', { name: 'Add 8 access entries to draft' })).toBeDisabled();
  await user.type(review().getByLabelText('Bulk per-player acquisition limit'), '3');
  expect(review().getByRole('checkbox', { name: /I approve/ })).not.toBeChecked();
  expect(current()).toEqual(before);
  await user.click(review().getByRole('checkbox', { name: /I approve/ }));
  await user.click(review().getByRole('button', { name: 'Add 8 access entries to draft' }));
  await waitFor(() => expect(current().speciesPolicies).toHaveLength(9));
  expect(current().speciesPolicies).toEqual([
    before.speciesPolicies![0],
    ...slugs.map((species) => ({ species, perPlayerLimit: 3 })),
  ]);
  const { speciesPolicies: _entries, ...rest } = current();
  const { speciesPolicies: _old, ...oldRest } = before;
  expect(rest).toEqual(oldRest);
  expect(initial).toEqual(before);
  expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  expect(api.publishDungeon).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      review().queryByRole('button', { name: /Add .*access entries/ }),
    ).not.toBeInTheDocument(),
  );
});

it('closing without approval or entering a limit changes nothing', async () => {
  const initial = draft(),
    user = userEvent.setup();
  renderWith(<Harness initial={initial} />);
  await ready();
  await user.type(review().getByLabelText('Bulk per-player acquisition limit'), '2');
  await user.click(screen.getByRole('button', { name: 'Close Species access' }));
  expect(current()).toEqual(initial);
  expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  expect(api.publishDungeon).not.toHaveBeenCalled();
});

it('withholds stale review and approval when the draft changes while a new review is pending', async () => {
  const initial = draft(),
    user = userEvent.setup();
  let replaceDraft!: (d: api.DungeonDefinition) => void;
  let finish!: (report: api.DungeonValidation) => void;
  const original = vi.mocked(api.validateDungeon).getMockImplementation()!;
  vi.mocked(api.validateDungeon).mockImplementation((d, ...args) =>
    d.description === 'Changed'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(d, ...args),
  );
  function Host() {
    const [d, setD] = useState(initial);
    replaceDraft = setD;
    return (
      <SpeciesAccessSheet
        definition={d}
        disabled={false}
        issues={[]}
        onChange={setD}
        onClose={() => {}}
      />
    );
  }
  renderWith(<Host />);
  await ready();
  await user.type(review().getByLabelText('Bulk per-player acquisition limit'), '2');
  await user.click(review().getByRole('checkbox', { name: /I approve/ }));
  expect(review().getByRole('button', { name: /Add 8/ })).toBeEnabled();
  const changed = { ...initial, description: 'Changed' };
  act(() => replaceDraft(changed));
  expect(
    screen.queryByRole('region', { name: 'Encounter Species Access review' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('Reviewing encounter Species Access…')).toBeVisible();
  await act(async () =>
    finish({
      definition: changed,
      contentHash: 'changed',
      publishable: false,
      issues: [],
      speciesAccessReview: rows,
    }),
  );
  await ready();
  expect(review().getByRole('checkbox', { name: /I approve/ })).not.toBeChecked();
  expect(review().getByLabelText('Bulk per-player acquisition limit')).toHaveValue(null);
  expect(review().getByRole('button', { name: /Add 8/ })).toBeDisabled();
});

it('distinguishes central authorization and existing dungeon limits and supports selecting only missing species', async () => {
  rows[0] = {
    ...rows[0]!,
    authorization: 'content',
    perPlayerLimit: 1,
    captureReason: null,
    canAdd: false,
  };
  const initial = draft();
  initial.speciesPolicies = [{ species: slugs[1]!, perPlayerLimit: 5 }];
  renderWith(<Harness initial={initial} />);
  await ready();
  expect(review().getByText('Central dungeonAccess authorization · Limit: 1')).toBeVisible();
  expect(review().getByText('Dungeon-specific authorization · Limit: 5')).toBeVisible();
  expect(review().queryByLabelText(`Create access for ${names[0]}`)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(review().getByLabelText(`Create access for ${names[2]}`));
  await user.type(review().getByLabelText('Bulk per-player acquisition limit'), '4');
  await user.click(review().getByRole('checkbox', { name: /I approve/ }));
  await user.click(review().getByRole('button', { name: 'Add 5 access entries to draft' }));
  expect(current().speciesPolicies).toEqual([
    { species: slugs[1], perPlayerLimit: 5 },
    ...slugs.slice(3).map((species) => ({ species, perPlayerLimit: 4 })),
  ]);
});

it('Direct Rescue is a separate explicit opt-in and read-only editors cannot apply', async () => {
  rows[0]!.references[0]!.direct = true;
  rows[0]!.directReason = 'not_permitted';
  const initial = draft(),
    user = userEvent.setup();
  const view = renderWith(<Harness initial={initial} />);
  await ready();
  expect(review().getByText(/Direct Rescue remains blocked/)).toBeVisible();
  await user.type(review().getByLabelText('Bulk per-player acquisition limit'), '2');
  await user.click(review().getByRole('checkbox', { name: /Also allow Direct Rescue/ }));
  await user.click(review().getByRole('checkbox', { name: /I approve/ }));
  await user.click(review().getByRole('button', { name: 'Add 8 access entries to draft' }));
  expect(current().speciesPolicies![0]).toEqual({
    species: slugs[0],
    perPlayerLimit: 2,
    directRescue: true,
  });
  expect(
    current()
      .speciesPolicies!.slice(1)
      .every((p) => !p.directRescue),
  ).toBe(true);
  view.unmount();
  renderWith(<Harness disabled initial={initial} />);
  await ready();
  expect(review().getByLabelText('Bulk per-player acquisition limit')).toBeDisabled();
  expect(review().getByRole('button', { name: /Add .*access entries/ })).toBeDisabled();
});

it('bulk model rejects unapproved/invalid limits, deduplicates repeated species and preserves existing terms', () => {
  const initial = draft();
  initial.speciesPolicies = [{ species: slugs[0]!, perPlayerLimit: 1 }];
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(approveEncounterSpeciesAccess(initial, rows, slugs, limit, true)).toBe(initial);
  expect(approveEncounterSpeciesAccess(initial, rows, slugs, 2, false)).toBe(initial);
  const next = approveEncounterSpeciesAccess(
    initial,
    [...rows, rows[1]!],
    [...slugs, ...slugs],
    2,
    true,
  );
  expect(next.speciesPolicies).toHaveLength(8);
  expect(next.speciesPolicies![0]).toEqual(initial.speciesPolicies[0]);
  expect(next.speciesPolicies!.every((p) => !p.directRescue)).toBe(true);
  const full = {
    ...initial,
    speciesPolicies: Array.from({ length: 200 }, (_, n) => ({
      species: `existing_${n}`,
      perPlayerLimit: 1,
    })),
  };
  expect(approveEncounterSpeciesAccess(full, rows, slugs, 2, true)).toBe(full);
});

it('publication checklist offers one grouped repair leading to the shared species in Species access', async () => {
  const initial = draft();
  world.stored = {
    ...world.stored,
    draft: initial,
    issues: slugs.map((slug) => ({
      code: 'species_not_permitted',
      severity: 'error',
      path: 'rooms[0].actions[0].source',
      message: `Species "${slug}" is unavailable: not_permitted.`,
    })),
  };
  renderAt();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Checklist: 8 to fix/ }));
  // The settings action may also be visible; the To do outline provides one grouped repair.
  const actions = await screen.findAllByRole('button', {
    name: 'Review Species Access from Encounters',
  });
  await user.click(actions[0]!);
  await ready();
  expect(review().getAllByTestId('species-access-review-row')).toHaveLength(8);
  expect(screen.getByRole('heading', { name: /^Species access$/ })).toBeVisible();
});
