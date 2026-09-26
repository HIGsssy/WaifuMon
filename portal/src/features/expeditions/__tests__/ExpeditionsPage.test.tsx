/**
 * Expeditions page tests.
 *
 * What this page must get right is less "does it render" than:
 *
 *   1. **Read-only.** No Start / Collect / Recall / Reroll control exists, and
 *      the only request the page makes is the one GET.
 *   2. **Finished means "claim in Discord".** Never a result, never a button.
 *   3. **Occupied regions are obvious** without implying the Portal can act.
 *   4. **Clocks tick locally.** A countdown moving costs no request.
 */
import { act, screen, within } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { data } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import type { ExpeditionOverview } from '@/api/types';
import { formatCountdown, formatMinutes } from '@/lib/format';
import { renderRoutes } from '@/test/renderWithProviders';

function renderExpeditions() {
  return renderRoutes({ routes, initialEntries: ['/expeditions'] });
}

function serve(overview: ExpeditionOverview) {
  server.use(http.get('/api/v1/players/:playerId/expeditions', () => data(overview)));
}

const activeList = () => screen.findByRole('list', { name: 'Active Expeditions' });

afterEach(() => {
  vi.useRealTimers();
});

describe('navigation', () => {
  it('offers Expeditions as a real destination', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/expeditions');
    expect(entry?.label).toBe('Expeditions');
    expect(entry?.comingSoon).toBeUndefined();
  });
});

describe('ExpeditionsPage — active', () => {
  it('shows every open mission with her name, level, region and match', async () => {
    renderExpeditions();
    const list = await activeList();
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);

    const summit = cards[0]!;
    expect(within(summit).getByText('Summit Relay')).toBeInTheDocument();
    expect(within(summit).getByText('Nyx')).toBeInTheDocument();
    expect(within(summit).getByText(/Lv 22/)).toBeInTheDocument();
    expect(within(summit).getByText('Twin Peeks')).toBeInTheDocument();
    expect(within(summit).getByText('Strong match')).toBeInTheDocument();
    expect(within(summit).getByText('6h')).toBeInTheDocument();
    expect(within(summit).getByText(/Returns in 2h 1[45]m/)).toBeInTheDocument();
    expect(within(summit).getByRole('progressbar')).toBeInTheDocument();
    expect(within(summit).getByRole('link', { name: 'View Nyx' })).toHaveAttribute(
      'href',
      '/collection/101',
    );

    const orchard = cards[1]!;
    expect(within(orchard).getByText('Orchard Watch')).toBeInTheDocument();
    expect(within(orchard).getByText('Waifu Valley')).toBeInTheDocument();
  });

  it('marks a finished mission "Complete — claim in Discord", with no result and no button', async () => {
    renderExpeditions();
    const list = await activeList();
    const orchard = within(list).getAllByRole('listitem')[1]!;
    expect(within(orchard).getByText('Complete — claim in Discord')).toBeInTheDocument();
    expect(within(orchard).queryByText(/Returns in/)).not.toBeInTheDocument();
    expect(within(orchard).queryByText(/success|failure|exceptional/i)).not.toBeInTheDocument();
  });

  it('offers no gameplay controls anywhere on the page', async () => {
    renderExpeditions();
    await activeList();
    expect(
      screen.queryByRole('button', {
        name: /start|assign|deploy|claim|collect|cancel|recall|reroll|refresh|send/i,
      }),
    ).toBeNull();
    expect(screen.getByText('Use Discord to start and manage Expeditions.')).toBeInTheDocument();
  });

  it('shows the empty state when nobody is away', async () => {
    serve({
      ...fixtures.expeditionOverview,
      active: [],
      regions: fixtures.expeditionOverview.regions.map((r) => ({ ...r, occupied: false })),
    });
    renderExpeditions();
    expect(
      await screen.findByText('No WaifuMon are currently away on an Expedition.'),
    ).toBeInTheDocument();
  });
});

