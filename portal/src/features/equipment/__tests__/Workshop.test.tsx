/**
 * Patch's Workshop on `/equipment`, against the stateful fake of the
 * Equipment API (`msw/equipment.ts`).
 *
 * The rule under test: the Portal renders the server's Workshop — balances,
 * yields, recipe costs, slot availability, dismantle eligibility, previews —
 * and sends explicit choices with a request key. It decides no rule itself:
 * a refusal is the server's, shown as the server phrased it.
 *
 * Writes go through the shared API client (`postData`), whose cookie-session
 * CSRF header is pinned in `api/__tests__/client.test.ts`; the server's CSRF
 * and self-only enforcement on these routes is pinned in the API's
 * `equipmentWorkshopPortal` integration test. Here: every write addresses the
 * session's own player.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  createEquipmentBackend,
  gearItem,
  type EquipmentBackendOptions,
} from '../../../../msw/equipment';
import { PLAYER_ID } from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function gear() {
  return {
    ring: gearItem({ name: 'Training Ring', slot: 'attack', rarity: 'N' }),
    plate: gearItem({ name: 'Scrap Plate', slot: 'defense', rarity: 'N' }),
    pipe: gearItem({
      name: 'Rusty Pipe of Poor Planning',
      baseName: 'Rusty Pipe',
      slot: 'attack',
      rarity: 'N',
    }),
    knife: gearItem({ name: 'Combat Knife', slot: 'attack', rarity: 'R', multiplier: 0.8 }),
    coil: gearItem({ name: 'Plasma Coil Ring', slot: 'attack', rarity: 'SR', favorite: true }),
    belt: gearItem({ name: 'Padded Belt', slot: 'defense', rarity: 'N', locked: true }),
    relic: gearItem({ name: 'Ancient Relic', slot: 'attack', rarity: 'SSR' }),
  };
}

function setup(opts: Omit<EquipmentBackendOptions, 'items' | 'equipped'> = {}) {
  const items = gear();
  const backend = createEquipmentBackend({
    components: 18,
    waifubux: 4_250,
    ...opts,
    items: Object.values(items),
    equipped: { attack: items.ring.id },
  });
  server.use(...backend.handlers);
  const user = userEvent.setup();
  renderRoutes({ routes, initialEntries: ['/equipment'] });
  return { ...backend, items, user };
}

const workshopRegion = () => screen.findByRole('region', { name: "Patch's Workshop" });
const bagList = () => screen.findByRole('list', { name: 'Gear Bag items', hidden: true });
const box = (name: RegExp) => screen.findByRole('checkbox', { name });

async function startDismantling(user: ReturnType<typeof userEvent.setup>) {
  const panel = await workshopRegion();
  await within(panel).findByTestId('workshop-components');
  await user.click(within(panel).getByRole('button', { name: 'Dismantle Equipment' }));
  await screen.findByRole('region', { name: 'Dismantle selection' });
}

async function openFabricate(user: ReturnType<typeof userEvent.setup>) {
  const panel = await workshopRegion();
  await within(panel).findByTestId('workshop-components');
  await user.click(within(panel).getByRole('button', { name: 'Fabricate Equipment' }));
  return screen.findByRole('dialog', { name: 'Fabricate Equipment' });
}

/* ─────────────────────────── gate and overview ─────────────────────────── */

describe('Workshop overview', () => {
  it('is not offered while Equipment is locked, and nothing is requested', async () => {
    const { state } = setup({ unlocked: false });
    expect(await screen.findByRole('heading', { name: 'Equipment is locked' })).toBeInTheDocument();
    expect(screen.queryByText("Patch's Workshop")).toBeNull();
    expect(state.workshopRequests).toHaveLength(0);
  });

  it('shows both balances and the salvage values from the server', async () => {
    setup();
    const panel = await workshopRegion();
    expect(await within(panel).findByTestId('workshop-components')).toHaveTextContent('18');
    expect(within(panel).getByTestId('workshop-waifubux')).toHaveTextContent('4,250');
    expect(within(panel).getByTestId('workshop-yields')).toHaveTextContent(
      'Salvage value: N 1 · R 4 · SR 12',
    );
  });
});

