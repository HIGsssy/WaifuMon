/**
 * Event authoring in the dungeon editor: attaching events and random pools to
 * rooms, the event and pool editors, the library, the Discord preview, the
 * sandbox, and the way from a checklist item to the field that fixes it.
 *
 * Odds, availability and check chances are the server's (`fakeInsight` stands
 * in for it); these tests pin that the editor shows them and never works them
 * out, and that every edit leaves the rest of the draft exactly as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import type {
  DungeonDefinition,
  DungeonEventScenario,
  DungeonSandboxInput,
  DungeonSandboxResult,
} from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { EventDiscordPreview } from '../EventDiscordPreview';
import { DISCORD_EVENT_LIMITS } from '../eventPreviewModel';
import { fixture, install, reference, renderAt } from './dungeonFixtures';
import { eventDungeon, fakeInsight } from './eventFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());

const ITEMS = [
  { slug: 'vault_key', name: 'Vault Key', category: 'key', enabled: true, maxOwned: 1 },
  { slug: 'scrap_parts', name: 'Scrap Parts', category: 'salvage', enabled: true, maxOwned: null },
];
type User = ReturnType<typeof userEvent.setup>;
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
  world.stored = { ...fixture(), draft: eventDungeon() };
  vi.mocked(api.getDungeonReference).mockResolvedValue({ ...reference, items: ITEMS });
  vi.mocked(api.validateDungeon).mockImplementation(async (definition, _signal, scenario) => ({
    definition,
    contentHash: 'hash',
    issues: [],
    publishable: true,
    ...fakeInsight(definition, scenario),
  }));
});
const inspector = () => within(screen.getByRole('complementary', { name: 'Map inspector' }));
const library = () => within(inspector().getByTestId('dungeon-events'));
async function ready() {
  const user = userEvent.setup();
  renderAt();
  await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
  return user;
}
async function openEvent(user: User, title: string) {
  await user.click(library().getByRole('button', { name: `Edit event ${title}` }));
  return within(await screen.findByTestId('event-editor'));
}
async function openPool(user: User, name: string) {
  await user.click(library().getByRole('button', { name: `Edit pool ${name}` }));
  return within(await screen.findByTestId('event-pool-editor'));
}
/** Closes whatever sheet is open and saves the draft; returns what was sent. */
async function save(user: User): Promise<DungeonDefinition> {
  const close = screen.queryByRole('button', { name: /^Close (event|random pool)$/ });
  if (close) await user.click(close);
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
  return vi.mocked(api.saveDungeonDraft).mock.calls.at(-1)![1].definition!;
}
const eventOf = (d: DungeonDefinition, id: string) => d.events!.find((e) => e.id === id)!;
const lastScenario = () =>
  vi.mocked(api.validateDungeon).mock.calls.at(-1)![2] as DungeonEventScenario | undefined;

describe('attaching an event to a room', () => {
  it('creates a handcrafted event from the room, attaches it, and edits its story and choices', async () => {
    world.stored = fixture();
    const user = await ready();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    const control = inspector().getByLabelText('Room event');
    expect(control).toHaveValue('none');
    await user.selectOptions(control, 'event');
    // Nothing is attached until there is an event to point at.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user.click(inspector().getByRole('button', { name: 'Room event: create a new event' }));

    const sheet = within(await screen.findByTestId('event-editor'));
    const title = sheet.getByLabelText('Event title');
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveValue('New event');
    await user.clear(title);
    await user.type(title, 'The Old Well');
    const story = sheet.getByLabelText('Event story');
    await user.clear(story);
    await user.type(story, 'Water glints far below.');
    expect(sheet.getByTestId('event-usage')).toHaveTextContent('Used in Entrance.');

    // A second choice, written and then moved to the front.
    await user.click(sheet.getByRole('button', { name: '+ Add choice' }));
    const label = sheet.getByLabelText('Choice 2 button text');
    await user.clear(label);
    await user.type(label, 'Climb down');
    await user.click(sheet.getByRole('button', { name: 'Move choice 2 up' }));
    expect(sheet.getAllByTestId('event-choice').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Climb down'),
      expect.stringContaining('Continue'),
    ]);

    const saved = await save(user);
    expect(saved.events).toHaveLength(1);
    const event = saved.events![0]!;
    expect(event).toEqual({
      id: event.id,
      title: 'The Old Well',
      text: 'Water glints far below.',
      choices: [
        { id: event.choices[0]!.id, label: 'Climb down', outcome: { text: '', effects: [] } },
        { id: event.choices[1]!.id, label: 'Continue', outcome: { text: '', effects: [] } },
      ],
    });
    expect(saved.rooms[0]!.actions).toEqual([
      {
        id: saved.rooms[0]!.actions[0]!.id,
        type: 'event',
        label: '',
        optional: false,
        outcomes: {},
        source: { kind: 'event', eventId: event.id },
      },
    ]);
    expect(saved).not.toHaveProperty('eventPools');
    // It is now a normal activity in the room.
    expect(
      inspector().getByRole('button', { name: /^Activity 1: Event\. “The Old Well” — 2 choices/ }),
    ).toBeInTheDocument();
  });

  it('creates a random pool from the room, attaches it, then changes the room to a specific event and to none', async () => {
    world.stored = fixture();
    const user = await ready();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await user.selectOptions(inspector().getByLabelText('Room event'), 'pool');
    await user.click(inspector().getByRole('button', { name: 'Room event: create a new pool' }));
    const sheet = within(await screen.findByTestId('event-pool-editor'));
    const name = sheet.getByLabelText('Pool name');
    await waitFor(() => expect(name).toHaveFocus());
    await user.clear(name);
    await user.type(name, 'Cellar finds');
    expect(sheet.getAllByTestId('pool-entry')).toHaveLength(2);

    const first = await save(user);
    const pool = first.eventPools![0]!;
    expect(pool.name).toBe('Cellar finds');
    expect(pool.entries).toEqual([
      { id: pool.entries[0]!.id, weight: 1, eventId: first.events![0]!.id, oncePerRun: true },
      { id: pool.entries[1]!.id, weight: 1, nothing: true },
    ]);
    const action = first.rooms[0]!.actions[0]!;
    expect(action.source).toEqual({ kind: 'pool', poolId: pool.id });

    // Change the source: the same activity, now presenting the event directly.
    await user.selectOptions(inspector().getByLabelText('Room event'), 'event');
    await user.selectOptions(
      inspector().getByLabelText('Room event: which event'),
      first.events![0]!.id,
    );
    const second = await save(user);
    expect(second.rooms[0]!.actions).toEqual([
      { ...action, source: { kind: 'event', eventId: first.events![0]!.id } },
    ]);
    expect(second.eventPools).toEqual(first.eventPools);

    // "No event" asks first, then takes the activity out and keeps the library.
    await user.selectOptions(inspector().getByLabelText('Room event'), 'none');
    await user.click(await screen.findByRole('button', { name: 'Remove activity' }));
    const third = await save(user);
    expect(third.rooms[0]!.actions).toEqual([]);
    expect(third.events).toEqual(second.events);
  });

  it('offers an Event room template that arrives with its own event', async () => {
    world.stored = fixture();
    const user = await ready();
    await user.click(await screen.findByRole('button', { name: 'Add Event room' }));
    expect(inspector().getByLabelText('Room event')).toHaveValue('event');
    expect(
      inspector().getByRole('button', { name: /^Activity 1: Event\. “New event” — 1 choice/ }),
    ).toBeInTheDocument();
    const saved = await save(user);
    expect(saved.rooms.at(-1)!.actions[0]!.source).toEqual({
      kind: 'event',
      eventId: saved.events![0]!.id,
    });
  });
});

