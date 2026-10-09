/**
 * The Boss Activity page: the active and recent encounter tables, Spawn Now —
 * including the one refusal that may be deliberately overridden, behind an
 * explicit confirmation — End Encounter and what it tells the admin about
 * committed players, and Diagnostics, which never reports a scheduler it
 * cannot see as healthy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';

import { BossActivityPage } from '../BossActivityPage';
import {
  ALL,
  FRIDAY_EVENINGS,
  NEXT_FRIDAY,
  OPEN,
  READ_ONLY,
  apiError,
  bossFixture,
  diagnosticsFixture,
  encounterFixture,
  installBossApi,
  renderWithSession,
  type BossApi,
} from './bossFixtures';

let boss: BossApi;

const ACTIVE = encounterFixture();
const PAST = encounterFixture({
  id: 40,
  bossId: 'neon_hydra',
  bossName: 'Neon Hydra',
  status: 'resolved',
  forced: true,
  resolvedAt: '2026-10-08T21:00:00.000Z',
  participantCount: 9,
  totalDamage: 125000,
  resolutionReason: 'repelled',
});

beforeEach(() => {
  boss = installBossApi([
    bossFixture({ id: 'iron_matron', name: 'Iron Matron' }),
    bossFixture({
      id: 'neon_hydra',
      name: 'Neon Hydra',
      schedule: FRIDAY_EVENINGS,
      scheduleSummary: 'Fri 18:00–23:00 (America/Toronto)',
      availability: NEXT_FRIDAY,
    }),
    bossFixture({ id: 'paper_tiger', name: 'Paper Tiger', status: 'draft' }),
  ]);
  boss.spawn.mockImplementation(async (id, overrideSchedule) => ({
    encounter: encounterFixture({
      id: 42,
      bossId: id,
      bossName: boss.store()[id]!.name,
      status: 'scheduled',
      forced: true,
      startedAt: null,
      expiresAt: null,
      participantCount: 0,
    }),
    scheduleOverridden: overrideSchedule,
    announcement: 'requested',
  }));
  boss.end.mockImplementation(async (id) => ({
    encounter: { ...ACTIVE, id, status: 'resolving' },
    announcement: 'requested',
  }));
});
afterEach(() => vi.restoreAllMocks());

function renderPage(permissions = ALL) {
  return renderWithSession(
    <Routes>
      <Route path="/admin/bosses/activity" element={<BossActivityPage />} />
      <Route path="*" element={<p>Elsewhere</p>} />
    </Routes>,
    '/admin/bosses/activity',
    permissions,
  );
}

const outsideSchedule = () =>
  apiError(409, 'BOSS_SPAWN_REFUSED', 'Neon Hydra is outside its availability schedule.', {
    reason: 'outside_schedule',
  });

describe('encounter tables', () => {
  it('shows the active encounter and the recent history', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [PAST] });
    renderPage();

    const active = within(await screen.findByTestId('active-encounters'));
    const live = within(active.getByTestId('encounter-row'));
    expect(live.getByRole('link', { name: 'Iron Matron' })).toHaveAttribute(
      'href',
      '/admin/bosses/iron_matron',
    );
    expect(live.getByText('#41')).toBeInTheDocument();
    expect(live.getByText('Waifu Valley')).toBeInTheDocument();
    expect(live.getByText('Open')).toBeInTheDocument();
    expect(live.queryByText('Manual')).not.toBeInTheDocument();
    expect(live.getByRole('cell', { name: '4' })).toBeInTheDocument();

    const recent = within(screen.getByTestId('recent-encounters'));
    const past = within(recent.getByTestId('encounter-row'));
    expect(past.getByText('Neon Hydra')).toBeInTheDocument();
    expect(past.getByText('Resolved')).toBeInTheDocument();
    expect(past.getByText('Manual')).toBeInTheDocument();
    expect(past.getByText('Repelled')).toBeInTheDocument();
    expect(past.getByRole('cell', { name: '9' })).toBeInTheDocument();
    expect(past.getByRole('cell', { name: '125,000' })).toBeInTheDocument();
    // History cannot be ended.
    expect(recent.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when nothing is active, and when the feature is switched off', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: false, active: [], recent: [] });
    renderPage();
    expect(await screen.findByTestId('boss-no-active')).toHaveTextContent(
      'No boss encounter is active on this server.',
    );
    expect(screen.getByTestId('boss-feature-off')).toHaveTextContent(
      'Boss encounters are switched off on this server.',
    );
  });
});

describe('Spawn Now', () => {
  it('offers only Active bosses, and spawns the chosen one without overriding anything', async () => {
    const user = renderPage();
    const picker = await screen.findByLabelText('Boss to spawn');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Iron Matron', 'Neon Hydra (outside its schedule)']);

    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
    await waitFor(() => expect(boss.spawn).toHaveBeenCalledWith('iron_matron', false));
    expect(boss.spawn).toHaveBeenCalledTimes(1);
    const notice = await screen.findByTestId('boss-spawn-notice');
    expect(notice).toHaveTextContent('Spawned Iron Matron (encounter #42).');
    expect(notice).toHaveTextContent('The scheduler has been asked to post it to Discord now.');
    expect(notice).not.toHaveTextContent('overridden');
    expect(screen.queryByTestId('override-schedule-confirm')).not.toBeInTheDocument();
  });

  it('asks before overriding the schedule, and spawns with the override only once confirmed', async () => {
    boss.spawn.mockRejectedValueOnce(outsideSchedule());
    const user = renderPage();
    await user.selectOptions(await screen.findByLabelText('Boss to spawn'), 'neon_hydra');
    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));

    const confirm = within(await screen.findByTestId('override-schedule-confirm'));
    expect(
      confirm.getByText('Neon Hydra is outside its availability schedule'),
    ).toBeInTheDocument();
    expect(
      confirm.getByText(/Spawning it now overrides\s+that schedule for this one encounter/),
    ).toBeInTheDocument();
    expect(
      confirm.getByText('The override is recorded in the audit trail under your name.'),
    ).toBeInTheDocument();
    // Nothing was retried on the admin's behalf.
    expect(boss.spawn).toHaveBeenCalledTimes(1);
    expect(boss.spawn).toHaveBeenLastCalledWith('neon_hydra', false);
    // The refusal is the question, not also an error banner.
    expect(screen.queryByTestId('boss-spawn-refused')).not.toBeInTheDocument();

    await user.click(confirm.getByRole('button', { name: 'Override schedule and spawn' }));
    await waitFor(() => expect(boss.spawn).toHaveBeenCalledTimes(2));
    expect(boss.spawn).toHaveBeenLastCalledWith('neon_hydra', true);
    const notice = await screen.findByTestId('boss-spawn-notice');
    expect(notice).toHaveTextContent('Spawned Neon Hydra (encounter #42).');
    expect(notice).toHaveTextContent(
      'Its availability schedule was overridden, and that has been recorded.',
    );
    await waitFor(() =>
      expect(screen.queryByTestId('override-schedule-confirm')).not.toBeInTheDocument(),
    );
  });

  it('spawns nothing when the override is declined', async () => {
    boss.spawn.mockRejectedValueOnce(outsideSchedule());
    const user = renderPage();
    await user.selectOptions(await screen.findByLabelText('Boss to spawn'), 'neon_hydra');
    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
    const confirm = within(await screen.findByTestId('override-schedule-confirm'));
    await user.click(confirm.getByRole('button', { name: 'Do not spawn' }));
    await waitFor(() =>
      expect(screen.queryByTestId('override-schedule-confirm')).not.toBeInTheDocument(),
    );
    expect(boss.spawn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('boss-spawn-notice')).not.toBeInTheDocument();
  });

  it.each([
    [
      'encounter_active',
      'This server already has an active boss encounter (Iron Matron). End it first.',
    ],
    ['reward_table_unavailable', 'The reward table "boss_standard" is disabled.'],
    ['feature_disabled', 'Boss encounters are switched off on this server.'],
  ])(
    'shows a %s refusal as the server worded it, with no way to override',
    async (reason, message) => {
      boss.spawn.mockRejectedValueOnce(apiError(409, 'BOSS_SPAWN_REFUSED', message, { reason }));
      const user = renderPage();
      await screen.findByLabelText('Boss to spawn');
      await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
      expect(await screen.findByTestId('boss-spawn-refused')).toHaveTextContent(message);
      expect(screen.queryByTestId('override-schedule-confirm')).not.toBeInTheDocument();
      expect(boss.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('shows a refused override as it is, rather than asking again', async () => {
    boss.spawn.mockRejectedValueOnce(outsideSchedule()).mockRejectedValueOnce(
      apiError(409, 'BOSS_SPAWN_REFUSED', 'This server already has an active boss encounter.', {
        reason: 'encounter_active',
      }),
    );
    const user = renderPage();
    await user.selectOptions(await screen.findByLabelText('Boss to spawn'), 'neon_hydra');
    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
    await user.click(
      within(await screen.findByTestId('override-schedule-confirm')).getByRole('button', {
        name: 'Override schedule and spawn',
      }),
    );
    expect(await screen.findByTestId('boss-spawn-refused')).toHaveTextContent(
      'This server already has an active boss encounter.',
    );
    expect(screen.queryByTestId('override-schedule-confirm')).not.toBeInTheDocument();
  });

  it('says the server has no boss channel', async () => {
    boss.spawn.mockRejectedValueOnce(
      apiError(404, 'BOSS_CHANNEL_NOT_CONFIGURED', 'This server has no boss channel configured.'),
    );
    const user = renderPage();
    await screen.findByLabelText('Boss to spawn');
    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
    expect(await screen.findByTestId('boss-spawn-refused')).toHaveTextContent(
      'This server has no boss channel configured.',
    );
  });

  it('says another process will announce it when this one runs no scheduler', async () => {
    boss.spawn.mockResolvedValueOnce({
      encounter: encounterFixture({ id: 43 }),
      scheduleOverridden: false,
      announcement: 'no_scheduler',
    });
    const user = renderPage();
    await screen.findByLabelText('Boss to spawn');
    await user.click(screen.getByRole('button', { name: 'Spawn Now' }));
    expect(await screen.findByTestId('boss-spawn-notice')).toHaveTextContent(
      'This API process runs no boss scheduler, so Discord is updated by whichever process does, on its next pass.',
    );
  });
});

describe('End Encounter', () => {
  it('asks first, saying committed players are still paid, and ends it only once confirmed', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [] });
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'End encounter with Iron Matron' }));

    const confirm = within(await screen.findByTestId('end-encounter-confirm'));
    expect(confirm.getByText('End the encounter with Iron Matron?')).toBeInTheDocument();
    expect(
      confirm.getByText(/Players who have already\s+committed are still paid in full/),
    ).toBeInTheDocument();
    expect(confirm.getByText(/4 players have\s+committed so far/)).toBeInTheDocument();
    expect(boss.end).not.toHaveBeenCalled();

    // Backing out ends nothing.
    await user.click(confirm.getByRole('button', { name: 'Keep it running' }));
    await waitFor(() =>
      expect(screen.queryByTestId('end-encounter-confirm')).not.toBeInTheDocument(),
    );
    expect(boss.end).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'End encounter with Iron Matron' }));
    await user.click(
      within(await screen.findByTestId('end-encounter-confirm')).getByRole('button', {
        name: 'End encounter',
      }),
    );
    await waitFor(() => expect(boss.end).toHaveBeenCalledWith(41));
    expect(await screen.findByTestId('boss-end-notice')).toHaveTextContent(
      'Ended the encounter with Iron Matron: 4 committed players are paid in full.',
    );
  });

  it('offers no End for an encounter that is already resolving', async () => {
    boss.activity.mockResolvedValue({
      featureEnabled: true,
      active: [{ ...ACTIVE, status: 'resolving' }],
      recent: [],
    });
    renderPage();
    const active = within(await screen.findByTestId('active-encounters'));
    expect(active.getByText('Already resolving')).toBeInTheDocument();
    expect(active.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows why an end was refused', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [] });
    boss.end.mockRejectedValueOnce(
      apiError(409, 'BOSS_SPAWN_REFUSED', 'That encounter is already resolving or finished.', {
        reason: 'not_active',
      }),
    );
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'End encounter with Iron Matron' }));
    await user.click(
      within(await screen.findByTestId('end-encounter-confirm')).getByRole('button', {
        name: 'End encounter',
      }),
    );
    expect(
      await screen.findByText('That encounter is already resolving or finished.'),
    ).toBeInTheDocument();
  });
});

describe('diagnostics', () => {
  it('says plainly that scheduler health is unknown when this process runs none', async () => {
    boss.diagnostics.mockResolvedValue(diagnosticsFixture({ scheduler: null }));
    renderPage();
    const scheduler = within(await screen.findByTestId('boss-scheduler'));
    expect(scheduler.getByTestId('boss-scheduler-health')).toHaveTextContent('Unknown');
    expect(scheduler.getByText('This API process runs no boss scheduler.')).toBeInTheDocument();
    expect(scheduler.getByText(/Its health cannot be seen from here/)).toBeInTheDocument();
    expect(scheduler.queryByText(/healthy/i)).not.toBeInTheDocument();
  });

  it.each([
    ['ok', 'Healthy', 'The last scheduler pass completed on time.'],
    [
      'stalled',
      'Stalled',
      'No scheduler pass has completed for 400 seconds (one is expected every 60).',
    ],
    ['failing', 'Failing', 'The last scheduler pass failed: connection refused'],
    ['stopped', 'Stopped', 'The boss scheduler is not running in this process.'],
  ] as const)('reports a %s scheduler with its explanation', async (health, label, explanation) => {
    const base = diagnosticsFixture().scheduler!;
    boss.diagnostics.mockResolvedValue(
      diagnosticsFixture({ scheduler: { ...base, health, explanation } }),
    );
    renderPage();
    const scheduler = within(await screen.findByTestId('boss-scheduler'));
    expect(scheduler.getByTestId('boss-scheduler-health')).toHaveTextContent(label);
    expect(scheduler.getByText(explanation)).toBeInTheDocument();
    expect(
      scheduler.getByText(/12 passes · every 60 s · .* 2 of 2 servers usable/),
    ).toBeInTheDocument();
  });

  it('shows this server’s spawn state', async () => {
    boss.diagnostics.mockResolvedValue(
      diagnosticsFixture({
        guild: {
          region: 'waifu-valley',
          channelConfigured: false,
          paused: true,
          suspendedReason: 'The boss channel was deleted.',
          suspendedAt: '2026-10-09T10:00:00.000Z',
          nextSpawnAt: '2026-10-09T17:00:00.000Z',
          cooldownActive: true,
          bagRemaining: 1,
        },
        active: ACTIVE,
      }),
    );
    renderPage();
    const guild = within(await screen.findByTestId('boss-guild-state'));
    expect(guild.getByTestId('guild-region')).toHaveTextContent('Waifu Valley');
    expect(guild.getByTestId('guild-channel')).toHaveTextContent('Not configured');
    expect(guild.getByTestId('guild-paused')).toHaveTextContent(
      /^Suspended: The boss channel was deleted\. \(since /,
    );
    expect(guild.getByTestId('guild-next-spawn')).toHaveTextContent(/^On cooldown until /);
    expect(guild.getByTestId('guild-bag')).toHaveTextContent('1 boss still owed');
    expect(guild.getByTestId('guild-active')).toHaveTextContent('Iron Matron (#41, open)');
  });

  it('reads a healthy, idle server as such', async () => {
    renderPage();
    const guild = within(await screen.findByTestId('boss-guild-state'));
    expect(guild.getByTestId('guild-channel')).toHaveTextContent('Configured');
    expect(guild.getByTestId('guild-paused')).toHaveTextContent('Running');
    expect(guild.getByTestId('guild-next-spawn')).toHaveTextContent(
      'Due as soon as a boss is eligible',
    );
    expect(guild.getByTestId('guild-bag')).toHaveTextContent('2 bosses still owed');
    expect(guild.getByTestId('guild-active')).toHaveTextContent('None');
  });

  it('groups the bosses by verdict, with what each verdict needs explained', async () => {
    const entry = (id: string, name: string) => ({
      id,
      name,
      status: 'active' as const,
      detail: null,
      heldByCooldown: false,
      timezone: 'America/Toronto',
      scheduleSummary: 'Always available',
      availability: OPEN,
    });
    boss.diagnostics.mockResolvedValue(
      diagnosticsFixture({
        bosses: [
          { ...entry('iron_matron', 'Iron Matron'), verdict: 'eligible', heldByCooldown: true },
          { ...entry('glass_widow', 'Glass Widow'), verdict: 'eligible' },
          {
            ...entry('neon_hydra', 'Neon Hydra'),
            verdict: 'outside_schedule',
            scheduleSummary: 'Fri 18:00–23:00 (America/Toronto)',
            availability: NEXT_FRIDAY,
          },
          { ...entry('paper_tiger', 'Paper Tiger'), verdict: 'not_active', status: 'draft' },
          { ...entry('old_guard', 'Old Guard'), verdict: 'not_active', status: 'disabled' },
          { ...entry('far_queen', 'Far Queen'), verdict: 'other_region' },
          {
            ...entry('broke_baron', 'Broke Baron'),
            verdict: 'reward_table_unavailable',
            detail: 'Reward table "boss_legacy" is disabled.',
          },
        ],
      }),
    );
    renderPage();
    const names = (testId: string) =>
      within(screen.getByTestId(testId))
        .getAllByTestId('verdict-boss')
        .map((li) => within(li).getByRole('link').textContent);

    const eligible = within(await screen.findByTestId('verdict-eligible'));
    expect(eligible.getByText('Eligible (2)')).toBeInTheDocument();
    expect(names('verdict-eligible')).toEqual(['Iron Matron', 'Glass Widow']);
    // Only the boss the cooldown is holding is flagged.
    const [matron, widow] = eligible.getAllByTestId('verdict-boss');
    expect(within(matron!).getByTestId('held-by-cooldown')).toHaveTextContent(
      'Waiting on the respawn cooldown',
    );
    expect(within(widow!).queryByTestId('held-by-cooldown')).not.toBeInTheDocument();

    const outside = within(screen.getByTestId('verdict-outside_schedule'));
    expect(outside.getByText('Outside schedule (1)')).toBeInTheDocument();
    expect(
      outside.getByText(
        'Fri 18:00–23:00 (America/Toronto) · Next window Fri, Oct 30, 2026, 18:00 (America/Toronto)',
      ),
    ).toBeInTheDocument();

    const inactive = within(screen.getByTestId('verdict-not_active'));
    expect(inactive.getByText('Draft or disabled (2)')).toBeInTheDocument();
    expect(inactive.getAllByTestId('boss-status').map((b) => b.textContent)).toEqual([
      'Draft',
      'Disabled',
    ]);

    expect(names('verdict-other_region')).toEqual(['Far Queen']);
    const unpaid = within(screen.getByTestId('verdict-reward_table_unavailable'));
    expect(unpaid.getByText('Reward table unavailable (1)')).toBeInTheDocument();
    expect(unpaid.getByText('Reward table "boss_legacy" is disabled.')).toBeInTheDocument();
  });
});

describe('bootstrap diagnostics', () => {
  it('says how many definitions exist and stays quiet when nothing is wrong', async () => {
    renderPage();
    const block = await screen.findByTestId('boss-bootstrap');
    expect(block).toHaveTextContent('3 boss definitions in the database.');
    expect(within(block).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names shipped bosses that never reached the database, and a failed import', async () => {
    boss.diagnostics.mockResolvedValue(
      diagnosticsFixture({
        bootstrap: {
          definitions: 1,
          missingShipped: ['iron_matron', 'velvet_tyrant'],
          lastRun: {
            at: '2026-10-09T15:00:00.000Z',
            error: 'connection refused',
            created: [],
            heldBack: [],
          },
        },
      }),
    );
    renderPage();
    const block = await screen.findByTestId('boss-bootstrap');
    expect(block).toHaveTextContent(
      '2 shipped bosses have no definition (iron_matron, velvet_tyrant)',
    );
    expect(block).toHaveTextContent('connection refused');
  });

  it('lists bosses imported disabled and waiting for activation', async () => {
    boss.diagnostics.mockResolvedValue(
      diagnosticsFixture({
        bootstrap: {
          definitions: 4,
          missingShipped: [],
          lastRun: {
            at: '2026-10-09T15:00:00.000Z',
            error: null,
            created: ['new_arrival'],
            heldBack: ['new_arrival'],
          },
        },
      }),
    );
    renderPage();
    expect(await screen.findByTestId('boss-bootstrap')).toHaveTextContent(
      'Imported disabled at the last start, waiting to be activated: new_arrival.',
    );
  });

  it('shows the live controls to an operator who cannot edit definitions', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [] });
    renderPage(['bosses.read', 'bosses.operate']);
    expect(await screen.findByTestId('boss-spawn')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /End encounter/i })).toBeInTheDocument();
  });

  it('hides the live controls from an editor who cannot operate', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [] });
    renderPage(['bosses.read', 'bosses.write']);
    expect(await screen.findByTestId('active-encounters')).toBeInTheDocument();
    expect(screen.queryByTestId('boss-spawn')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /End encounter/i })).not.toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('hides Spawn Now and End Encounter without `bosses.operate`, and still shows everything else', async () => {
    boss.activity.mockResolvedValue({ featureEnabled: true, active: [ACTIVE], recent: [PAST] });
    renderPage(READ_ONLY);
    expect(await screen.findByTestId('active-encounters')).toBeInTheDocument();
    expect(screen.getByTestId('recent-encounters')).toBeInTheDocument();
    expect(await screen.findByTestId('boss-scheduler')).toBeInTheDocument();

    expect(screen.queryByTestId('boss-spawn')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Spawn Now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /End encounter/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    // The Active-boss picker is not even fetched for.
    expect(boss.list).not.toHaveBeenCalled();
  });
});
