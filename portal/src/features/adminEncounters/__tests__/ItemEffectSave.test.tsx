/**
 * Item effects through the whole editor: Add effect → pick type → edit → Save
 * → the `PUT` payload.
 *
 * The production failure this pins: editing an encounter, adding a third
 * SUCCESS effect, switching it to `give_item` and picking an item — leaving the
 * Quantity input on the `1` it displayed — sent
 * `{ type: 'give_item', amount: 100, slug }` and the server answered
 * `/input/choices/0/successEffects/2/quantity: Required`. The input showed a
 * fallback the effect never held, and the type switch carried the previous
 * type's `amount` along.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import type { AdminEncounter, AdminEncounterReference } from '@/api/adminEncounters';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { AdminEncounterEditorPage } from '../AdminEncounterEditorPage';
import { draftFrom, toPayload } from '../encounterDraft';

const REFERENCE: AdminEncounterReference = {
  regions: ['waifu-valley'],
  regionNames: { 'waifu-valley': 'Waifu Valley' },
  speciesRarities: ['N', 'R'],
  affinities: ['primal'],
  races: ['demon'],
  items: [
    { slug: 'basic_charm', name: 'Basic Charm', category: 'charm' },
    { slug: 'shiny_charm', name: 'Shiny Charm', category: 'charm' },
  ],
  encounters: [],
  species: [],
  vendors: [],
  types: ['decision'],
  rarities: ['common'],
  lifecycles: ['draft', 'active', 'disabled'],
};

/** Encounter 47: two choices, a check, and an existing item grant on each branch. */
function encounter(): AdminEncounter {
  return {
    id: 47,
    slug: 'wv_merchant_cart',
    name: 'Merchant Cart',
    description: '',
    type: 'decision',
    rarity: 'common',
    weight: 10,
    lifecycle: 'draft',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: ['waifu-valley'],
    routes: [],
    choices: [
      {
        id: 470,
        sortOrder: 0,
        label: 'Help push',
        emoji: null,
        requirements: {},
        check: { type: 'sp', baseChance: 0.5 },
        successEffects: [
          { type: 'waifubux_gain', amount: 150 },
          { type: 'give_item', slug: 'basic_charm', quantity: 3 },
        ],
        failureEffects: [{ type: 'consume_item', slug: 'basic_charm', quantity: 2 }],
      },
      {
        id: 471,
        sortOrder: 1,
        label: 'Walk on',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [],
        failureEffects: [],
      },
    ],
    metadata: {},
  };
}

let updateSpy: MockInstance<typeof adminEncounters.updateAdminEncounter>;

