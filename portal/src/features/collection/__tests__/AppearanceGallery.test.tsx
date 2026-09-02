/**
 * Appearance gallery tests.
 *
 * The assertions are chosen around the three design rules the gallery exists
 * to enforce, because each is the kind of thing a well-meaning refactor would
 * quietly undo:
 *
 *   1. locked entries are **shown**, with their requirement, not filtered out;
 *   2. locked artwork is **never** shown, and nothing offers to show it;
 *   3. the Portal never computes unlock state — it renders the server's.
 *
 * Rule 2 used to read "locked artwork stays a silhouette until the player opts
 * in", implemented as a "Reveal artwork" button. That was a curtain, not a
 * fence: the API had already sent `assetId` for every locked entry, so the
 * reward was one click away for anyone who wanted it and zero clicks away for
 * anyone reading the network tab. The API withholds the identifier now, so
 * these tests assert there is nothing to reveal *and* no control offering to.
 *
 * Selection is deliberately tested without weakening the locked-artwork rules:
 * an unlocked entry may be worn because the API already sent its `assetId`;
 * a locked entry still has neither an image nor a wear control.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data } from '../../../../msw/handlers';
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
    expect(within(group).getAllByText('Reach Level 40')).not.toHaveLength(0);
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

  it('renders no image at all for a locked tile', async () => {
    renderDetail(101);
    const group = await galleryGroup();

    // Rule 2. Not a silhouette of the real art, not a blurred copy — both would
    // need the artwork in the browser to produce. There is simply no <img>.
    const lockedTile = within(group).getByRole('button', { name: /Midnight Bloom/ });
    expect(within(lockedTile).queryByRole('img')).not.toBeInTheDocument();
    expect(lockedTile.querySelector('img')).toBeNull();

    // The unlocked tile beside it still has one — the regression guard.
    const wornTile = within(group).getByRole('button', { name: /Standard/ });
    expect(wornTile.querySelector('img')).not.toBeNull();
  });

  it('names no artwork URL anywhere in a locked tile', async () => {
    renderDetail(101);
    const group = await galleryGroup();
    const lockedTile = within(group).getByRole('button', { name: /Midnight Bloom/ });

    // Belt to the braces above: no attribute anywhere under the tile resolves
    // to an asset, however it might have got there.
    expect(lockedTile.innerHTML).not.toMatch(/\.(png|jpe?g|webp)/i);
    expect(lockedTile.innerHTML).not.toContain('dev-assets');
    expect(lockedTile.innerHTML).not.toContain('/cards/');
  });

  it('puts the unlock requirement where the artwork would have been', async () => {
    renderDetail(101);
    const group = await galleryGroup();
    const lockedTile = within(group).getByRole('button', { name: /Midnight Bloom/ });

    // The slot is legible rather than blank: a lock and what earns it.
    expect(within(lockedTile).getAllByText(/Reach Level 40/i).length).toBeGreaterThan(0);
  });

  it('offers no control that would reveal locked artwork', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    await user.click(within(group).getByRole('button', { name: /Midnight Bloom/ }));

    // The button this bug was hiding behind. It is gone, and nothing replaced
    // it — there is no client-side path to artwork the server did not send.
    expect(screen.queryByRole('button', { name: /Reveal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show artwork/i })).not.toBeInTheDocument();
  });

  it('opens a locked detail panel with the requirement and no spoilers', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    await user.click(within(group).getByRole('button', { name: /Midnight Bloom/ }));

    expect(await screen.findByText(/Locked — Reach Level 40/i)).toBeInTheDocument();
    // Flavour text and description describe the look, so they are held back
    // with it — describing a surprise is a smaller version of spoiling it.
    expect(
      screen.queryByText(/Prepared for the annual shrine celebration/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/A darker cut of her usual silhouette/i)).not.toBeInTheDocument();
    // And still no way to wear it.
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
  });

  it('states the worn look read-only, offering no control to change it', async () => {
    const user = userEvent.setup();
    renderDetail(101);
    const group = await galleryGroup();

    await user.click(within(group).getByRole('button', { name: /Standard/ }));
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
    expect(screen.getByText(/wearing this one/i)).toBeInTheDocument();
  });

  /**
   * The regression this fix exists for. Four unlocked looks of one copy, each
   * of which must render *its own* artwork rather than the generic silhouette
   * or the worn look repeated. Mirrors the `bimbo_valkyrie` report: `standard`,
   * `level_10`, `level_20`, `level_30` unlocked; `level_40` locked.
   */
  function multiLookGallery() {
    const unlocked = (id: string, atLevel: number | null) => ({
      id,
      name: id === 'standard' ? 'Standard' : `Level ${atLevel}`,
      description: null,
      flavorText: null,
      cosmeticRarity: 'standard' as const,
      introducedVersion: null,
      assetId: { kind: 'waifumon' as const, slug: 'void_empress', variant: id },
      unlock: atLevel === null ? { type: 'owned' as const } : { type: 'level' as const, atLevel },
      unlockLabel: atLevel === null ? 'Owned' : `Reach Level ${atLevel}`,
      isUnlocked: true,
      isSelected: id === 'level_30',
    });

    return {
      selected: 'level_30',
      appearances: [
        unlocked('standard', null),
        unlocked('level_10', 10),
        unlocked('level_20', 20),
        unlocked('level_30', 30),
        {
          id: 'level_40',
          name: 'Level 40',
          description: null,
          flavorText: null,
          cosmeticRarity: 'standard' as const,
          introducedVersion: null,
          assetId: null,
          unlock: { type: 'level' as const, atLevel: 40 },
          unlockLabel: 'Reach Level 40',
          isUnlocked: false,
          isSelected: false,
        },
      ],
    };
  }

  function tileImage(group: HTMLElement, name: RegExp): HTMLImageElement | null {
    const tile = within(group).getByRole('button', { name });
    return tile.querySelector('img');
  }

  it('renders each unlocked tile’s own artwork through the authenticated owned route', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        data(multiLookGallery()),
      ),
    );
    renderDetail(101);
    const group = await galleryGroup();

    // Every unlocked tile has an <img>, and each points at *its own* appearance
    // on the per-copy authenticated endpoint — not `/dev-assets`, not the worn
    // look, not the silhouette placeholder.
    for (const id of ['standard', 'level_10', 'level_20', 'level_30']) {
      const img = tileImage(group, new RegExp(id === 'standard' ? 'Standard' : id.replace('_', ' '), 'i'));
      expect(img, id).not.toBeNull();
      expect(img!.getAttribute('src'), id).toContain('/players/1/collection/owned/101/artwork');
      expect(img!.getAttribute('src'), id).toContain(`appearance=${id}`);
      expect(img!.getAttribute('src'), id).not.toContain('dev-assets');
    }
  });

  it('gives no two unlocked tiles the same artwork URL', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        data(multiLookGallery()),
      ),
    );
    renderDetail(101);
    const group = await galleryGroup();

    const srcs = ['Standard', 'level 10', 'level 20', 'level 30'].map(
      (name) => tileImage(group, new RegExp(name, 'i'))!.getAttribute('src'),
    );
    expect(new Set(srcs).size).toBe(srcs.length);
    // And none of them collapses onto the worn (`level_30`) look for the others.
    expect(srcs.filter((s) => s?.includes('appearance=level_30'))).toHaveLength(1);
  });

  it('keeps selection highlighting independent of which image each tile shows', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        data(multiLookGallery()),
      ),
    );
    renderDetail(101);
    const group = await galleryGroup();

    // The worn badge is on `level_30` only, even though every unlocked tile
    // draws real art — the highlight tracks `isSelected`, not the image.
    expect(
      within(group).getByRole('button', { name: /Level 30 — currently worn/i }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole('button', { name: /Level 10 — unlocked/i }),
    ).toBeInTheDocument();
  });

  it('leaves the locked tile with no artwork while its unlocked peers render', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        data(multiLookGallery()),
      ),
    );
    renderDetail(101);
    const group = await galleryGroup();

    const locked = within(group).getByRole('button', { name: /Level 40/ });
    expect(locked.querySelector('img')).toBeNull();
    expect(locked.innerHTML).not.toMatch(/\.(png|jpe?g|webp)/i);
    expect(locked.innerHTML).not.toContain('/artwork');
  });

  it('offers no wear control or mutation anywhere in the read-only gallery', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', () =>
        data(multiLookGallery()),
      ),
    );
    renderDetail(101);
    const group = await galleryGroup();

    await user.click(within(group).getByRole('button', { name: /Level 10/ }));
    expect(screen.queryByRole('button', { name: /Wear this look/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reveal/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Equip it from the Discord bot/i)).toBeInTheDocument();
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
