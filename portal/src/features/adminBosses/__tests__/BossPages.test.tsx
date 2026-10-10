/**
 * The Boss Management definition pages: the list (search, filters, lifecycle,
 * duplicate, delete and its refusal, export), the creation flow (id made from
 * the name, server issues at their fields), and the editor — saved with the
 * loaded revision, the stale-save refusal, issues beside the fields they name,
 * the read-only global tuning, and the recent-changes list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';

import { BossEditorPage } from '../BossEditorPage';
import { BossesListPage } from '../BossesListPage';
import {
  ALL,
  ALWAYS,
  FRIDAY_EVENINGS,
  NEXT_FRIDAY,
  READ_ONLY,
  apiError,
  bossFixture,
  inputOfDetail,
  installBossApi,
  renderWithSession,
  staleError,
  type BossApi,
  type User,
} from './bossFixtures';

let boss: BossApi;

beforeEach(() => {
  boss = installBossApi([
    bossFixture({
      id: 'iron_matron',
      name: 'Iron Matron',
      description: 'She keeps the furnaces.',
      encounterCount: 7,
      lastEncounterAt: '2026-10-08T20:00:00.000Z',
    }),
    bossFixture({
      id: 'neon_hydra',
      name: 'Neon Hydra',
      affinity: 'primal',
      regions: ['waifu-valley', 'twin-peeks'],
      schedule: FRIDAY_EVENINGS,
      scheduleSummary: 'Fri 18:00–23:00 (America/Toronto)',
      availability: NEXT_FRIDAY,
    }),
    bossFixture({
      id: 'paper_tiger',
      name: 'Paper Tiger',
      status: 'draft',
      affinity: 'switch',
      regions: ['twin-peeks'],
      artwork: null,
      rewardTable: '',
      scoutingText: '',
      source: 'portal',
      shipped: false,
    }),
    bossFixture({ id: 'old_guard', name: 'Old Guard', status: 'disabled', encounterCount: 2 }),
  ]);
});
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string, permissions = ALL) {
  return renderWithSession(
    <Routes>
      <Route path="/admin/bosses" element={<BossesListPage />} />
      <Route path="/admin/bosses/new" element={<BossEditorPage />} />
      <Route path="/admin/bosses/activity" element={<p>Activity page</p>} />
      <Route path="/admin/bosses/:id" element={<BossEditorPage />} />
      <Route path="/admin/reward-tables/boss/:id" element={<p>Reward table page</p>} />
    </Routes>,
    path,
    permissions,
  );
}

const LIST = '/admin/bosses';
const MATRON = '/admin/bosses/iron_matron';
const HYDRA = '/admin/bosses/neon_hydra';
const rows = () => screen.getAllByTestId('boss-row');
const row = (name: string) => {
  const found = rows().find((r) => within(r).queryByRole('link', { name }) !== null);
  if (!found) throw new Error(`no boss row for ${name}`);
  return within(found);
};
const rowNames = () => rows().map((r) => within(r).getAllByRole('link')[0]!.textContent);
const retype = async (user: User, label: string, value: string) => {
  const field = await screen.findByLabelText(label);
  await user.clear(field);
  if (value !== '') await user.type(field, value);
};
const save = async (user: User) => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save boss' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save boss' }));
};

/* ───────────────────────── the list ───────────────────────── */

