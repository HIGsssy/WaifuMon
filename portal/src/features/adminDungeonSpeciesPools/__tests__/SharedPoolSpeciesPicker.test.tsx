import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { renderWith } from '@/features/adminDungeons/__tests__/dungeonFixtures';
import { DungeonSpeciesPicker } from '@/features/adminDungeons/DungeonSpeciesPicker';

const base: api.DungeonSpeciesRef = {
  slug: 'valley',
  name: 'Valley Angel',
  rarity: 'N',
  race: 'angel',
  affinity: 'switch',
  regions: ['waifu-valley'],
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: false,
  permitted: true,
  unavailableReason: null,
  dungeonPolicyAllowed: true,
  dungeonAccess: [],
  perPlayerLimit: null,
  directRescue: { available: false, reason: 'direct_not_permitted' },
};
const catalogue = [
  base,
  {
    ...base,
    slug: 'multi',
    name: 'Multi Angel',
    regions: ['waifu-valley', 'twin-peeks'],
    rarity: 'SR',
  },
  {
    ...base,
    slug: 'exclusive',
    name: 'Exclusive Angel',
    regions: [],
    dungeonExclusive: true,
    permitted: false,
    unavailableReason: 'not_permitted' as const,
  },
  {
    ...base,
    slug: 'unassigned',
    name: 'Unassigned Demon',
    regions: [],
    race: 'demon',
    affinity: 'dom',
  },
  {
    ...base,
    slug: 'disabled',
    name: 'Disabled Angel',
    enabled: false,
    dungeonPolicyAllowed: false,
  },
];
beforeEach(() => {
  vi.spyOn(api, 'dungeonSpeciesArtworkBlob').mockResolvedValue(new Blob());
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
function renderPicker() {
  function Picker() {
    const [selected, setSelected] = useState(new Set<string>());
    return (
      <DungeonSpeciesPicker
        species={catalogue}
        regions={[
          { id: 'waifu-valley', name: 'Waifu Valley' },
          { id: 'twin-peeks', name: 'Twin Peeks' },
          { id: 'thirstlands', name: 'Thirstlands' },
        ]}
        dungeonKey="shared_pool_catalogue"
        purpose="shared_pool"
        disabled={false}
        listed={selected}
        onSelect={(slug) => setSelected((current) => new Set([...current, slug]))}
        onRemove={(slug) =>
          setSelected((current) => new Set([...current].filter((s) => s !== slug)))
        }
      />
    );
  }
  renderWith(<Picker />);
  return userEvent.setup();
}
const results = () => within(screen.getByRole('list', { name: 'Matching species' }));
it('filters each actual region and supports multiple-region membership', async () => {
  const user = renderPicker();
  await user.selectOptions(screen.getByLabelText('Filter species by region'), 'twin-peeks');
  expect(results().getByText('Multi Angel')).toBeVisible();
  expect(results().queryByText('Valley Angel')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Filter species by region'), 'waifu-valley');
  expect(results().getByText('Multi Angel')).toBeVisible();
  expect(results().getByText('Valley Angel')).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Filter species by region'), 'thirstlands');
  expect(screen.getByText('No species match these filters.')).toBeVisible();
});
it('filters unassigned species without treating them all as dungeon-exclusive', async () => {
  const user = renderPicker();
  await user.selectOptions(screen.getByLabelText('Filter species by region'), 'unassigned');
  expect(results().getByText('Exclusive Angel')).toBeVisible();
  expect(results().getByText('Unassigned Demon')).toBeVisible();
  expect(results().queryByText('Multi Angel')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Filter species by dungeon exclusivity'), 'other');
  expect(results().getByText('Unassigned Demon')).toBeVisible();
  expect(results().queryByText('Exclusive Angel')).not.toBeInTheDocument();
  await user.selectOptions(
    screen.getByLabelText('Filter species by dungeon exclusivity'),
    'dungeon',
  );
  expect(results().getByText('Exclusive Angel')).toBeVisible();
  expect(results().queryByText('Unassigned Demon')).not.toBeInTheDocument();
});
it('combines search, region, exclusivity, rarity, race, affinity and availability filters', async () => {
  const user = renderPicker();
  await user.type(screen.getByLabelText('Search species'), 'Angel');
  for (const [label, value] of [
    ['region', 'waifu-valley'],
    ['dungeon exclusivity', 'other'],
    ['rarity', 'SR'],
    ['race', 'angel'],
    ['affinity', 'switch'],
    ['availability', 'permitted'],
  ])
    await user.selectOptions(screen.getByLabelText(`Filter species by ${label}`), value!);
  expect(results().getAllByRole('listitem')).toHaveLength(1);
  expect(results().getByText('Multi Angel')).toBeVisible();
});
it('keeps filters while selecting multiple species, prevents duplicates, and removes selections', async () => {
  const user = renderPicker();
  await user.type(screen.getByLabelText('Search species'), 'Angel');
  await user.selectOptions(screen.getByLabelText('Filter species by availability'), 'permitted');
  await user.click(screen.getByRole('button', { name: 'Add species Valley Angel' }));
  expect(
    screen.queryByRole('button', { name: 'Add species Valley Angel' }),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByTestId('species-option-valley')).getByText('In this pool'),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Add species Exclusive Angel' }));
  expect(screen.getByLabelText('Search species')).toHaveValue('Angel');
  expect(screen.getByLabelText('Filter species by availability')).toHaveValue('permitted');
  expect(screen.getByText(/2 selected/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Remove species Valley Angel' }));
  expect(screen.getByRole('button', { name: 'Add species Valley Angel' })).toBeEnabled();
  expect(screen.getByText(/1 selected/)).toBeVisible();
  expect(results().queryByText('Disabled Angel')).not.toBeInTheDocument();
});
