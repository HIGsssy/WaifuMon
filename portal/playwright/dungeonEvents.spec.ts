/**
 * Event authoring in the real editor build. The stand-in backend
 * (`dungeonBackend.ts`) checks drafts with the server's own validator, works
 * out pool odds and choices with the engine's own functions, and plays the
 * sandbox with the real engine, so nothing a spec sees here is a stand-in's
 * arithmetic or leniency.
 */
import { expect, test, type Page } from '@playwright/test';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { starterDungeon } from '@/features/adminDungeons/dungeonModel';
import { serveDungeon, validate } from './dungeonBackend';
import { stubApi } from './stubApi';

const WRITER = ['dungeons.read', 'dungeons.write', 'dungeons.publish'];
const desktopOnly = (isMobile: boolean) => test.skip(isMobile, 'desktop authoring flow');
const errorsOf = async (definition: unknown) =>
  (await validate(definition)).issues.filter((i) => i.severity === 'error');

/** A dungeon that can be finished: an entrance and an exit. */
function twoRooms(): DungeonDefinition {
  const base = starterDungeon('event_halls', 'Event Halls', ['waifu-valley']);
  return {
    ...base,
    rooms: [...base.rooms, { id: 'out', name: 'Way Out', kind: 'exit', actions: [] }],
    connections: [
      { id: 'c_out', from: 'entrance', to: 'out', label: '', kind: 'path', lockedText: '' },
    ],
  };
}

function eventDungeon(): DungeonDefinition {
  return {
    ...twoRooms(),
    flags: [{ key: 'vault_opened', scope: 'run', description: 'Vault opened' }],
    events: [
      {
        id: 'sealed_vault',
        title: 'The Sealed Vault',
        text: 'A blast door fills the corridor.',
        choices: [
          {
            id: 'pick_lock',
            label: 'Work the lock',
            check: { type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 },
            success: {
              text: 'It opens.',
              effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }],
            },
            failure: {
              text: 'It jams.',
              tone: 'bad',
              effects: [{ type: 'damage', basisPoints: 2500 }],
            },
          },
          {
            id: 'force',
            label: 'Force it',
            outcome: {
              text: 'It gives.',
              effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }],
            },
          },
        ],
      },
      {
        id: 'buried_crate',
        title: 'A Buried Crate',
        text: 'Something square.',
        choices: [{ id: 'dig', label: 'Dig it out', outcome: { text: 'Scrap.', effects: [] } }],
      },
    ],
    eventPools: [
      {
        id: 'finds',
        name: 'Scrapheap finds',
        entries: [
          { id: 'e_crate', weight: 1, eventId: 'buried_crate', oncePerRun: true },
          { id: 'e_nothing', weight: 3, nothing: true, text: 'Nothing but rust.' },
        ],
      },
    ],
    rooms: [
      { id: 'out', name: 'Way Out', kind: 'exit', actions: [] },
      {
        id: 'entrance',
        name: 'Entrance',
        extraction: true,
        actions: [
          {
            id: 'a_find',
            type: 'event',
            label: '',
            optional: false,
            outcomes: {},
            source: { kind: 'pool', poolId: 'finds' },
          },
          {
            id: 'a_door',
            type: 'event',
            label: '',
            optional: false,
            outcomes: {},
            source: { kind: 'event', eventId: 'sealed_vault' },
          },
        ],
      },
    ],
  };
}
/** The draft as the server's schema stores it, defaults filled in. */
const stored = async (definition: DungeonDefinition) =>
  (await validate(definition)).definition as DungeonDefinition;

async function open(page: Page, definition: DungeonDefinition, permissions = WRITER) {
  await stubApi(page, { session: { permissions } });
  const backend = await serveDungeon(page, definition);
  await page.goto(`/admin/dungeons/definitions/${definition.key}`);
  await expect(page.getByRole('heading', { level: 1, name: definition.name })).toBeVisible();
  return backend;
}
const library = (page: Page) => page.getByTestId('dungeon-events');

