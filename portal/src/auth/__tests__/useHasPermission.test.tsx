/**
 * Portal permission gating — visual (nav) and structural
 * (`RequirePortalPermission`) tests.
 *
 * The vitest environment runs the DevLoginSessionProvider (see
 * `vitest.setup.ts`), which grants every permission by design. To test the
 * unprivileged view, we override the /players/lookup handler with a canonical
 * fixture and then intercept `useHasPermission` via a wrapping provider.
 *
 * Simpler here: test the `useHasPermission` hook directly against a canned
 * session — that is the surface every guard reads.
 */
import { describe, expect, it } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { SessionContext } from '@/auth/SessionContext';
import { RequirePortalPermission } from '@/auth/RequirePortalPermission';
import { useHasPermission } from '@/auth/useSession';
import type { PortalSession, SessionState } from '@/auth/types';

function sessionFor(permissions: readonly string[]): PortalSession {
  return {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Trainer',
    avatarUrl: null,
    permissions,
  };
}

function stateFor(session: PortalSession | null): SessionState {
  return {
    status: session ? 'ready' : 'unresolved',
    session,
    error: null,
    configuredPlayerId: undefined,
    retry: () => {},
  };
}

function Wrap({ state, children }: { state: SessionState; children: ReactNode }) {
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

describe('useHasPermission', () => {
  it('returns false when there is no session', () => {
    const { result } = renderHook(() => useHasPermission('admin.access'), {
      wrapper: ({ children }) => <Wrap state={stateFor(null)}>{children}</Wrap>,
    });
    expect(result.current).toBe(false);
  });

  it('returns false when the session lacks the permission', () => {
    const { result } = renderHook(() => useHasPermission('admin.access'), {
      wrapper: ({ children }) => (
        <Wrap state={stateFor(sessionFor([]))}>{children}</Wrap>
      ),
    });
    expect(result.current).toBe(false);
  });

  it('returns true when the session holds the permission', () => {
    const { result } = renderHook(() => useHasPermission('encounters.write'), {
      wrapper: ({ children }) => (
        <Wrap
          state={stateFor(sessionFor(['admin.access', 'encounters.write']))}
        >
          {children}
        </Wrap>
      ),
    });
    expect(result.current).toBe(true);
  });
});

/**
 * Guild switching, from the React side.
 *
 * The server recomputes permissions for the newly selected guild and returns
 * them on `/auth/guild` (proved over HTTP in
 * `tests/unit/api/adminEncounterAuth.test.ts`). What has to be true *here* is
 * that a consumer re-reads them when the session is replaced — a component
 * that captured the old set, or a payload whose `permissions` field were
 * merely absent, would leave the user looking at admin surfaces for a guild
 * they do not own.
 */
function Probe() {
  const has = useHasPermission('admin.access');
  return <span data-testid="probe">{String(has)}</span>;
}

describe('permissions after a guild switch', () => {
  it('drops admin the moment the session is replaced with the new guild’s payload', () => {
    const { rerender } = render(
      <Wrap state={stateFor(sessionFor(['admin.access', 'encounters.read']))}>
        <Probe />
      </Wrap>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('true');

    // `OAuthSessionProvider.selectGuild` replaces the whole cached session
    // with the server's response for the new guild.
    rerender(
      <Wrap state={stateFor(sessionFor([]))}>
        <Probe />
      </Wrap>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('hides the guarded subtree once the permission is gone', () => {
    const { rerender } = render(
      <Wrap state={stateFor(sessionFor(['admin.access']))}>
        <RequirePortalPermission permission="admin.access" fallback={<span>denied</span>}>
          <span>admin screen</span>
        </RequirePortalPermission>
      </Wrap>,
    );
    expect(screen.getByText('admin screen')).toBeTruthy();

    rerender(
      <Wrap state={stateFor(sessionFor([]))}>
        <RequirePortalPermission permission="admin.access" fallback={<span>denied</span>}>
          <span>admin screen</span>
        </RequirePortalPermission>
      </Wrap>,
    );
    expect(screen.queryByText('admin screen')).toBeNull();
    expect(screen.getByText('denied')).toBeTruthy();
  });

  it('treats a session carrying an empty permission list as no permissions', () => {
    // `OAuthSessionProvider` maps `payload.permissions ?? []`. An API that
    // omits the field — no bot wired, so no ownership oracle — must read as
    // "nothing", never as "unchanged".
    render(
      <Wrap state={stateFor(sessionFor([]))}>
        <Probe />
      </Wrap>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });
});
