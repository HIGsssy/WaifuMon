/**
 * Appearance gallery tests.
 *
 * The assertions are chosen around the three design rules the gallery exists
 * to enforce, because each is the kind of thing a well-meaning refactor would
 * quietly undo:
 *
 *   1. locked entries are **shown**, with their requirement, not filtered out;
 *   2. locked artwork stays a silhouette until the player opts in;
 *   3. the Portal never computes unlock state — it renders the server's.
 *
 * There is no mutation path to test: the Portal is read-only (§4) and selection
 * happens in Discord until the authenticated-Portal milestone. The gallery's
 * job here is the journal — browsing, previewing, and stating requirements.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

/** Waifu 101 (Nyx) has a two-entry catalog: `standard` + a locked `level_40`. */
function renderDetail(waifuId: number) {
  return renderRoutes({ routes, initialEntries: [`/collection/${waifuId}`] });
}

async function galleryGroup() {
  return screen.findByRole('group', { name: /Appearances for Nyx/i });
}

describe('AppearanceGallery', () => {
  it('lists locked entries alongside unlocked ones', async () => {
    renderDetail(101);
    const group = await galleryGroup();

    // Rule 1: a locked entry is present and named, not hidden.
    expect(within(group).getByRole('button', { name: /Standard/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Midnight Bloom/ })).toBeInTheDocument();
    expect(screen.getByText('1 / 2 unlocked')).toBeInTheDocument();
  });

  it('shows every tile’s unlock requirement, locked or not', async () => {
    renderDetail(101);
    const group = await galleryGroup();

    // The progression-journal property. "Owned" appears on the earned tile and
    // "Reach Level 40" on the one the player is working toward.
    expect(within(group).getByText('Owned')).toBeInTheDocument();
    expect(within(group).getByText('Reach Level 40')).toBeInTheDocument();
  });

  it('states locked and worn status in the accessible name, not by colour alone', async () => {
    renderDetail(101);
    const group = await galleryGroup();

    expect(
      within(group).getByRole('button', { name: /Standard — currently worn/i }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole('button', { name: /Midnight Bloom — locked — Reach Level 40/i }),
    ).toBeInTheDocument();
  });

  it('renders the cosmetic-rarity chip and the introduced-version chip', async () => {
    renderDetail(101);
    const group = await galleryGroup();

    expect(within(group).getByText('Seasonal')).toBeInTheDocument();
    expect(within(group).getByText('v1.3')).toBeInTheDocument();
  });

  it('keeps locked artwork a silhouette until the player asks to see it', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    // Rule 2: silhouette by default — players who want the surprise keep it.
    const lockedTile = within(group).getByRole('button', { name: /Midnight Bloom/ });
    expect(within(lockedTile).getByAltText(/Undiscovered Waifumon silhouette/i)).toBeInTheDocument();

    await user.click(lockedTile);
    await user.click(await screen.findByRole('button', { name: /Reveal artwork/i }));

    await waitFor(() => {
      expect(
        within(lockedTile).queryByAltText(/Undiscovered Waifumon silhouette/i),
      ).not.toBeInTheDocument();
    });
  });

  it('opens a detail panel with flavor text, description and the requirement', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    await user.click(within(group).getByRole('button', { name: /Midnight Bloom/ }));

    expect(
      await screen.findByText(/Prepared for the annual shrine celebration/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/A darker cut of her usual silhouette/i)).toBeInTheDocument();
    expect(screen.getByText(/Locked — Reach Level 40/i)).toBeInTheDocument();
    // A locked entry offers no way to wear it.
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
  });

  it('offers no way to change her look — that lives in Discord', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    // Rule: the Portal browses, Discord acts. An unlocked-but-unworn entry
    // names the command rather than offering a control the client would refuse
    // to send, so there is never a button that silently does nothing.
    await user.click(within(group).getByRole('button', { name: /Standard/ }));
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
    expect(screen.getByText(/wearing this one/i)).toBeInTheDocument();
    expect(screen.getByText(/\/wm appearance/)).toBeInTheDocument();
  });

  it('points an unlocked-but-unworn entry at the Discord command', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        Response.json({
          data: {
            selected: 'standard',
            appearances: [
              {
                id: 'standard',
                name: 'Standard',
                description: null,
                flavorText: null,
                cosmeticRarity: 'standard',
                introducedVersion: null,
                assetId: { kind: 'waifumon', slug: 'void_empress', variant: 'standard' },
                unlock: { type: 'owned' },
                unlockLabel: 'Owned',
                isUnlocked: true,
                isSelected: true,
              },
              {
                id: 'level_20',
                name: 'Midnight Bloom',
                description: null,
                flavorText: null,
                cosmeticRarity: 'seasonal',
                introducedVersion: null,
                assetId: { kind: 'waifumon', slug: 'void_empress', variant: 'level_20' },
                unlock: { type: 'level', atLevel: 20 },
                unlockLabel: 'Reach Level 20',
                isUnlocked: true,
                isSelected: false,
              },
            ],
          },
          meta: { requestId: 'test-request-id' },
        }),
      ),
    );

    renderDetail(101);
    const group = await galleryGroup();
    await user.click(within(group).getByRole('button', { name: /Midnight Bloom/ }));

    expect(await screen.findByText(/Switch to this look in Discord/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
  });

  it('shows a single implicit entry for a species with no authored catalog', async () => {
    // Backward compatibility, from the player's side: a pre-appearance species
    // still has a gallery, and it reads sensibly.
    renderDetail(103);
    const group = await screen.findByRole('group', { name: /Appearances for Neko Barista/i });
    expect(within(group).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('1 / 1 unlocked')).toBeInTheDocument();
  });

  it('degrades to a retry affordance when the gallery cannot be loaded', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );
    renderDetail(101);
    expect(await screen.findByText(/Couldn’t load Nyx’s appearances/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });
});