test('an author creates a handcrafted event from a room, writes its choices and a skill check, saves and reloads', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  const backend = await open(page, twoRooms());
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  await page.getByLabel('Room event', { exact: true }).selectOption('event');
  await page.getByRole('button', { name: 'Room event: create a new event' }).click();

  const sheet = page.getByTestId('event-editor');
  const title = sheet.getByLabel('Event title');
  await expect(title).toBeFocused();
  await title.fill('The Sealed Vault');
  await sheet.getByLabel('Event story').fill('A blast door fills the corridor.');
  // The first choice: forcing it costs health and is remembered.
  await sheet.getByLabel('Choice 1 button text').fill('Force it');
  await sheet.getByLabel('Force it what happens: result text').fill('It gives.');
  await sheet.getByRole('button', { name: 'Force it what happens: add lose health' }).click();
  await sheet.getByRole('button', { name: 'Force it what happens: add remember' }).click();
  await sheet.getByLabel('Force it what happens: effect 2 name').fill('Vault opened');
  // A second choice with a skill check, written in percentages.
  await sheet.getByRole('button', { name: '+ Add choice' }).click();
  await sheet.getByLabel('Choice 2 button text').fill('Work the lock');
  await sheet.getByLabel('Choice 2 result kind').selectOption('check');
  await sheet.getByLabel('Choice 2 chance for an average Buddy').fill('55');
  // The engine's own curve: 55% for an average Buddy, 40% for the weakest, 70% for the strongest.
  await expect(sheet.getByTestId('check-range')).toHaveText(
    'Weakest Buddy 40% · average 55% · strongest 70%',
  );
  await sheet.getByLabel('Work the lock on failure: result text').fill('It jams.');
  await sheet.getByLabel('Work the lock on failure: mood').selectOption('bad');
  await expect(sheet).not.toContainText(/basis points/i);
  // The preview shows both buttons as players will, with the chance on the checked one.
  await expect(sheet.getByTestId('preview-button')).toHaveText(['Force it', 'Work the lock (55%)']);
  await page.getByRole('button', { name: 'Close event' }).click();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(1);
  const saved = backend.detail.draft;
  expect(await errorsOf(saved)).toEqual([]);
  expect(saved.events).toHaveLength(1);
  const event = saved.events![0]!;
  expect(event).toMatchObject({
    title: 'The Sealed Vault',
    text: 'A blast door fills the corridor.',
  });
  expect(event.choices.map((c) => c.label)).toEqual(['Force it', 'Work the lock']);
  expect(event.choices[0]!.outcome).toMatchObject({
    text: 'It gives.',
    effects: [
      { type: 'damage', basisPoints: 2500 },
      { type: 'set_flag', flag: saved.flags[0]!.key, value: true },
    ],
  });
  expect(event.choices[1]).toMatchObject({
    check: { type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 },
    failure: { text: 'It jams.', tone: 'bad' },
  });
  expect(saved.flags[0]).toMatchObject({ scope: 'run', description: 'Vault opened' });
  expect(saved.rooms.find((r) => r.id === 'entrance')!.actions).toMatchObject([
    { type: 'event', source: { kind: 'event', eventId: event.id } },
  ]);

  // Reloaded from what was stored: the room shows it, the editor holds it, nothing to save.
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  await expect(
    page.getByRole('button', { name: /^Activity 1: Event\. “The Sealed Vault” — 2 choices/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Room event: edit event' }).click();
  await expect(sheet.getByLabel('Event title')).toHaveValue('The Sealed Vault');
  await sheet.getByRole('button', { name: /^Choice 2: Work the lock/ }).click();
  await expect(sheet.getByLabel('Work the lock on failure: result text')).toHaveValue('It jams.');
  await page.getByRole('button', { name: 'Close event' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  expect(backend.detail.draft).toEqual(saved);
});

test('an author creates a random pool from a room and sees the engine’s odds, base and for a situation', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  const original = eventDungeon();
  const backend = await open(page, original);
  await library(page).getByRole('button', { name: 'Edit pool Scrapheap finds' }).click();
  const sheet = page.getByTestId('event-pool-editor');
  // Shares of 1 and 3.
  await expect(sheet.getByTestId('pool-base-odds').getByTestId('pool-odds-row')).toHaveText([
    'A Buried Crate25%about 1 in 4',
    'Nothing happens75%about 1 in 1.3',
  ]);
  // A third entry: the vault, twice as likely, only while it has not been opened.
  await sheet.getByRole('button', { name: '+ Add event' }).click();
  await expect(sheet.getByLabel('Entry 3: what happens')).toHaveValue('sealed_vault');
  await sheet.getByLabel('Entry 3 share').fill('4');
  await sheet.getByRole('button', { name: 'Entry 3: add a rule' }).click();
  await sheet.getByLabel('Entry 3 is in the draw type').selectOption('flag');
  await sheet.getByLabel('Entry 3 is in the draw equals').selectOption('false');
  await expect(sheet.getByTestId('pool-base-odds').getByTestId('pool-odds-row')).toHaveText([
    'A Buried Crate12.5%about 1 in 8',
    'Nothing happens37.5%about 1 in 2.7',
    'The Sealed Vault50%about 1 in 2',
  ]);
  // Try a situation: the vault already opened, the crate already met.
  const situation = sheet.getByTestId('event-scenario');
  const scenario = sheet.getByTestId('pool-scenario-odds').getByTestId('pool-odds-row');
  await situation.getByLabel('Vault opened').check();
  await expect(scenario).toHaveText([
    'A Buried Crate25%about 1 in 4',
    'Nothing happens75%about 1 in 1.3',
    'The Sealed VaultNot in the draw: its rule is not met',
  ]);
  await situation.getByLabel('A Buried Crate').check();
  await expect(scenario).toHaveText([
    'A Buried CrateNot in the draw: already met this run',
    'Nothing happens100%',
    'The Sealed VaultNot in the draw: its rule is not met',
  ]);
  // Without its Nothing entry the same situation leaves nothing to draw, and the editor says what that means.
  await sheet.getByRole('button', { name: 'Remove entry 2' }).click();
  await expect(sheet.getByTestId('pool-scenario-odds').getByTestId('pool-empty')).toContainText(
    'No entry is in the draw, so this pool results in Nothing',
  );
  await expect(sheet.getByTestId('pool-base-odds').getByTestId('pool-empty')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close random pool' }).click();

  // The validator's warning about exactly this is in the checklist, and leads back to the pool.
  const warning = 'Random pool “Scrapheap finds” can run out of entries.';
  await page.getByRole('button', { name: `Show me: ${warning}` }).click();
  await expect(sheet).toContainText(warning);
  await page.getByRole('button', { name: 'Close random pool' }).click();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(1);
  const saved = backend.detail.draft;
  expect(await errorsOf(saved)).toEqual([]);
  expect(saved.eventPools![0]!.entries).toMatchObject([
    { id: 'e_crate', weight: 1, eventId: 'buried_crate', oncePerRun: true },
    {
      weight: 4,
      eventId: 'sealed_vault',
      oncePerRun: true,
      when: { type: 'flag', flag: 'vault_opened', scope: 'run', equals: false },
    },
  ]);
  // The events themselves, and the rooms that use them, were not touched.
  expect(saved.events).toEqual((await stored(original)).events);
  expect(saved.rooms).toEqual((await stored(original)).rooms);
});

test('the checklist names an event’s problem and “Show me” opens its editor on the choice', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  const backend = await open(page, eventDungeon());
  // Give the crate's only choice a rule: now nobody is sure of a way through it.
  await library(page).getByRole('button', { name: 'Edit event A Buried Crate' }).click();
  const sheet = page.getByTestId('event-editor');
  await sheet.getByLabel('Choice 1 is available type').selectOption('flag');
  await expect(sheet.getByTestId('no-open-choice')).toBeVisible();
  await page.getByRole('button', { name: 'Close event' }).click();
  const problem = 'Event “A Buried Crate” needs a choice everyone can pick.';
  // Two things follow from it: the event itself, and the start room that can draw it.
  await expect(page.getByRole('button', { name: 'Checklist: 2 to fix. Show it' })).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Show me: Entrance: the event “A Buried Crate” can appear here, where players can’t turn back.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
  await page.getByRole('button', { name: `Show me: ${problem}` }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'To do in this event' })).toContainText(problem);
  // Repair it where the checklist led, and the problem is gone without leaving the editor.
  await sheet.getByLabel('Choice 1 is available type').selectOption('none');
  await page.getByRole('button', { name: 'Close event' }).click();
  await expect(page.getByRole('button', { name: `Show me: ${problem}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  expect(backend.saves).toBe(0);
});

test('the library refuses to delete an event that is used, and deletes a copy that is not', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  const original = eventDungeon();
  const backend = await open(page, original);
  await library(page).getByRole('button', { name: 'Delete event A Buried Crate' }).click();
  await expect(page.getByTestId('delete-blockers')).toHaveText(
    'The random pool Scrapheap finds lists it: remove its entry there.',
  );
  await expect(page.getByRole('button', { name: 'Delete event', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await library(page).getByRole('button', { name: 'Duplicate event A Buried Crate' }).click();
  await expect(library(page).getByTestId('event-row')).toHaveText([
    /The Sealed Vault.*Used in Entrance/,
    /A Buried Crate.*Used in Scrapheap finds \(random pool\)/,
    /A Buried Crate \(copy\).*Not used yet/,
  ]);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(1);
  expect(backend.detail.draft.events!.map((e) => e.title)).toEqual([
    'The Sealed Vault',
    'A Buried Crate',
    'A Buried Crate (copy)',
  ]);
  await library(page).getByRole('button', { name: 'Delete event A Buried Crate (copy)' }).click();
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(2);
  expect(backend.detail.draft.events).toEqual((await stored(original)).events);
});

// Run at desktop and at the 375px baseline.
test('an author plays the draft’s events in the sandbox, and nothing is given, used or saved', async ({
  page,
}) => {
  const backend = await open(page, eventDungeon());
  await library(page).getByRole('button', { name: 'Play the dungeon' }).click();
  const play = page.getByTestId('dungeon-sandbox');
  await expect(play.getByTestId('sandbox-safe')).toContainText(
    'no reward is given, no item is used up, and no run is saved',
  );
  await expect(play.getByTestId('sandbox-room')).toHaveText('Entrance');
  // The entrance first draws from the pool: the crate, or nothing. Either way the vault follows.
  const event = play.getByTestId('sandbox-event');
  const dig = event.getByRole('button', { name: 'Dig it out' });
  await expect(event.getByRole('button', { name: /^(Dig it out|Force it)$/ })).toBeVisible();
  if (await dig.isVisible()) await dig.click();
  await expect(event).toContainText('The Sealed Vault');
  await expect(event.getByRole('button', { name: 'Work the lock (55%)' })).toBeEnabled();
  // A stronger pretend Buddy changes the chance on the button.
  await play.getByLabel('Buddy strength').selectOption('350');
  await expect(event.getByRole('button', { name: 'Work the lock (70%)' })).toBeEnabled();
  await event.getByRole('button', { name: 'Force it' }).click();
  await expect(play.getByTestId('sandbox-results')).toContainText(
    'The Sealed Vault — Force it It gives.',
  );
  await expect(play).toContainText('Remembers: Vault opened');
  await expect(play.getByTestId('sandbox-would')).toContainText('given and used nothing');
  // The room is done; the way out is offered, and taking it ends the run.
  await play.getByRole('button', { name: 'Go to Way Out' }).click();
  await expect(play.getByTestId('sandbox-ended')).toHaveText('The dungeon was completed.');
  // Start again plays the same run the same way.
  await play.getByRole('button', { name: 'Start again' }).click();
  await expect(play.getByTestId('sandbox-room')).toHaveText('Entrance');
  // The dialog fits the screen it is on.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Close test play' }).click();

  expect(backend.sandboxRuns).toBeGreaterThan(3);
  expect(backend.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  expect(backend.detail.draft).toEqual(eventDungeon());
});

test('the event and pool editors fit a narrow screen', async ({ page }) => {
  await open(page, eventDungeon());
  const fits = async (testId: string) => {
    const box = (await page.getByTestId(testId).boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    // Nothing inside pushes the sheet wider than itself.
    const spill = await page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill).toBeLessThanOrEqual(1);
  };
  await library(page).getByRole('button', { name: 'Edit event The Sealed Vault' }).click();
  const sheet = page.getByTestId('event-editor');
  await sheet.getByRole('button', { name: /^Choice 1: Work the lock/ }).click();
  await expect(sheet.getByTestId('check-range')).toContainText('Weakest Buddy 40%');
  await expect(sheet.getByTestId('preview-button')).toHaveText(['Work the lock (55%)', 'Force it']);
  await fits('event-editor');
  await page.getByRole('button', { name: 'Close event' }).click();

  await library(page).getByRole('button', { name: 'Edit pool Scrapheap finds' }).click();
  await expect(page.getByTestId('pool-base-odds')).toBeVisible();
  await fits('event-pool-editor');
  await page.getByRole('button', { name: 'Close random pool' }).click();
});

test('a reader can look at events, try a situation and play, and cannot change them', async ({
  page,
}) => {
  const backend = await open(page, eventDungeon(), ['dungeons.read']);
  await expect(library(page).getByRole('button', { name: '+ New event' })).toHaveCount(0);
  await expect(library(page).getByRole('button', { name: /^(Delete|Duplicate)/ })).toHaveCount(0);
  await library(page).getByRole('button', { name: 'View event The Sealed Vault' }).click();
  const sheet = page.getByTestId('event-editor');
  await expect(sheet.getByLabel('Event title')).toBeDisabled();
  await expect(sheet.getByLabel('Event story')).toBeDisabled();
  await expect(sheet.getByRole('button', { name: '+ Add choice' })).toHaveCount(0);
  await sheet.getByRole('button', { name: /^Choice 1: Work the lock/ }).click();
  await expect(sheet.getByLabel('Choice 1 button text')).toBeDisabled();
  await expect(sheet.getByLabel('Choice 1 result kind')).toBeDisabled();
  // Looking is allowed: the preview answers for whatever situation is tried.
  await sheet.getByTestId('event-scenario').getByLabel('Buddy strength').selectOption('50');
  await expect(sheet.getByTestId('preview-button').first()).toHaveText('Work the lock (40%)');
  await page.getByRole('button', { name: 'Close event' }).click();
  await library(page).getByRole('button', { name: 'Play the dungeon' }).click();
  await expect(page.getByTestId('sandbox-room')).toHaveText('Entrance');
  await page.getByRole('button', { name: 'Close test play' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  expect(backend.saves).toBe(0);
});