describe('the event editor', () => {
  it('edits story and picture and leaves every other member of the dungeon’s events as stored', async () => {
    const original = eventDungeon();
    const user = await ready();
    const sheet = await openEvent(user, 'The Sealed Vault');
    await user.type(sheet.getByLabelText('Event story'), ' It hums.');
    expect(within(sheet.getByTestId('event-artwork')).getByText('vault.webp')).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Clear event picture' }));

    const saved = await save(user);
    const vault = eventOf(saved, 'sealed_vault');
    expect(vault.text).toBe('A blast door fills the corridor. It hums.');
    expect(vault).not.toHaveProperty('artwork');
    // Choices, the other events, the pool and the activities: byte-for-byte.
    expect(JSON.stringify(vault.choices)).toBe(JSON.stringify(original.events![0]!.choices));
    expect(JSON.stringify(saved.events!.slice(1))).toBe(JSON.stringify(original.events!.slice(1)));
    expect(JSON.stringify(saved.eventPools)).toBe(JSON.stringify(original.eventPools));
    expect(JSON.stringify(saved.rooms)).toBe(JSON.stringify(original.rooms));
    expect(saved.flags).toEqual(original.flags);
  });

  it('adds an item requirement, lets a limited key be required, and spells out what using it up means', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'A Buried Crate');
    // The single choice starts open and unrestricted.
    expect(sheet.getByText('Anyone, always.')).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Choice 1: add item requirement' }));
    // A key limited to one per player cannot be loot, but is exactly what a door asks for.
    const key = sheet.getByRole('button', { name: /Vault Key/ });
    expect(key).toBeEnabled();
    await user.click(key);
    const quantity = sheet.getByLabelText('Choice 1: item 1 quantity');
    fireEvent.change(quantity, { target: { value: '2' } });
    expect(sheet.queryByTestId('consume-warning')).not.toBeInTheDocument();
    await user.click(sheet.getByLabelText('Choice 1: item 1 is used up'));
    expect(sheet.getByTestId('consume-warning')).toHaveTextContent(
      'The item is used up the moment the player picks this. Players are told so on the choice.',
    );
    // With a skill check the cost is stated outright: it goes even when the check fails.
    await user.selectOptions(sheet.getByLabelText('Choice 1 result kind'), 'check');
    expect(sheet.getByTestId('consume-warning')).toHaveTextContent(
      'before the skill check is rolled. They lose it even if the check fails.',
    );
    // The only choice now needs an item, so nobody is guaranteed a way out.
    expect(sheet.getByTestId('no-open-choice')).toHaveTextContent(
      'Players need one choice they can always pick.',
    );
    await user.type(sheet.getByLabelText('Choice 1 unavailable text'), 'You need two keys.');
    await user.click(sheet.getByLabelText('Choice 1: hide when unavailable'));

    const choice = eventOf(await save(user), 'buried_crate').choices[0]!;
    expect(choice.items).toEqual([{ item: 'vault_key', quantity: 2, consume: true }]);
    expect(choice.unavailableText).toBe('You need two keys.');
    expect(choice.hideWhenUnavailable).toBe(true);
    expect(choice).not.toHaveProperty('outcome');
    expect(choice.success).toEqual({ text: 'Scrap.', effects: [] });
  });

  it('authors a skill check in percentages, with the weakest, average and strongest chances the server gives', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'The Sealed Vault');
    await user.click(sheet.getByRole('button', { name: /^Choice 2: Work the lock/ }));
    await waitFor(() =>
      expect(sheet.getByTestId('check-range')).toHaveTextContent(
        'Weakest Buddy 40% · average 55% · strongest 70%',
      ),
    );
    fireEvent.change(sheet.getByLabelText('Choice 2 chance for an average Buddy'), {
      target: { value: '80' },
    });
    await waitFor(() =>
      expect(sheet.getByTestId('check-range')).toHaveTextContent(
        'Weakest Buddy 65% · average 80% · strongest 95%',
      ),
    );
    // How much strength matters is an advanced setting, in points, never basis points.
    expect(sheet.queryByLabelText('Choice 2 Buddy strength influence')).not.toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Advanced' }));
    const influence = sheet.getByLabelText('Choice 2 Buddy strength influence');
    expect(influence).toHaveValue(15);
    fireEvent.change(influence, { target: { value: '30' } });
    await waitFor(() =>
      expect(sheet.getByTestId('check-range')).toHaveTextContent(
        'Weakest Buddy 50% · average 80% · strongest 95%',
      ),
    );
    expect(screen.getByTestId('event-editor')).not.toHaveTextContent(/basis points/i);

    const choice = eventOf(await save(user), 'sealed_vault').choices[1]!;
    expect(choice.check).toEqual({
      type: 'sp',
      baseChanceBasisPoints: 8000,
      maxSpModifierBasisPoints: 3000,
    });
    // Success and failure were not touched by tuning the check.
    expect(choice.success).toEqual(eventDungeon().events![0]!.choices[1]!.success);
    expect(choice.failure).toEqual(eventDungeon().events![0]!.choices[1]!.failure);
  });

  it('writes success and failure results: text, mood, remembered things, health and what happens next', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'A Buried Crate');
    await user.selectOptions(sheet.getByLabelText('Choice 1 result kind'), 'check');
    const success = within(sheet.getByTestId('outcome-success'));
    const failure = within(sheet.getByTestId('outcome-failure'));
    // The result already written became the success.
    expect(success.getByLabelText('Dig it out on success: result text')).toHaveValue('Scrap.');
    await user.selectOptions(success.getByLabelText('Dig it out on success: mood'), 'good');
    // Remember something that already exists, then something new, declared in the same edit.
    await user.click(success.getByRole('button', { name: 'Dig it out on success: add remember' }));
    expect(success.getByLabelText('Dig it out on success: effect 1 what')).toHaveValue(
      'vault_opened',
    );
    await user.click(
      success.getByRole('button', {
        name: 'Dig it out on success: effect 1 new thing to remember',
      }),
    );
    const named = success.getByLabelText('Dig it out on success: effect 1 name');
    await user.clear(named);
    await user.type(named, 'Crate opened');
    await user.click(
      success.getByRole('button', { name: 'Dig it out on success: add restore health' }),
    );
    fireEvent.change(success.getByLabelText('Dig it out on success: effect 2 percent'), {
      target: { value: '10' },
    });
    await user.selectOptions(
      success.getByLabelText('Dig it out on success: then'),
      'room_complete',
    );

    await user.type(
      failure.getByLabelText('Dig it out on failure: result text'),
      'The lid snaps shut on your hand.',
    );
    await user.selectOptions(failure.getByLabelText('Dig it out on failure: mood'), 'bad');
    await user.click(
      failure.getByRole('button', { name: 'Dig it out on failure: add lose health' }),
    );
    expect(failure.getByText('(never below 1 HP)')).toBeInTheDocument();
    await user.selectOptions(failure.getByLabelText('Dig it out on failure: effect 1'), 'forget');
    await user.selectOptions(
      failure.getByLabelText('Dig it out on failure: then'),
      'end_run:defeated',
    );

    const saved = await save(user);
    const flag = saved.flags.at(-1)!;
    expect(saved.flags).toHaveLength(3);
    expect(flag).toMatchObject({ scope: 'run', description: 'Crate opened' });
    const choice = eventOf(saved, 'buried_crate').choices[0]!;
    expect(choice.success).toEqual({
      text: 'Scrap.',
      tone: 'good',
      effects: [
        { type: 'set_flag', flag: flag.key, value: true },
        { type: 'heal', basisPoints: 1000 },
      ],
      then: { type: 'room_complete' },
    });
    expect(choice.failure).toEqual({
      text: 'The lid snaps shut on your hand.',
      tone: 'bad',
      effects: [{ type: 'set_flag', flag: 'vault_opened', value: false }],
      then: { type: 'end_run', outcome: 'defeated' },
    });
  });

  it('explains what turning back means where it is chosen', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'The Sealed Vault');
    await user.click(sheet.getByRole('button', { name: /^Choice 4: Leave it/ }));
    const outcome = within(sheet.getByTestId('outcome-outcome'));
    expect(outcome.getByLabelText('Leave it what happens: then')).toHaveValue('retreat');
    expect(outcome.getByRole('note')).toHaveTextContent(
      'meets this event again on return. A choice that turns back decides nothing',
    );
  });

  it('adds rewards to a result with the shared reward section, and stores none when they are removed', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'A Buried Crate');
    const outcome = within(sheet.getByTestId('outcome-outcome'));
    const toggle = outcome.getByRole('button', { name: 'Rewards: No rewards yet' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(outcome.getByTestId('payout-timing')).toHaveTextContent(
      'Paid once, when the player picks this choice.',
    );
    for (const heading of ['Guaranteed', 'Chance drops', 'Loot tables'])
      expect(outcome.getByRole('heading', { name: heading })).toBeVisible();
    await user.click(outcome.getByRole('button', { name: '+ Add guaranteed reward' }));
    await user.click(outcome.getByRole('radio', { name: 'Essence' }));
    const amount = outcome.getByLabelText(/^(Amount|How many)$/);
    await user.clear(amount);
    await user.type(amount, '7');
    await user.click(outcome.getByRole('button', { name: 'Add reward' }));
    await waitFor(() =>
      expect(outcome.getByTestId('rewards-summary')).not.toHaveTextContent('No rewards yet'),
    );

    const saved = await save(user);
    const rewards = eventOf(saved, 'buried_crate').choices[0]!.outcome!.rewards!;
    expect(rewards.chances).toEqual([]);
    expect(rewards.tables).toEqual([]);
    expect(rewards.guaranteed).toHaveLength(1);
    expect(rewards.guaranteed[0]!.grant).toMatchObject({ type: 'currency', currency: 'essence' });
    // The vault's existing bundle, table reference included, was never rebuilt.
    expect(eventOf(saved, 'sealed_vault').choices[0]!.outcome!.rewards).toEqual(
      eventDungeon().events![0]!.choices[0]!.outcome!.rewards,
    );
  });

  it('gives a choice a rule about the run, and sets what players read when they cannot pick it', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'A Shelved Idea');
    await user.selectOptions(sheet.getByLabelText('Choice 1 is available type'), 'flag');
    await user.selectOptions(sheet.getByLabelText('Choice 1 is available flag'), 'alarm_triggered');
    await user.selectOptions(sheet.getByLabelText('Choice 1 is available equals'), 'false');
    expect(sheet.getByTestId('no-open-choice')).toBeInTheDocument();
    const choice = eventOf(await save(user), 'shelved').choices[0]!;
    expect(choice.requires).toEqual({
      type: 'flag',
      flag: 'alarm_triggered',
      scope: 'run',
      equals: false,
    });
  });

  it('keeps a complex event intact through an edit, a save and a reload', async () => {
    const original = eventDungeon();
    const user = userEvent.setup();
    const view = renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
    const sheet = await openEvent(user, 'The Sealed Vault');
    // Open every choice and its parts, and change exactly one description.
    for (const name of [/^Choice 1:/, /^Choice 2:/, /^Choice 3:/, /^Choice 4:/])
      await user.click(sheet.getByRole('button', { name }));
    await user.click(sheet.getByRole('button', { name: /^Choice 1:/ }));
    const line = sheet.getByLabelText('Choice 1 description');
    await user.clear(line);
    await user.type(line, 'It might fit.');
    const saved = await save(user);
    const [edited, ...others] = eventOf(saved, 'sealed_vault').choices;
    expect(edited).toEqual({ ...original.events![0]!.choices[0], description: 'It might fit.' });
    // Everything that was only looked at is the same bytes it was.
    expect(JSON.stringify(others)).toBe(JSON.stringify(original.events![0]!.choices.slice(1)));
    expect(JSON.stringify({ ...eventOf(saved, 'sealed_vault'), choices: [] })).toBe(
      JSON.stringify({ ...original.events![0], choices: [] }),
    );
    expect(JSON.stringify(saved.events!.slice(1))).toBe(JSON.stringify(original.events!.slice(1)));
    expect(JSON.stringify(saved.eventPools)).toBe(JSON.stringify(original.eventPools));
    expect(JSON.stringify(saved.rooms)).toBe(JSON.stringify(original.rooms));

    view.unmount();
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
    const again = await openEvent(user, 'The Sealed Vault');
    await user.click(again.getByRole('button', { name: /^Choice 1:/ }));
    expect(again.getByLabelText('Choice 1 description')).toHaveValue('It might fit.');
    await user.click(screen.getByRole('button', { name: 'Close event' }));
    // Opening and reading it again changed nothing.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });
});

