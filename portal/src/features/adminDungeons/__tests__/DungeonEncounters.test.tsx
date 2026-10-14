import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { ACTION_TYPES } from '../dungeonActionModel';
import { fixture, install, renderAt } from './dungeonFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
  vi.spyOn(api, 'getDungeonSpecies').mockResolvedValue({ species: [] });
});
const inspector = () => within(screen.getByRole('complementary', { name: 'Map inspector' }));
const parts = (d: api.DungeonDefinition) => ({
  pools: d.speciesPools,
  encounters: d.rooms.flatMap((r) =>
    r.actions.filter((a) => ['wild_encounter', 'rescue'].includes(a.type)),
  ),
});

describe('P4B1 encounter drafts', () => {
  it.each(['species', 'pool'] as const)(
    'edits %s encounters and preserves pools, placement and outcomes through unrelated save/reload',
    async (kind) => {
      const stored = fixture();
      stored.draft.speciesPools = [
        {
          id: 'wild',
          name: 'Wild androids',
          entries: [
            { id: 'one', weight: 3, species: 'android', oncePerRun: true },
            { id: 'none', weight: 1, nothing: true, text: 'Quiet.' },
          ],
        },
      ];
      stored.draft.rooms[0]!.actions.push({
        id: 'wild',
        type: 'wild_encounter',
        source: kind === 'species' ? { kind, species: 'android' } : { kind, poolId: 'wild' },
        intro: 'She appears.',
        capture: { maxAttempts: 3, allowGuaranteedItems: true },
        results: { captured: { text: 'Saved!', flags: [{ flag: 'opened', value: true }] } },
        placement: { anchor: 'center', scaleBasisPoints: 5000, offsetX: 20, offsetY: 0 },
        mirror: true,
        sceneSprites: [
          {
            id: 'sprite',
            spriteKey: 'tree',
            placement: { anchor: 'bottom-right', scaleBasisPoints: 2000, offsetX: 0, offsetY: 0 },
          },
        ],
      });
      stored.draft.rooms[0]!.actions.push({
        id: 'rescue',
        type: 'rescue',
        mode: 'direct',
        source: { kind: 'species', species: 'captive' },
        intro: 'Help her.',
      });
      world.stored = stored;
      const original = JSON.stringify(parts(stored.draft));
      const user = userEvent.setup(),
        rendered = renderAt();
      await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
      await user.type(inspector().getByLabelText('Dungeon name'), ' Updated');
      await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
      await user.click(inspector().getByRole('button', { name: /Activity \d+: Wild Encounter/ }));
      const card = within(screen.getByTestId('encounter-editor'));
      expect(card.getByLabelText('Encounter introduction')).toHaveValue('She appears.');
      expect(card.getByLabelText('Mirror encountered WaifuMon')).toBeChecked();
      await user.type(inspector().getByLabelText('Room description'), 'Wind.');
      await user.click(screen.getByRole('button', { name: 'Save draft' }));
      await vi.waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1));
      expect(
        JSON.stringify(parts(vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!)),
      ).toBe(original);
      rendered.unmount();
      renderAt();
      await screen.findByRole('heading', { level: 1, name: 'Tunnels Updated' });
      expect(JSON.stringify(parts(world.stored.draft))).toBe(original);
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    },
  );
  it('adds both encounters to the activity authoring menu', () => {
    expect(ACTION_TYPES).toContain('wild_encounter');
    expect(ACTION_TYPES).toContain('rescue');
  });
});
