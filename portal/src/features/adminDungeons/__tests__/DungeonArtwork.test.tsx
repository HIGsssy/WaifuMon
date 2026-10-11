import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import type { DungeonArtworkRef } from '@/api/adminDungeons';
import { assetFixture, stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { install, renderAt, fixture } from './dungeonFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
vi.mock('@/features/adminArtwork/AssetPickerDialog', () => ({
  AssetPickerDialog: ({
    open,
    title,
    category,
    onSelect,
  }: {
    open: boolean;
    title: string;
    category: string;
    onSelect: (asset: ReturnType<typeof assetFixture>) => void;
  }) =>
    open ? (
      <button
        onClick={() =>
          onSelect(
            assetFixture({
              name: 'Night Tunnels',
              category: category as never,
              contentHash: 'a'.repeat(64),
            }),
          )
        }
      >
        Pick for: {title} ({category})
      </button>
    ) : null,
}));
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
});
const managed = (
  hash: string,
  name: string,
  category = 'dungeon_background',
): DungeonArtworkRef => ({
  kind: 'managed',
  category,
  contentHash: hash.repeat(64),
  name,
});
const field = (testId: string) => within(screen.getByTestId(testId));
const saved = () => vi.mocked(api.saveDungeonDraft).mock.calls.at(-1)![1].definition!;