describe('boss list', () => {
  it('shows every boss with its artwork, regions, status, affinity, schedule, availability and encounters', async () => {
    renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    expect(rowNames()).toEqual(['Iron Matron', 'Neon Hydra', 'Paper Tiger', 'Old Guard']);

    const matron = row('Iron Matron');
    expect(matron.getByTestId('boss-status')).toHaveTextContent('Active');
    expect(matron.getByTestId('boss-affinity')).toHaveTextContent('Dominant');
    expect(matron.getByTestId('boss-regions')).toHaveTextContent('Waifu Valley');
    expect(matron.getByTestId('boss-schedule')).toHaveTextContent('Always available');
    expect(matron.getByTestId('boss-available-now')).toHaveTextContent('Available now');
    expect(matron.getByTestId('boss-next-window')).toHaveTextContent('No schedule limits');
    expect(matron.getByTestId('boss-encounters')).toHaveTextContent(/^7 encounters, last /);
    expect(matron.getByText('iron_matron')).toBeInTheDocument();
    expect(await matron.findByTestId('boss-art-iron_matron-image')).toBeInTheDocument();
    expect(boss.artwork).toHaveBeenCalledWith('bosses/iron_matron.webp');

    const hydra = row('Neon Hydra');
    expect(hydra.getByTestId('boss-regions')).toHaveTextContent('Waifu Valley, Twin Peeks');
    expect(hydra.getByTestId('boss-schedule')).toHaveTextContent('Fri 18:00–23:00');
    expect(hydra.getByTestId('boss-available-now')).toHaveTextContent('Not available now');
    // 22:00Z is 18:00 in Toronto: the instant is shown in the schedule's own zone, and says so.
    expect(hydra.getByTestId('boss-next-window')).toHaveTextContent(
      'Next window Fri, Oct 30, 2026, 18:00 (America/Toronto)',
    );

    const tiger = row('Paper Tiger');
    expect(tiger.getByTestId('boss-status')).toHaveTextContent('Draft');
    expect(tiger.getByTestId('boss-encounters')).toHaveTextContent('No encounters yet');
    expect(tiger.getByTestId('boss-art-paper_tiger-empty')).toHaveTextContent('No art');
    expect(row('Old Guard').getByTestId('boss-status')).toHaveTextContent('Disabled');

    expect(screen.getByRole('link', { name: 'New Boss' })).toHaveAttribute(
      'href',
      '/admin/bosses/new',
    );
    expect(matron.getByRole('link', { name: 'Edit Iron Matron' })).toHaveAttribute('href', MATRON);
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute(
      'href',
      '/admin/bosses/activity',
    );
  });

  it('searches by name and id, and filters by region and status', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');

    await user.type(screen.getByLabelText('Search bosses'), 'hydra');
    expect(rowNames()).toEqual(['Neon Hydra']);
    expect(screen.getByTestId('boss-count')).toHaveTextContent('1 of 4 shown');
    await retype(user, 'Search bosses', 'old_gu');
    expect(rowNames()).toEqual(['Old Guard']);
    await retype(user, 'Search bosses', 'nothing like this');
    expect(screen.getByTestId('boss-no-match')).toBeInTheDocument();
    await retype(user, 'Search bosses', '');

    expect(
      within(screen.getByLabelText('Filter by region'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any region', 'Twin Peeks', 'Waifu Valley']);
    await user.selectOptions(screen.getByLabelText('Filter by region'), 'twin-peeks');
    expect(rowNames()).toEqual(['Neon Hydra', 'Paper Tiger']);
    await user.selectOptions(screen.getByLabelText('Filter by region'), '');

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'draft');
    expect(rowNames()).toEqual(['Paper Tiger']);
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'disabled');
    expect(rowNames()).toEqual(['Old Guard']);
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'active');
    expect(rowNames()).toEqual(['Iron Matron', 'Neon Hydra']);
  });

  it('activates and disables a boss with the revision it showed', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    // An Active boss offers Disable only; a Disabled one, Activate only.
    expect(screen.queryByRole('button', { name: 'Activate Iron Matron' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable Old Guard' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Activate Old Guard' }));
    await waitFor(() => expect(boss.status).toHaveBeenCalledWith('old_guard', 'active', 3));
    await waitFor(() =>
      expect(row('Old Guard').getByTestId('boss-status')).toHaveTextContent('Active'),
    );

    await user.click(screen.getByRole('button', { name: 'Disable Iron Matron' }));
    await waitFor(() => expect(boss.status).toHaveBeenCalledWith('iron_matron', 'disabled', 3));
    await waitFor(() =>
      expect(row('Iron Matron').getByTestId('boss-status')).toHaveTextContent('Disabled'),
    );
  });

  it('shows why a boss cannot be activated, and where to fix it', async () => {
    boss.status.mockRejectedValueOnce(
      apiError(400, 'BOSS_DEFINITION_INVALID', 'This boss is not valid.', {
        issues: [
          {
            path: 'rewardTable',
            message: 'An active boss needs a reward table.',
            severity: 'error',
          },
          {
            path: 'scoutingText',
            message: 'An active boss needs scouting text.',
            severity: 'error',
          },
        ],
      }),
    );
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Activate Paper Tiger' }));

    const refused = within(await screen.findByTestId('boss-activation-refused'));
    expect(refused.getByText('Paper Tiger cannot be made Active yet.')).toBeInTheDocument();
    expect(refused.getByText('An active boss needs a reward table.')).toBeInTheDocument();
    expect(refused.getByText('An active boss needs scouting text.')).toBeInTheDocument();
    expect(refused.getByRole('link', { name: 'Open Paper Tiger to fix it' })).toHaveAttribute(
      'href',
      '/admin/bosses/paper_tiger',
    );
    expect(row('Paper Tiger').getByTestId('boss-status')).toHaveTextContent('Draft');
  });

  it('says so when someone else changed the boss first', async () => {
    boss.status.mockRejectedValueOnce(staleError());
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Disable Iron Matron' }));
    expect(
      await screen.findByText(
        /That boss was changed by someone else — the list has been refreshed/,
      ),
    ).toBeInTheDocument();
  });

  it('duplicates a boss under a suggested id, as a draft, and opens the copy', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Duplicate Neon Hydra' }));
    const dialog = within(await screen.findByTestId('duplicate-boss-dialog'));
    expect(dialog.getByLabelText('Id of the copy')).toHaveValue('neon_hydra_copy');
    expect(dialog.getByText(/The\s+copy starts as a Draft/)).toBeInTheDocument();

    // A bad id is caught before the round trip; a reserved one too.
    await user.clear(dialog.getByLabelText('Id of the copy'));
    await user.type(dialog.getByLabelText('Id of the copy'), 'Neon Hydra');
    expect(dialog.getByRole('alert')).toHaveTextContent('lowercase snake_case');
    expect(dialog.getByRole('button', { name: 'Duplicate' })).toBeDisabled();
    await user.clear(dialog.getByLabelText('Id of the copy'));
    await user.type(dialog.getByLabelText('Id of the copy'), 'activity');
    expect(dialog.getByRole('alert')).toHaveTextContent('“activity” is reserved');

    await user.clear(dialog.getByLabelText('Id of the copy'));
    await user.type(dialog.getByLabelText('Id of the copy'), 'neon_hydra_ii');
    await user.type(dialog.getByLabelText('Name of the copy'), 'Neon Hydra II');
    await user.click(dialog.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() =>
      expect(boss.duplicate).toHaveBeenCalledWith('neon_hydra', {
        id: 'neon_hydra_ii',
        name: 'Neon Hydra II',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Boss — Neon Hydra II' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Boss status')).toHaveValue('draft');
  });

  it('says the id is taken when duplicating onto an existing boss', async () => {
    boss.duplicate.mockRejectedValueOnce(
      apiError(409, 'BOSS_DEFINITION_KEY_TAKEN', 'That id is already in use.'),
    );
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Duplicate Neon Hydra' }));
    const dialog = within(await screen.findByTestId('duplicate-boss-dialog'));
    await user.click(dialog.getByRole('button', { name: 'Duplicate' }));
    expect(
      await dialog.findByText(/A boss with the id “neon_hydra_copy” already exists/),
    ).toBeInTheDocument();
  });

  it('deletes a boss only after asking, with the revision it showed', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Delete Paper Tiger' }));
    const dialog = within(await screen.findByTestId('delete-boss-dialog'));
    expect(dialog.getByText('Delete Paper Tiger?')).toBeInTheDocument();
    expect(boss.remove).not.toHaveBeenCalled();

    // Backing out changes nothing.
    await user.click(dialog.getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByTestId('delete-boss-dialog')).not.toBeInTheDocument());
    expect(boss.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete Paper Tiger' }));
    await user.click(
      within(await screen.findByTestId('delete-boss-dialog')).getByRole('button', {
        name: 'Delete boss',
      }),
    );
    await waitFor(() => expect(boss.remove).toHaveBeenCalledWith('paper_tiger', 3));
    await waitFor(() => expect(rowNames()).toEqual(['Iron Matron', 'Neon Hydra', 'Old Guard']));
  });

  it('shows the in-use refusal as the server worded it, and offers to disable instead', async () => {
    boss.remove.mockRejectedValueOnce(
      apiError(
        409,
        'BOSS_DEFINITION_IN_USE',
        'Iron Matron has encounter history and ships with the game, so it cannot be deleted.',
        { encounterCount: 7, shipped: true },
      ),
    );
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Delete Iron Matron' }));
    const dialog = within(await screen.findByTestId('delete-boss-dialog'));
    await user.click(dialog.getByRole('button', { name: 'Delete boss' }));

    const refused = within(await dialog.findByTestId('boss-delete-refused'));
    expect(
      refused.getByText(
        'Iron Matron has encounter history and ships with the game, so it cannot be deleted.',
      ),
    ).toBeInTheDocument();
    expect(refused.getByText(/It has 7 recorded encounters/)).toBeInTheDocument();
    expect(refused.getByText(/It ships with the game/)).toBeInTheDocument();
    expect(refused.getByText(/Disable it instead/)).toBeInTheDocument();
    // The refused delete is no longer on offer.
    expect(dialog.queryByRole('button', { name: 'Delete boss' })).not.toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Disable instead' }));
    await waitFor(() => expect(boss.status).toHaveBeenCalledWith('iron_matron', 'disabled', 3));
    await waitFor(() => expect(screen.queryByTestId('delete-boss-dialog')).not.toBeInTheDocument());
    expect(row('Iron Matron').getByTestId('boss-status')).toHaveTextContent('Disabled');
  });

  it('exports the document under the file name the server gives', async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    const user = renderAt(LIST);
    await screen.findAllByTestId('boss-row');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByTestId('boss-export-notice')).toHaveTextContent(
      'Downloaded boss-definitions.json — 4 bosses, schedules included.',
    );
    expect(downloads).toEqual(['boss-definitions.json']);
  });

  it('is read-only without `bosses.write`: no lifecycle, duplicate, delete or create', async () => {
    renderAt(LIST, READ_ONLY);
    await screen.findAllByTestId('boss-row');
    expect(screen.queryByRole('link', { name: 'New Boss' })).not.toBeInTheDocument();
    for (const action of ['Activate', 'Disable', 'Duplicate', 'Delete']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${action} `) })).toBeNull();
    }
    expect(screen.getByRole('link', { name: 'View Iron Matron' })).toHaveAttribute('href', MATRON);
    // Export is a read.
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });
});

/* ───────────────────────── creating ───────────────────────── */

describe('boss creation', () => {
  it('makes the id from the name, starts as a Draft, and opens the editor on the new boss', async () => {
    const user = renderAt('/admin/bosses/new');
    expect(await screen.findByRole('heading', { name: 'New boss' })).toBeInTheDocument();
    expect(boss.get).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create boss' })).toBeDisabled();

    await user.type(screen.getByLabelText('Boss name'), 'Glass Widow');
    expect(screen.getByLabelText('Boss id')).toHaveValue('glass_widow');
    await user.click(screen.getByLabelText('Region Waifu Valley'));
    await user.selectOptions(screen.getByLabelText('Boss affinity'), 'caregiver');
    await user.selectOptions(screen.getByLabelText('Reward table'), 'boss_standard');
    await user.selectOptions(screen.getByLabelText('Boss artwork'), 'bosses/neon_hydra.webp');
    await user.type(screen.getByLabelText('Scouting text'), 'A shimmer in the dark.');
    await user.click(screen.getByRole('button', { name: 'Create boss' }));

    await waitFor(() =>
      expect(boss.create).toHaveBeenCalledWith('glass_widow', {
        name: 'Glass Widow',
        affinity: 'caregiver',
        regions: ['waifu-valley'],
        status: 'draft',
        artwork: 'bosses/neon_hydra.webp',
        artworkAssetId: null,
        rewardTable: 'boss_standard',
        scoutingText: 'A shimmer in the dark.',
        repelledText: '',
        unchallengedText: '',
        description: '',
        schedule: ALWAYS,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Boss — Glass Widow' })).toBeInTheDocument();
    expect(screen.getByTestId('boss-id')).toHaveTextContent('glass_widow');
  });

  it('refuses a malformed or reserved id before the round trip, and reports a taken one', async () => {
    boss.create.mockRejectedValueOnce(
      apiError(409, 'BOSS_DEFINITION_KEY_TAKEN', 'That id is already in use.'),
    );
    const user = renderAt('/admin/bosses/new');
    await user.type(await screen.findByLabelText('Boss name'), 'Iron Matron');

    await retype(user, 'Boss id', 'Iron-Matron');
    expect(screen.getByTestId('boss-id-error')).toHaveTextContent('lowercase snake_case');
    expect(screen.getByRole('button', { name: 'Create boss' })).toBeDisabled();
    await retype(user, 'Boss id', 'new');
    expect(screen.getByTestId('boss-id-error')).toHaveTextContent('“new” is reserved');

    await retype(user, 'Boss id', 'iron_matron');
    await user.click(screen.getByRole('button', { name: 'Create boss' }));
    expect(await screen.findByTestId('boss-id-taken')).toHaveTextContent(
      'A boss with the id “iron_matron” already exists',
    );
  });

  it('shows what the server refused beside the fields it names', async () => {
    boss.create.mockRejectedValueOnce(
      apiError(400, 'BOSS_DEFINITION_INVALID', 'This boss is not valid.', {
        issues: [
          { path: 'id', message: 'another boss already uses that id', severity: 'error' },
          {
            path: 'regions',
            message: 'An active boss needs at least one region.',
            severity: 'error',
          },
        ],
      }),
    );
    const user = renderAt('/admin/bosses/new');
    await user.type(await screen.findByLabelText('Boss name'), 'Glass Widow');
    await user.click(screen.getByRole('button', { name: 'Create boss' }));
    expect(await screen.findByTestId('boss-identity-issues')).toHaveTextContent(
      'another boss already uses that id',
    );
    expect(screen.getByTestId('boss-regions-issues')).toHaveTextContent(
      'An active boss needs at least one region.',
    );
  });
});

/* ───────────────────────── the editor ───────────────────────── */

describe('boss editor', () => {
  it('loads the boss into its sections, with the id fixed', async () => {
    renderAt(MATRON);
    expect(await screen.findByRole('heading', { name: 'Boss — Iron Matron' })).toBeInTheDocument();
    expect(screen.getByLabelText('Boss name')).toHaveValue('Iron Matron');
    expect(screen.getByTestId('boss-id')).toHaveTextContent('iron_matron');
    expect(screen.queryByLabelText('Boss id')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Boss status')).toHaveValue('active');
    expect(screen.getByLabelText('Boss description')).toHaveValue('She keeps the furnaces.');
    expect(screen.getByLabelText('Boss artwork')).toHaveValue('bosses/iron_matron.webp');
    expect(await screen.findByTestId('boss-artwork-preview-image')).toBeInTheDocument();
    expect(screen.getByLabelText('Region Waifu Valley')).toBeChecked();
    expect(screen.getByLabelText('Region Twin Peeks')).not.toBeChecked();
    expect(screen.getByLabelText('Boss affinity')).toHaveValue('dominant');
    expect(screen.getByLabelText('Reward table')).toHaveValue('boss_standard');
    expect(screen.getByLabelText('Scouting text')).toHaveValue('It has been sighted.');
    expect(screen.getByLabelText('Repelled text')).toHaveValue('It was driven off.');
    expect(screen.getByLabelText('Unchallenged text')).toHaveValue('Nobody came.');
    expect(screen.getByLabelText('Always available')).toBeChecked();
    expect(screen.getByTestId('boss-provenance')).toHaveTextContent(
      /Revision 3 · .* by bootstrap · ships with the game · 7 encounters/,
    );
    expect(screen.getByTestId('boss-save-status')).toHaveTextContent('No unsaved changes.');
    expect(screen.getByRole('button', { name: 'Save boss' })).toBeDisabled();
  });

  it('shows the global encounter tuning read-only, and says it is shared by every boss', async () => {
    renderAt(MATRON);
    const combat = within(await screen.findByTestId('boss-combat'));
    expect(combat.getByTestId('boss-tuning-attacks')).toHaveTextContent('3');
    expect(combat.getByText(/Shared by every boss.*changed in content/)).toBeInTheDocument();

    const spawning = within(screen.getByTestId('boss-spawning'));
    expect(spawning.getByTestId('boss-tuning-window')).toHaveTextContent('45 minutes');
    expect(spawning.getByTestId('boss-tuning-cooldown')).toHaveTextContent(
      '90 minutes to 180 minutes',
    );
    expect(spawning.getByText(/Shared by every boss.*changed in content/)).toBeInTheDocument();
    // They are facts, not fields: nothing in either section but the affinity can be edited.
    expect(spawning.queryByRole('textbox')).not.toBeInTheDocument();
    expect(spawning.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(combat.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('names the chosen reward table, and flags a disabled table', async () => {
    renderAt(MATRON);
    // Reward tables are content on this branch: named, never linked.
    await screen.findByTestId('boss-rewards');
    expect(screen.queryByTestId('boss-reward-table-link')).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Reward table'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None yet', 'boss_standard', 'boss_legacy (disabled)']);
  });

  it('saves the whole boss with the revision it loaded', async () => {
    const user = renderAt(MATRON);
    await retype(user, 'Boss name', 'Iron Matriarch');
    await user.click(screen.getByLabelText('Region Twin Peeks'));
    await user.selectOptions(screen.getByLabelText('Boss affinity'), 'switch');
    await user.selectOptions(screen.getByLabelText('Boss status'), 'disabled');
    await retype(user, 'Repelled text', 'She retreats to the furnaces.');
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();
    await save(user);

    await waitFor(() => expect(boss.update).toHaveBeenCalledTimes(1));
    expect(boss.update).toHaveBeenCalledWith(
      'iron_matron',
      {
        ...inputOfDetail(boss.store().iron_matron!),
        name: 'Iron Matriarch',
        regions: ['waifu-valley', 'twin-peeks'],
        affinity: 'switch',
        status: 'disabled',
        repelledText: 'She retreats to the furnaces.',
        schedule: ALWAYS,
      },
      3,
    );
    expect(
      await screen.findByRole('heading', { name: 'Boss — Iron Matriarch' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('boss-save-status')).toHaveTextContent('Saved.');
    expect(screen.getByTestId('boss-provenance')).toHaveTextContent(/Revision 4 · .* by 777/);

    // The next save names the new revision.
    await retype(user, 'Boss name', 'Iron Matron');
    await save(user);
    await waitFor(() => expect(boss.update).toHaveBeenCalledTimes(2));
    expect(boss.update.mock.calls[1]![2]).toBe(4);
  });

  it('saves the schedule the availability section holds', async () => {
    const user = renderAt(HYDRA);
    expect(await screen.findByLabelText('Weekly schedule')).toBeChecked();
    expect(screen.getByLabelText('Friday window 1 end')).toHaveValue('23:00');
    await retype(user, 'Friday window 1 end', '02:00');
    await save(user);
    await waitFor(() => expect(boss.update).toHaveBeenCalledTimes(1));
    expect(boss.update.mock.calls[0]![1].schedule).toEqual({
      timezone: 'America/Toronto',
      weekly: [{ day: 'fri', allDay: false, windows: [{ start: '18:00', end: '02:00' }] }],
      dateRange: null,
    });
  });

  it('discards edits back to the loaded boss', async () => {
    const user = renderAt(MATRON);
    await retype(user, 'Boss name', 'Something Else');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Boss name')).toHaveValue('Iron Matron');
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
    expect(boss.update).not.toHaveBeenCalled();
  });

  it('refuses to overwrite when someone else saved first, and reloads their version', async () => {
    boss.update.mockRejectedValueOnce(staleError());
    const user = renderAt(MATRON);
    await retype(user, 'Boss name', 'Mine');
    await save(user);

    const banner = within(await screen.findByTestId('stale-banner'));
    expect(
      banner.getByText('This boss was changed by someone else since you opened it.'),
    ).toBeInTheDocument();
    expect(
      banner.getByText(/revision 4 \(saved by 999\)\. Your change was not applied/),
    ).toBeInTheDocument();
    // Nothing more can be sent on top of the stale revision.
    expect(screen.getByRole('button', { name: 'Save boss' })).toBeDisabled();
    expect(boss.update).toHaveBeenCalledTimes(1);

    boss.get.mockResolvedValueOnce(
      bossFixture({ id: 'iron_matron', name: 'Theirs', revision: 4, updatedBy: '999' }),
    );
    await user.click(banner.getByRole('button', { name: 'Reload latest version' }));
    await waitFor(() => expect(screen.getByLabelText('Boss name')).toHaveValue('Theirs'));
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();

    await retype(user, 'Boss name', 'Ours');
    await save(user);
    await waitFor(() => expect(boss.update).toHaveBeenCalledTimes(2));
    expect(boss.update.mock.calls[1]![2]).toBe(4);
  });

  it('shows refused errors and warnings beside the fields they name', async () => {
    boss.update.mockRejectedValueOnce(
      apiError(400, 'BOSS_DEFINITION_INVALID', 'This boss is not valid.', {
        issues: [
          { path: 'name', message: 'a name is required', severity: 'error' },
          {
            path: 'regions',
            message: 'An active boss needs at least one region.',
            severity: 'error',
          },
          {
            path: 'rewardTable',
            message: 'Boss reward table "gone" does not exist.',
            severity: 'error',
          },
          { path: 'artwork', message: 'No file at "bosses/x.webp".', severity: 'warning' },
          {
            path: 'scoutingText',
            message: 'An active boss needs scouting text.',
            severity: 'error',
          },
          {
            path: 'schedule.weekly[0].windows',
            message: 'Fri needs at least one time window, or all day',
            severity: 'error',
          },
          {
            path: 'schedule',
            message: 'This schedule has no availability window in the next year.',
            severity: 'error',
          },
          {
            path: 'somethingNew',
            message: 'A problem this page has no field for.',
            severity: 'error',
          },
        ],
      }),
    );
    const user = renderAt(HYDRA);
    await retype(user, 'Boss name', 'Neon Hydra Prime');
    await save(user);

    expect(await screen.findByTestId('boss-identity-issues')).toHaveTextContent(
      'a name is required',
    );
    expect(screen.getByTestId('boss-regions-issues')).toHaveTextContent(
      'An active boss needs at least one region.',
    );
    expect(screen.getByTestId('boss-rewards-issues')).toHaveTextContent(
      'Boss reward table "gone" does not exist.',
    );
    // A warning is marked as one, and is not an alert.
    const artwork = within(screen.getByTestId('boss-artwork-issues'));
    expect(artwork.getByText(/⚠ No file at "bosses\/x\.webp"\./)).toBeInTheDocument();
    expect(artwork.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('boss-scoutingText-issues')).toHaveTextContent(
      'An active boss needs scouting text.',
    );
    // `schedule.weekly[0]` is the first enabled weekday: Friday.
    expect(screen.getByTestId('schedule-day-fri-issues')).toHaveTextContent(
      'Fri needs at least one time window, or all day',
    );
    expect(screen.getByTestId('schedule-issues')).toHaveTextContent(
      'This schedule has no availability window in the next year.',
    );
    expect(screen.getByTestId('boss-other-issues')).toHaveTextContent(
      'A problem this page has no field for.',
    );
    // The page's own Save error is not shown on top of the field issues.
    expect(screen.queryByText('Could not save')).not.toBeInTheDocument();
  });

  it('shows the stored boss’s standing issues at their fields when it opens', async () => {
    boss.get.mockResolvedValueOnce(
      bossFixture({
        id: 'paper_tiger',
        name: 'Paper Tiger',
        status: 'draft',
        rewardTable: '',
        issues: [
          {
            path: 'rewardTable',
            message: 'An active boss needs a reward table.',
            severity: 'warning',
          },
        ],
      }),
    );
    renderAt('/admin/bosses/paper_tiger');
    expect(await screen.findByTestId('boss-rewards-issues')).toHaveTextContent(
      '⚠ An active boss needs a reward table.',
    );
    expect(screen.queryByTestId('boss-reward-table-link')).not.toBeInTheDocument();
  });

  it('catches an empty name before the round trip', async () => {
    const user = renderAt(MATRON);
    await retype(user, 'Boss name', '');
    expect(screen.getByTestId('boss-identity-issues')).toHaveTextContent('A name is required.');
    expect(screen.getByTestId('boss-save-status')).toHaveTextContent(
      '1 problem to fix before saving.',
    );
    expect(screen.getByRole('button', { name: 'Save boss' })).toBeDisabled();
  });

  it('lists the boss’s recent changes from the audit trail', async () => {
    boss.events.mockResolvedValue({
      events: [
        {
          id: 9,
          bossKey: 'iron_matron',
          action: 'schedule_override',
          actor: '777',
          details: { encounterId: 41, scheduleOverridden: true },
          createdAt: '2026-10-09T15:00:00.000Z',
        },
        {
          id: 8,
          bossKey: 'iron_matron',
          action: 'status',
          actor: '777',
          details: { from: 'draft', to: 'active', revision: 3 },
          createdAt: '2026-10-08T15:00:00.000Z',
        },
        {
          id: 7,
          bossKey: 'iron_matron',
          action: 'update',
          actor: null,
          details: { revision: 2, changed: ['name', 'schedule'] },
          createdAt: '2026-10-07T15:00:00.000Z',
        },
      ],
    });
    renderAt(MATRON);
    await waitFor(() => expect(screen.getAllByTestId('boss-event')).toHaveLength(3));
    expect(boss.events).toHaveBeenCalledWith(
      { bossId: 'iron_matron', limit: 10 },
      expect.anything(),
    );
    const [override, status, update] = screen.getAllByTestId('boss-event');
    expect(override).toHaveTextContent(
      'Schedule overridden for a manual spawn — encounter #41 — 777',
    );
    expect(status).toHaveTextContent('Status changed: Draft → Active — 777');
    expect(update).toHaveTextContent('Edited: name, schedule — system');
  });

  it('is read-only without `bosses.write`', async () => {
    renderAt(HYDRA, READ_ONLY);
    expect(await screen.findByRole('heading', { name: 'Boss — Neon Hydra' })).toBeInTheDocument();
    for (const label of [
      'Boss name',
      'Boss status',
      'Boss description',
      'Boss artwork',
      'Region Waifu Valley',
      'Boss affinity',
      'Reward table',
      'Scouting text',
      'Timezone',
      'Friday',
      'Friday window 1 start',
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByLabelText('Weekly schedule')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add Friday window' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save boss' })).toBeDisabled();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
    expect(screen.queryByTestId('boss-reward-table-link')).not.toBeInTheDocument();
    // The preview is a read, so a read-only admin still sees what the schedule means.
    expect(await screen.findByTestId('schedule-summary')).toBeInTheDocument();
  });

  it('reports a boss that does not exist', async () => {
    renderAt('/admin/bosses/nobody');
    expect(await screen.findByText('Could not load the boss')).toBeInTheDocument();
  });
});
