/**
 * The Global Encounter Settings panel.
 *
 * Two things it owes an operator, and both are tested here: it shows what the
 * server is *actually* using (not just what is in the inputs), and it makes
 * Force Trigger impossible to miss when it is on.
 *
 * The save path is tested for the property that matters at the API boundary —
 * it sends only what changed — because a full-object PUT would let two people
 * editing different fields silently overwrite each other.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { GlobalEncounterSettingsPanel } from '../GlobalEncounterSettingsPanel';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import * as adminEncounters from '@/api/adminEncounters';
import type { AdminEncounterSettings } from '@/api/adminEncounters';

const BOUNDS = {
  chance: { min: 0, max: 1 },
  expirySeconds: { min: 30, max: 86_400 },
};

function settings(overrides: Partial<AdminEncounterSettings> = {}): AdminEncounterSettings {
  return {
    huntChance: 0.35,
    travelChance: 0.2,
    defaultExpirySeconds: 600,
    forceTrigger: false,
    updatedAt: null,
    updatedBy: null,
    bounds: BOUNDS,
    ...overrides,
  };
}

function sessionState(permissions: readonly string[]): SessionState {
  const session: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Owner',
    avatarUrl: null,
    permissions,
  };
  return {
    status: 'ready',
    session,
    error: null,
    configuredPlayerId: undefined,
    retry: () => {},
  };
}

function Wrap({
  children,
  permissions = ['admin.access', 'encounters.read', 'encounters.publish'],
}: {
  children: ReactNode;
  permissions?: readonly string[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        {children}
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue(settings());
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('effective values', () => {
  it('shows what the server is currently using', async () => {
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );

    const effective = await screen.findByTestId('effective-settings');
    expect(effective.textContent).toContain('35.0%');
    expect(effective.textContent).toContain('20.0%');
    expect(effective.textContent).toContain('600s');
  });

  it('keeps showing the live value while an edit is unsaved', async () => {
    // The disagreement between "live" and the input is the useful part: an
    // unsaved edit must never look like the running configuration.
    const user = userEvent.setup();
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );
    await screen.findByTestId('effective-settings');

    const huntInput = screen.getByDisplayValue('0.35');
    await user.clear(huntInput);
    await user.type(huntInput, '0.9');

    expect(screen.getByTestId('effective-settings').textContent).toContain('35.0%');
    expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  });
});

describe('force trigger is impossible to miss', () => {
  it('shows no warning when it is off', async () => {
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );
    await screen.findByTestId('effective-settings');

    expect(screen.queryByTestId('force-trigger-badge')).toBeNull();
    expect(screen.queryByTestId('force-trigger-warning')).toBeNull();
  });

  it('shows a badge and a warning when it is on', async () => {
    vi.spyOn(adminEncounters, 'getAdminEncounterSettings').mockResolvedValue(
      settings({ forceTrigger: true }),
    );
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );

    expect(await screen.findByTestId('force-trigger-badge')).toBeTruthy();
    const warning = screen.getByTestId('force-trigger-warning');
    // Says what it does *and* what it does not do, so nobody reads it as a
    // licence to ignore cooldowns.
    expect(warning.textContent).toContain('Every eligible hunt and travel');
    expect(warning.textContent).toContain('Cooldowns, region rules');
  });
});

describe('saving', () => {
  it('sends only the fields that changed', async () => {
    const update = vi
      .spyOn(adminEncounters, 'updateAdminEncounterSettings')
      .mockResolvedValue(settings({ huntChance: 0.9 }));
    const user = userEvent.setup();
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );
    await screen.findByTestId('effective-settings');

    const huntInput = screen.getByDisplayValue('0.35');
    await user.clear(huntInput);
    await user.type(huntInput, '0.9');
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Travel chance and expiry were untouched, so they are absent entirely.
    expect(update).toHaveBeenCalledWith({ huntChance: 0.9 });
  });

  it('refuses to save an out-of-range value', async () => {
    const update = vi.spyOn(adminEncounters, 'updateAdminEncounterSettings');
    const user = userEvent.setup();
    render(
      <Wrap>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );
    await screen.findByTestId('effective-settings');

    const huntInput = screen.getByDisplayValue('0.35');
    await user.clear(huntInput);
    await user.type(huntInput, '5');

    expect(screen.getByTestId('settings-validation').textContent).toContain('between 0 and 1');
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('is read-only without the publish permission', async () => {
    render(
      <Wrap permissions={['admin.access', 'encounters.read']}>
        <GlobalEncounterSettingsPanel />
      </Wrap>,
    );
    await screen.findByTestId('effective-settings');

    // The API is the real boundary; this just avoids offering an action that
    // would only be refused.
    expect(screen.getByDisplayValue('0.35')).toBeDisabled();
    expect(screen.getByTestId('force-trigger-input')).toBeDisabled();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    expect(screen.getByText(/needs the publish permission/i)).toBeTruthy();
  });
});
