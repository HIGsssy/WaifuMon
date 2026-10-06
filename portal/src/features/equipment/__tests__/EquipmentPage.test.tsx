/**
 * `/equipment` — what a player sees and can do, against a stateful fake of the
 * Equipment API (`msw/equipment.ts`).
 *
 * The rule under test throughout: the Portal renders the server's numbers and
 * sends the server actions. Stats, comparisons and roll quality are asserted
 * as the response delivered them; filters, search and sort are asserted as the
 * query parameters that reached the server *and* the cards that came back.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  createEquipmentBackend,
  gearItem,
  type EquipmentBackendOptions,
} from '../../../../msw/equipment';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';
import { CONFLICT_MESSAGE } from '../EquipmentDetailDialog';

function gear() {
  const ring = gearItem({
    name: 'Training Ring',
    slot: 'attack',
    multiplier: 0.5,
    range: { min: 0.5, max: 0.5 },
    rollQuality: 100,
  });
  const plate = gearItem({
    name: 'Scrap Plate',
    slot: 'defense',
    multiplier: 0.4,
    range: { min: 0.3, max: 0.5 },
  });
  const harness = gearItem({
    name: 'Basic Harness',
    slot: 'health',
    multiplier: 2,
    range: { min: 1.8, max: 2.2 },
  });
  const coil = gearItem({
    name: 'Plasma Coil Ring',
    slot: 'attack',
    rarity: 'SR',
    multiplier: 0.86,
    range: { min: 0.8, max: 0.95 },
    rollQuality: 40,
    favorite: true,
  });
  const knife = gearItem({
    name: 'Combat Knife of Bad Decisions',
    baseName: 'Combat Knife',
    slot: 'attack',
    rarity: 'R',
    multiplier: 0.8,
    range: { min: 0.65, max: 0.85 },
    rollQuality: 75,
  });
  return { ring, plate, harness, coil, knife };
}

function setup(
  opts: Omit<EquipmentBackendOptions, 'items' | 'equipped'> & { empty?: boolean } = {},
) {
  const items = gear();
  const backend = createEquipmentBackend({
    ...opts,
    items: opts.empty ? [] : Object.values(items),
    equipped: opts.empty ? {} : { attack: items.ring.id, defense: items.plate.id },
  });
  server.use(...backend.handlers);
  const user = userEvent.setup();
  renderRoutes({ routes, initialEntries: ['/equipment'] });
  return { ...backend, items, user };
}

/*
 * Background queries pass `hidden: true`: while the detail dialog is open,
 * Radix hides the page behind it from the accessibility tree, and the action
 * tests assert that the page *behind* the dialog refreshed.
 */
const bagList = () => screen.findByRole('list', { name: 'Gear Bag items', hidden: true });
const stat = (key: 'attack' | 'defense' | 'maxHp') => screen.getByTestId(`stat-${key}`);
const slotCell = (label: string) =>
  screen.getByRole('listitem', { name: `${label} slot`, hidden: true });
const lastBagRequest = (state: { bagRequests: URLSearchParams[] }) =>
  state.bagRequests[state.bagRequests.length - 1]!;

async function cardNames(): Promise<string[]> {
  const list = await bagList();
  return within(list)
    .getAllByTestId('equipment-card')
    .map((card) => card.querySelector('.font-medium')?.textContent ?? '');
}