describe('the Discord preview', () => {
  it('shows requirements, the item-cost statement, check chances, and disabled and hidden choices for a situation', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'The Sealed Vault');
    const preview = () => within(sheet.getByTestId('event-discord-preview'));
    await waitFor(() => expect(preview().getAllByTestId('preview-choice')).toHaveLength(3));
    expect(preview().getByTestId('preview-title')).toHaveTextContent('The Sealed Vault');
    // No key held: the choice is shown, greyed out, with the author's line.
    const [key, lock, leave] = preview().getAllByTestId('preview-choice');
    expect(key).toHaveAttribute('data-available', 'false');
    expect(key).toHaveTextContent('🚫 Use the Vault Key');
    expect(key).toHaveTextContent('Needs 1× Vault Key (you have 0).');
    expect(key).toHaveTextContent('Consumed when selected.');
    expect(key).toHaveTextContent('You have no Vault Key.');
    expect(lock).toHaveTextContent('Success chance: 55%');
    expect(leave).toHaveTextContent('Step back for now.');
    expect(
      preview()
        .getAllByTestId('preview-button')
        .map((b) => b.textContent),
    ).toEqual(['Use the Vault Key', 'Work the lock (55%)', 'Leave it']);
    // The rule-gated choice is hidden from this player, and said to be.
    expect(preview().getByTestId('preview-hidden')).toHaveTextContent('“Whisper the code”');

    // Try a situation: holding the key, a strong Buddy, the alarm raised, at the entrance.
    const scenario = within(sheet.getByTestId('event-scenario'));
    fireEvent.change(scenario.getByLabelText('How many Vault Key the player holds'), {
      target: { value: '1' },
    });
    await user.selectOptions(scenario.getByLabelText('Buddy strength'), '350');
    await user.click(scenario.getByLabelText('Alarm triggered'));
    await user.click(scenario.getByLabelText(/arrived from another room/));
    await waitFor(() => expect(preview().getAllByTestId('preview-choice')).toHaveLength(4));
    expect(lastScenario()).toEqual({
      flags: ['alarm_triggered'],
      completedRooms: [],
      seenEvents: [],
      inventory: { vault_key: 1 },
      currentSp: 350,
      canTurnBack: false,
    });
    const now = preview().getAllByTestId('preview-choice');
    expect(now[0]).toHaveAttribute('data-available', 'true');
    expect(now[0]).toHaveTextContent('Needs 1× Vault Key (you have 1).');
    expect(now[1]).toHaveTextContent('Success chance: 70%');
    expect(now[2]).toHaveTextContent('▸ Whisper the code');
    expect(now[3]).toHaveTextContent('There is nowhere to go back to.');
    expect(preview().queryByTestId('preview-hidden')).not.toBeInTheDocument();
    // What each result looks like.
    const outcomes = within(preview().getByTestId('preview-outcomes'));
    expect(outcomes.getAllByRole('listitem')).toHaveLength(5);
    expect(outcomes.getByText('✅ Success — 70% chance')).toBeInTheDocument();
    expect(outcomes.getByText('Used 1× Vault Key')).toBeInTheDocument();
    // Trying a situation is a question, not an edit.
    await user.click(screen.getByRole('button', { name: 'Close event' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('holds an event at its text limits without cutting what Discord would show', () => {
    const L = DISCORD_EVENT_LIMITS;
    const label = 'L'.repeat(L.choiceLabel);
    const event = {
      id: 'big',
      title: 'T'.repeat(L.title),
      text: 'S'.repeat(L.text),
      choices: [
        {
          id: 'c1',
          label,
          description: 'D'.repeat(L.description),
          unavailableText: 'U'.repeat(L.unavailableText),
          items: [{ item: 'vault_key', quantity: 99, consume: true }],
          check: { type: 'sp' as const, baseChanceBasisPoints: 9500 },
          success: { text: 'O'.repeat(L.outcomeText), effects: [] },
          failure: { text: '', effects: [] },
        },
      ],
    };
    const insight = fakeInsight({ ...eventDungeon(), events: [event] });
    render(
      <EventDiscordPreview
        event={event}
        preview={insight.eventPreviews[0]}
        itemName={() => 'Vault Key'}
        updating={false}
      />,
    );
    expect(screen.getByTestId('preview-title')).toHaveTextContent(`❔ ${event.title}`);
    expect(screen.getByTestId('preview-text').textContent).toBe(event.text);
    const choice = screen.getByTestId('preview-choice');
    expect(choice).toHaveTextContent(`🚫 ${label}`);
    expect(choice).toHaveTextContent('D'.repeat(L.description));
    expect(choice).toHaveTextContent('U'.repeat(L.unavailableText));
    // The cost of a checked choice is never shortened.
    expect(screen.getByTestId('preview-consumed')).toHaveTextContent(
      'Consumed when selected, even if the check fails.',
    );
    const button = screen.getByTestId('preview-button');
    expect(button.textContent).toBe(`${label} (95%)`);
    expect(button.textContent!.length).toBeLessThanOrEqual(L.button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('O'.repeat(L.outcomeText))).toBeInTheDocument();
    // Anything longer than Discord shows is cut the way the Discord screen cuts it.
    const long = { ...event, title: 'T'.repeat(L.title + 20) };
    render(<EventDiscordPreview event={long} preview={undefined} itemName={(s) => s} updating />);
    expect(screen.getAllByTestId('preview-title')[1]!.textContent).toBe(
      `❔ ${'T'.repeat(L.title - 1)}…`,
    );
    expect(screen.getByText('Working out the choices…')).toBeInTheDocument();
  });
});

describe('the random pool editor', () => {
  it('shows base odds from the server as percentages and about 1 in N', async () => {
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    const base = within(await sheet.findByTestId('pool-base-odds'));
    expect(base.getAllByTestId('pool-odds-row').map((row) => row.textContent)).toEqual([
      'A Buried Crate30%about 1 in 3.3',
      'The Sealed Vault10%about 1 in 10',
      'Nothing happens60%about 1 in 1.7',
    ]);
    expect(base.getByTestId('pool-nothing-chance')).toHaveTextContent(
      'Chance that no event appears: 60% (about 1 in 1.7).',
    );
    expect(sheet.getAllByTestId('pool-entry-chance').map((c) => c.textContent)).toEqual([
      '30% about 1 in 3.3',
      '10% about 1 in 10',
      '60% about 1 in 1.7',
    ]);
    expect(sheet.getByTestId('pool-usage')).toHaveTextContent('Used in Entrance.');
  });

  it('shows the server’s numbers as given, never its own arithmetic', async () => {
    vi.mocked(api.validateDungeon).mockImplementation(async (definition, _signal, scenario) => {
      const real = fakeInsight(definition, scenario);
      const skew = (odds: (typeof real.eventPools)[number]['base']) => ({
        ...odds,
        nothingProbability: 0.4321,
        entries: odds.entries.map((e, i) => ({ ...e, probability: [0.1234, 0.4445, 0.4321][i]! })),
      });
      return {
        definition,
        contentHash: 'hash',
        issues: [],
        publishable: true,
        eventPreviews: real.eventPreviews,
        eventPools: real.eventPools.map((p) => ({
          ...p,
          base: skew(p.base),
          scenario: skew(p.scenario),
        })),
      };
    });
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    const base = within(await sheet.findByTestId('pool-base-odds'));
    // Shares of 30, 10 and 60 would never give these.
    expect(base.getAllByTestId('pool-odds-row').map((row) => row.textContent)).toEqual([
      'A Buried Crate12.3%about 1 in 8.1',
      'The Sealed Vault44.5%about 1 in 2.2',
      'Nothing happens43.2%about 1 in 2.3',
    ]);
    expect(base.getByTestId('pool-nothing-chance')).toHaveTextContent('43.2%');
  });

  it('tries a situation: remembered things and events already met take entries out of the draw', async () => {
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    const scenarioOdds = () =>
      within(sheet.getByTestId('pool-scenario-odds'))
        .getAllByTestId('pool-odds-row')
        .map((row) => row.textContent);
    await sheet.findByTestId('pool-scenario-odds');
    const situation = within(sheet.getByTestId('event-scenario'));
    // Only what this pool reads is offered: the flag its rule checks, and its once-per-run event.
    expect(situation.getByLabelText('Alarm triggered')).toBeInTheDocument();
    expect(situation.queryByLabelText('Vault opened')).not.toBeInTheDocument();
    expect(situation.queryByLabelText('The Sealed Vault')).not.toBeInTheDocument();

    await user.click(situation.getByLabelText('Alarm triggered'));
    await waitFor(() =>
      expect(scenarioOdds()).toEqual([
        'A Buried Crate33.3%about 1 in 3',
        'The Sealed VaultNot in the draw: its rule is not met',
        'Nothing happens66.7%about 1 in 1.5',
      ]),
    );
    expect(lastScenario()).toMatchObject({ flags: ['alarm_triggered'], seenEvents: [] });

    await user.click(situation.getByLabelText('A Buried Crate'));
    await waitFor(() =>
      expect(scenarioOdds()).toEqual([
        'A Buried CrateNot in the draw: already met this run',
        'The Sealed VaultNot in the draw: its rule is not met',
        'Nothing happens100%',
      ]),
    );
    expect(lastScenario()).toMatchObject({ seenEvents: ['buried_crate'] });
    // The base odds are untouched by the situation.
    expect(
      within(sheet.getByTestId('pool-base-odds'))
        .getAllByTestId('pool-odds-row')
        .map((row) => row.textContent)[0],
    ).toBe('A Buried Crate30%about 1 in 3.3');
    await user.click(screen.getByRole('button', { name: 'Close random pool' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('says plainly that a pool with nothing left in the draw results in Nothing', async () => {
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    await sheet.findByTestId('pool-scenario-odds');
    // Without its Nothing entry, the pool's two events can both drop out.
    await user.click(sheet.getByRole('button', { name: 'Remove entry 3' }));
    const situation = within(sheet.getByTestId('event-scenario'));
    await user.click(situation.getByLabelText('Alarm triggered'));
    await user.click(situation.getByLabelText('A Buried Crate'));
    const odds = within(sheet.getByTestId('pool-scenario-odds'));
    expect(await odds.findByTestId('pool-empty')).toHaveTextContent(
      'No entry is in the draw, so this pool results in Nothing',
    );
    expect(odds.getByTestId('pool-nothing-chance')).toHaveTextContent(
      'Chance that no event appears: 100%.',
    );
    expect(within(sheet.getByTestId('pool-base-odds')).queryByTestId('pool-empty')).toBeNull();
  });

  it('adds, re-aims, reorders and removes entries, sets shares, rules and once-per-run, and keeps ids', async () => {
    const original = eventDungeon().eventPools![0]!;
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    // An explicit second Nothing, with its own line, moved to the top.
    await user.click(sheet.getByRole('button', { name: '+ Add “Nothing happens”' }));
    await user.type(sheet.getByLabelText('Entry 4 nothing text'), 'Just dust.');
    for (const n of [4, 3, 2])
      await user.click(sheet.getByRole('button', { name: `Move entry ${n} up` }));
    // The only event not yet listed can be added; after that there is none left to add.
    await user.click(sheet.getByRole('button', { name: '+ Add event' }));
    expect(sheet.getByLabelText('Entry 5: what happens')).toHaveValue('shelved');
    expect(sheet.getByRole('button', { name: '+ Add event' })).toBeDisabled();
    // An event already in the pool cannot be picked for a second entry.
    expect(
      within(sheet.getByLabelText('Entry 5: what happens')).getByRole('option', {
        name: 'A Buried Crate',
      }),
    ).toBeDisabled();
    // Shares: a usable number is stored, an unusable one is held back and explained.
    const share = sheet.getByLabelText('Entry 2 share');
    fireEvent.change(share, { target: { value: '45' } });
    fireEvent.change(sheet.getByLabelText('Entry 5 share'), { target: { value: '0' } });
    expect(sheet.getByRole('alert')).toHaveTextContent('The draft still says 1 until this is one.');
    fireEvent.change(sheet.getByLabelText('Entry 5 share'), { target: { value: '5' } });
    expect(sheet.queryByRole('alert')).not.toBeInTheDocument();
    // Once-per-run off for the crate; a rule on the new entry; the vault's rule removed.
    await user.click(sheet.getByLabelText('Entry 2: once per run'));
    await user.click(sheet.getByRole('button', { name: 'Entry 5: add a rule' }));
    await user.selectOptions(sheet.getByLabelText('Entry 5 is in the draw type'), 'room_completed');
    await user.selectOptions(sheet.getByLabelText('Entry 3 is in the draw type'), 'none');
    await user.click(sheet.getByRole('button', { name: 'Remove entry 4' }));

    const pool = (await save(user)).eventPools![0]!;
    expect(pool.id).toBe(original.id);
    expect(pool.entries).toEqual([
      { id: pool.entries[0]!.id, weight: 1, nothing: true, text: 'Just dust.' },
      { ...original.entries[0], weight: 45, oncePerRun: false },
      { id: 'e_vault', weight: 10, eventId: 'sealed_vault', oncePerRun: false },
      {
        id: pool.entries[3]!.id,
        weight: 5,
        eventId: 'shelved',
        oncePerRun: true,
        when: { type: 'room_completed', roomId: 'entrance' },
      },
    ]);
  });

  it('never shows an answer about an older situation as the current one', async () => {
    const user = await ready();
    const sheet = await openPool(user, 'Scrapheap finds');
    await sheet.findByTestId('pool-scenario-odds');
    // The next answer is held back; the one after it arrives at once.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answer = vi.mocked(api.validateDungeon).getMockImplementation()!;
    vi.mocked(api.validateDungeon).mockImplementationOnce(async (...args) => {
      await held;
      return answer(...args);
    });
    const situation = within(sheet.getByTestId('event-scenario'));
    await user.click(situation.getByLabelText('Alarm triggered'));
    await waitFor(() => expect(lastScenario()?.flags).toEqual(['alarm_triggered']));
    await user.click(situation.getByLabelText('A Buried Crate'));
    const rows = () =>
      within(sheet.getByTestId('pool-scenario-odds'))
        .getAllByTestId('pool-odds-row')
        .map((row) => row.textContent);
    await waitFor(() =>
      expect(rows()[0]).toBe('A Buried CrateNot in the draw: already met this run'),
    );
    await act(async () => {
      release();
      await held;
    });
    // The slow answer (crate still in the draw) is dropped.
    expect(rows()[0]).toBe('A Buried CrateNot in the draw: already met this run');
  });
});

describe('the dungeon’s events library', () => {
  it('lists every event and pool with where it is used', async () => {
    await ready();
    const rows = library()
      .getAllByTestId('event-row')
      .map((row) => row.textContent);
    expect(rows).toEqual([
      'The Sealed Vault4 choicesUsed in Entrance, Scrapheap finds (random pool)',
      'A Buried Crate1 choiceUsed in Scrapheap finds (random pool)',
      'A Shelved Idea1 choiceNot used yet',
    ]);
    expect(library().getByTestId('pool-row')).toHaveTextContent(
      'Scrapheap findsRandom pool, 3 entriesUsed in Entrance',
    );
  });

  it('duplicates and renames, refuses to delete what is used and deletes what is not', async () => {
    const original = eventDungeon();
    const user = await ready();
    await user.click(library().getByRole('button', { name: 'Duplicate event The Sealed Vault' }));
    expect(library().getAllByTestId('event-row')[1]).toHaveTextContent(
      'The Sealed Vault (copy)4 choicesNot used yet',
    );
    // Rename the copy in its editor.
    const sheet = await openEvent(user, 'The Sealed Vault (copy)');
    const title = sheet.getByLabelText('Event title');
    await user.clear(title);
    await user.type(title, 'The Second Vault');
    await user.click(screen.getByRole('button', { name: 'Close event' }));
    expect(library().getAllByTestId('event-row')[1]).toHaveTextContent('The Second Vault');

    // Still used by a room and a pool: no delete on offer, and each use is named.
    await user.click(library().getByRole('button', { name: 'Delete event The Sealed Vault' }));
    const blocked = within(await screen.findByRole('dialog'));
    expect(blocked.getByText(/Can’t delete “The Sealed Vault” yet/)).toBeInTheDocument();
    expect(
      within(blocked.getByTestId('delete-blockers'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'The room Entrance shows it: set that room’s Event to something else.',
      'The random pool Scrapheap finds lists it: remove its entry there.',
    ]);
    expect(blocked.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    await user.click(blocked.getByRole('button', { name: 'OK' }));
    // The pool is used by a room, too.
    await user.click(library().getByRole('button', { name: 'Delete pool Scrapheap finds' }));
    expect(await screen.findByTestId('delete-blockers')).toHaveTextContent('The room Entrance');
    await user.click(screen.getByRole('button', { name: 'OK' }));

    // Unused: asks, then deletes.
    await user.click(library().getByRole('button', { name: 'Delete event A Shelved Idea' }));
    await user.click(await screen.findByRole('button', { name: 'Delete event' }));
    await user.click(library().getByRole('button', { name: 'Duplicate pool Scrapheap finds' }));

    const saved = await save(user);
    expect(saved.events!.map((e) => e.title)).toEqual([
      'The Sealed Vault',
      'The Second Vault',
      'A Buried Crate',
    ]);
    // The originals, and every reference to them, are as they were.
    expect(saved.events![0]).toEqual(original.events![0]);
    expect(saved.events![1]!.choices).toEqual(original.events![0]!.choices);
    expect(saved.events![1]!.id).not.toBe('sealed_vault');
    expect(saved.eventPools![0]).toEqual(original.eventPools![0]);
    expect(saved.eventPools![1]).toMatchObject({
      name: 'Scrapheap finds (copy)',
      entries: original.eventPools![0]!.entries,
    });
    expect(JSON.stringify(saved.rooms)).toBe(JSON.stringify(original.rooms));
  });

  it('starts a new event from a starting point', async () => {
    const user = await ready();
    await user.click(library().getByRole('button', { name: '+ New event' }));
    await user.click(library().getByRole('button', { name: 'Start from Locked door' }));
    const sheet = within(await screen.findByTestId('event-editor'));
    expect(sheet.getByLabelText('Event title')).toHaveValue('A Locked Door');
    expect(sheet.getAllByTestId('event-choice')).toHaveLength(2);
    expect(sheet.queryByTestId('no-open-choice')).not.toBeInTheDocument();
    expect(sheet.getByTestId('event-usage')).toHaveTextContent('Not used yet.');
  });
});

describe('the checklist', () => {
  const ISSUES: api.DungeonIssue[] = [
    {
      code: 'event_item_missing',
      severity: 'error',
      path: 'events[0].choices[0].items[0].item',
      message:
        'event "The Sealed Vault", choice "Use the Vault Key" needs item "vault_key", which does not exist. Pick another item.',
    },
    {
      code: 'event_pool_may_be_empty',
      severity: 'warning',
      path: 'eventPools[0].entries',
      message: 'every entry of event pool "Scrapheap finds" has a rule or is once per run',
    },
    {
      code: 'event_check_retreat',
      severity: 'error',
      path: 'events[0].choices[1].failure.then',
      message: 'turns back after a check',
    },
  ];
  it('names the event, pool and choice, and “Show me” opens the editor on the field', async () => {
    world.stored = { ...world.stored, issues: ISSUES };
    // The server says the same of the draft once it has unsaved edits.
    vi.mocked(api.validateDungeon).mockImplementation(async (definition, _signal, scenario) => ({
      definition,
      contentHash: 'hash',
      issues: ISSUES,
      publishable: false,
      ...fakeInsight(definition, scenario),
    }));
    const user = await ready();
    const outline = within(screen.getByRole('navigation', { name: 'Dungeon outline' }));
    const item =
      'Event “The Sealed Vault”, choice “Use the Vault Key” needs an item that no longer exists.';
    expect(outline.getByText(item)).toBeInTheDocument();
    expect(
      outline.getByText('Random pool “Scrapheap finds” can run out of entries.'),
    ).toBeInTheDocument();

    // An unsaved edit made before following the checklist is still there afterwards.
    await user.type(inspector().getByLabelText('Dungeon name'), ' Deep');
    // The checklist is asked for again about the edited draft, and says the same.
    await user.click(await outline.findByRole('button', { name: `Show me: ${item}` }));
    const sheet = within(await screen.findByTestId('event-editor'));
    // The choice is opened, the issue is beside it, and focus is on the item it is about.
    const choice = sheet.getByRole('button', { name: /^Choice 1: Use the Vault Key/ });
    expect(choice).toHaveAttribute('aria-expanded', 'true');
    const card = sheet.getAllByTestId('event-choice')[0]!;
    expect(card).toHaveTextContent(item);
    await waitFor(() =>
      expect(sheet.getByRole('button', { name: 'Choice 1: choose item 1' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Close event' }));

    // A field inside a result: the right choice opens and its "Then" takes focus.
    await user.click(
      outline.getByRole('button', {
        name: /^Show me: Event “The Sealed Vault”, choice “Work the lock” turns the player back/,
      }),
    );
    const again = within(await screen.findByTestId('event-editor'));
    await waitFor(() =>
      expect(again.getByLabelText('Work the lock on failure: then')).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Close event' }));

    await user.click(
      outline.getByRole('button', {
        name: 'Show me: Random pool “Scrapheap finds” can run out of entries.',
      }),
    );
    expect(await screen.findByTestId('event-pool-editor')).toHaveTextContent(
      'Random pool “Scrapheap finds” can run out of entries.',
    );
    await user.click(screen.getByRole('button', { name: 'Close random pool' }));
    expect(inspector().getByLabelText('Dungeon name')).toHaveValue('Tunnels Deep');
  });

  it('asks for a blank event field before saving, and takes the author to it', async () => {
    const user = await ready();
    const sheet = await openEvent(user, 'A Buried Crate');
    await user.clear(sheet.getByLabelText('Event title'));
    await user.click(screen.getByRole('button', { name: 'Close event' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    // The reason is said in terms of what is actually missing, not fights.
    expect(
      screen.getByText('Finish the items under “Finish before saving” to save.'),
    ).toBeInTheDocument();
    const outline = within(screen.getByRole('navigation', { name: 'Dungeon outline' }));
    await user.click(
      outline.getByRole('button', { name: 'Show me: Event “Untitled” needs a title.' }),
    );
    const again = within(await screen.findByTestId('event-editor'));
    await waitFor(() => expect(again.getByLabelText('Event title')).toHaveFocus());
    await user.type(again.getByLabelText('Event title'), 'A Crate');
    await user.click(screen.getByRole('button', { name: 'Close event' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });

  it('keeps the page’s checklist when the editor asks its own questions', async () => {
    world.stored = { ...world.stored, issues: ISSUES };
    const user = await ready();
    const todo = () =>
      within(screen.getByRole('navigation', { name: 'Dungeon outline' })).getByRole('button', {
        name: /To do/,
      });
    expect(todo()).toHaveTextContent('3');
    // The sheet asks the server about odds and choices; that answer carries no issues here.
    const sheet = await openPool(user, 'Scrapheap finds');
    await sheet.findByTestId('pool-scenario-odds');
    await user.click(within(sheet.getByTestId('event-scenario')).getByLabelText('Alarm triggered'));
    await waitFor(() => expect(lastScenario()?.flags).toEqual(['alarm_triggered']));
    await user.click(screen.getByRole('button', { name: 'Close random pool' }));
    expect(todo()).toHaveTextContent('3');
  });
});

describe('the sandbox', () => {
  /** A stand-in run: an event at the start, then the room's ways out. */
  function sandbox() {
    const calls: Array<Parameters<typeof api.playDungeonSandbox>[0]> = [];
    const spy = vi.spyOn(api, 'playDungeonSandbox').mockImplementation(async (input) => {
      calls.push(structuredClone(input));
      const definition = input.definition;
      const event = definition.events![0]!;
      const choices = fakeInsight(definition, {
        flags: [],
        completedRooms: [],
        seenEvents: [],
        inventory: input.inventory,
        currentSp: input.currentSp,
        canTurnBack: false,
      }).eventPreviews[0]!.choices.filter((c) => !c.hidden);
      const picked = input.inputs.find(
        (i): i is Extract<DungeonSandboxInput, { type: 'choose' }> => i.type === 'choose',
      );
      const chosen = choices.find((c) => c.id === picked?.choiceId);
      const refused = picked !== undefined && !chosen?.available;
      const done = picked !== undefined && !refused;
      const base = {
        status: 'active',
        step: input.inputs.length,
        hp: 400,
        maxHp: 400,
        room: { id: 'entrance', name: 'Entrance', description: '', kind: 'room' as const },
        canExtract: false,
        stuck: false,
        flags: done ? { vault_opened: true } : {},
        end: null,
      };
      const result: DungeonSandboxResult = {
        view: done
          ? { ...base, phase: 'connections', action: null, connections: [], recent: [] }
          : {
              ...base,
              phase: 'action',
              action: {
                id: 'a_door',
                type: 'event',
                label: '',
                optional: false,
                wave: null,
                event: {
                  eventId: event.id,
                  title: event.title,
                  text: event.text,
                  artwork: null,
                  choices,
                },
              },
              connections: [],
              recent: [],
            },
        effects:
          done && chosen!.consumesOnSelect
            ? [
                { type: 'consume_items', items: [{ item: 'vault_key', quantity: 1 }] },
                { type: 'grant_rewards', plan: {} },
              ]
            : [],
        eventResults: done
          ? [
              {
                roomId: 'entrance',
                actionId: 'a_door',
                eventTitle: event.title,
                choiceLabel: chosen!.label,
                text: 'The door rolls aside.',
                tone: 'good',
              },
            ]
          : [],
        steps: refused ? input.inputs.length - 1 : input.inputs.length,
        stoppedBy: refused ? 'refused' : null,
        refusal: refused ? 'choice_unavailable' : null,
      };
      return result;
    });
    return { calls, spy };
  }

  it('plays the draft’s event with an assumed inventory and Buddy, and gives, uses and saves nothing', async () => {
    const { calls } = sandbox();
    const user = await ready();
    await user.click(library().getByRole('button', { name: 'Play the dungeon' }));
    const play = within(await screen.findByTestId('dungeon-sandbox'));
    expect(play.getByTestId('sandbox-safe')).toHaveTextContent(
      'no reward is given, no item is used up, and no run is saved. Your draft is not changed.',
    );
    const event = within(await play.findByTestId('sandbox-event'));
    expect(event.getByText('The Sealed Vault')).toBeInTheDocument();
    // The draft itself is what is played, from its first step.
    expect(calls[0]).toMatchObject({ seed: 1, inputs: [], inventory: {}, currentSp: 200 });
    expect(calls[0]!.definition).toEqual(eventDungeon());
    // No key: the choice is there and cannot be pressed.
    expect(event.getByRole('button', { name: 'Use the Vault Key' })).toBeDisabled();
    expect(event.getByRole('button', { name: 'Work the lock (55%)' })).toBeEnabled();
    expect(event.queryByRole('button', { name: 'Whisper the code' })).not.toBeInTheDocument();

    // Pretend to hold the key and to have a strong Buddy.
    fireEvent.change(play.getByLabelText('Pretend the player holds Vault Key'), {
      target: { value: '1' },
    });
    // The run is replayed for each change; the controls wait for it.
    await waitFor(() => expect(play.getByLabelText('Buddy strength')).toBeEnabled());
    await user.selectOptions(play.getByLabelText('Buddy strength'), '350');
    await waitFor(() =>
      expect(event.getByRole('button', { name: 'Work the lock (70%)' })).toBeEnabled(),
    );
    expect(event.getByText('Consumed when selected.')).toBeInTheDocument();
    await user.click(event.getByRole('button', { name: 'Use the Vault Key' }));
    expect(await play.findByTestId('sandbox-results')).toHaveTextContent(
      'The Sealed Vault — Use the Vault Key The door rolls aside.',
    );
    expect(calls.at(-1)).toMatchObject({
      inputs: [{ type: 'choose', choiceId: 'use_key' }],
      inventory: { vault_key: 1 },
      currentSp: 350,
    });
    expect(play.getByTestId('sandbox-would')).toHaveTextContent(
      'In a real run this would have used up 1× Vault Key and paid rewards 1 time. Here, nothing was.',
    );
    expect(play.getByText(/Remembers: Vault opened/)).toBeInTheDocument();

    // Back one step replays without the choice; different luck starts over with a new seed.
    await user.click(play.getByRole('button', { name: 'Back one step' }));
    await play.findByTestId('sandbox-event');
    expect(calls.at(-1)!.inputs).toEqual([]);
    await user.click(play.getByRole('button', { name: 'Try different luck' }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ seed: 2, inputs: [] }));
    expect(play.getByTestId('sandbox-luck')).toHaveTextContent('Luck #2');

    await user.click(screen.getByRole('button', { name: 'Close test play' }));
    // Nothing was saved, and there is nothing to save.
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('rewinds to what still works when the pretend player changes', async () => {
    const { calls } = sandbox();
    const user = await ready();
    await user.click(library().getByRole('button', { name: 'Play the dungeon' }));
    const play = within(await screen.findByTestId('dungeon-sandbox'));
    await play.findByTestId('sandbox-event');
    const held = play.getByLabelText('Pretend the player holds Vault Key');
    fireEvent.change(held, { target: { value: '1' } });
    await user.click(await play.findByRole('button', { name: 'Use the Vault Key' }));
    await play.findByTestId('sandbox-results');
    // Without the key that press could never have happened.
    fireEvent.change(held, { target: { value: '0' } });
    expect(await play.findByTestId('sandbox-notice')).toHaveTextContent(
      'That choice can’t be picked with what this player holds and remembers.',
    );
    expect(await play.findByTestId('sandbox-event')).toBeInTheDocument();
    await user.click(play.getByRole('button', { name: /^Work the lock/ }));
    await waitFor(() =>
      expect(calls.at(-1)!.inputs).toEqual([{ type: 'choose', choiceId: 'pick_lock' }]),
    );
  });

  it('says what to do when the draft has errors, instead of playing it', async () => {
    vi.spyOn(api, 'playDungeonSandbox').mockRejectedValue(
      new PortalApiError({ status: 400, code: 'DUNGEON_INVALID', message: 'invalid' }),
    );
    const user = await ready();
    await user.click(library().getByRole('button', { name: 'Play the dungeon' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This draft can’t be played yet. Close this and finish everything under “Fix before publishing”',
    );
  });
});

describe('a reader', () => {
  it('can open, preview and play events, and change nothing', async () => {
    vi.spyOn(api, 'playDungeonSandbox').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderAt(undefined, ['dungeons.read']);
    await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
    for (const name of [/^Duplicate/, /^Delete/, '+ New event', '+ New random pool'])
      expect(library().queryByRole('button', { name })).not.toBeInTheDocument();
    await user.click(library().getByRole('button', { name: 'View event The Sealed Vault' }));
    const sheet = within(await screen.findByTestId('event-editor'));
    expect(sheet.getByText(/Changing it needs permission to edit dungeons/)).toBeInTheDocument();
    expect(sheet.getByLabelText('Event title')).toBeDisabled();
    expect(sheet.getByLabelText('Event story')).toBeDisabled();
    expect(sheet.queryByRole('button', { name: '+ Add choice' })).not.toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: /^Choice 2: Work the lock/ }));
    expect(sheet.getByLabelText('Choice 2 button text')).toBeDisabled();
    expect(sheet.getByLabelText('Choice 2 chance for an average Buddy')).toBeDisabled();
    expect(sheet.getByLabelText('Work the lock on failure: then')).toBeDisabled();
    expect(sheet.queryByRole('button', { name: 'Remove choice 2' })).not.toBeInTheDocument();
    // Looking is allowed: the preview answers, and a situation can be tried.
    await waitFor(() => expect(sheet.getAllByTestId('preview-choice')).toHaveLength(3));
    const strength = within(sheet.getByTestId('event-scenario')).getByLabelText('Buddy strength');
    expect(strength).toBeEnabled();
    await user.selectOptions(strength, '50');
    await waitFor(() =>
      expect(sheet.getAllByTestId('preview-choice')[1]).toHaveTextContent('Success chance: 40%'),
    );
    await user.click(screen.getByRole('button', { name: 'Close event' }));

    await user.click(library().getByRole('button', { name: 'View pool Scrapheap finds' }));
    const pool = within(await screen.findByTestId('event-pool-editor'));
    expect(pool.getByLabelText('Pool name')).toBeDisabled();
    expect(pool.getByLabelText('Entry 1 share')).toBeDisabled();
    expect(pool.queryByRole('button', { name: /^Remove entry/ })).not.toBeInTheDocument();
    expect(pool.queryByRole('button', { name: '+ Add event' })).not.toBeInTheDocument();
    expect(await pool.findByTestId('pool-base-odds')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close random pool' }));
    // The sandbox is a read, so a reader may open it.
    expect(library().getByRole('button', { name: 'Play the dungeon' })).toBeEnabled();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });
});
