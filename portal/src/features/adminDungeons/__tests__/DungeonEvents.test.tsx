/**
 * Event dungeons in the room editor: an event activity shows what it presents,
 * and events and pools survive every other edit and a save exactly. The event
 * and pool editors themselves are covered in `DungeonEventAuthoring.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { ACTION_TYPES } from '../dungeonActionModel';
import { activityOf, activitySummary, eventSourceOf, roomSummary } from '../dungeonText';
import { RewardHealthPanel } from '../RewardHealthPanel';
import { fixture, install, renderAt, renderWith } from './dungeonFixtures';
import { eventDungeon } from './eventFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());

let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
  world.stored = { ...fixture(), draft: eventDungeon() };
});
const inspector = () => within(screen.getByRole('complementary', { name: 'Map inspector' }));
const eventParts = (d: DungeonDefinition) => ({
  events: d.events,
  eventPools: d.eventPools,
  eventActions: d.rooms.flatMap((r) => r.actions.filter((a) => a.type === 'event')),
});

describe('event dungeons in the editor', () => {
  it('saves unrelated edits and reloads with every event, pool and event activity byte-for-byte', async () => {
    const original = eventDungeon();
    const user = userEvent.setup();
    const view = renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
    await user.type(inspector().getByLabelText('Dungeon name'), ' Deep');
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.type(inspector().getByLabelText('Room description'), 'Cold air');
    // Reorder around the events, and edit the activity beside them.
    await user.click(inspector().getByRole('button', { name: /^Activity 1: Rest/ }));
    await user.click(inspector().getByRole('button', { name: 'Move activity 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await vi.waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!;
    expect(saved.name).toBe('Tunnels Deep');
    expect(saved.rooms[0]!.description).toBe('Cold air');
    expect(saved.rooms[0]!.actions.map((a) => a.id)).toEqual(['a_find', 'a_rest', 'a_door']);
    // Not merely equal: the same members in the same order, so nothing was rebuilt.
    expect(JSON.stringify(eventParts(saved))).toBe(JSON.stringify(eventParts(original)));
    expect(saved.flags).toEqual(original.flags);

    // Reload from what the server now holds, change nothing, and it is clean.
    view.unmount();
    renderAt();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tunnels Deep' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(JSON.stringify(eventParts(world.stored.draft))).toBe(
      JSON.stringify(eventParts(original)),
    );
  });

  it('shows an event activity with what it presents, and lets it be moved, duplicated and removed', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    const card = inspector().getByRole('button', {
      name: /^Activity 3: Event\. “The Sealed Vault” — 4 choices/,
    });
    await user.click(card);
    const body = within(inspector().getByTestId('event-activity'));
    expect(body.getByText('A blast door fills the corridor.')).toBeInTheDocument();
    expect(body.getByText('Use the Vault Key')).toBeInTheDocument();
    expect(body.getByText(/Needs 1× vault_key, used up when chosen/)).toBeInTheDocument();
    expect(body.getByText(/Skill check, 55% for an average Buddy/)).toBeInTheDocument();
    expect(body.getByText(/Only when/)).toHaveTextContent('Alarm triggered');
    expect(body.getByText(/Remembers “Vault opened”; Gives rewards/)).toBeInTheDocument();
    expect(body.getByText(/The player steps back; the event stays open/)).toBeInTheDocument();
    expect(body.getByLabelText('This activity shows')).toHaveValue('event');
    expect(body.getByLabelText('This activity shows: which event')).toHaveValue('sealed_vault');
    for (const name of ['Move activity 3 up', 'Duplicate activity 3', 'Remove activity 3'])
      expect(inspector().getByRole('button', { name })).toBeEnabled();
    // An event is answered with a choice: it has no button text of its own and cannot be skipped.
    expect(inspector().queryByLabelText('Button text')).not.toBeInTheDocument();
    expect(inspector().queryByLabelText('Player can skip this')).not.toBeInTheDocument();
    // Its flow can be set, but never to turn the player back.
    const after = inspector().getByLabelText('If a random pool comes up with nothing');
    expect(within(after).queryByRole('option', { name: /back the way they came/ })).toBeNull();
    // Looking changes nothing.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('shows a random pool with each entry’s share and its events', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.click(
      inspector().getByRole('button', {
        name: /^Activity 2: Event\. Random: “Scrapheap finds” — one of 2 events, or nothing/,
      }),
    );
    const body = within(inspector().getByTestId('event-activity'));
    expect(body.getByText('Random: Scrapheap finds')).toBeInTheDocument();
    const rows = body
      .getAllByRole('listitem')
      .slice(0, 3)
      .map((li) => li.textContent);
    expect(rows).toEqual([
      'A Buried Crate30%Once per run',
      'The Sealed Vault10%Conditional',
      'Nothing happens60%',
    ]);
  });

  it('keeps events read-only for a reader', async () => {
    expect(ACTION_TYPES).not.toContain('event');
    const user = userEvent.setup();
    renderAt(undefined, ['dungeons.read']);
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.click(inspector().getByRole('button', { name: /^Activity 3: Event/ }));
    const body = within(inspector().getByTestId('event-activity'));
    expect(body.getByLabelText('This activity shows')).toBeDisabled();
    expect(body.getByLabelText('This activity shows: which event')).toBeDisabled();
    expect(body.queryByRole('button', { name: /create a new/ })).not.toBeInTheDocument();
    expect(inspector().getByRole('button', { name: 'Move activity 3 up' })).toBeDisabled();
    expect(inspector().getByRole('button', { name: 'Remove activity 3' })).toBeDisabled();
    // Two event activities: the room's single Event setting steps aside for the activity list.
    expect(inspector().getByTestId('room-event-many')).toHaveTextContent('This room has 2 events');
  });
});

describe('event text', () => {
  const definition = eventDungeon();
  const [, find, door] = definition.rooms[0]!.actions;
  it('names an event activity and what it presents', () => {
    expect(activityOf(door!).title).toBe('Event');
    expect(activitySummary(door!, definition, undefined)).toBe('“The Sealed Vault” — 4 choices');
    expect(activitySummary(find!, definition, undefined)).toBe(
      'Random: “Scrapheap finds” — one of 2 events, or nothing',
    );
    expect(roomSummary(definition.rooms[0]!, definition, undefined)).toContain(
      '“The Sealed Vault” — 4 choices',
    );
  });
  it('says so when the event or pool is not in the dungeon, without throwing', () => {
    const lost = { ...door!, source: { kind: 'event' as const, eventId: 'gone' } };
    expect(eventSourceOf(lost, definition)).toEqual({ kind: 'missing', what: 'an event' });
    expect(
      activitySummary(
        { ...find!, source: { kind: 'pool', poolId: 'gone' } },
        definition,
        undefined,
      ),
    ).toMatch(/^Missing: a random pool/);
    const { source: _source, ...sourceless } = door!;
    const { events: _events, ...eventless } = definition;
    expect(eventSourceOf(sourceless, eventless)).toEqual({ kind: 'missing', what: 'an event' });
  });
  it('reads a definition without changing it', () => {
    const before = JSON.stringify(definition);
    eventSourceOf(find!, definition);
    activitySummary(door!, definition, undefined);
    expect(JSON.stringify(definition)).toBe(before);
  });
});

describe('Reward Health notices', () => {
  it('lists an event’s missing item as information, not as broken rewards', async () => {
    vi.mocked(api.getDungeonRewardHealth).mockResolvedValue({
      dungeons: [
        {
          key: 'tunnels',
          name: 'Tunnels',
          enabled: true,
          revision: 2,
          status: 'healthy',
          problems: [],
          draftErrors: 0,
          activeRuns: 1,
          activeRevisions: [],
          notices: [
            {
              type: 'event_item',
              reason: 'item_missing',
              key: 'vault_key',
              name: 'vault_key',
              message: 'An event choice needs the item “vault_key”, which no longer exists.',
              hint: 'Players see that choice as unavailable.',
            },
          ],
        },
      ],
    });
    renderWith(<RewardHealthPanel />);
    const notices = within(await screen.findByTestId('reward-health-notices'));
    expect(notices.getByText(/An event choice needs the item “vault_key”/)).toBeInTheDocument();
    expect(notices.getByText(/No reward is affected/)).toBeInTheDocument();
    expect(screen.getByTestId('reward-health-ok')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
