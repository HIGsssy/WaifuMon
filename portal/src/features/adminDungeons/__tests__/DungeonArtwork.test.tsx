import { beforeEach, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { assetFixture, stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { install, renderAt, fixture } from './dungeonFixtures';
vi.mock('@/features/adminArtwork/AssetPickerDialog', () => ({
  AssetPickerDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (asset: ReturnType<typeof assetFixture>) => void;
  }) =>
    open ? (
      <button
        onClick={() =>
          onSelect(
            assetFixture({ name: 'Cover', category: 'dungeon_zone', contentHash: 'a'.repeat(64) }),
          )
        }
      >
        Select cover
      </button>
    ) : null,
}));
beforeEach(() => {
  install();
  stubObjectUrls();
});
it('preserves the shipped artwork input, preview and browse control', async () => {
  const user = userEvent.setup();
  renderAt();
  await user.type(await screen.findByLabelText('Artwork path'), 'dungeons/tunnels.webp');
  expect(screen.getByRole('button', { name: 'Browse artwork' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(api.saveDungeonDraft).toHaveBeenCalledWith(
    'tunnels',
    expect.objectContaining({
      definition: expect.objectContaining({
        artwork: { kind: 'shipped', path: 'dungeons/tunnels.webp' },
      }),
    }),
  );
});
it('stores managed artwork by hash and category rather than environment-specific asset ID', async () => {
  const user = userEvent.setup();
  renderAt();
  await user.click(await screen.findByRole('button', { name: 'Choose uploaded artwork' }));
  await user.click(screen.getByRole('button', { name: 'Select cover' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(api.saveDungeonDraft).toHaveBeenCalledWith(
    'tunnels',
    expect.objectContaining({
      definition: expect.objectContaining({
        artwork: {
          kind: 'managed',
          category: 'dungeon_zone',
          contentHash: 'a'.repeat(64),
          name: 'Cover',
        },
      }),
    }),
  );
});
it('preserves artwork and layout on metadata-only saves', async () => {
  const w = install();
  w.stored = {
    ...fixture(),
    draft: {
      ...fixture().draft,
      artwork: { kind: 'managed', category: 'dungeon_zone', contentHash: 'b'.repeat(64) },
    },
  };
  const user = userEvent.setup();
  renderAt();
  await user.type(await screen.findByLabelText('Dungeon name'), ' updated');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(api.saveDungeonDraft).toHaveBeenCalledWith(
    'tunnels',
    expect.objectContaining({
      definition: expect.objectContaining({ artwork: w.stored.draft.artwork }),
    }),
  );
  expect(w.stored.layout).toEqual(fixture().layout);
});
