import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as sprites from '@/api/adminDungeonSceneSprites';
import * as dungeons from '@/api/adminDungeons';
import { SceneSpritesEditor, newSceneSpriteInstance } from '../SceneSpritesEditor';
import { friendlyIssue } from '../dungeonText';
import { starterDungeon } from '../dungeonModel';
const chest: sprites.SceneSpriteSummary = {
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
  updatedBy: null,
};
beforeEach(() => {
  vi.spyOn(sprites, 'listSceneSprites').mockResolvedValue({
    sprites: [structuredClone(chest), { ...chest, key: 'old', name: 'Old Chest', archived: true }],
  });
  vi.spyOn(dungeons, 'previewDungeonScene').mockResolvedValue({
    image: new Blob(['image'], { type: 'image/webp' }),
    mode: 'sprite',
    background: 'plain',
  });
});
function show(
  scope: 'room' | 'activity' = 'room',
  roomSprites: sprites.SceneSpriteInstance[] = [],
) {
  let saved = '';
  function Host() {
    const [value, setValue] = useState<sprites.SceneSpriteInstance[] | undefined>(undefined);
    return (
      <>
        <SceneSpritesEditor
          scope={scope}
          value={value}
          roomSprites={roomSprites}
          backgrounds={[]}
          enemyKey={scope === 'activity' ? 'grunt' : undefined}
          disabled={false}
          onChange={setValue}
        />
        <button
          onClick={() => {
            saved = JSON.stringify(value);
          }}
        >
          Save test dungeon
        </button>
        <button onClick={() => setValue(JSON.parse(saved))}>Reload test dungeon</button>
        <output data-testid="placements">{JSON.stringify(value)}</output>
      </>
    );
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <Host />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function add(user: ReturnType<typeof userEvent.setup>, scope = 'room') {
  await screen.findByRole('option', { name: 'Chest · Chest' });
  await user.selectOptions(await screen.findByLabelText(`Add ${scope} scene sprite`), 'chest');
  await user.click(screen.getByRole('button', { name: 'Add sprite' }));
}
it('copies defaults independently, permits repeated sprite keys, and preserves controls across save/reload', async () => {
  const user = userEvent.setup();
  show();
  await add(user);
  await add(user);
  const first = screen.getByLabelText('Scene sprite 1');
  await user.selectOptions(within(first).getByLabelText('Sprite position'), 'left');
  await user.click(within(first).getByLabelText('Mirror scene sprite 1'));
  await user.selectOptions(within(first).getByLabelText('Layer for scene sprite 1'), 'foreground');
  await user.click(within(first).getByRole('button', { name: 'Move sprite 1 right' }));
  await user.click(screen.getByRole('button', { name: 'Save test dungeon' }));
  await user.click(screen.getByRole('button', { name: 'Reload test dungeon' }));
  const values = JSON.parse(screen.getByTestId('placements').textContent!);
  expect(values[0]).toMatchObject({
    mirror: true,
    visualLayer: 'foreground',
    placement: { anchor: 'left', offsetX: 20 },
  });
  expect(values[1]).toMatchObject({
    mirror: false,
    visualLayer: 'background',
    placement: { anchor: 'bottom-center', offsetX: 0 },
  });
  expect(values[0].id).not.toBe(values[1].id);
  expect(chest.placement.offsetX).toBe(0);
});
it('bounds each editor to five placements and removes empty lists', async () => {
  const user = userEvent.setup();
  show();
  for (let i = 0; i < 5; i++) await add(user);
  expect(screen.getByRole('button', { name: 'Add sprite' })).toBeDisabled();
  for (let i = 0; i < 5; i++)
    await user.click(screen.getByRole('button', { name: 'Remove scene sprite 1' }));
  expect(screen.getByTestId('placements')).toHaveTextContent('');
});
it('previews room and activity placements together, keeping enemy context', async () => {
  const user = userEvent.setup();
  const room = newSceneSpriteInstance(chest);
  show('activity', [room]);
  await add(user, 'activity');
  await waitFor(() =>
    expect(dungeons.previewDungeonScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enemyKey: 'grunt',
        roomSprites: [room],
        activitySprites: [expect.objectContaining({ spriteKey: 'chest' })],
      }),
      expect.any(AbortSignal),
    ),
  );
});
it('does not offer archived catalogue entries', async () => {
  show();
  await screen.findByRole('option', { name: 'Chest · Chest' });
  expect(screen.queryByRole('option', { name: /Old Chest/ })).not.toBeInTheDocument();
});
it('maps Show me to the room and applicable activity', () => {
  const d = starterDungeon('test', 'Test', ['waifu-valley']);
  d.rooms[0]!.actions = [{ id: 'rest', type: 'rest' }];
  const f = friendlyIssue(
    {
      code: 'scene_sprite_missing',
      severity: 'error',
      path: 'rooms[0].actions[0].sceneSprites[0].spriteKey',
      message: 'Choose another sprite.',
    },
    d,
  );
  expect(f).toMatchObject({
    target: { kind: 'room', id: d.rooms[0]!.id },
    actionId: 'rest',
    help: expect.stringContaining('Scene Sprites'),
  });
});