beforeEach(() => {
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockResolvedValue(encounter());
  updateSpy = vi
    .spyOn(adminEncounters, 'updateAdminEncounter')
    .mockImplementation(async () => encounter());
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
        <MemoryRouter initialEntries={['/admin/encounters/47']}>
          <Routes>
            <Route path="/admin/encounters/:id" element={children} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

async function open() {
  const user = userEvent.setup();
  render(<AdminEncounterEditorPage />, { wrapper: Providers });
  await screen.findByText('Edit — Merchant Cart');
  // The item options arrive with the reference query.
  await screen.findAllByRole('option', { name: 'Shiny Charm (shiny_charm)' });
  return user;
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
/** Effect rows in document order: choice 1 success, choice 1 failure, choice 2… */
const effectRow = (i: number) => screen.getAllByTestId('effect-editor')[i]!;
const typeOf = (i: number) => within(effectRow(i)).getByLabelText('Effect type');
const itemOf = (i: number) => within(effectRow(i)).getByLabelText('Item');
const quantityOf = (i: number) => within(effectRow(i)).getByLabelText('Quantity');

async function save(user: ReturnType<typeof userEvent.setup>) {
  expect(saveButton()).toBeEnabled();
  await user.click(saveButton());
  await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
  const [id, payload] = updateSpy.mock.calls[0]!;
  expect(id).toBe(47);
  return payload;
}

describe('the production reproduction', () => {
  it('a new SUCCESS item effect saves with quantity 1 without touching Quantity', async () => {
    const user = await open();
    // Choice 1 → add a third success effect.
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    // Rows: [0] waifubux_gain, [1] give_item ×3, [2] the new one, [3] failure consume_item.
    await user.selectOptions(typeOf(2), 'give_item');
    await user.selectOptions(itemOf(2), 'shiny_charm');
    expect(quantityOf(2)).toHaveValue(1);

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects).toEqual([
      { type: 'waifubux_gain', amount: 150 },
      { type: 'give_item', slug: 'basic_charm', quantity: 3 },
      { type: 'give_item', slug: 'shiny_charm', quantity: 1 },
    ]);
  });
});

describe('every effect location gets the same defaults', () => {
  it('a new FAILURE item effect saves with quantity 1', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add failure effect' })[0]!);
    // Rows: [0][1] success, [2] failure consume_item, [3] the new failure effect.
    await user.selectOptions(typeOf(3), 'give_item');
    await user.selectOptions(itemOf(3), 'basic_charm');

    const payload = await save(user);
    expect(payload.choices[0]!.failureEffects).toEqual([
      { type: 'consume_item', slug: 'basic_charm', quantity: 2 },
      { type: 'give_item', slug: 'basic_charm', quantity: 1 },
    ]);
  });

  it('an item effect on a second choice (no check) saves with quantity 1', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[1]!);
    // Choice 2's only row follows choice 1's three.
    await user.selectOptions(typeOf(3), 'consume_item');
    await user.selectOptions(itemOf(3), 'shiny_charm');

    const payload = await save(user);
    expect(payload.choices[1]!.successEffects).toEqual([
      { type: 'consume_item', slug: 'shiny_charm', quantity: 1 },
    ]);
  });

  it('success and failure item effects added together both save', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    await user.click(screen.getAllByRole('button', { name: '+ Add failure effect' })[0]!);
    // [2] new success, [4] new failure.
    await user.selectOptions(typeOf(2), 'give_item');
    await user.selectOptions(itemOf(2), 'shiny_charm');
    await user.selectOptions(typeOf(4), 'give_item');
    await user.selectOptions(itemOf(4), 'basic_charm');

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[2]).toEqual({
      type: 'give_item',
      slug: 'shiny_charm',
      quantity: 1,
    });
    expect(payload.choices[0]!.failureEffects[1]).toEqual({
      type: 'give_item',
      slug: 'basic_charm',
      quantity: 1,
    });
  });

  it('a new effect left on its default type saves its default amount', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[1]!);
    await user.click(screen.getAllByRole('button', { name: '+ Add failure effect' })[1]!);
    const payload = await save(user);
    expect(payload.choices[1]!.successEffects).toEqual([{ type: 'waifubux_gain', amount: 100 }]);
    expect(payload.choices[1]!.failureEffects).toEqual([{ type: 'waifubux_loss', amount: 50 }]);
  });
});

describe('quantity input', () => {
  async function newItemEffect(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    await user.selectOptions(typeOf(2), 'give_item');
    await user.selectOptions(itemOf(2), 'shiny_charm');
  }

  it('an explicit quantity above 1 is saved exactly', async () => {
    const user = await open();
    await newItemEffect(user);
    await user.clear(quantityOf(2));
    await user.type(quantityOf(2), '12');
    expect(quantityOf(2)).toHaveValue(12);

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[2]).toEqual({
      type: 'give_item',
      slug: 'shiny_charm',
      quantity: 12,
    });
  });

  it('clearing it shows empty and blocks Save, rather than sending 0 or nothing', async () => {
    const user = await open();
    await newItemEffect(user);
    await user.clear(quantityOf(2));
    expect(quantityOf(2)).toHaveValue(null);
    expect(screen.getByTestId('save-blockers')).toHaveTextContent(
      'Choice #1, success effect #3: quantity must be a whole number from 1 to 99.',
    );
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('zero stays zero on screen and blocks Save', async () => {
    const user = await open();
    await newItemEffect(user);
    await user.clear(quantityOf(2));
    await user.type(quantityOf(2), '0');
    expect(quantityOf(2)).toHaveValue(0);
    expect(saveButton()).toBeDisabled();
  });

  it('negative, fractional and over-99 quantities block Save', async () => {
    const user = await open();
    await newItemEffect(user);
    for (const bad of ['-1', '1.5', '100']) {
      await user.clear(quantityOf(2));
      await user.type(quantityOf(2), bad);
      expect(saveButton(), bad).toBeDisabled();
      expect(screen.getByTestId('save-blockers')).toHaveTextContent(
        'quantity must be a whole number',
      );
    }
    // Fixing it unblocks the save, with the fixed value.
    await user.clear(quantityOf(2));
    await user.type(quantityOf(2), '99');
    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[2]).toMatchObject({ quantity: 99 });
  });

  it('an item effect with no item picked blocks Save', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    await user.selectOptions(typeOf(2), 'give_item');
    expect(screen.getByTestId('save-blockers')).toHaveTextContent(
      'Choice #1, success effect #3: pick an item.',
    );
    expect(saveButton()).toBeDisabled();
  });

  it('several item effects keep their own quantities', async () => {
    const user = await open();
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    await user.click(screen.getAllByRole('button', { name: '+ Add success effect' })[0]!);
    for (const [row, slug, qty] of [
      [2, 'shiny_charm', '2'],
      [3, 'basic_charm', '7'],
    ] as const) {
      await user.selectOptions(typeOf(row), 'give_item');
      await user.selectOptions(itemOf(row), slug);
      await user.clear(quantityOf(row));
      await user.type(quantityOf(row), qty);
    }

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects).toEqual([
      { type: 'waifubux_gain', amount: 150 },
      { type: 'give_item', slug: 'basic_charm', quantity: 3 },
      { type: 'give_item', slug: 'shiny_charm', quantity: 2 },
      { type: 'give_item', slug: 'basic_charm', quantity: 7 },
    ]);
    expect(payload.choices[0]!.failureEffects).toEqual([
      { type: 'consume_item', slug: 'basic_charm', quantity: 2 },
    ]);
  });
});

