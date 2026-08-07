/**
 * The developer login screen.
 *
 * This is the replacement for editing `VITE_DEFAULT_PLAYER_ID` and restarting
 * the dev server, so what is worth asserting is the round trip a tester
 * actually performs: type a Discord id, land in the Portal, and come back out
 * again via "Switch player". The 404 case gets its own test because it is the
 * one place the Portal could plausibly be tempted to create a player, and must
 * not.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import * as fixtures from '../../../../msw/fixtures';
import { routes } from '@/app/router';
import { DEV_IDENTITY_STORAGE_KEY } from '@/auth/dev/devIdentity';
import { renderRoutes } from '@/test/renderWithProviders';

function stored() {
  const raw = localStorage.getItem(DEV_IDENTITY_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : null;
}

describe('developer login', () => {
  it('signs in from a Discord user id and enters the Portal', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Developer login' });

    // The guild is optional because it pre-fills from the existing dev config.
    expect(screen.getByLabelText('Discord server ID')).toHaveValue(fixtures.DISCORD_GUILD_ID);

    await user.type(screen.getByLabelText('Discord user ID'), fixtures.DISCORD_USER_ID);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Which account you just became, before the Portal takes over.
    expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
    expect(screen.getByText(`#${fixtures.PLAYER_ID}`)).toBeInTheDocument();
    expect(screen.getAllByText('Mika').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Enter the Portal' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('goes back to the form from the confirmation instead of redirecting', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Developer login' });
    await user.type(screen.getByLabelText('Discord user ID'), fixtures.DISCORD_USER_ID);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Signed in' });

    // The session is resolved at this point, so the redirect that serves a
    // restored session must not fire on an explicit request for the form.
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    expect(await screen.findByRole('heading', { name: 'Developer login' })).toBeInTheDocument();
  });

  it('remembers the choice for the next start', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Developer login' });
    await user.type(screen.getByLabelText('Discord user ID'), fixtures.DISCORD_USER_ID);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Signed in' });

    await waitFor(() =>
      expect(stored()).toEqual({
        discordUserId: fixtures.DISCORD_USER_ID,
        discordGuildId: fixtures.DISCORD_GUILD_ID,
      }),
    );
  });

  it('explains an account that has never played here, and stores nothing', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Developer login' });
    await user.type(screen.getByLabelText('Discord user ID'), '111111111111111111');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('This Discord account hasn’t played here yet'),
    ).toBeInTheDocument();
    // A failed attempt must not become the state the next reload starts in.
    expect(stored()).toBeNull();
  });

  it('rejects a malformed snowflake without calling the API', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Developer login' });
    await user.type(screen.getByLabelText('Discord user ID'), 'mika#1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // An unmocked request would fail the suite outright (`onUnhandledRequest:
    // 'error'`), so reaching this assertion is itself the proof none was made.
    expect(await screen.findByRole('alert')).toHaveTextContent('run of digits');
    expect(screen.getByRole('heading', { name: 'Developer login' })).toBeInTheDocument();
  });

  it('returns to the login screen from "Switch player" and forgets the session', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/settings'] });

    await screen.findByRole('heading', { name: 'Settings' });

    // Both the header and the Settings development card offer it.
    const [switcher] = screen.getAllByRole('button', { name: 'Switch player' });
    await user.click(switcher!);

    expect(await screen.findByRole('heading', { name: 'Developer login' })).toBeInTheDocument();
    expect(stored()).toBeNull();
    // The pair is kept in memory so switching back costs one click, not a trip
    // to Discord for the snowflake.
    expect(screen.getByLabelText('Discord user ID')).toHaveValue(fixtures.DISCORD_USER_ID);
  });
});
