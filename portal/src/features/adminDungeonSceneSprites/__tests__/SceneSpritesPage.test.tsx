import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import * as api from '@/api/adminDungeonSceneSprites';
import { SceneSpritesPage } from '../SceneSpritesPage';
vi.mock('@/features/adminArtwork/AssetField', () => ({
  AssetField: ({
    label,
    onChange,
    disabled,
  }: {
    label: string;
    disabled: boolean;
    onChange: (id: string) => void;
  }) => (
    <button disabled={disabled} onClick={() => onChange('12345678-1234-1234-1234-123456789abc')}>
      {label}
    </button>
  ),
}));
let sprite: api.SceneSpriteDetail;
beforeEach(() => {
  sprite = {
    key: 'chest',
    name: 'Chest',
    category: 'Chest',
    assetId: '12345678-1234-1234-1234-123456789abc',
    placement: { anchor: 'bottom-center', scaleBasisPoints: 5000, offsetX: 0, offsetY: 0 },
    mirror: false,
    visualLayer: 'background',
    revision: 1,
    archived: false,
    createdAt: '',
    updatedAt: '',
    updatedBy: 'author',
    references: [],
    events: [],
  };
  vi.spyOn(api, 'listSceneSprites').mockImplementation(async () => ({ sprites: [{ ...sprite }] }));
  vi.spyOn(api, 'getSceneSprite').mockImplementation(async () => structuredClone(sprite));
  vi.spyOn(api, 'createSceneSprite').mockImplementation(
    async (key, form) => (sprite = { ...sprite, ...structuredClone(form), key }),
  );
  vi.spyOn(api, 'updateSceneSprite').mockImplementation(
    async (_key, form) =>
      (sprite = { ...sprite, ...structuredClone(form), revision: sprite.revision + 1 }),
  );
  vi.spyOn(api, 'archiveSceneSprite').mockImplementation(
    async (_key, archived) => (sprite = { ...sprite, archived, revision: sprite.revision + 1 }),
  );
});
function show(permissions = ['dungeons.read', 'dungeons.write']) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionContext.Provider
        value={{ status: 'ready', session: { permissions } } as unknown as SessionState}
      >
        <MemoryRouter>
          <SceneSpritesPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
it('creates using selected artwork and independent defaults', async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole('button', { name: 'Create sprite' }));
  await user.type(screen.getByLabelText('Sprite identifier'), 'console');
  await user.type(screen.getByLabelText('Sprite display name'), 'Console');
  await user.click(screen.getByRole('button', { name: 'Scene sprite artwork' }));
  await user.click(screen.getByRole('button', { name: 'Save sprite' }));
  await waitFor(() =>
    expect(api.createSceneSprite).toHaveBeenCalledWith(
      'console',
      expect.objectContaining({
        name: 'Console',
        mirror: false,
        placement: expect.objectContaining({ scaleBasisPoints: 5000 }),
      }),
    ),
  );
});
it('saves mirror/layer/placement and reloads the returned revision', async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole('button', { name: /Chest chest/ }));
  await user.click(screen.getByLabelText('Mirror sprite'));
  await user.selectOptions(screen.getByLabelText('Sprite visual layer'), 'foreground');
  await user.selectOptions(screen.getByLabelText('Sprite position'), 'left');
  await user.click(screen.getByRole('button', { name: 'Save sprite' }));
  await waitFor(() =>
    expect(api.updateSceneSprite).toHaveBeenCalledWith(
      'chest',
      expect.objectContaining({
        mirror: true,
        visualLayer: 'foreground',
        placement: expect.objectContaining({ anchor: 'left' }),
      }),
      1,
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByLabelText('Mirror sprite')).toBeChecked();
  expect(screen.getByLabelText('Sprite position')).toHaveValue('left');
});
it('archives and reveals archived entries only when requested', async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole('button', { name: /Chest chest/ }));
  await user.click(screen.getByRole('button', { name: 'Archive sprite' }));
  await waitFor(() => expect(api.archiveSceneSprite).toHaveBeenCalledWith('chest', true, 1));
  await user.click(screen.getByLabelText('Include archived sprites'));
  expect(await screen.findByRole('button', { name: /Chest \(archived\)/ })).toBeVisible();
});
it('searches and protects referenced sprites from deletion', async () => {
  sprite.references.push({
    dungeonKey: 'crypt',
    name: 'Crypt',
    source: 'revision[1]',
    roomId: 'hall',
    instanceId: 'one',
  });
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole('button', { name: /Chest chest/ }));
  expect(screen.getByRole('button', { name: 'Delete unused sprite' })).toBeDisabled();
  expect(screen.getByRole('link', { name: 'Crypt' })).toHaveAttribute(
    'href',
    '/admin/dungeons/definitions/crypt',
  );
  await user.type(screen.getByLabelText('Search scene sprites'), 'console');
  expect(screen.queryByRole('button', { name: /Chest chest/ })).not.toBeInTheDocument();
});
it('readers can browse but cannot mutate', async () => {
  const user = userEvent.setup();
  show(['dungeons.read']);
  await user.click(await screen.findByRole('button', { name: /Chest chest/ }));
  expect(screen.queryByRole('button', { name: 'Save sprite' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sprite display name')).toBeDisabled();
});
