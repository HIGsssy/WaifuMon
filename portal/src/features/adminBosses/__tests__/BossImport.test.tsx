/**
 * Importing boss definitions from the list page: paste or upload a document,
 * review the server's plan, choose what happens to bosses that already exist,
 * apply. Overwriting is never the default and never one click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';

import type { BossImportPlan } from '@/api/adminBosses';

import { BossesListPage } from '../BossesListPage';
import {
  ALL,
  READ_ONLY,
  apiError,
  bossFixture,
  installBossApi,
  renderWithSession,
  staleError,
  type BossApi,
  type User,
} from './bossFixtures';

let boss: BossApi;

const DOCUMENT = {
  format: 'waifumon-boss-definitions',
  version: 1,
  bosses: [
    { id: 'glass_widow', name: 'Glass Widow' },
    { id: 'iron_matron', name: 'Iron Matriarch' },
    { id: 'neon_hydra', name: 'Neon Hydra' },
    { id: 'old_guard', name: 'Old Guard' },
  ],
};

const PLAN: BossImportPlan = {
  entries: [
    {
      id: 'glass_widow',
      name: 'Glass Widow',
      action: 'create',
      currentRevision: null,
      changedFields: [],
      issues: [],
    },
    {
      id: 'iron_matron',
      name: 'Iron Matriarch',
      action: 'conflict',
      currentRevision: 3,
      changedFields: ['name', 'schedule'],
      issues: [],
    },
    {
      id: 'old_guard',
      name: 'Old Guard',
      action: 'conflict',
      currentRevision: 8,
      changedFields: ['rewardTable'],
      issues: [
        {
          path: 'rewardTable',
          message:
            'Reward table "boss_legacy" is disabled, so this boss will not spawn until it is enabled.',
          severity: 'warning',
        },
      ],
    },
    {
      id: 'neon_hydra',
      name: 'Neon Hydra',
      action: 'unchanged',
      currentRevision: 3,
      changedFields: [],
      issues: [],
    },
  ],
  issues: [],
  canApply: true,
};

beforeEach(() => {
  boss = installBossApi([
    bossFixture({ id: 'iron_matron', name: 'Iron Matron' }),
    bossFixture({ id: 'neon_hydra', name: 'Neon Hydra' }),
    bossFixture({ id: 'old_guard', name: 'Old Guard', revision: 8 }),
  ]);
  boss.planImport.mockResolvedValue(PLAN);
  boss.applyImport.mockImplementation(async (_document, conflicts) => ({
    created: ['glass_widow'],
    overwritten: conflicts === 'overwrite' ? ['iron_matron', 'old_guard'] : [],
    skipped: conflicts === 'overwrite' ? [] : ['iron_matron', 'old_guard'],
    unchanged: ['neon_hydra'],
  }));
});
afterEach(() => vi.restoreAllMocks());

function renderList(permissions = ALL) {
  return renderWithSession(
    <Routes>
      <Route path="*" element={<BossesListPage />} />
    </Routes>,
    '/admin/bosses',
    permissions,
  );
}

/** Open the import panel, paste `document`, and have the server check it. */
async function planned(user: User, document: unknown = DOCUMENT) {
  await user.click(await screen.findByRole('button', { name: 'Import' }));
  await user.click(screen.getByLabelText('Import JSON'));
  await user.paste(JSON.stringify(document));
  await user.click(screen.getByRole('button', { name: 'Check import' }));
  return within(await screen.findByTestId('import-plan'));
}
const entry = (plan: ReturnType<typeof within>, id: string) => {
  const found = plan
    .getAllByTestId('import-entry')
    .find((r: HTMLElement) => within(r).queryAllByText(id).length > 0);
  if (!found) throw new Error(`no import entry for ${id}`);
  return within(found);
};

