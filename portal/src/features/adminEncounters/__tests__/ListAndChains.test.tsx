/**
 * The encounter list (summaries, filters, persistence) and the Chains view.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { AdminEncountersListPage } from '../AdminEncountersListPage';
import { EncounterChainsPage } from '../EncounterChainsPage';
import { WorldEncountersNav } from '../WorldEncountersLayout';
import { ALL, REFERENCE, SETTINGS } from './authoringFixtures';

function wrapper(
  path = '/admin/encounters',
  permissions = ['admin.access', 'encounters.read', 'encounters.write', 'encounters.publish'],
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = {
      status: 'ready',
      session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
      error: null,
    } as unknown as SessionState;
    return (
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.spyOn(adminEncounters, 'listAdminEncounters').mockResolvedValue({ encounters: ALL });
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue(SETTINGS);
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const rows = () => screen.getAllByTestId('encounter-row');
const rowFor = (name: string) => rows().find((r) => within(r).queryByRole('link', { name }))!;
const visibleNames = () => rows().map((r) => within(r).getAllByRole('link')[0]!.textContent);

describe('encounter list', () => {
  it('summarises chain participation on each row without opening it', async () => {
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });
    expect(within(rowFor('A Strange Door')).getByTestId('row-summary')).toHaveTextContent(
      'TRAVEL · CHAIN ROOT · 3 CHOICES · 15M REPEAT',
    );
    expect(within(rowFor('Security Override')).getByTestId('row-summary')).toHaveTextContent(
      'CHAIN ONLY · CHILD OF: A Strange Door',
    );
    expect(within(rowFor('Market Stall')).getByTestId('row-summary')).toHaveTextContent(
      'OPENS VENDOR',
    );
    // Problems are visible from the list: the orphan and the broken link.
    expect(within(rowFor('Lonely Room')).getByTestId('row-issues')).toBeInTheDocument();
    expect(within(rowFor('Broken Bridge')).getByTestId('row-issues')).toBeInTheDocument();
  });

  it('filters by role, status, source and region', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });

    await user.selectOptions(screen.getByLabelText('Encounter role'), 'chain-only');
    expect(visibleNames()).toEqual(['Hidden Laboratory', 'Lonely Room', 'Security Override']);

    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    expect(visibleNames()).toEqual(['Lonely Room', 'Security Override']);

    await user.click(screen.getByRole('button', { name: /Clear 2 filters/ }));
    await user.selectOptions(screen.getByLabelText('Source'), 'travel');
    expect(visibleNames()).toEqual(['A Strange Door']);

    await user.selectOptions(screen.getByLabelText('Source'), 'all');
    await user.selectOptions(screen.getByLabelText('Region'), 'waifu-valley');
    expect(visibleNames()).not.toContain('Market Stall'); // Twin Peeks only
    expect(screen.getByTestId('encounter-count')).toHaveTextContent(`of ${ALL.length}`);
  });

  it('search finds encounters through the encounters they link to', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });
    await user.type(screen.getByLabelText('Search encounters'), 'hidden laboratory');
    expect(visibleNames()).toEqual(['Hidden Laboratory', 'Security Override']);
  });

  it('keeps the filters when the author comes back from the editor', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });
    await user.selectOptions(screen.getByLabelText('Encounter role'), 'root');
    unmount();

    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });
    expect(screen.getByLabelText('Encounter role')).toHaveValue('root');
    expect(visibleNames()).toEqual(['A Strange Door', 'Broken Bridge']);
  });

  it('keeps Edit visible and moves the rest into a menu', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await screen.findByRole('link', { name: 'A Strange Door' });
    const row = rowFor('A Strange Door');
    expect(within(row).getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/admin/encounters/1',
    );
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'More actions for A Strange Door' }));
    const menu = await screen.findByRole('menu');
    for (const action of ['Preview', 'View chain', 'Export…']) {
      expect(within(menu).getByRole('menuitem', { name: action })).toBeInTheDocument();
    }
    for (const action of ['Clone as draft', 'Disable', 'Delete']) {
      expect(within(menu).getByRole('menuitem', { name: action })).toBeInTheDocument();
    }
  });

  it('hides write actions from a read-only author', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, {
      wrapper: wrapper('/admin/encounters', ['admin.access', 'encounters.read']),
    });
    await screen.findByRole('link', { name: 'A Strange Door' });
    expect(screen.queryByRole('link', { name: 'New encounter' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions for A Strange Door' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Clone as draft' })).toBeNull();
  });

  it('flags Force Trigger even though its switch lives under Settings', async () => {
    vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue({
      ...SETTINGS,
      forceTrigger: true,
    });
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    expect(await screen.findByTestId('force-trigger-banner')).toHaveTextContent(
      'Force Trigger is on',
    );
  });
});

describe('section navigation', () => {
  it('lights the tab for the current page', () => {
    render(<WorldEncountersNav />, {
      wrapper: wrapper('/admin/encounters/vendors/wandering_merchant'),
    });
    expect(screen.getByRole('link', { name: 'Vendors' })).toHaveAttribute('aria-current', 'page');
    cleanup();
    render(<WorldEncountersNav />, { wrapper: wrapper('/admin/encounters/42') });
    expect(screen.getByRole('link', { name: 'Encounters' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('chains view', () => {
  it('draws each chain from its root with success and failure branches', async () => {
    render(<EncounterChainsPage />, { wrapper: wrapper('/admin/encounters/chains') });
    const trees = await screen.findAllByTestId('chain-tree');
    const door = trees.find((t) => within(t).queryByRole('link', { name: 'A Strange Door' }))!;
    expect(door).toHaveTextContent('“Open it”');
    expect(door).toHaveTextContent('On success →');
    expect(within(door).getByRole('link', { name: 'Security Override' })).toHaveAttribute(
      'href',
      '/admin/encounters/2',
    );
    expect(within(door).getByRole('link', { name: 'Hidden Laboratory' })).toBeInTheDocument();
    expect(door).toHaveTextContent('On failure →');
    expect(within(door).getByRole('link', { name: 'Alarm Triggered' })).toBeInTheDocument();
    // Chain children are not drawn as roots of their own.
    expect(trees).toHaveLength(2);
  });

  it('marks broken links and lists chain problems', async () => {
    render(<EncounterChainsPage />, { wrapper: wrapper('/admin/encounters/chains') });
    expect(await screen.findByTestId('chain-missing')).toHaveTextContent('“nowhere” — missing');
    const issues = screen.getByTestId('chain-issues');
    expect(issues).toHaveTextContent('“Lonely Room” is chain-only, but nothing links to it');
    expect(issues).toHaveTextContent('which is draft');
    expect(issues).toHaveTextContent('also appears on its own in Hunt');
  });

  it('focuses on the chains through one encounter', async () => {
    render(<EncounterChainsPage />, {
      wrapper: wrapper('/admin/encounters/chains?focus=hidden_laboratory'),
    });
    const trees = await screen.findAllByTestId('chain-tree');
    expect(trees).toHaveLength(1);
    expect(screen.getByText(/Showing chains through/)).toHaveTextContent('Hidden Laboratory');
  });
});
