/**
 * Encounter Manager — row-level selection and its wiring into Export Selected.
 *
 * The Encounter Manager owed the promotion panel a way to *pick* encounters.
 * Before this change it never rendered anything selectable, so Export Selected
 * was always disabled. These tests cover the pieces that make the workflow
 * actually work:
 *
 *   - a checkbox per row and a header Select-All that respects the active
 *     filter (never reaches encounters the author cannot see),
 *   - selection that survives filtering, so an author can select, refine, add
 *     more, and export both,
 *   - Export Selected sends exactly the checked slugs — never every encounter
 *     silently when nothing is checked,
 *   - Export All is unaffected,
 *   - a Clear affordance that resets selection.
 *
 * Only the client is exercised: `exportAdminEncounters` is spied so we can
 * inspect the exact payload, and the file download side-effect is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import { AdminEncountersListPage } from '../AdminEncountersListPage';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import * as adminEncounters from '@/api/adminEncounters';
import type { AdminEncounter } from '@/api/adminEncounters';

const PUBLISHER = [
  'admin.access',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
];

function session(permissions: readonly string[]): SessionState {
  const s: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Operator',
    avatarUrl: null,
    permissions,
  };
  return { status: 'ready', session: s, error: null } as unknown as SessionState;
}

function wrapper(permissions: readonly string[] = PUBLISHER) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session(permissions)}>
          <MemoryRouter initialEntries={['/admin/encounters']}>{children}</MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    );
  };
}

function encounter(over: Partial<AdminEncounter>): AdminEncounter {
  return {
    id: 0,
    slug: '',
    name: '',
    description: '',
    type: 'decision',
    rarity: 'common',
    weight: 10,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [],
    metadata: {},
    ...over,
  };
}

const A = encounter({ id: 1, slug: 'tv_alpha', name: 'Alpha' });
const B = encounter({ id: 2, slug: 'tv_bravo', name: 'Bravo' });
const C = encounter({ id: 3, slug: 'tv_charlie', name: 'Charlie' });

const EXPORTED = {
  format: 'waifumon-world-encounters',
  version: 1,
  exportedAt: '2026-09-11T00:00:00.000Z',
  label: null,
  vendors: [],
  encounters: [{ slug: 'tv_alpha', name: 'Alpha' }],
};

beforeEach(() => {
  vi.spyOn(adminEncounters, 'listAdminEncounters').mockResolvedValue({
    encounters: [A, B, C],
  });
  vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue({
    huntChance: 0,
    travelChance: 0,
    defaultExpirySeconds: 60,
    forceTrigger: false,
    updatedAt: null,
    updatedBy: null,
    bounds: {
      chance: { min: 0, max: 1 },
      expirySeconds: { min: 30, max: 86_400 },
    },
  });
  // The panel triggers a synthetic download on success. jsdom cannot navigate
  // and would log a stack that buries the real failure, so it is a no-op here.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function waitForRows() {
  await screen.findByText('Alpha');
  await screen.findByText('Bravo');
  await screen.findByText('Charlie');
}

const rowCheckbox = (name: string) =>
  screen.getByRole('checkbox', { name: `Select ${name}` });
const selectAll = () =>
  screen.getByRole('checkbox', { name: /select all encounters/i });
const exportSelectedBtn = () =>
  screen.getByRole('button', { name: /^export selected/i });
const exportAllBtn = () => screen.getByRole('button', { name: /export all encounters/i });

describe('per-row selection', () => {
  it('starts with nothing checked and Export Selected disabled', async () => {
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    expect(rowCheckbox('Alpha')).not.toBeChecked();
    expect(rowCheckbox('Bravo')).not.toBeChecked();
    expect(rowCheckbox('Charlie')).not.toBeChecked();
    expect(exportSelectedBtn()).toBeDisabled();
    expect(screen.queryByTestId('encounter-selection-status')).not.toBeInTheDocument();
  });

  it('checks a single encounter and exposes the count', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Bravo'));

    expect(rowCheckbox('Bravo')).toBeChecked();
    expect(rowCheckbox('Alpha')).not.toBeChecked();
    expect(
      within(screen.getByTestId('encounter-selection-status')).getByText('1 selected'),
    ).toBeInTheDocument();
    expect(exportSelectedBtn()).toBeEnabled();
    expect(exportSelectedBtn()).toHaveTextContent(/export selected \(1\)/i);
  });

  it('checks multiple encounters', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Alpha'));
    await user.click(rowCheckbox('Charlie'));

    expect(rowCheckbox('Alpha')).toBeChecked();
    expect(rowCheckbox('Bravo')).not.toBeChecked();
    expect(rowCheckbox('Charlie')).toBeChecked();
    expect(screen.getByTestId('encounter-selection-status')).toHaveTextContent(
      '2 selected',
    );
  });

  it('deselects when clicked a second time', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Alpha'));
    await user.click(rowCheckbox('Alpha'));

    expect(rowCheckbox('Alpha')).not.toBeChecked();
    expect(exportSelectedBtn()).toBeDisabled();
  });

  it('does not navigate when the checkbox is clicked', async () => {
    // A checkbox in the row must not be confused with the Name link that
    // opens the editor — the two are separate interactions.
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    const link = screen.getByRole('link', { name: 'Alpha' });
    expect(link).toHaveAttribute('href', '/admin/encounters/1');

    await user.click(rowCheckbox('Alpha'));

    expect(rowCheckbox('Alpha')).toBeChecked();
    // The MemoryRouter would swap out the page on navigation; the Edit link
    // for Alpha still being on screen confirms the row was not opened.
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });
});

describe('Select all', () => {
  it('selects every row currently in view', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(selectAll());

    expect(rowCheckbox('Alpha')).toBeChecked();
    expect(rowCheckbox('Bravo')).toBeChecked();
    expect(rowCheckbox('Charlie')).toBeChecked();
    expect(screen.getByTestId('encounter-selection-status')).toHaveTextContent(
      '3 selected',
    );
  });

  it('goes to an indeterminate state when a row is deselected', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(selectAll());
    await user.click(rowCheckbox('Bravo'));

    const header = selectAll() as HTMLInputElement;
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(true);
  });

  it('a second click while all are selected clears them', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(selectAll());
    await user.click(selectAll());

    expect(rowCheckbox('Alpha')).not.toBeChecked();
    expect(rowCheckbox('Bravo')).not.toBeChecked();
    expect(rowCheckbox('Charlie')).not.toBeChecked();
    expect(exportSelectedBtn()).toBeDisabled();
  });
});

describe('selection survives filtering', () => {
  it('lets an author select, narrow the list, select again, and export both', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue(EXPORTED);
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Alpha'));

    await user.type(screen.getByPlaceholderText(/search name or slug/i), 'charlie');
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Charlie')).toBeInTheDocument();

    // Alpha is no longer on screen but its selection is preserved.
    expect(screen.getByTestId('encounter-selection-status')).toHaveTextContent(
      '1 selected',
    );

    await user.click(rowCheckbox('Charlie'));
    expect(screen.getByTestId('encounter-selection-status')).toHaveTextContent(
      '2 selected',
    );

    await user.click(exportSelectedBtn());

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const call = exportSpy.mock.calls.at(0)?.[0];
    if (!call) throw new Error('Expected exportAdminEncounters to have been called');
    if (!call.slugs) throw new Error('Expected export call to contain slugs');
    expect([...call.slugs].sort()).toEqual(['tv_alpha', 'tv_charlie']);
  });

  it('Select-all only reaches rows the filter shows', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue(EXPORTED);
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.type(screen.getByPlaceholderText(/search name or slug/i), 'bravo');
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());

    await user.click(selectAll());
    expect(rowCheckbox('Bravo')).toBeChecked();
    expect(screen.getByTestId('encounter-selection-status')).toHaveTextContent(
      '1 selected',
    );

    await user.click(exportSelectedBtn());
    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const call = exportSpy.mock.calls.at(0)?.[0];
    if (!call) throw new Error('Expected exportAdminEncounters to have been called');
    if (!call.slugs) throw new Error('Expected export call to contain slugs');
    expect(call.slugs).toEqual(['tv_bravo']);
  });
});

describe('Export wiring', () => {
  it('sends exactly the checked slugs, in no particular order', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue(EXPORTED);
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Alpha'));
    await user.click(rowCheckbox('Charlie'));
    await user.click(exportSelectedBtn());

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const call = exportSpy.mock.calls.at(0)?.[0];
    if (!call) throw new Error('Expected exportAdminEncounters to have been called');
    if (!call.slugs) throw new Error('Expected export call to contain slugs');
    expect(call.label).toBeNull();
    expect([...call.slugs].sort()).toEqual(['tv_alpha', 'tv_charlie']);
  });

  it('Export All is unchanged: it sends an empty selection', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue(EXPORTED);
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    // Even if the author has a partial selection, Export All must ignore it —
    // otherwise selecting one encounter would silently redefine "all".
    await user.click(rowCheckbox('Alpha'));
    await user.click(exportAllBtn());

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const call = exportSpy.mock.calls.at(0)?.[0];
    if (!call) throw new Error('Expected exportAdminEncounters to have been called');
    expect(call).toEqual({ slugs: [], label: null });
  });

  it('Export Selected is disabled with zero checked', async () => {
    const exportSpy = vi.spyOn(adminEncounters, 'exportAdminEncounters');
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    expect(exportSelectedBtn()).toBeDisabled();
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe('Clear selection', () => {
  it('resets every checked row and disables Export Selected', async () => {
    const user = userEvent.setup();
    render(<AdminEncountersListPage />, { wrapper: wrapper() });
    await waitForRows();

    await user.click(rowCheckbox('Alpha'));
    await user.click(rowCheckbox('Bravo'));
    await user.click(
      within(screen.getByTestId('encounter-selection-status')).getByRole('button', {
        name: /clear selection/i,
      }),
    );

    expect(rowCheckbox('Alpha')).not.toBeChecked();
    expect(rowCheckbox('Bravo')).not.toBeChecked();
    expect(screen.queryByTestId('encounter-selection-status')).not.toBeInTheDocument();
    expect(exportSelectedBtn()).toBeDisabled();
  });
});
