/**
 * The effect editor's `give_equipment` support: an author can reach the
 * effect, pick an optional slot and rarity, and narrow it to specific
 * definitions — and nothing else. There are deliberately no affix or
 * multiplier controls; the Equipment system rolls those. The server validates
 * the selector on save.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import { describeEffect } from '../describe';
import { EffectEditor, type EffectShape } from '../EffectEditor';

const REFERENCE = {
  equipmentDefinitions: [
    { key: 'combat_knife', name: 'Combat Knife', slot: 'attack', rarity: 'R', enabled: true },
    { key: 'semi_auto_sidearm', name: 'Semi-Auto Sidearm', slot: 'attack', rarity: 'R', enabled: true },
    { key: 'throbbing_mace', name: 'Throbbing Mace', slot: 'attack', rarity: 'R', enabled: false },
    { key: 'rusty_pipe', name: 'Rusty Pipe', slot: 'attack', rarity: 'N', enabled: true },
    { key: 'kevlar_carrier', name: 'Kevlar Carrier', slot: 'defense', rarity: 'R', enabled: true },
    { key: 'golden_gun', name: 'Golden Gun', slot: 'attack', rarity: 'SSR', enabled: true },
  ],
} as unknown as AdminEncounterReference;

function setup(initial: EffectShape) {
  const onChange = vi.fn();
  let latest = initial;
  function Harness() {
    const [effect, setEffect] = useState<EffectShape>(initial);
    return (
      <EffectEditor
        effect={effect}
        reference={REFERENCE}
        onChange={(next) => {
          onChange(next);
          latest = next;
          setEffect(next);
        }}
        onRemove={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return { onChange, latest: () => latest };
}

const offeredNames = () =>
  screen.queryAllByRole('checkbox').map((box) => box.closest('label')!.textContent ?? '');

describe('EffectEditor — give_equipment', () => {
  it('offers it in the type list and starts as a valid "any equipment" effect', async () => {
    const user = userEvent.setup();
    const { latest } = setup({ type: 'waifubux_gain', amount: 10 });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Effect type' }), 'give_equipment');
    expect(latest()).toEqual({ type: 'give_equipment', quantity: 1 });
    expect(screen.getByTestId('effect-summary')).toHaveTextContent('Give random equipment');
  });

  it('sets and clears slot and rarity, storing "Any" as an absent field', async () => {
    const user = userEvent.setup();
    const { latest } = setup({ type: 'give_equipment', quantity: 1 });
    await user.selectOptions(screen.getByLabelText('Equipment slot'), 'attack');
    await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'R');
    expect(latest()).toEqual({ type: 'give_equipment', quantity: 1, slot: 'attack', rarity: 'R' });
    await user.selectOptions(screen.getByLabelText('Equipment slot'), '');
    expect(latest()).toEqual({ type: 'give_equipment', quantity: 1, rarity: 'R' });
  });

  it('offers only enabled N/R/SR definitions matching the filters', () => {
    setup({ type: 'give_equipment', quantity: 1, slot: 'attack', rarity: 'R' });
    const names = offeredNames().join('|');
    expect(names).toContain('Combat Knife');
    expect(names).toContain('Semi-Auto Sidearm');
    expect(names).not.toContain('Throbbing Mace');
    expect(names).not.toContain('Rusty Pipe');
    expect(names).not.toContain('Kevlar Carrier');
    expect(names).not.toContain('Golden Gun');
  });

  it('ticks definitions into a whitelist and unticking the last removes it', async () => {
    const user = userEvent.setup();
    const { latest } = setup({ type: 'give_equipment', quantity: 1, rarity: 'R' });
    await user.click(screen.getByRole('checkbox', { name: /Combat Knife/ }));
    expect(latest()).toEqual({ type: 'give_equipment', quantity: 1, rarity: 'R', definitionKeys: ['combat_knife'] });
    // No name lookups in this harness, so the summary falls back to the key.
    expect(screen.getByTestId('effect-summary')).toHaveTextContent('Give one of: combat_knife');
    await user.click(screen.getByRole('checkbox', { name: /Combat Knife/ }));
    expect(latest()).toEqual({ type: 'give_equipment', quantity: 1, rarity: 'R' });
  });

  it('keeps a chosen definition visible (flagged) after it stops being offered', () => {
    setup({ type: 'give_equipment', quantity: 1, definitionKeys: ['throbbing_mace'] });
    expect(screen.getByRole('checkbox', { name: /Throbbing Mace/ })).toBeChecked();
    expect(offeredNames().find((n) => n.includes('Throbbing Mace'))).toContain('disabled');
  });

  it('has no affix or multiplier controls', () => {
    setup({ type: 'give_equipment', quantity: 1 });
    expect(screen.queryByLabelText(/affix/i)).toBeNull();
    expect(screen.queryByLabelText(/multiplier/i)).toBeNull();
  });

  it('describes each selector in plain language', () => {
    expect(describeEffect({ type: 'give_equipment', slot: 'attack', rarity: 'N' })).toBe('Give random N attack equipment');
    expect(describeEffect({ type: 'give_equipment' })).toBe('Give random equipment');
    expect(
      describeEffect(
        { type: 'give_equipment', definitionKeys: ['combat_knife', 'kevlar_carrier'] },
        { equipment: (key) => ({ combat_knife: 'Combat Knife', kevlar_carrier: 'Kevlar Carrier' })[key] },
      ),
    ).toBe('Give one of: Combat Knife, Kevlar Carrier');
  });
});
