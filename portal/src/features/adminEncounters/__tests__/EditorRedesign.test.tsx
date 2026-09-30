/**
 * The redesigned encounter editor: existing content loads and saves unchanged,
 * a simple encounter needs nothing from Advanced, cooldowns are friendly
 * durations, follow-ups are picked or created without slugs, and vendors are
 * picked, previewed and created in place.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import type { AdminEncounter, EncounterInputPayload } from '@/api/adminEncounters';
import * as adminVendors from '@/api/adminVendors';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { AdminEncounterEditorPage } from '../AdminEncounterEditorPage';
import { draftFrom, toPayload } from '../encounterDraft';
import {
  ALARM,
  ALL,
  DOOR,
  MERCHANT,
  ORPHAN,
  OVERRIDE,
  REFERENCE,
  SETTINGS,
  STALL,
  enc,
} from './authoringFixtures';

let store: Map<number, AdminEncounter>;
let updateSpy: MockInstance<typeof adminEncounters.updateAdminEncounter>;
let createSpy: MockInstance<typeof adminEncounters.createAdminEncounter>;
let createVendorSpy: MockInstance<typeof adminVendors.createAdminVendor>;

function fromPayload(id: number, input: EncounterInputPayload): AdminEncounter {
  return enc({
    ...input,
    id,
    choices: input.choices.map((c, i) => ({ ...c, id: id * 10 + i, sortOrder: i })),
  });
}

beforeEach(() => {
  store = new Map(ALL.map((e) => [e.id, e]));
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue(SETTINGS);
  vi.spyOn(adminEncounters, 'listAdminEncounters').mockImplementation(async () => ({
    encounters: [...store.values()],
  }));
  vi.spyOn(adminEncounters, 'getAdminEncounter').mockImplementation(async (id) => {
    const e = store.get(id);
    if (!e) throw new Error(`no encounter ${id}`);
    return e;
  });
  updateSpy = vi
    .spyOn(adminEncounters, 'updateAdminEncounter')
    .mockImplementation(async (id, input) => {
      const saved = fromPayload(id, input);
      store.set(id, saved);
      return saved;
    });
  createSpy = vi
    .spyOn(adminEncounters, 'createAdminEncounter')
    .mockImplementation(async (input) => {
      const saved = fromPayload(100 + store.size, input);
      store.set(saved.id, saved);
      return saved;
    });
  vi.spyOn(adminVendors, 'listAdminVendors').mockResolvedValue({ vendors: [MERCHANT] });
  createVendorSpy = vi
    .spyOn(adminVendors, 'createAdminVendor')
    .mockImplementation(async (input) => ({
      ...input,
      updatedAt: '2026-09-30T00:00:00.000Z',
      usedBy: [],
    }));
});
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string) {
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
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(
    <Routes>
      <Route path="/admin/encounters/new" element={<AdminEncounterEditorPage />} />
      <Route path="/admin/encounters/:id" element={<AdminEncounterEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

async function openEncounter(e: AdminEncounter) {
  const user = renderAt(`/admin/encounters/${e.id}`);
  await screen.findByText(`Edit — ${e.name}`);
  // The chain graph arrives with the encounter list.
  await waitFor(() => expect(adminEncounters.listAdminEncounters).toHaveBeenCalled());
  return user;
}

const saveButton = () => screen.getByRole('button', { name: /^(Save changes|Create encounter)$/ });

async function save(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(saveButton()).toBeEnabled());
  await user.click(saveButton());
  await waitFor(() =>
    expect(updateSpy.mock.calls.length + createSpy.mock.calls.length).toBeGreaterThan(0),
  );
  return (updateSpy.mock.calls.at(-1)?.[1] ?? createSpy.mock.calls.at(-1)?.[0])!;
}

describe('an existing encounter', () => {
  it('loads as collapsed choice summaries', async () => {
    await openEncounter(DOOR);
    const card = screen.getAllByTestId('choice-card')[0]!;
    expect(within(card).getByRole('heading', { name: 'Open it' })).toBeInTheDocument();
    expect(within(card).getByTestId('choice-requirement')).toHaveTextContent('None');
    expect(within(card).getByTestId('choice-resolution')).toHaveTextContent(
      'Skill check · 50% base, ±15% from Buddy SP',
    );
    expect(within(card).getByTestId('choice-on-success')).toHaveTextContent(
      'Gain 3 Energy, +10 Player XP',
    );
    expect(within(card).getByTestId('choice-on-failure')).toHaveTextContent('Lose 2 Energy');
    await waitFor(() =>
      expect(within(card).getByTestId('choice-follow-up')).toHaveTextContent(
        'On success → Security Override · On failure → Alarm Triggered',
      ),
    );
    // Nothing is editable until asked for.
    expect(screen.queryAllByTestId('effect-editor')).toHaveLength(0);
  });

  it('saves unchanged data when nothing is touched', async () => {
    const user = await openEncounter(DOOR);
    expect(await save(user)).toEqual(toPayload(draftFrom(DOOR)));
  });

  it('shows the repeat cooldown as a friendly duration and explains the real pacing', async () => {
    await openEncounter(DOOR);
    expect(screen.getByLabelText('Repeat cooldown for this encounter')).toHaveValue(15);
    expect(screen.getByLabelText('Repeat cooldown for this encounter unit')).toHaveValue('minutes');
    const explanation = await screen.findByTestId('cooldown-explanation');
    await waitFor(() => expect(explanation).toHaveTextContent('every hunt has a 35% chance'));
    expect(explanation).toHaveTextContent('There is no global World Encounter cooldown');
    expect(explanation).toHaveTextContent('cannot appear for them on its own again for 15 minutes');
  });

  it('stores a friendly cooldown as seconds', async () => {
    const user = await openEncounter(DOOR);
    const value = screen.getByLabelText('Repeat cooldown for this encounter');
    await user.clear(value);
    await user.type(value, '6');
    await user.selectOptions(
      screen.getByLabelText('Repeat cooldown for this encounter unit'),
      'hours',
    );
    expect(screen.getByTestId('cooldown-explanation')).toHaveTextContent('for 6 hours');
    expect((await save(user)).cooldownSeconds).toBe(6 * 3600);
  });

  it('says a chain follow-up is opened by its chain, not the normal cooldown', async () => {
    await openEncounter(OVERRIDE);
    await waitFor(() =>
      expect(screen.getByTestId('cooldown-explanation')).toHaveTextContent(
        'This encounter is triggered as part of a chain',
      ),
    );
    const chain = screen.getByTestId('chain-context');
    expect(within(chain).getByRole('link', { name: 'A Strange Door' })).toHaveAttribute(
      'href',
      '/admin/encounters/1',
    );
    expect(chain).toHaveTextContent('“Open it” · on success');
  });

  it('blocks saving a chain-only encounter nothing links to', async () => {
    await openEncounter(ORPHAN);
    expect(await screen.findByTestId('save-blockers')).toHaveTextContent('can never appear');
    expect(saveButton()).toBeDisabled();
  });
});

describe('preview drawer', () => {
  it('opens beside the editor and closes with its own label', async () => {
    const user = await openEncounter(DOOR);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Compute preview' })).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('creating a simple encounter', () => {
  it('starts with a template choice and needs nothing from Advanced', async () => {
    const user = renderAt('/admin/encounters/new');
    await user.click(await screen.findByRole('button', { name: /Simple encounter/ }));
    await user.type(await screen.findByLabelText('Name'), 'Quiet Pond');
    expect(screen.getByTestId('section-advanced')).not.toHaveAttribute('open');
    const payload = await save(user);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      slug: 'quiet_pond',
      name: 'Quiet Pond',
      lifecycle: 'draft',
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      chainedEncounterSlug: null,
      choices: [
        { label: 'Continue', check: { type: 'none' }, successEffects: [], failureEffects: [] },
      ],
    });
  });

  it('never generates a slug that would replace an existing encounter', async () => {
    const user = renderAt('/admin/encounters/new?template=simple');
    await waitFor(() => expect(adminEncounters.listAdminEncounters).toHaveBeenCalled());
    await screen.findByText('New encounter');
    await user.type(screen.getByLabelText('Name'), 'Market Stall');
    // Derived from the name against every existing slug, whenever the list lands.
    await waitFor(() => expect(screen.getByLabelText('Slug')).toHaveValue('market_stall_2'));
    expect((await save(user)).slug).toBe('market_stall_2');
  });

  it('a skill-check template shows the failure branch', async () => {
    const user = renderAt('/admin/encounters/new');
    await user.click(await screen.findByRole('button', { name: /Skill-check encounter/ }));
    expect(await screen.findAllByText('On failure')).not.toHaveLength(0);
    expect(screen.getAllByLabelText('Resolution')[0]).toHaveValue('sp');
  });
});

describe('follow-ups', () => {
  it('continues to an existing encounter picked by name', async () => {
    const user = await openEncounter(ALARM);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('button', { name: 'Continue to another encounter' }));
    const picker = screen.getByLabelText('Continue to');
    // Options describe status and how each encounter appears.
    expect(
      within(picker).getByRole('option', {
        name: /Security Override — draft · chain-only · linked from 1/,
      }),
    ).toBeInTheDocument();
    await user.selectOptions(picker, 'hidden_laboratory');
    expect(screen.getByTestId('follow-up-summary')).toHaveTextContent('Hidden Laboratory');
    expect(screen.getByTestId('follow-up-summary')).toHaveTextContent(
      'also linked from Security Override',
    );
    const payload = await save(user);
    expect(payload.choices[0]!.successEffects).toEqual([
      { type: 'trigger_encounter', encounterSlug: 'hidden_laboratory' },
    ]);
  });

  it('creates a follow-up, links it, saves this encounter and opens the new one', async () => {
    const user = await openEncounter(ALARM);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('button', { name: 'Create new follow-up' }));
    await user.type(screen.getByLabelText('Follow-up encounter name'), 'Back Exit');
    await user.click(screen.getByRole('button', { name: 'Create and open' }));

    await screen.findByText('Edit — Back Exit');
    // Parent saved first, with the link, so the new encounter is reachable.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]![0]).toBe(ALARM.id);
    expect(updateSpy.mock.calls[0]![1].choices[0]!.successEffects).toEqual([
      { type: 'trigger_encounter', encounterSlug: 'back_exit' },
    ]);
    expect(updateSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      createSpy.mock.invocationCallOrder[0]!,
    );
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      slug: 'back_exit',
      name: 'Back Exit',
      lifecycle: 'draft',
      huntEligible: false,
      travelEligible: false,
    });
    // The new encounter shows where it is reached from.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('chain-context')).getByRole('link', { name: 'Alarm Triggered' }),
      ).toBeInTheDocument(),
    );
  });
});

describe('choice requirements', () => {
  it('stores picked items and races, not typed slugs', async () => {
    const user = await openEncounter(ALARM);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.selectOptions(screen.getByLabelText('Add requirement'), 'requiresItem');
    await user.selectOptions(screen.getByLabelText('Required item'), 'basic_charm');
    await user.selectOptions(screen.getByLabelText('Add requirement'), 'raceAny');
    await user.click(
      within(screen.getByRole('group', { name: 'Buddy race (any of)' })).getByRole('button', {
        name: 'Demon',
      }),
    );
    const payload = await save(user);
    expect(payload.choices[0]!.requirements).toEqual({
      requiresItem: 'basic_charm',
      raceAny: ['demon'],
    });
  });
});

describe('vendors in the encounter editor', () => {
  it('shows the vendor by name and previews its inventory', async () => {
    const user = await openEncounter(STALL);
    expect(screen.getAllByTestId('choice-card')[0]).toHaveTextContent(
      'Open vendor: The Wandering Merchant',
    );
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const vendor = await screen.findByTestId('vendor-effect');
    expect(within(vendor).getByLabelText('Vendor')).toHaveValue('wandering_merchant');
    await user.click(within(vendor).getByRole('button', { name: 'Preview inventory' }));
    const preview = screen.getByTestId('vendor-inventory-preview');
    expect(preview).toHaveTextContent('Basic Charm');
    expect(preview).toHaveTextContent('75 WB · 3 per visit');
  });

  it('creates a vendor from the choice and links it', async () => {
    const user = await openEncounter(STALL);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(await screen.findByRole('button', { name: 'Create new vendor' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Night Market');
    expect(dialog).toHaveTextContent('Key: night_market');
    await user.selectOptions(within(dialog).getByLabelText('Add item'), 'energy_drink');
    await user.click(within(dialog).getByRole('button', { name: 'Add to inventory' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create and link vendor' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createVendorSpy).toHaveBeenCalledWith({
      vendorKey: 'night_market',
      name: 'Night Market',
      description: '',
      stock: [{ itemSlug: 'energy_drink', quantity: 1, price: 100, currency: 'waifubux' }],
    });
    expect(screen.getByLabelText('Vendor')).toHaveValue('night_market');
    const payload = await save(user);
    expect(payload.choices[0]!.successEffects).toEqual([
      { type: 'open_vendor', vendorKey: 'night_market' },
    ]);
  });

  it('warns when the chosen vendor has no inventory', async () => {
    vi.spyOn(adminVendors, 'listAdminVendors').mockResolvedValue({
      vendors: [{ ...MERCHANT, stock: [] }],
    });
    await openEncounter(STALL);
    expect(await screen.findByTestId('validation-warnings')).toHaveTextContent(
      'The Wandering Merchant” has no inventory',
    );
    expect(saveButton()).toBeEnabled();
  });
});
