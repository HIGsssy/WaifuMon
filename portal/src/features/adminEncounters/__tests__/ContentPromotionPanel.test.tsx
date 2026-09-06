/**
 * The content promotion panel.
 *
 * What it owes an operator, and what is tested here: preview is mandatory and
 * cannot be bypassed, Apply can never act on a file other than the one that
 * was previewed, errors and warnings are visibly different kinds of thing, and
 * an Encounter Editor sees the whole workflow but cannot pull the trigger.
 *
 * Nothing here is a security boundary — the API re-checks every request — but
 * a UI that lets someone believe they applied a package when they did not is
 * its own kind of failure.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ContentPromotionPanel } from '../ContentPromotionPanel';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import * as adminEncounters from '@/api/adminEncounters';
import type { ImportPlan } from '@/api/adminEncounters';

function sessionState(permissions: readonly string[]): SessionState {
  const session: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Operator',
    avatarUrl: null,
    permissions,
  };
  return { status: 'ready', session, error: null } as unknown as SessionState;
}

function wrapper(permissions: readonly string[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
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
  };
}

const EDITOR = ['admin.access', 'encounters.read', 'encounters.write'];
const PUBLISHER = [...EDITOR, 'encounters.publish'];

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    ok: true,
    format: 'waifumon-world-encounters',
    version: 1,
    exportedAt: '2026-09-05T00:00:00.000Z',
    label: 'staging',
    encounters: [{ slug: 'tv_new', name: 'New One', status: 'create' }],
    vendors: [],
    issues: [],
    counts: {
      created: 1,
      updated: 0,
      unchanged: 0,
      vendorsCreated: 0,
      vendorsUpdated: 0,
      vendorsUnchanged: 0,
      errors: 0,
      warnings: 0,
    },
    ...overrides,
  };
}

/** A File whose `.text()` resolves to a package body. */
function packageFile(name = 'staging.json', body: unknown = { format: 'x', encounters: [] }) {
  const file = new File([JSON.stringify(body)], name, { type: 'application/json' });
  // jsdom's File has no `.text()` in some versions; provide it deterministically.
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(body) });
  return file;
}

beforeEach(() => {
  // The download helper clicks a synthetic <a download>. jsdom cannot navigate
  // and logs a stack for it, which would bury a real error in this file's
  // output — so the click is a no-op here. What the tests assert is the API
  // call that produced the package, not the browser's save dialog.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  });
  vi.spyOn(adminEncounters, 'previewAdminEncounterImport').mockResolvedValue(plan());
  vi.spyOn(adminEncounters, 'applyAdminEncounterImport').mockResolvedValue({
    plan: plan(),
    importLogId: 1,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('export', () => {
  it('requests every encounter, with the label the operator typed', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue({
        format: 'waifumon-world-encounters',
        version: 1,
        exportedAt: '2026-09-05T00:00:00.000Z',
        label: 'staging run',
        vendors: [],
        encounters: [{ slug: 'a', name: 'A' }],
      });
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.type(screen.getByLabelText('Package label'), 'staging run');
    await user.click(screen.getByRole('button', { name: /export all encounters/i }));

    await waitFor(() =>
      expect(exportSpy).toHaveBeenCalledWith({ slugs: [], label: 'staging run' }),
    );
  });

  it('exports only the selected slugs when there is a selection', async () => {
    const exportSpy = vi
      .spyOn(adminEncounters, 'exportAdminEncounters')
      .mockResolvedValue({
        format: 'waifumon-world-encounters',
        version: 1,
        exportedAt: '',
        label: null,
        vendors: [],
        encounters: [{ slug: 'tv_a', name: 'A' }],
      });
    const user = userEvent.setup();
    render(<ContentPromotionPanel selectedSlugs={['tv_a', 'tv_b']} />, {
      wrapper: wrapper(PUBLISHER),
    });

    await user.click(screen.getByRole('button', { name: /export selected \(2\)/i }));

    await waitFor(() =>
      expect(exportSpy).toHaveBeenCalledWith({ slugs: ['tv_a', 'tv_b'], label: null }),
    );
  });

  it('is hidden entirely from someone without read access', () => {
    render(<ContentPromotionPanel />, { wrapper: wrapper(['admin.access']) });

    expect(screen.queryByTestId('content-promotion')).not.toBeInTheDocument();
  });
});

describe('import requires a preview first', () => {
  it('Apply is disabled until a clean plan comes back', async () => {
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    const apply = screen.getByRole('button', { name: /apply import/i });
    expect(apply).toBeDisabled();

    await user.upload(screen.getByLabelText('Package file'), packageFile());
    // A file alone is not enough — the plan is what enables Apply.
    expect(apply).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /preview import/i }));
    await waitFor(() => expect(apply).toBeEnabled());
  });

  it('choosing a different file clears the plan, re-disabling Apply', async () => {
    // Otherwise Apply would act on a package other than the one on screen.
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), packageFile('first.json'));
    await user.click(screen.getByRole('button', { name: /preview import/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply import/i })).toBeEnabled(),
    );

    await user.upload(screen.getByLabelText('Package file'), packageFile('second.json'));

    expect(screen.getByRole('button', { name: /apply import/i })).toBeDisabled();
    expect(screen.queryByTestId('import-plan')).not.toBeInTheDocument();
  });

  it('shows the plan counts and each encounter’s disposition', async () => {
    vi.spyOn(adminEncounters, 'previewAdminEncounterImport').mockResolvedValue(
      plan({
        encounters: [
          { slug: 'tv_new', name: 'New One', status: 'create' },
          { slug: 'tv_old', name: 'Old One', status: 'update' },
        ],
        counts: { ...plan().counts, created: 1, updated: 1 },
      }),
    );
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), packageFile());
    await user.click(screen.getByRole('button', { name: /preview import/i }));

    expect(await screen.findByText('1 new')).toBeInTheDocument();
    expect(screen.getByText('1 updated')).toBeInTheDocument();
    expect(screen.getByText('tv_new')).toBeInTheDocument();
    expect(screen.getByText('tv_old')).toBeInTheDocument();
  });
});