describe('boss import', () => {
  it('is closed until asked for, and writes nothing while a document is only checked', async () => {
    const user = renderList();
    await screen.findAllByTestId('boss-row');
    expect(screen.queryByTestId('boss-import')).not.toBeInTheDocument();

    await planned(user);
    expect(boss.planImport).toHaveBeenCalledWith(DOCUMENT);
    expect(boss.applyImport).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close import' }));
    expect(screen.queryByTestId('boss-import')).not.toBeInTheDocument();
  });

  it('shows what each boss in the document would do', async () => {
    const user = renderList();
    const plan = await planned(user);
    expect(plan.getAllByTestId('import-entry')).toHaveLength(4);

    const widow = entry(plan, 'glass_widow');
    expect(widow.getByText('New')).toBeInTheDocument();
    expect(widow.getByText('Will be created.')).toBeInTheDocument();

    const matron = entry(plan, 'iron_matron');
    expect(matron.getByText('Conflict')).toBeInTheDocument();
    // The document's name for it, so the admin sees what they would be getting.
    expect(matron.getByText('Iron Matriarch')).toBeInTheDocument();
    expect(matron.getByTestId('import-changed-fields')).toHaveTextContent(
      'Already exists and differs in: name, schedule',
    );

    const guard = entry(plan, 'old_guard');
    expect(guard.getByTestId('import-changed-fields')).toHaveTextContent('rewardTable');
    expect(guard.getByTestId('import-entry-issues')).toHaveTextContent(
      '⚠ Reward table "boss_legacy" is disabled',
    );

    const hydra = entry(plan, 'neon_hydra');
    expect(hydra.getByText('Unchanged')).toBeInTheDocument();
    expect(hydra.getByText('Matches the boss on this server.')).toBeInTheDocument();
  });

  it('skips existing bosses by default: only new ids are created, and no revisions are sent', async () => {
    const user = renderList();
    const plan = await planned(user);
    expect(plan.getByLabelText('Skip existing bosses')).toBeChecked();
    expect(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/)).not.toBeChecked();
    expect(plan.queryByTestId('import-overwrite-confirm')).not.toBeInTheDocument();

    await user.click(plan.getByRole('button', { name: 'Apply: create 1' }));
    await waitFor(() => expect(boss.applyImport).toHaveBeenCalledTimes(1));
    expect(boss.applyImport).toHaveBeenCalledWith(DOCUMENT, 'skip', undefined);

    const applied = await screen.findByTestId('import-applied');
    expect(applied).toHaveTextContent(
      'Import applied: 1 created, 0 overwritten, 2 skipped, 1 unchanged.',
    );
    expect(applied).toHaveTextContent('Created: glass_widow');
    expect(applied).toHaveTextContent('Skipped: iron_matron, old_guard');
    // The reviewed plan is spent; the list is re-read.
    expect(screen.queryByTestId('import-plan')).not.toBeInTheDocument();
    await waitFor(() => expect(boss.list.mock.calls.length).toBeGreaterThan(1));
  });

  it('overwrites only after it is chosen and separately confirmed, at the revisions the plan showed', async () => {
    const user = renderList();
    const plan = await planned(user);

    await user.click(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/));
    const apply = plan.getByRole('button', { name: 'Apply: create 1, overwrite 2' });
    // Choosing it is not confirming it.
    expect(apply).toBeDisabled();
    const confirm = within(plan.getByTestId('import-overwrite-confirm'));
    expect(confirm.getByText(/I understand this replaces 2 existing bosses/)).toBeInTheDocument();
    expect(confirm.getByText('iron_matron, old_guard')).toBeInTheDocument();
    expect(boss.applyImport).not.toHaveBeenCalled();

    await user.click(confirm.getByLabelText('Confirm overwrite'));
    expect(apply).toBeEnabled();
    await user.click(apply);

    await waitFor(() => expect(boss.applyImport).toHaveBeenCalledTimes(1));
    // Conflicts only — not the new boss, not the unchanged one.
    expect(boss.applyImport).toHaveBeenCalledWith(DOCUMENT, 'overwrite', {
      iron_matron: 3,
      old_guard: 8,
    });
    const applied = await screen.findByTestId('import-applied');
    expect(applied).toHaveTextContent(
      'Import applied: 1 created, 2 overwritten, 0 skipped, 1 unchanged.',
    );
    expect(applied).toHaveTextContent('Overwritten: iron_matron, old_guard');
  });

  it('withdraws the confirmation when the admin goes back to skipping', async () => {
    const user = renderList();
    const plan = await planned(user);
    await user.click(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/));
    await user.click(plan.getByLabelText('Confirm overwrite'));
    await user.click(plan.getByLabelText('Skip existing bosses'));
    await user.click(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/));
    expect(plan.getByLabelText('Confirm overwrite')).not.toBeChecked();
    expect(plan.getByRole('button', { name: 'Apply: create 1, overwrite 2' })).toBeDisabled();
  });

  it('cannot apply a document with an invalid boss, and shows why', async () => {
    boss.planImport.mockResolvedValue({
      entries: [
        PLAN.entries[0]!,
        {
          id: 'bad_boss',
          name: null,
          action: 'invalid',
          currentRevision: null,
          changedFields: [],
          issues: [
            { path: 'name', message: 'a name is required', severity: 'error' },
            {
              path: 'schedule.timezone',
              message: '"Nowhere" is not a known IANA timezone',
              severity: 'error',
            },
          ],
        },
      ],
      issues: [
        {
          path: 'bosses[1].id',
          message: '"bad_boss" appears twice in the package',
          severity: 'error',
        },
      ],
      canApply: false,
    });
    const user = renderList();
    const plan = await planned(user);

    const bad = entry(plan, 'bad_boss');
    expect(bad.getByText('Invalid')).toBeInTheDocument();
    expect(bad.getByText('a name is required')).toBeInTheDocument();
    expect(bad.getByText('"Nowhere" is not a known IANA timezone')).toBeInTheDocument();
    expect(plan.getByTestId('import-document-issues')).toHaveTextContent(
      '"bad_boss" appears twice in the package',
    );
    expect(plan.getByTestId('import-blocked')).toBeInTheDocument();
    expect(plan.getByRole('button', { name: /^Apply/ })).toBeDisabled();
    // No choice about conflicts is offered for a document that cannot be applied at all.
    expect(plan.queryByLabelText('Skip existing bosses')).not.toBeInTheDocument();
  });

  it('has nothing to apply when every boss already matches', async () => {
    boss.planImport.mockResolvedValue({ entries: [PLAN.entries[3]!], issues: [], canApply: true });
    const user = renderList();
    const plan = await planned(user);
    expect(plan.getByTestId('import-nothing')).toHaveTextContent(
      'Nothing to change — every boss in the document matches this server.',
    );
    expect(plan.getByRole('button', { name: 'Apply: create 0' })).toBeDisabled();
  });

  it('applies nothing, and says to check again, when a boss changed after the plan', async () => {
    boss.applyImport.mockRejectedValueOnce(staleError());
    const user = renderList();
    const plan = await planned(user);
    await user.click(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/));
    await user.click(plan.getByLabelText('Confirm overwrite'));
    await user.click(plan.getByRole('button', { name: 'Apply: create 1, overwrite 2' }));
    expect(await screen.findByTestId('import-stale')).toHaveTextContent(
      'A boss changed on this server after the document was checked, so nothing was applied.',
    );
    expect(screen.queryByTestId('import-applied')).not.toBeInTheDocument();
  });

  it('discards the reviewed plan when the document is edited', async () => {
    const user = renderList();
    await planned(user);
    await user.type(screen.getByLabelText('Import JSON'), ' ');
    expect(screen.queryByTestId('import-plan')).not.toBeInTheDocument();
  });

  it('reads an uploaded file and checks it straight away', async () => {
    const user = renderList();
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    const file = new File([JSON.stringify(DOCUMENT)], 'boss-definitions.json', {
      type: 'application/json',
    });
    // jsdom's File has no `.text()` in some versions; provide it deterministically.
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(DOCUMENT) });
    await user.upload(screen.getByLabelText('Import file'), file);
    expect(await screen.findByTestId('import-plan')).toBeInTheDocument();
    expect(boss.planImport).toHaveBeenCalledWith(DOCUMENT);
    expect(screen.getByLabelText('Import JSON')).toHaveValue(JSON.stringify(DOCUMENT));
  });

  it('says so when what was pasted is not JSON, without asking the server', async () => {
    const user = renderList();
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    await user.click(screen.getByLabelText('Import JSON'));
    await user.paste('not json at all');
    await user.click(screen.getByRole('button', { name: 'Check import' }));
    expect(await screen.findByText('That is not valid JSON.')).toBeInTheDocument();
    expect(boss.planImport).not.toHaveBeenCalled();
  });

  it('shows what the server refused at apply time', async () => {
    boss.applyImport.mockRejectedValueOnce(
      apiError(400, 'BOSS_DEFINITION_INVALID', 'The import is not valid.', {
        issues: [
          {
            path: 'glass_widow.rewardTable',
            message: 'Boss reward table "x" does not exist.',
            severity: 'error',
          },
        ],
      }),
    );
    const user = renderList();
    const plan = await planned(user);
    await user.click(plan.getByRole('button', { name: 'Apply: create 1' }));
    expect(await screen.findByTestId('import-refused-issues')).toHaveTextContent(
      'Boss reward table "x" does not exist.',
    );
  });

  it('lets a read-only admin check a document but not apply it', async () => {
    const user = renderList(READ_ONLY);
    const plan = await planned(user);
    expect(plan.getAllByTestId('import-entry')).toHaveLength(4);
    expect(plan.queryByRole('button', { name: /^Apply/ })).not.toBeInTheDocument();
    expect(plan.getByText('You do not have write permission to apply it.')).toBeInTheDocument();
    expect(plan.getByLabelText(/^Overwrite the 2 conflicting bosses/)).toBeDisabled();
  });
});