describe('dungeon pictures', () => {
  it('chooses an uploaded scene background, stores the portable reference and shows the picture', async () => {
    const user = userEvent.setup();
    renderAt();
    const background = () => field('dungeon-background');
    await screen.findByLabelText('Dungeon name');
    expect(background().getByText('Not set.')).toBeInTheDocument();
    expect(background().getByText('No picture')).toBeInTheDocument();
    // The two dungeon-wide pictures say what each is for.
    expect(background().getByText(/Shown behind every room and fight/)).toBeInTheDocument();
    expect(field('dungeon-artwork').getByText(/cover picture players see/)).toBeInTheDocument();
    await user.click(background().getByRole('button', { name: 'Choose scene background' }));
    await user.click(
      screen.getByRole('button', {
        name: 'Pick for: Choose scene background (dungeon_background)',
      }),
    );
    expect(
      await background().findByRole('img', { name: 'Scene background: Night Tunnels' }),
    ).toBeVisible();
    expect(api.managedDungeonArtworkBlob).toHaveBeenCalledWith(
      'dungeon_background',
      'a'.repeat(64),
    );
    expect(background().getByTestId('dungeon-background-status')).toHaveTextContent(
      'Night Tunnels',
    );
    // No hash or path on the default view.
    expect(background().queryByText(/a{12}/)).toBeNull();
    expect(
      background().getByRole('button', { name: 'Replace scene background' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(saved().background).toEqual(managed('a', 'Night Tunnels'));
    expect(saved().artwork).toBeNull();
    await user.click(background().getByRole('button', { name: 'Clear scene background' }));
    expect(background().getByText('No picture')).toBeInTheDocument();
  });
  it('says plainly when a stored picture cannot be found, without changing the reference', async () => {
    world.stored = {
      ...fixture(),
      draft: {
        ...fixture().draft,
        background: managed('b', 'Old Vault'),
        artwork: { kind: 'shipped', path: 'dungeons/zones/gone.webp' },
      },
    };
    vi.mocked(api.managedDungeonArtworkBlob).mockRejectedValue(new Error('404'));
    vi.mocked(api.dungeonArtworkBlob).mockRejectedValue(new Error('404'));
    const user = userEvent.setup();
    renderAt();
    const background = () => field('dungeon-background');
    await screen.findByLabelText('Dungeon name');
    expect(await background().findByRole('alert')).toHaveTextContent(
      'This picture can’t be found on this server, so players won’t see it.',
    );
    expect(background().getByTestId('dungeon-background-missing')).toHaveTextContent(
      '“Old Vault” was removed or switched off in Artwork, or this dungeon came from another server.',
    );
    expect(await field('dungeon-artwork').findByRole('alert')).toBeInTheDocument();
    expect(field('dungeon-artwork').getByTestId('dungeon-artwork-missing')).toHaveTextContent(
      'No file named “gone.webp” is shipped with the game here.',
    );
    // Looking is not an edit, and an unrelated save keeps both references exactly.
    expect(screen.queryByText('Unsaved dungeon changes')).toBeNull();
    await user.type(screen.getByLabelText('Dungeon name'), ' updated');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(saved().background).toEqual(managed('b', 'Old Vault'));
    expect(saved().artwork).toEqual({ kind: 'shipped', path: 'dungeons/zones/gone.webp' });
  });
  it('keeps shipped files and technical details available under Details', async () => {
    world.stored = {
      ...fixture(),
      draft: { ...fixture().draft, background: managed('c', 'Cellar') },
    };
    const user = userEvent.setup();
    renderAt();
    const artwork = () => field('dungeon-artwork');
    await screen.findByLabelText('Dungeon name');
    expect(screen.queryByLabelText('Dungeon artwork path')).toBeNull();
    await user.click(artwork().getByRole('button', { name: 'Dungeon artwork details' }));
    expect(
      artwork().getByRole('button', { name: 'Browse shipped files for dungeon artwork' }),
    ).toBeInTheDocument();
    await user.type(
      artwork().getByLabelText('Dungeon artwork path'),
      'dungeons/zones/tunnels.webp',
    );
    expect(
      await artwork().findByRole('img', { name: 'Dungeon artwork: tunnels.webp' }),
    ).toBeVisible();
    expect(api.dungeonArtworkBlob).toHaveBeenLastCalledWith('dungeons/zones/tunnels.webp');
    const background = () => field('dungeon-background');
    await user.click(background().getByRole('button', { name: 'Scene background details' }));
    expect(background().getByText('c'.repeat(64))).toBeInTheDocument();
    // An empty path box never discards an uploaded picture.
    await user.clear(background().getByLabelText('Scene background path'));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(saved().artwork).toEqual({ kind: 'shipped', path: 'dungeons/zones/tunnels.webp' });
    expect(saved().background).toEqual(managed('c', 'Cellar'));
  });
});

describe('room backgrounds', () => {
  it('shows the inherited dungeon background until a room is given its own, and back again', async () => {
    world.stored = {
      ...fixture(),
      draft: { ...fixture().draft, background: managed('d', 'Dungeon Night') },
    };
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    const room = () => field('room-background');
    expect(room().getByTestId('room-background-status')).toHaveTextContent(
      'Uses the dungeon’s scene background. Choose a picture to give this room its own.',
    );
    // The inherited picture is previewed, through the dungeon's reference.
    expect(
      await room().findByRole('img', { name: 'Room background: Dungeon Night' }),
    ).toBeVisible();
    expect(api.managedDungeonArtworkBlob).toHaveBeenLastCalledWith(
      'dungeon_background',
      'd'.repeat(64),
    );
    await user.click(room().getByRole('button', { name: 'Choose room background' }));
    await user.click(
      screen.getByRole('button', { name: 'Pick for: Choose room background (dungeon_background)' }),
    );
    expect(room().getByTestId('room-background-status')).toHaveTextContent(
      'This room has its own background: Night Tunnels.',
    );
    await waitFor(() =>
      expect(api.managedDungeonArtworkBlob).toHaveBeenLastCalledWith(
        'dungeon_background',
        'a'.repeat(64),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(saved().rooms[0]!.background).toEqual(managed('a', 'Night Tunnels'));
    expect(saved().background).toEqual(managed('d', 'Dungeon Night'));
    await user.click(room().getByRole('button', { name: 'Clear room background' }));
    expect(room().getByTestId('room-background-status')).toHaveTextContent(
      'Uses the dungeon’s scene background.',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saved().rooms[0]!.background).toBeNull());
  });
  it('says when neither the room nor the dungeon has a background', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    expect(field('room-background').getByTestId('room-background-status')).toHaveTextContent(
      'No background yet: neither this room nor the dungeon’s scene background has one.',
    );
  });
});

describe('enemy appearance in fights', () => {
  const fight = (key: string) => ({
    id: `a_${key}`,
    type: 'combat',
    outcomes: {},
    waves: [{ enemy: { key } }],
  });
  it('previews each wave with the production renderer and the room’s background order', async () => {
    const roomBg = managed('e', 'Engine Room');
    const dungeonBg = managed('f', 'Dungeon Night');
    world.stored = {
      ...fixture(),
      draft: {
        ...fixture().draft,
        background: dungeonBg,
        rooms: [
          {
            id: 'entrance',
            name: 'Entrance',
            background: roomBg,
            actions: [
              {
                ...fight('slime'),
                waves: [{ enemy: { key: 'slime' } }, { enemy: { key: 'golem' } }],
              },
            ],
          },
        ],
      },
    };
    vi.mocked(api.previewDungeonScene).mockImplementation(async ({ enemyKey }) =>
      enemyKey === 'slime'
        ? { image: new Blob(['s']), mode: 'sprite', background: 0 }
        : { image: new Blob(['g']), mode: 'full-art', background: null },
    );
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    const first = () => field('wave-1-appearance');
    const second = () => field('wave-2-appearance');
    expect(
      await first().findByRole('img', { name: 'Fight preview for wave 1: Slime' }),
    ).toBeVisible();
    expect(
      first().getByText(/Slime’s combat sprite on this room’s background\./),
    ).toBeInTheDocument();
    expect(first().getByRole('link', { name: 'Change Slime’s sprite' })).toHaveAttribute(
      'href',
      '/admin/enemies/slime',
    );
    // A different enemy in the next wave is previewed on its own, and its fallback is named.
    expect(
      await second().findByRole('img', { name: 'Fight preview for wave 2: Rust Golem' }),
    ).toBeVisible();
    expect(
      second().getByText(
        /Rust Golem has no combat sprite, so its full artwork fills the scene on its own, without the background or the player’s Buddy\./,
      ),
    ).toBeInTheDocument();
    // Only a composed scene has a stand-in Buddy to explain.
    expect(first().getByText(/The Buddy shown is a stand-in/)).toBeInTheDocument();
    expect(second().queryByText(/stand-in/)).toBeNull();
    expect(
      second().getByRole('link', { name: 'Add a combat sprite for Rust Golem' }),
    ).toHaveAttribute('target', '_blank');
    expect(api.previewDungeonScene).toHaveBeenCalledWith(
      { enemyKey: 'slime', backgrounds: [roomBg, dungeonBg, null] },
      expect.anything(),
    );
    // Authors never pick a sprite per use: there is no sprite control in the wave.
    expect(screen.queryByLabelText(/sprite/i)).toBeNull();
    expect(screen.queryByText('Unsaved dungeon changes')).toBeNull();
  });
  it('explains the plain stage and an enemy with nothing to show', async () => {
    world.stored = {
      ...fixture(),
      draft: {
        ...fixture().draft,
        rooms: [{ id: 'entrance', name: 'Entrance', actions: [fight('slime')] }],
      },
    };
    vi.mocked(api.previewDungeonScene).mockResolvedValue({
      image: new Blob(['s']),
      mode: 'sprite',
      background: 'plain',
    });
    const user = userEvent.setup();
    const view = renderAt(undefined, ['dungeons.read', 'dungeons.write']);
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    expect(
      await field('wave-1-appearance').findByText(
        /No background could be found, so the fight uses a plain stage/,
      ),
    ).toBeInTheDocument();
    // Without access to the Enemy Catalogue there is no link into it.
    expect(screen.queryByRole('link', { name: /sprite/ })).toBeNull();
    view.unmount();
    vi.mocked(api.previewDungeonScene).mockRejectedValue(new Error('404'));
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    expect(
      await field('wave-1-appearance').findByText(
        /Slime has no sprite or artwork that can be shown/,
      ),
    ).toBeInTheDocument();
  });
});