describe('errors and warnings read differently', () => {
  it('blocks Apply and lists the problems when the plan has errors', async () => {
    vi.spyOn(adminEncounters, 'previewAdminEncounterImport').mockResolvedValue(
      plan({
        ok: false,
        issues: [
          {
            severity: 'error',
            code: 'missing_item',
            subject: 'tv_new',
            message: 'choice[0] references unknown item "ghost_charm".',
          },
        ],
        counts: { ...plan().counts, errors: 1 },
      }),
    );
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), packageFile());
    await user.click(screen.getByRole('button', { name: /preview import/i }));

    expect(await screen.findByText(/1 problem\(s\) block this import/i)).toBeInTheDocument();
    expect(screen.getByText(/ghost_charm/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply import/i })).toBeDisabled();
  });

  it('does not block Apply for a warning, such as undeployed artwork', async () => {
    vi.spyOn(adminEncounters, 'previewAdminEncounterImport').mockResolvedValue(
      plan({
        ok: true,
        issues: [
          {
            severity: 'warning',
            code: 'missing_artwork',
            subject: 'tv_new',
            message: 'Artwork "encounters/x.png" is not deployed here yet.',
          },
        ],
        counts: { ...plan().counts, warnings: 1 },
      }),
    );
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), packageFile());
    await user.click(screen.getByRole('button', { name: /preview import/i }));

    expect(await screen.findByText(/1 warning\(s\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply import/i })).toBeEnabled();
  });

  it('reports a file that is not JSON without calling the API', async () => {
    const preview = vi.spyOn(adminEncounters, 'previewAdminEncounterImport');
    const notJson = new File(['this is not json'], 'broken.json');
    Object.defineProperty(notJson, 'text', { value: async () => 'this is not json' });
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), notJson);

    expect(await screen.findByText(/broken\.json is not valid JSON/i)).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('permissions', () => {
  it('an Encounter Editor can preview but not apply, and is told why', async () => {
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(EDITOR) });

    await user.upload(screen.getByLabelText('Package file'), packageFile());
    await user.click(screen.getByRole('button', { name: /preview import/i }));
    await screen.findByTestId('import-plan');

    // The plan is visible — the editor did the useful work — but Apply is not
    // available to them, and the reason is on screen rather than implied.
    expect(screen.getByRole('button', { name: /apply import/i })).toBeDisabled();
    expect(screen.getByText(/needs the publish permission/i)).toBeInTheDocument();
  });

  it('a publisher can apply, and sees what landed', async () => {
    const applySpy = vi
      .spyOn(adminEncounters, 'applyAdminEncounterImport')
      .mockResolvedValue({
        plan: plan({ counts: { ...plan().counts, created: 2, updated: 1 } }),
        importLogId: 7,
      });
    const user = userEvent.setup();
    render(<ContentPromotionPanel />, { wrapper: wrapper(PUBLISHER) });

    await user.upload(screen.getByLabelText('Package file'), packageFile('staging.json'));
    await user.click(screen.getByRole('button', { name: /preview import/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply import/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /apply import/i }));

    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    // The filename travels with the request, so the audit log can name it.
    expect(applySpy.mock.calls[0]![1]).toBe('staging.json');
    expect(await screen.findByText(/2 created, 1 updated/i)).toBeInTheDocument();
  });

  it('the import section is hidden from a read-only viewer', () => {
    render(<ContentPromotionPanel />, {
      wrapper: wrapper(['admin.access', 'encounters.read']),
    });

    expect(screen.getByTestId('content-promotion')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export all encounters/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Package file')).not.toBeInTheDocument();
  });
});