async function openFromBag(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const list = await bagList();
  await user.click(within(list).getByRole('button', { name }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('button', { name: /Favorite|Unfavorite/ });
  return dialog;
}

async function chooseFilter(
  user: ReturnType<typeof userEvent.setup>,
  group: string,
  option: string,
) {
  await user.click(screen.getByRole('button', { name: 'Open filters' }));
  const fieldset = await screen.findByRole('group', { name: group });
  await user.click(within(fieldset).getByRole('button', { name: option }));
  await user.keyboard('{Escape}');
}

/* ─────────────────────────── gate ─────────────────────────── */

describe('locked Equipment', () => {
  it('renders the locked-feature page and requests no gear', async () => {
    const { state } = setup({ unlocked: false });
    expect(await screen.findByRole('heading', { name: 'Equipment is locked' })).toBeInTheDocument();
    expect(screen.getByText(/Level 35 Equipment onboarding/)).toBeInTheDocument();
    expect(screen.queryByText('Gear Bag')).toBeNull();
    expect(screen.queryByText('Training Ring')).toBeNull();
    expect(state.bagRequests).toHaveLength(0);
  });

  it('is the default for a player the API reports as locked', async () => {
    renderRoutes({ routes, initialEntries: ['/equipment'] });
    expect(await screen.findByRole('heading', { name: 'Equipment is locked' })).toBeInTheDocument();
  });
});

/* ─────────────────────────── overview ─────────────────────────── */

describe('overview', () => {
  it('shows the active Buddy and the stats the API calculated', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
    expect(screen.getByText(/Level 30 · 420 SP/)).toBeInTheDocument();
    expect(stat('attack')).toHaveTextContent('210');
    expect(stat('defense')).toHaveTextContent('168');
    // The health slot is empty: unavailable, not zero.
    expect(stat('maxHp')).toHaveTextContent('—');
    expect(screen.getByText('An empty slot leaves its stat unavailable.')).toBeInTheDocument();
  });

  it('shows the three slots, with an empty one stated as empty', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Current loadout' });
    expect(within(slotCell('Attack')).getByText('Training Ring')).toBeInTheDocument();
    expect(within(slotCell('Attack')).getByText('Equipped')).toBeInTheDocument();
    expect(within(slotCell('Defense')).getByText('Scrap Plate')).toBeInTheDocument();
    expect(within(slotCell('Health')).getByText('Health — Empty')).toBeInTheDocument();
    expect(
      within(slotCell('Health')).getByText('HP is unavailable while this slot is empty.'),
    ).toBeInTheDocument();
  });

  it('without a Buddy explains why stats are unavailable, and still lists gear', async () => {
    const { user } = setup({ buddy: null });
    expect(await screen.findByText('No active Buddy')).toBeInTheDocument();
    expect(stat('attack')).toHaveTextContent('—');
    expect(stat('defense')).toHaveTextContent('—');
    expect(stat('maxHp')).toHaveTextContent('—');
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    expect(
      within(dialog).getByText(/Set an active Buddy in Discord to see how this changes your ATK/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('With this item')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Equip' })).toBeEnabled();
  });
});

/* ─────────────────────────── gear bag ─────────────────────────── */

describe('Gear Bag', () => {
  it('lists one card per copy with the numbers a decision needs', async () => {
    setup();
    expect(await cardNames()).toHaveLength(5);
    const list = await bagList();
    const knife = within(list).getByRole('button', { name: /Combat Knife of Bad Decisions/ });
    expect(within(knife).getByText('ATK ×0.80')).toBeInTheDocument();
    expect(within(knife).getByText('Range ×0.65–0.85')).toBeInTheDocument();
    expect(within(knife).getByText('Roll 75%')).toBeInTheDocument();
    expect(within(knife).getByText('Rarity: Rare')).toBeInTheDocument();
    expect(within(knife).getByText('Attack')).toBeInTheDocument();
    const coil = within(list).getByRole('button', { name: /Plasma Coil Ring/ });
    expect(within(coil).getByText('Favorite')).toBeInTheDocument();
    const ring = within(list).getByRole('button', { name: /Training Ring/ });
    expect(within(ring).getByText('Equipped')).toBeInTheDocument();
  });

  it('shows a plain empty state for an empty bag', async () => {
    setup({ empty: true });
    expect(await screen.findByText('Your Gear Bag is empty')).toBeInTheDocument();
    expect(screen.getByText('Equipment you earn lands here.')).toBeInTheDocument();
  });

  it('pages with Load more instead of loading everything', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      gearItem({ name: `Spare Pipe ${i}`, slot: 'attack' }),
    );
    const backend = createEquipmentBackend({ items: many });
    server.use(...backend.handlers);
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/equipment'] });
    await waitFor(async () => expect(await cardNames()).toHaveLength(24));
    expect(lastBagRequest(backend.state).get('limit')).toBe('24');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await cardNames()).toHaveLength(30));
    expect(lastBagRequest(backend.state).get('cursor')).toBe('24');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('filters', () => {
  it('filters by slot on the server', async () => {
    const { state, user } = setup();
    await bagList();
    await chooseFilter(user, 'Slot', 'Defense');
    await waitFor(async () => expect(await cardNames()).toEqual(['Scrap Plate']));
    expect(lastBagRequest(state).get('slot')).toBe('defense');
  });

  it('filters by rarity', async () => {
    const { state, user } = setup();
    await bagList();
    await chooseFilter(user, 'Rarity', 'SR');
    await waitFor(async () => expect(await cardNames()).toEqual(['Plasma Coil Ring']));
    expect(lastBagRequest(state).get('rarity')).toBe('SR');
  });

  it('filters by equipped state', async () => {
    const { state, user } = setup();
    await bagList();
    await chooseFilter(user, 'Equipped', 'Unequipped');
    await waitFor(async () => expect(await cardNames()).toHaveLength(3));
    expect(lastBagRequest(state).get('equipped')).toBe('false');
  });

  it('filters by favourite, and says so when nothing is locked', async () => {
    const { state, user } = setup();
    await bagList();
    await chooseFilter(user, 'Favorite', 'Favorite');
    await waitFor(async () => expect(await cardNames()).toEqual(['Plasma Coil Ring']));
    expect(lastBagRequest(state).get('favorite')).toBe('true');
    await chooseFilter(user, 'Locked', 'Locked');
    expect(await screen.findByText('No gear matches')).toBeInTheDocument();
    expect(lastBagRequest(state).get('locked')).toBe('true');
  });
});

describe('search', () => {
  it('finds a copy by its base name', async () => {
    const { state, user } = setup();
    await bagList();
    await user.type(screen.getByRole('textbox', { name: 'Search your Gear Bag' }), 'Combat Knife');
    await waitFor(async () => expect(await cardNames()).toEqual(['Combat Knife of Bad Decisions']));
    expect(lastBagRequest(state).get('search')).toBe('Combat Knife');
  });

  it('finds a copy by its affix suffix', async () => {
    const { state, user } = setup();
    await bagList();
    await user.type(screen.getByRole('textbox', { name: 'Search your Gear Bag' }), 'Bad Decisions');
    await waitFor(async () => expect(await cardNames()).toEqual(['Combat Knife of Bad Decisions']));
    expect(lastBagRequest(state).get('search')).toBe('Bad Decisions');
  });
});

describe('sorting', () => {
  it('asks the server for the chosen order and renders it', async () => {
    const { state, user } = setup();
    await bagList();
    expect(lastBagRequest(state).get('sort')).toBe('newest');
    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    await user.click(await screen.findByRole('option', { name: 'Multiplier' }));
    await waitFor(() => expect(lastBagRequest(state).get('sort')).toBe('multiplier'));
    await waitFor(async () => expect((await cardNames())[0]).toBe('Basic Harness'));

    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    await user.click(await screen.findByRole('option', { name: 'Roll quality' }));
    await waitFor(async () => expect((await cardNames())[0]).toBe('Training Ring'));
    expect(lastBagRequest(state).get('sort')).toBe('quality');
  });
});

/* ─────────────────────────── detail ─────────────────────────── */

describe('item detail', () => {
  it('shows the roll, its range and roll quality next to the multiplier', async () => {
    const { user } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    expect(
      within(dialog).getByRole('heading', { name: 'Combat Knife of Bad Decisions' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('ATK ×0.80')).toBeInTheDocument();
    expect(within(dialog).getByText('×0.65–0.85')).toBeInTheDocument();
    expect(within(dialog).getByText('Roll quality')).toBeInTheDocument();
    expect(within(dialog).getByText('75%')).toBeInTheDocument();
    expect(within(dialog).getByText(/Boss/)).toBeInTheDocument();
  });

  it('compares against the equipped item using the server’s preview', async () => {
    const { user } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    const comparison = within(dialog).getByRole('region', { name: 'Comparison' });
    expect(within(comparison).getByText('Current ATK').nextSibling).toHaveTextContent('210');
    expect(within(comparison).getByText('With this item').nextSibling).toHaveTextContent('336');
    expect(within(comparison).getByText('Change').nextSibling).toHaveTextContent('+126');
    expect(
      within(comparison).getByText('Compared with Training Ring (×0.50).'),
    ).toBeInTheDocument();
  });

  it('compares against an empty slot', async () => {
    const { user } = setup();
    const dialog = await openFromBag(user, /Basic Harness/);
    const comparison = within(dialog).getByRole('region', { name: 'Comparison' });
    expect(within(comparison).getByText('Current HP').nextSibling).toHaveTextContent('—');
    expect(within(comparison).getByText('With this item').nextSibling).toHaveTextContent('840');
    expect(within(comparison).queryByText('Change')).toBeNull();
    expect(within(comparison).getByText('Your Health slot is empty.')).toBeInTheDocument();
  });

  it('says an equipped copy is already active', async () => {
    const { user } = setup();
    const dialog = await openFromBag(user, /Training Ring/);
    expect(within(dialog).getByText('Already active in your Attack slot.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Unequip' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Equip' })).toBeNull();
  });
});

/* ─────────────────────────── actions ─────────────────────────── */

describe('actions', () => {
  it('equips, and the stats, loadout and dialog all refresh from the server', async () => {
    const { user, state, items } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    await user.click(within(dialog).getByRole('button', { name: 'Equip' }));
    expect(await within(dialog).findByText('Equipped. ATK 210 → 336.')).toBeInTheDocument();
    expect(state.slots.attack).toBe(items.knife.id);
    await waitFor(() => expect(stat('attack')).toHaveTextContent('336'));
    expect(
      within(slotCell('Attack')).getByText('Combat Knife of Bad Decisions'),
    ).toBeInTheDocument();
    expect(
      await within(dialog).findByText('Already active in your Attack slot.'),
    ).toBeInTheDocument();
  });

  it('unequips, leaving the slot empty and its stat unavailable', async () => {
    const { user, state } = setup();
    await screen.findByRole('heading', { name: 'Current loadout' });
    await user.click(within(slotCell('Defense')).getByRole('button', { name: /Scrap Plate/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Unequip' }));
    expect(await within(dialog).findByText('Unequipped. DEF 168 → —.')).toBeInTheDocument();
    expect(state.slots.defense).toBeNull();
    await waitFor(() => expect(stat('defense')).toHaveTextContent('—'));
    expect(within(slotCell('Defense')).getByText('Defense — Empty')).toBeInTheDocument();
  });

  it('favourites and unfavourites a copy', async () => {
    const { user, items, state } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    await user.click(within(dialog).getByRole('button', { name: 'Favorite' }));
    expect(await within(dialog).findByRole('button', { name: 'Unfavorite' })).toBeInTheDocument();
    expect(state.items.find((i) => i.id === items.knife.id)!.favorite).toBe(true);
    expect(state.items.find((i) => i.id === items.knife.id)!.locked).toBe(false);
    const list = await bagList();
    await waitFor(() =>
      expect(
        within(within(list).getByRole('button', { name: /Combat Knife/, hidden: true })).getByText(
          'Favorite',
        ),
      ).toBeInTheDocument(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Unfavorite' }));
    expect(await within(dialog).findByRole('button', { name: 'Favorite' })).toBeInTheDocument();
  });

  it('locks and unlocks a copy, independently of favourite', async () => {
    const { user, items, state } = setup();
    const dialog = await openFromBag(user, /Plasma Coil Ring/);
    await user.click(within(dialog).getByRole('button', { name: 'Lock' }));
    expect(await within(dialog).findByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    const coil = state.items.find((i) => i.id === items.coil.id)!;
    expect(coil.locked).toBe(true);
    expect(coil.favorite).toBe(true);
    const list = await bagList();
    await waitFor(() =>
      expect(
        within(
          within(list).getByRole('button', { name: /Plasma Coil Ring/, hidden: true }),
        ).getByText('Locked'),
      ).toBeInTheDocument(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('shows a failed action as an error and changes nothing', async () => {
    const { user, state, items } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    state.failNextMutation = {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side.',
    };
    await user.click(within(dialog).getByRole('button', { name: 'Equip' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side.',
    );
    expect(state.slots.attack).toBe(items.ring.id);
    expect(stat('attack')).toHaveTextContent('210');
  });

  it('refuses a stale equip with a clear message, then shows the slot as it now is', async () => {
    const { user, state, items } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    // Swapped in Discord after this page loaded.
    state.slots.attack = items.coil.id;
    await user.click(within(dialog).getByRole('button', { name: 'Equip' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE);
    expect(state.slots.attack).toBe(items.coil.id);
    await waitFor(() =>
      expect(within(slotCell('Attack')).getByText('Plasma Coil Ring')).toBeInTheDocument(),
    );
    expect(
      await within(dialog).findByText('Compared with Plasma Coil Ring (×0.86).'),
    ).toBeInTheDocument();
    expect(stat('attack')).toHaveTextContent('361');
  });
});

/* ─────────────────────────── combat bonuses ─────────────────────────── */

describe('secondary combat bonuses', () => {
  const CRIT = {
    stat: 'crit_chance',
    label: 'Crit Chance',
    percent: 4.25,
    text: '+4.25% Crit Chance',
  } as const;
  const CRIT_DMG = {
    stat: 'crit_damage',
    label: 'Crit Damage',
    percent: 12.5,
    text: '+12.5% Crit Damage',
  } as const;
  const LIFESTEAL = {
    stat: 'lifesteal',
    label: 'Lifesteal',
    percent: 2,
    text: '+2% Lifesteal',
  } as const;

  /** An N copy with none, an R copy with one (equipped), an SR copy with two. */
  function setupBonuses(opts: Pick<EquipmentBackendOptions, 'combatModifiers'> = {}) {
    const items = {
      ring: gearItem({ name: 'Training Ring', slot: 'attack', rarity: 'N' }),
      knife: gearItem({
        name: 'Combat Knife',
        slot: 'attack',
        rarity: 'R',
        multiplier: 0.8,
        combatBonuses: [CRIT],
      }),
      coil: gearItem({
        name: 'Plasma Coil Ring',
        slot: 'attack',
        rarity: 'SR',
        multiplier: 0.86,
        combatBonuses: [CRIT_DMG, LIFESTEAL],
      }),
    };
    const backend = createEquipmentBackend({
      ...opts,
      items: Object.values(items),
      equipped: { attack: items.knife.id },
    });
    server.use(...backend.handlers);
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/equipment'] });
    return { ...backend, items, user };
  }

  const bonusRows = (within_: HTMLElement) =>
    within(within_)
      .queryAllByTestId('combat-bonus')
      .map((row) => row.textContent);

  it('an N item with no bonus shows nothing extra, on its card or in its detail', async () => {
    const { user } = setupBonuses();
    const list = await bagList();
    const ring = within(list).getByRole('button', { name: /Training Ring/ });
    expect(within(ring).getByText('ATK ×0.50')).toBeInTheDocument();
    expect(within(ring).queryByTestId('combat-bonuses')).toBeNull();
    expect(ring).not.toHaveTextContent(/bonus/i);

    const dialog = await openFromBag(user, /Training Ring/);
    expect(within(dialog).getByText('Multiplier').nextSibling).toHaveTextContent('ATK ×0.50');
    expect(within(dialog).queryByRole('region', { name: 'Combat Bonuses' })).toBeNull();
  });

  it('an R item with one bonus shows that row under its multiplier and in its detail', async () => {
    const { user } = setupBonuses();
    const list = await bagList();
    const knife = within(list).getByRole('button', { name: /Combat Knife/ });
    expect(within(knife).getByText('ATK ×0.80')).toBeInTheDocument();
    expect(bonusRows(knife)).toEqual(['+4.25% Crit Chance']);

    const dialog = await openFromBag(user, /Combat Knife/);
    expect(within(dialog).getByText('ATK ×0.80')).toBeInTheDocument();
    const section = within(dialog).getByRole('region', { name: 'Combat Bonuses' });
    expect(bonusRows(section)).toEqual(['+4.25% Crit Chance']);
  });

  it('an SR item with two bonuses shows both rows, as the server worded them', async () => {
    const { user } = setupBonuses();
    const list = await bagList();
    const coil = within(list).getByRole('button', { name: /Plasma Coil Ring/ });
    expect(bonusRows(coil)).toEqual(['+12.5% Crit Damage', '+2% Lifesteal']);

    const dialog = await openFromBag(user, /Plasma Coil Ring/);
    const section = within(dialog).getByRole('region', { name: 'Combat Bonuses' });
    expect(bonusRows(section)).toEqual(['+12.5% Crit Damage', '+2% Lifesteal']);
    // Never the bonus family's identifier or a basis-point value.
    for (const leak of ['crit_damage', 'lifesteal', '1250'])
      expect(dialog.textContent).not.toContain(leak);
  });

  it('shows the loadout’s cumulative totals from the server, and the equipped copy’s own bonuses', async () => {
    setupBonuses({
      combatModifiers: [
        { key: 'crit_chance', label: 'Crit', value: '9.75%' },
        { key: 'crit_damage', label: 'Crit DMG', value: '167.5%' },
      ],
    });
    await screen.findByRole('heading', { name: 'Current loadout' });
    const totals = screen.getByRole('list', { name: 'Combat Bonuses' });
    expect(
      within(totals)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Crit: 9.75%', 'Crit DMG: 167.5%']);
    expect(screen.getByTestId('loadout-combat-bonuses')).not.toHaveTextContent(/Bp/);
    expect(bonusRows(slotCell('Attack'))).toEqual(['+4.25% Crit Chance']);
  });

  it('omits the cumulative totals when the loadout has none', async () => {
    setupBonuses({ combatModifiers: [] });
    await screen.findByRole('heading', { name: 'Current loadout' });
    expect(stat('attack')).toHaveTextContent('336');
    expect(screen.queryByTestId('loadout-combat-bonuses')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Combat Bonuses' })).toBeNull();
  });

  it('compares both sides’ bonuses side by side, without scoring them', async () => {
    const { user } = setupBonuses();
    const dialog = await openFromBag(user, /Plasma Coil Ring/);
    const comparison = within(dialog).getByRole('region', { name: 'Comparison' });
    const current = within(comparison).getByRole('group', { name: 'Current' });
    expect(current).toHaveTextContent('Combat Knife');
    expect(current).toHaveTextContent('ATK ×0.80');
    expect(bonusRows(current)).toEqual(['+4.25% Crit Chance']);
    const candidate = within(comparison).getByRole('group', { name: 'Candidate' });
    expect(candidate).toHaveTextContent('Plasma Coil Ring');
    expect(candidate).toHaveTextContent('ATK ×0.86');
    expect(bonusRows(candidate)).toEqual(['+12.5% Crit Damage', '+2% Lifesteal']);
    // Differing bonus families are listed, not ranked.
    expect(within(comparison).getByTestId('bonus-comparison')).not.toHaveTextContent(
      /better|worse|upgrade|downgrade|score/i,
    );
  });

  it('compares a bonus-less candidate against an equipped copy that has one', async () => {
    const { user } = setupBonuses();
    const dialog = await openFromBag(user, /Training Ring/);
    const comparison = within(dialog).getByRole('region', { name: 'Comparison' });
    expect(bonusRows(within(comparison).getByRole('group', { name: 'Current' }))).toEqual([
      '+4.25% Crit Chance',
    ]);
    const candidate = within(comparison).getByRole('group', { name: 'Candidate' });
    expect(bonusRows(candidate)).toEqual([]);
    expect(candidate).toHaveTextContent('No combat bonuses');
  });

  it('leaves the comparison as it was when neither side has a bonus', async () => {
    const { user } = setup();
    const dialog = await openFromBag(user, /Combat Knife of Bad Decisions/);
    const comparison = within(dialog).getByRole('region', { name: 'Comparison' });
    expect(
      within(comparison).getByText('Compared with Training Ring (×0.50).'),
    ).toBeInTheDocument();
    expect(within(comparison).queryByTestId('bonus-comparison')).toBeNull();
  });
});
