/**
 * The effect editor's `affection_gain` support.
 *
 * The editor is deliberately thin — server-side Zod is what actually validates
 * a save — so the only thing worth pinning here is that an author can *reach*
 * the effect at all: it must appear in the type list, and choosing it must
 * reveal an amount field wired to `amount`. An effect the server understands
 * but the editor cannot express is invisible to the people who author content.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EffectEditor, type EffectShape } from '../EffectEditor';

/**
 * The editor is a controlled component, so the test has to own the state the
 * way the real form does. Rendering it with a frozen `effect` prop would make
 * every keystroke fight the stale value and produce edits no user could
 * actually make.
 */
function setup(initial: EffectShape) {
  const onChange = vi.fn();
  function Harness() {
    const [effect, setEffect] = useState<EffectShape>(initial);
    return (
      <EffectEditor
        effect={effect}
        reference={undefined}
        onChange={(next) => {
          onChange(next);
          setEffect(next);
        }}
        onRemove={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return { onChange };
}

describe('EffectEditor — affection_gain', () => {
  it('offers affection_gain in the type list', () => {
    setup({ type: 'waifubux_gain', amount: 10 });
    const select = screen.getByRole('combobox');
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('affection_gain');
  });

  it('switching to it reports the new type to the parent', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ type: 'waifubux_gain', amount: 10 });

    await user.selectOptions(screen.getByRole('combobox'), 'affection_gain');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'affection_gain' }),
    );
  });

  it('renders an Amount field for it, prefilled from the effect', () => {
    setup({ type: 'affection_gain', amount: 25 });
    const amount = screen.getByLabelText(/amount/i);
    expect(amount).toHaveValue(25);
  });

  it('edits write back to `amount`, which is the field the schema reads', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ type: 'affection_gain', amount: 25 });

    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);
    await user.type(amount, '30');

    // The last call carries the finished value; intermediate keystrokes are
    // the controlled-input churn and say nothing useful.
    expect(onChange).toHaveBeenLastCalledWith({ type: 'affection_gain', amount: 30 });
  });

  it('shows no item, vendor or percent fields for it', () => {
    // The type is a bare amount. A stray field from another branch would let an
    // author submit something `.strict()` rejects on the server.
    setup({ type: 'affection_gain', amount: 25 });
    expect(screen.queryByLabelText(/percent/i)).toBeNull();
    expect(screen.queryByLabelText(/vendor/i)).toBeNull();
    expect(screen.queryByLabelText(/slug/i)).toBeNull();
  });
});