describe('switching effect type in the editor', () => {
  it('another effect → item grant → pick item saves a clean item effect', async () => {
    const user = await open();
    await user.selectOptions(typeOf(0), 'give_item');
    expect(quantityOf(0)).toHaveValue(1);
    await user.selectOptions(itemOf(0), 'shiny_charm');

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[0]).toEqual({
      type: 'give_item',
      slug: 'shiny_charm',
      quantity: 1,
    });
  });

  it('item grant → another effect drops the item fields', async () => {
    const user = await open();
    await user.selectOptions(typeOf(1), 'essence_gain');
    expect(within(effectRow(1)).getByLabelText('Amount')).toHaveValue(25);

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[1]).toEqual({ type: 'essence_gain', amount: 25 });
  });

  it('item grant → another effect → item grant needs only the item re-picked', async () => {
    const user = await open();
    await user.selectOptions(typeOf(1), 'waifubux_gain');
    await user.selectOptions(typeOf(1), 'give_item');
    expect(quantityOf(1)).toHaveValue(1);
    expect(itemOf(1)).toHaveValue('');
    expect(saveButton()).toBeDisabled();
    await user.selectOptions(itemOf(1), 'basic_charm');

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[1]).toEqual({
      type: 'give_item',
      slug: 'basic_charm',
      quantity: 1,
    });
  });

  it('give_item → consume_item keeps the item and quantity', async () => {
    const user = await open();
    await user.selectOptions(typeOf(1), 'consume_item');
    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[1]).toEqual({
      type: 'consume_item',
      slug: 'basic_charm',
      quantity: 3,
    });
  });

  it('switching to a percent loss or a buff saves the defaults it displays', async () => {
    const user = await open();
    await user.selectOptions(typeOf(0), 'waifubux_loss_percent');
    expect(within(effectRow(0)).getByLabelText('Percent (0–1)')).toHaveValue(0.1);
    await user.selectOptions(typeOf(2), 'temp_buff');
    expect(within(effectRow(2)).getByLabelText('Duration (s)')).toHaveValue(3600);
    await user.type(within(effectRow(2)).getByLabelText('Key'), 'lucky');

    const payload = await save(user);
    expect(payload.choices[0]!.successEffects[0]).toEqual({
      type: 'waifubux_loss_percent',
      percent: 0.1,
    });
    expect(payload.choices[0]!.failureEffects[0]).toEqual({
      type: 'temp_buff',
      key: 'lucky',
      durationSeconds: 3600,
    });
  });
});

describe('existing encounters', () => {
  it('saving without touching anything sends the canonical data unchanged', async () => {
    const user = await open();
    const payload = await save(user);
    expect(payload).toEqual(toPayload(draftFrom(encounter())));
    expect(payload.choices[0]!.successEffects).toEqual(encounter().choices[0]!.successEffects);
    expect(payload.choices[0]!.failureEffects).toEqual(encounter().choices[0]!.failureEffects);
    expect(payload.choices[1]!.successEffects).toEqual([]);
  });

  it('existing item effects display their stored quantity', async () => {
    await open();
    expect(quantityOf(1)).toHaveValue(3);
    expect(quantityOf(2)).toHaveValue(2);
  });
});

describe('a server validation failure', () => {
  it('names the effect and field the server rejected', async () => {
    updateSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The request was not valid.',
        details: {
          issues: [{ path: '/input/choices/0/successEffects/2/quantity', message: 'Required' }],
        },
      }),
    );
    const user = await open();
    await user.click(saveButton());

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByTestId('save-error-issues')).toHaveTextContent(
      'Choice #1, success effect #3 — quantity: Required',
    );
  });
});