describe('ExpeditionsPage — regional boards', () => {
  it('groups offers by region in the order the API sent, current first', async () => {
    renderExpeditions();
    await activeList();
    const available = screen.getByRole('region', { name: 'Available Expeditions' });
    const headings = within(available)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent?.trim());
    expect(headings).toEqual(['🏔️ Twin Peeks', '🏜️ Thirstlands', 'Base 80085']);

    const peeks = screen.getByTestId('region-twin-peeks');
    expect(within(peeks).getByText('You are here')).toBeInTheDocument();
    expect(within(peeks).getByText('Ridge Survey')).toBeInTheDocument();

    const thirst = screen.getByTestId('region-thirstlands');
    const offers = within(thirst).getAllByRole('listitem');
    expect(offers.map((o) => within(o).getByRole('heading').textContent)).toEqual([
      '📦 Dune Salvage',
      '🐫 Oasis Escort',
    ]);
  });

  it('shows planning details for each offer', async () => {
    renderExpeditions();
    await activeList();
    const thirst = screen.getByTestId('region-thirstlands');
    const [dune, oasis] = within(thirst).getAllByRole('listitem');

    expect(within(dune!).getByText('3h')).toBeInTheDocument();
    expect(within(dune!).getByText('Recommended Lv 15')).toBeInTheDocument();
    expect(within(dune!).getByText('Salvage Dive')).toBeInTheDocument();
    expect(within(dune!).getByText('Android')).toBeInTheDocument();
    expect(within(dune!).getByText(/📦 Salvage · 🌟 Rare find/)).toBeInTheDocument();

    expect(within(oasis!).getByText('18h')).toBeInTheDocument();
    expect(within(oasis!).getByText('Caregiver / Switch')).toBeInTheDocument();
    expect(within(oasis!).getByText('Rewards unknown.')).toBeInTheDocument();
    expect(within(thirst).getByText('Travel here in Discord to start one.')).toBeInTheDocument();
  });

  it('makes an occupied region obvious and informational', async () => {
    renderExpeditions();
    await activeList();
    const peeks = screen.getByTestId('region-twin-peeks');
    expect(within(peeks).getByText('Occupied')).toBeInTheDocument();
    expect(within(peeks).getByText(/is working this region on/)).toHaveTextContent(
      /Nyx is working this region on Summit Relay — returns in/,
    );
    expect(within(peeks).getByText(/planning only/)).toBeInTheDocument();
    expect(within(screen.getByTestId('region-thirstlands')).queryByText('Occupied')).toBeNull();
  });

  it('shows the empty state for a region with no board', async () => {
    renderExpeditions();
    await activeList();
    expect(
      within(screen.getByTestId('region-base-80085')).getByText(
        'No Expeditions are currently available here.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the board rotation countdown', async () => {
    renderExpeditions();
    await activeList();
    expect(screen.getByTestId('rotation-countdown')).toHaveTextContent(
      /Boards rotate in 3h (29|30)m/,
    );
  });
});

describe('ExpeditionsPage — clocks', () => {
  it('ticks countdowns locally without another request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let requests = 0;
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url, 'http://localhost').pathname.endsWith('/expeditions')) requests++;
    });

    renderExpeditions();
    const list = await activeList();
    const summit = within(list).getAllByRole('listitem')[0]!;
    const before = within(summit).getByText(/Returns in/).textContent;
    expect(requests).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });

    const after = within(summit).getByText(/Returns in/).textContent;
    expect(after).not.toBe(before);
    expect(requests).toBe(1);
    server.events.removeAllListeners();
  });

  it('turns a mission complete when its countdown runs out, still without a request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const soon = new Date(Date.now() + 30_000).toISOString();
    serve({
      ...fixtures.expeditionOverview,
      active: [
        { ...fixtures.expeditionOverview.active[0]!, completesAt: soon, secondsRemaining: 30 },
      ],
    });
    renderExpeditions();
    const list = await activeList();
    expect(within(list).getByText(/Returns in less than a minute/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(list).getByText('Complete — claim in Discord')).toBeInTheDocument();
  });
});

describe('formatting', () => {
  it('formats durations the way Discord does', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(150)).toBe('2h 30m');
    expect(formatMinutes(1080)).toBe('18h');
    expect(formatMinutes(1560)).toBe('1d 2h');
  });

  it('counts down to a timestamp, rounding up, and stops at zero', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    expect(formatCountdown('2026-09-25T12:13:30Z', now)).toBe('2h 14m');
    expect(formatCountdown('2026-09-25T10:00:20Z', now)).toBe('less than a minute');
    expect(formatCountdown('2026-09-25T09:59:00Z', now)).toBeNull();
  });
});
