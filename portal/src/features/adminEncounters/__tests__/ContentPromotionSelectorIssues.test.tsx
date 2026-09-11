/**
 * Import preview wording for the two species-selector issues.
 *
 * They must read as what they mean — not as generic schema errors — and name
 * regions the way authors know them rather than as ids. Errors still block and
 * warnings still do not, exactly as for every other issue.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import * as adminEncounters from '@/api/adminEncounters';
import type { ImportPlan } from '@/api/adminEncounters';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { ContentPromotionPanel } from '../ContentPromotionPanel';

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = {
    status: 'ready',
    session: {
      playerId: 1,
      guildDbId: 1,
      displayName: 'Operator',
      avatarUrl: null,
      permissions: ['admin.access', 'encounters.read', 'encounters.write', 'encounters.publish'],
    },
    error: null,
  } as unknown as SessionState;
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  );
}

const PLAN: ImportPlan = {
  ok: false,
  format: 'waifumon-world-encounters',
  version: 1,
  exportedAt: null,
  label: null,
  encounters: [{ slug: 'lr_trail_end', name: 'Trail End', status: 'create' }],
  vendors: [],
  issues: [
    {
      severity: 'error',
      code: 'selector_no_candidates',
      subject: 'lr_trail_end',
      message: 'choice[0] random selector (region, rarities EX) matches no species on this server.',
    },
    {
      severity: 'warning',
      code: 'selector_region_no_candidates',
      subject: 'lr_trail_mid',
      message: 'choice[0] random selector (region, rarities LR) matches no species in twin-peeks.',
      regions: ['twin-peeks'],
    },
  ],
  counts: {
    created: 1,
    updated: 0,
    unchanged: 0,
    vendorsCreated: 0,
    vendorsUpdated: 0,
    vendorsUnchanged: 0,
    errors: 1,
    warnings: 1,
  },
};

beforeEach(() => {
  vi.spyOn(adminEncounters, 'previewAdminEncounterImport').mockResolvedValue(PLAN);
});
afterEach(() => vi.restoreAllMocks());

async function previewPlan() {
  const user = userEvent.setup();
  render(<ContentPromotionPanel />, { wrapper: Wrapper });
  const file = new File(['{}'], 'pkg.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => '{}' });
  await user.upload(screen.getByLabelText('Package file'), file);
  await user.click(screen.getByRole('button', { name: /preview import/i }));
  await screen.findByTestId('import-plan');
}

describe('selector issues in import preview', () => {
  it('explains selector_no_candidates as a blocking problem', async () => {
    await previewPlan();
    expect(screen.getByText(/1 problem\(s\) block this import/)).toBeInTheDocument();
    expect(
      screen.getByText(/This selector does not match any enabled Waifumon in any valid region\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply import/i })).toBeDisabled();
  });

  it('explains selector_region_no_candidates as a warning, naming the region', async () => {
    await previewPlan();
    expect(screen.getByText('1 warning(s)')).toBeInTheDocument();
    expect(
      screen.getByText(
        /no matching Waifumon in one or more regions where this encounter may run \(Twin Peeks\)/,
      ),
    ).toBeInTheDocument();
    // The server's own detail is kept, not replaced.
    expect(screen.getByText(/matches no species in twin-peeks/)).toBeInTheDocument();
  });
});
