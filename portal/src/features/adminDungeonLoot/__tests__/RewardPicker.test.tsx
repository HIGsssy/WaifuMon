import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as loot from '@/api/adminDungeonLootTables';
import { EquipmentPicker } from '../EquipmentPicker';
import { ItemPicker } from '../ItemPicker';
import { RewardEditor } from '../RewardForm';
import { ITEMS, install, renderPart } from './lootFixtures';

beforeEach(() => {
  install();
});

function Items({ onChange }: { onChange: (slug: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <ItemPicker
      items={ITEMS}
      value={value}
      onChange={(slug) => {
        setValue(slug);
        onChange(slug);
      }}
    />
  );
}
function Gear({ onChange }: { onChange: (selector: loot.EquipmentRewardSelector) => void }) {
  const [selector, setSelector] = useState<loot.EquipmentRewardSelector>({});
  return (
    <EquipmentPicker
      selector={selector}
      onChange={(next) => {
        setSelector(next);
        onChange(next);
      }}
    />
  );
}
const optionNames = () =>
  screen.getAllByRole('option').map((o) => within(o).getByRole('button').firstChild?.textContent);

describe('item picker', () => {
  it('searches by readable name and filters by type', async () => {
    const user = userEvent.setup();
    renderPart(<Items onChange={() => {}} />);
    expect(optionNames()).toHaveLength(ITEMS.length);
    await user.type(screen.getByLabelText('Search items'), 'vel');
    expect(optionNames()).toEqual(['Velvet Charm']);
    await user.clear(screen.getByLabelText('Search items'));
    await user.click(screen.getByRole('button', { name: 'Charms' }));
    expect(optionNames()).toEqual(['Velvet Charm']);
    await user.click(screen.getByRole('button', { name: 'Salvage' }));
    expect(optionNames()).toEqual(['Bent Gear']);
    await user.click(screen.getByRole('button', { name: 'Consumables' }));
    expect(optionNames()).toEqual(['Old Token', 'Tonic']);
    await user.click(screen.getByRole('button', { name: 'Other' }));
    expect(optionNames()).toEqual(['Founder’s Badge', 'Tunnel Key']);
    await user.type(screen.getByLabelText('Search items'), 'zzz');
    expect(screen.getByTestId('item-picker-empty')).toHaveTextContent('No items match');
  });

  it('shows category and availability, and says why an item cannot be used', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPart(<Items onChange={onChange} />);
    const option = (name: string) => screen.getByRole('option', { name: new RegExp(name) });
    expect(option('Velvet Charm')).toHaveTextContent('Charm');
    expect(option('Velvet Charm')).toHaveTextContent('Available');
    expect(option('Old Token')).toHaveTextContent('Disabled');
    expect(option('Founder’s Badge')).toHaveTextContent(
      'Limited to 1 per player, so it cannot be dungeon loot',
    );
    expect(within(option('Old Token')).getByRole('button')).toBeDisabled();
    expect(within(option('Founder’s Badge')).getByRole('button')).toBeDisabled();
    // The slug is stored and kept out of the readable text.
    expect(screen.getByTestId('item-picker')).not.toHaveTextContent('velvet_charm');
    await user.click(within(option('Velvet Charm')).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('velvet_charm');
    expect(option('Velvet Charm')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('equipment picker', () => {
  it('previews which definitions match the real selector fields', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPart(<Gear onChange={onChange} />);
    expect(
      await screen.findByText(
        '4 pieces can drop: Bolt Cutter, Heart Locket, Iron Plate, Rusted Wrench.',
      ),
    ).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'R');
    expect(onChange).toHaveBeenLastCalledWith({ rarity: 'R' });
    expect(await screen.findByText('2 pieces can drop: Bolt Cutter, Iron Plate.')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Equipment slot'), 'attack');
    expect(onChange).toHaveBeenLastCalledWith({ slot: 'attack', rarity: 'R' });
    expect(await screen.findByText('1 piece can drop: Bolt Cutter.')).toBeVisible();
    expect(screen.getByText(/its stats are rolled when it\s+drops/)).toBeVisible();
    // The server is asked with a selector, never with a rolled instance.
    expect(loot.validateDungeonLootTable).toHaveBeenLastCalledWith(
      {
        guaranteed: [
          {
            id: 'preview',
            grant: { type: 'equipment', selector: { slot: 'attack', rarity: 'R' } },
          },
        ],
        chances: [],
        pools: [],
      },
      expect.anything(),
    );
  });

  it('explains at once when nothing matches', async () => {
    const user = userEvent.setup();
    renderPart(<Gear onChange={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'N');
    await user.selectOptions(screen.getByLabelText('Equipment slot'), 'health');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing matches this. Pick a different rarity or slot.',
    );
  });

  it('chooses specific pieces and drops ones that stop fitting', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPart(<Gear onChange={onChange} />);
    await user.click(screen.getByText(/Only specific pieces/));
    await user.click(await screen.findByLabelText(/Iron Plate/));
    await user.click(screen.getByLabelText(/Bolt Cutter/));
    expect(onChange).toHaveBeenLastCalledWith({ definitionKeys: ['iron_plate', 'bolt_cutter'] });
    expect(await screen.findByText('2 pieces can drop: Bolt Cutter, Iron Plate.')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Equipment slot'), 'attack');
    expect(onChange).toHaveBeenLastCalledWith({ slot: 'attack', definitionKeys: ['bolt_cutter'] });
  });
});

describe('reward form', () => {
  it('asks for a type first and then shows only that type’s fields', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderPart(
      <RewardEditor
        items={ITEMS}
        confirmLabel="Add reward"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const add = screen.getByRole('button', { name: 'Add reward' });
    expect(add).toBeDisabled();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Baddie Shards',
      'WaifuBux',
      'Essence',
      'Item',
      'Equipment',
      'Affection',
    ]);
    await user.click(screen.getByRole('radio', { name: 'Affection' }));
    expect(screen.getByTestId('reward-note')).toHaveTextContent(
      'Goes to the WaifuMon the player brought into this run',
    );
    expect(screen.queryByTestId('item-picker')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Item' }));
    expect(screen.getByTestId('item-picker')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an item.');
    await user.click(screen.getByRole('radio', { name: 'Equipment' }));
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
    expect(await screen.findByText(/^4 pieces can drop/)).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'N');
    await user.selectOptions(screen.getByLabelText('Equipment slot'), 'health');
    await screen.findByText(/Nothing matches this/);
    expect(add).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Baddie Shards' }));
    expect(screen.getByTestId('reward-note')).toHaveTextContent('At risk');
  });

  it('takes a single amount by default and a range on request, refusing bad numbers kindly', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderPart(
      <RewardEditor
        items={ITEMS}
        confirmLabel="Add reward"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Essence' }));
    const amount = screen.getByLabelText('Amount');
    expect(screen.queryByLabelText('Highest amount')).not.toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, '0');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 100,000.');
    expect(screen.getByRole('button', { name: 'Add reward' })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, '9');
    await user.click(screen.getByRole('button', { name: 'Use a range' }));
    const highest = screen.getByLabelText('Highest amount');
    expect(highest).toHaveValue('9');
    await user.clear(highest);
    await user.type(highest, '4');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The highest amount must be at least the lowest.',
    );
    await user.clear(highest);
    await user.type(highest, '12');
    await user.click(screen.getByRole('button', { name: 'Add reward' }));
    expect(onConfirm).toHaveBeenCalledWith({
      type: 'currency',
      currency: 'essence',
      amount: { min: 9, max: 12 },
    });
  });
});