describe('Workshop artwork', () => {
  it.each([
    ['the Workshop artwork', 'workshop'],
    ['Patch’s portrait (the fallback)', 'patch'],
  ] as const)(
    'shows %s the server resolved, through the image resolver',
    async (_label, source) => {
      setup({ workshopArtwork: source });
      const panel = await workshopRegion();
      const img = await within(panel).findByRole('img');
      // The same route whichever picture won — never a filesystem path.
      expect(img.getAttribute('src')).toBe(
        `/api/v1/players/${PLAYER_ID}/equipment/workshop/artwork?source=${source}`,
      );
      expect(img.getAttribute('src')).not.toMatch(/\.(webp|png|jpe?g|gif)/);
    },
  );

  it('is text-only when the server resolved no image', async () => {
    setup({ workshopArtwork: null });
    const panel = await workshopRegion();
    await within(panel).findByTestId('workshop-components');
    expect(within(panel).queryByRole('img')).toBeNull();
  });
});

/* ─────────────────────────── dismantling ─────────────────────────── */

describe('dismantling', () => {
  it('turns the Gear Bag into explicit checkboxes; protected copies are disabled with the reason', async () => {
    const { user } = setup();
    await startDismantling(user);
    expect(await box(/Rusty Pipe of Poor Planning/)).toBeEnabled();
    expect(await box(/Combat Knife/)).toBeEnabled();
    for (const [name, reason] of [
      [/Training Ring/, 'Equipped — unequip it first'],
      [/Plasma Coil Ring/, 'Favorite — unfavorite it first'],
      [/Padded Belt/, 'Locked — unlock it first'],
      [/Ancient Relic/, "Patch can't salvage this rarity yet"],
    ] as const) {
      const checkbox = await box(name);
      expect(checkbox).toBeDisabled();
      expect(checkbox).toHaveAccessibleDescription(expect.stringContaining(reason));
    }
    // Nothing is preselected and nothing dismantles by itself.
    expect(screen.getByTestId('dismantle-selected')).toHaveTextContent('0 selected');
    expect(screen.getByRole('button', { name: 'Review dismantle' })).toBeDisabled();
  });

  it('a protected copy cannot be selected by clicking it', async () => {
    const { user } = setup();
    await startDismantling(user);
    await user.click(await box(/Plasma Coil Ring/));
    expect(await box(/Plasma Coil Ring/)).not.toBeChecked();
    expect(screen.getByTestId('dismantle-selected')).toHaveTextContent('0 selected');
  });

  it('previews the server’s yield, then dismantles on Confirm and refreshes the bag and balance', async () => {
    const { user, state, items } = setup();
    await startDismantling(user);
    for (const name of [/Rusty Pipe of Poor Planning/, /Scrap Plate/, /Combat Knife/])
      await user.click(await box(name));
    expect(screen.getByTestId('dismantle-selected')).toHaveTextContent('3 selected');
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));

    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    expect(await within(dialog).findByTestId('dismantle-count')).toHaveTextContent('3 items');
    expect(within(dialog).getByRole('list', { name: 'By rarity' })).toHaveTextContent('2 N1 R');
    expect(within(dialog).getByTestId('dismantle-total')).toHaveTextContent(
      '6 Salvaged Components',
    );
    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    // Reviewing destroyed nothing.
    expect(state.items).toHaveLength(7);

    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Dismantled 3 items · +6 Salvaged Components.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    const write = state.workshopRequests.find((r) => r.path === 'dismantle')!;
    expect(write.body).toMatchObject({
      equipmentIds: [items.pipe.id, items.plate.id, items.knife.id],
      expectedComponents: 6,
      requestKey: expect.stringMatching(/^portal:/),
    });
    expect(write.playerId).toBe(String(PLAYER_ID));

    // Gear Bag and balance come back from the server — no reload.
    const list = await bagList();
    await waitFor(() => expect(within(list).queryByText('Combat Knife')).toBeNull());
    expect(within(list).getByText('Training Ring')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('workshop-components')).toHaveTextContent('24'));
    expect(screen.queryByRole('region', { name: 'Dismantle selection' })).toBeNull();
  });

  it('shows a copy’s combat bonuses while selecting and again in the review, so the player sees what is scrapped', async () => {
    const { user, state, items } = setup();
    state.items.find((i) => i.id === items.knife.id)!.combatBonuses = [
      { stat: 'crit_chance', label: 'Crit Chance', percent: 4.25, text: '+4.25% Crit Chance' },
      { stat: 'lifesteal', label: 'Lifesteal', percent: 2, text: '+2% Lifesteal' },
    ];
    await startDismantling(user);
    const knife = await box(/Combat Knife/);
    expect(knife).toHaveAccessibleDescription(expect.stringContaining('+4.25% Crit Chance'));
    expect(knife).toHaveAccessibleDescription(expect.stringContaining('+2% Lifesteal'));
    // A copy without bonuses gets no extra row.
    const plateCard = (await box(/Scrap Plate/)).closest('[data-testid="dismantle-card"]')!;
    expect(within(plateCard as HTMLElement).queryByTestId('combat-bonuses')).toBeNull();

    await user.click(knife);
    await user.click(await box(/Scrap Plate/));
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    await within(dialog).findByTestId('dismantle-total');
    const lines = within(within(dialog).getByRole('list', { name: 'Selected items' })).getAllByRole(
      'listitem',
    );
    const knifeLine = lines.find((li) => li.textContent?.includes('Combat Knife'))!;
    expect(
      within(knifeLine)
        .getAllByTestId('combat-bonus')
        .map((row) => row.textContent),
    ).toEqual(['+4.25% Crit Chance', '+2% Lifesteal']);
    const plateLine = lines.find((li) => li.textContent?.includes('Scrap Plate'))!;
    expect(within(plateLine).queryByTestId('combat-bonuses')).toBeNull();
    // The list is open without a click when something with bonuses is in it.
    expect(knifeLine.closest('details')).toHaveAttribute('open');
  });

  it('cancel destroys nothing', async () => {
    const { user, state } = setup();
    await startDismantling(user);
    await user.click(await box(/Combat Knife/));
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    await within(dialog).findByTestId('dismantle-total');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.workshopRequests.some((r) => r.path === 'dismantle')).toBe(false);
    expect(state.items).toHaveLength(7);
  });

  it('a stale selection (favourited elsewhere after picking) is refused, naming the copy', async () => {
    const { user, state, items } = setup();
    await startDismantling(user);
    await user.click(await box(/Combat Knife/));
    await user.click(await box(/Scrap Plate/));
    // Discord, another tab: the knife becomes a favourite.
    state.items.find((i) => i.id === items.knife.id)!.favorite = true;
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was dismantled.');
    expect(within(alert).getByRole('list', { name: 'Problems' })).toHaveTextContent(
      'Combat Knife: Favorite — unfavorite it first',
    );
    expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(state.items).toHaveLength(7);
  });

  it('a protection added between review and Confirm still destroys nothing', async () => {
    const { user, state, items } = setup();
    await startDismantling(user);
    await user.click(await box(/Combat Knife/));
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    await within(dialog).findByTestId('dismantle-total');
    state.items.find((i) => i.id === items.knife.id)!.locked = true;
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Combat Knife: Locked — unlock it first',
    );
    expect(state.items.some((i) => i.id === items.knife.id)).toBe(true);
  });

  it('a retried Confirm reuses the review’s request key, so nothing is dismantled twice', async () => {
    const { user, state } = setup();
    await startDismantling(user);
    await user.click(await box(/Combat Knife/));
    await user.click(screen.getByRole('button', { name: 'Review dismantle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismantle selected Equipment?' });
    await within(dialog).findByTestId('dismantle-total');
    // The first attempt fails on the way back (a dropped response) …
    state.failNextMutation = { status: 503, code: 'UNAVAILABLE', message: 'Try again shortly.' };
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Try again shortly.');
    // … Confirm is still there; clicking again sends the same key.
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Dismantled 1 item');
    const keys = state.workshopRequests
      .filter((r) => r.path === 'dismantle')
      .map((r) => r.body.requestKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

/* ─────────────────────────── fabrication ─────────────────────────── */

describe('fabrication', () => {
  it('lists recipes with costs and live slot availability', async () => {
    const { user } = setup();
    const dialog = await openFabricate(user);
    const recipes = within(dialog).getByRole('list', { name: 'Recipes' });
    expect(recipes).toHaveTextContent('Improved Rebuild');
    expect(recipes).toHaveTextContent('15 Components + 750 WaifuBux');
    const improved = within(dialog).getByRole('list', { name: 'Improved Rebuild availability' });
    expect(improved).toHaveTextContent('Attack — Available');
    expect(improved).toHaveTextContent('Health — 0 eligible');
    expect(improved).toHaveTextContent('Any — Available');
    expect(recipes).toHaveTextContent('Needs 22 more Salvaged Components.');
  });

  it('disables an unavailable slot, reviews the cost, fabricates and reveals the item', async () => {
    const { user, state } = setup();
    state.nextFabricated = {
      name: 'Combat Knife of Bad Decisions',
      baseName: 'Combat Knife',
      multiplier: 0.75,
    };
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Improved Rebuild' }));
    const slots = within(dialog).getByRole('group', { name: 'Slot' });
    expect(within(slots).getByRole('button', { name: 'Health — 0 eligible' })).toBeDisabled();
    await user.click(within(slots).getByRole('button', { name: 'Attack' }));

    expect(within(dialog).getByTestId('fabricate-summary')).toHaveTextContent(
      'Improved Rebuild · R · Attack',
    );
    expect(within(dialog).getByTestId('fabricate-cost')).toHaveTextContent(
      '15 Components + 750 WaifuBux',
    );
    expect(state.workshopRequests.some((r) => r.path === 'fabricate')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    const result = await within(dialog).findByTestId('fabricate-result');
    expect(result).toHaveTextContent('Combat Knife of Bad Decisions');
    expect(result).toHaveTextContent('Rarity: Rare');
    expect(result).toHaveTextContent('Attack');
    expect(result).toHaveTextContent('ATK ×0.75');
    expect(result).toHaveTextContent('of Bad Decisions');
    expect(within(dialog).getByTestId('fabricate-remaining')).toHaveTextContent(
      'Remaining: 3 Salvaged Components · 3,500 WaifuBux',
    );
    const write = state.workshopRequests.find((r) => r.path === 'fabricate')!;
    expect(write.body).toMatchObject({ recipeKey: 'improved_rebuild', slot: 'attack' });
    expect(write.playerId).toBe(String(PLAYER_ID));
    for (const leak of ['improved_rebuild', 'portal:'])
      expect(dialog.textContent).not.toContain(leak);

    // Inspect opens the new copy's detail; the bag already lists it.
    await user.click(within(dialog).getByRole('button', { name: 'Inspect' }));
    expect(
      await screen.findByRole('dialog', { name: 'Combat Knife of Bad Decisions' }),
    ).toBeInTheDocument();
    expect(
      await within(await bagList()).findByText('Combat Knife of Bad Decisions'),
    ).toBeInTheDocument();
  });

  it('reveals the secondary combat bonuses the fabricated item rolled', async () => {
    const { user, state } = setup({ components: 40, waifubux: 2_000 });
    state.nextFabricated = {
      name: 'Plasma Coil Ring',
      baseName: 'Plasma Coil Ring',
      multiplier: 0.9,
      combatBonuses: [
        { stat: 'crit_chance', label: 'Crit Chance', percent: 4.25, text: '+4.25% Crit Chance' },
        {
          stat: 'armor_penetration',
          label: 'Armor Penetration',
          percent: 6,
          text: '+6% Armor Penetration',
        },
      ],
    };
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Advanced Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Attack',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const result = await within(dialog).findByTestId('fabricate-result');
    expect(result).toHaveTextContent('ATK ×0.90');
    expect(within(result).getByText('Combat Bonuses')).toBeInTheDocument();
    expect(
      within(result)
        .getAllByTestId('combat-bonus')
        .map((row) => row.textContent),
    ).toEqual(['+4.25% Crit Chance', '+6% Armor Penetration']);
    for (const leak of ['crit_chance', 'armor_penetration'])
      expect(dialog.textContent).not.toContain(leak);
  });

  it('a fabricated item that rolled no bonus shows no Combat Bonuses row', async () => {
    const { user } = setup({ components: 40, waifubux: 2_000 });
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Standard Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Attack',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const result = await within(dialog).findByTestId('fabricate-result');
    expect(within(result).queryByText('Combat Bonuses')).toBeNull();
    expect(within(result).queryByTestId('combat-bonuses')).toBeNull();
  });

  it('Fabricate Again returns to Confirm with a fresh request key', async () => {
    const { user, state } = setup({ components: 40, waifubux: 2_000 });
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Standard Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Any / Surprise Me',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await within(dialog).findByTestId('fabricate-result');
    await user.click(within(dialog).getByRole('button', { name: 'Fabricate Again' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await within(dialog).findByTestId('fabricate-result');
    const keys = state.workshopRequests
      .filter((r) => r.path === 'fabricate')
      .map((r) => r.body.requestKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(state.items.filter((i) => i.source === 'Fabricated by Patch')).toHaveLength(2);
  });

  it('cannot confirm an unaffordable recipe', async () => {
    const { user } = setup({ components: 18, waifubux: 4_250 });
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Advanced Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Attack',
      }),
    );
    expect(within(dialog).getByText('Needs 22 more Salvaged Components.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it.each([
    [
      'insufficient Components (spent elsewhere meanwhile)',
      'INSUFFICIENT_COMPONENTS',
      'You need 15 Salvaged Components but only have 3.',
    ],
    ['insufficient WaifuBux', 'INSUFFICIENT_FUNDS', 'You need 750 WaifuBux but only have 100.'],
    [
      'no eligible definitions',
      'WORKSHOP_NO_ELIGIBLE_EQUIPMENT',
      'Patch has no blueprints for R attack Equipment yet. Nothing was charged.',
    ],
  ])('shows the server’s refusal for %s, charging nothing', async (_label, code, message) => {
    const { user, state } = setup();
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Improved Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Attack',
      }),
    );
    state.failNextMutation = { status: 422, code, message };
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(state.components).toBe(18);
    expect(state.waifubux).toBe(4_250);
    expect(state.items).toHaveLength(7);
  });

  it('a retried Confirm on the same step sends the same request key, and the server replays', async () => {
    const { user, state } = setup();
    const dialog = await openFabricate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Choose Improved Rebuild' }));
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Slot' })).getByRole('button', {
        name: 'Attack',
      }),
    );
    // The first attempt "fails" on the way back (a dropped response) …
    state.failNextMutation = { status: 503, code: 'UNAVAILABLE', message: 'Try again shortly.' };
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await within(dialog).findByRole('alert');
    // … the player clicks again: same key.
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await within(dialog).findByTestId('fabricate-result');
    const keys = state.workshopRequests
      .filter((r) => r.path === 'fabricate')
      .map((r) => r.body.requestKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
