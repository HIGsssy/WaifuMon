/**
 * Buddy Bonus on the two detail pages.
 *
 * The rule under test throughout: **the Portal renders the sentence the API
 * hands it.** No case here asserts that a percentage was formatted, a target
 * phrase assembled or an effect id translated, because none of that is the
 * Portal's job — the API resolves it from the bot's own effect registry so
 * Discord and the Portal cannot describe one bonus two ways. What the Portal
 * *does* decide is whether the section appears at all, and whether the bonus is
 * currently in force, and that is what is asserted.
 *
 * Fixture bonuses (`msw/fixtures.ts`) cover the shapes that render differently:
 * a race-qualified capture bonus on `void_empress` (the buddy), an untargeted
 * item-find bonus on `neon_kitsune` (owned, not equipped), and no bonus at all
 * on `neko_barista`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import * as fixtures from '../../../msw/fixtures';
import { page as pageEnvelope } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderAt(path: string) {
  return renderRoutes({ routes, initialEntries: [path] });
}

/** The Buddy Bonus card, found by its section heading. */
function bonusSection(): HTMLElement {
  return screen.getByText('Buddy Bonus').closest('div') as HTMLElement;
}

const HIJACK = fixtures.buddyBonuses.void_empress!;
const TRASH_TREASURE = fixtures.buddyBonuses.neon_kitsune!;

describe('the encyclopedia entry', () => {
  it('shows the bonus name, effect and flavour for a discovered species', async () => {
    renderAt('/encyclopedia/void_empress');
    await screen.findByRole('heading', { name: 'Void Empress' });

    const section = await screen.findByText('Buddy Bonus');
    expect(section).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hijack' })).toBeInTheDocument();
    // A race-qualified capture bonus, phrased by the API — not reassembled here.
    expect(screen.getByText('+15% capture chance against android Waifumon')).toBeInTheDocument();
    expect(screen.getByText(`“${HIJACK.flavorText}”`)).toBeInTheDocument();
  });

  it('says the effect needs her equipped as Buddy', async () => {
    renderAt('/encyclopedia/void_empress');
    await screen.findByRole('heading', { name: 'Void Empress' });

    expect(
      await screen.findByText(/Applies while she is your active Buddy/i),
    ).toBeInTheDocument();
  });

  it('omits the section entirely for a species with no bonus', async () => {
    renderAt('/encyclopedia/neko_barista');
    await screen.findByRole('heading', { name: 'Neko Barista' });

    expect(screen.queryByText('Buddy Bonus')).toBeNull();
    // And no empty placeholder stood in for it.
    expect(screen.queryByText(/no buddy bonus/i)).toBeNull();
  });

  /** The bonus is authored lore too — an undiscovered entry gives away nothing. */
  it('withholds the bonus from an undiscovered entry', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope([], 1, 25, 0)),
    );

    renderAt('/encyclopedia/void_empress');
    await screen.findByRole('heading', { name: '???' });

    expect(screen.queryByText('Buddy Bonus')).toBeNull();
    expect(screen.queryByText('Hijack')).toBeNull();
  });
});

describe('an owned copy', () => {
  it('marks the bonus active when that copy is the Buddy', async () => {
    renderAt('/collection/101');
    await screen.findByRole('heading', { name: 'Nyx' });

    await screen.findByText('Buddy Bonus');
    expect(screen.getByRole('heading', { name: 'Hijack' })).toBeInTheDocument();
    expect(within(bonusSection()).getByText(/she is your Buddy/i)).toBeInTheDocument();
  });

  /**
   * A non-capture, untargeted effect — the other end of the range the one
   * component has to cover, and on a copy that is not equipped.
   */
  it('shows an unequipped copy what equipping her would do', async () => {
    renderAt('/collection/102');
    await screen.findByRole('heading', { name: 'Neon Kitsune' });

    await screen.findByText('Buddy Bonus');
    expect(screen.getByRole('heading', { name: 'Trash Treasure' })).toBeInTheDocument();
    expect(screen.getByText(TRASH_TREASURE.effectSummary)).toBeInTheDocument();
    expect(screen.getByText(/Set her as your Buddy/i)).toBeInTheDocument();
    expect(screen.queryByText(/she is your Buddy/i)).toBeNull();
  });

  it('omits the section for a copy whose species grants nothing', async () => {
    renderAt('/collection/103');
    await screen.findByRole('heading', { name: 'Neko Barista' });

    // The rest of the page is present, so this is an omission and not a stall.
    await screen.findByText(/combat is not modelled/i);
    expect(screen.queryByText('Buddy Bonus')).toBeNull();
  });

  /**
   * The bonus rides on the content snapshot, which is a separate request from
   * the copy. The page must not break — or invent a section — while it is in
   * flight or if it fails outright.
   */
  it('renders the copy without a bonus when the content snapshot is unavailable', async () => {
    server.use(
      http.get('/api/v1/content/species', () => new Response(null, { status: 500 })),
    );

    renderAt('/collection/101');
    await screen.findByRole('heading', { name: 'Nyx' });

    await waitFor(() => expect(screen.queryByText('Buddy Bonus')).toBeNull());
    expect(screen.getByText('Level 22')).toBeInTheDocument();
  });
});
