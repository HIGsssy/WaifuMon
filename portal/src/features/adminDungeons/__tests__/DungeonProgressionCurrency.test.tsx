import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { bundleIssueText } from '@/features/adminDungeonLoot/bundleModel';
import { rewardNames } from '@/features/adminDungeonLoot/lootModel';
import { friendlyIssue } from '../dungeonText';
import { fixture, install, reference, renderAt } from './dungeonFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());

const currencies: api.DungeonReferenceData['currencies'] = [
  {
    key: 'ascension_currency',
    singularName: 'Baddie Shard',
    pluralName: 'Baddie Shards',
    enabled: true,
  },
  { key: 'retired_currency', singularName: 'Old Token', pluralName: 'Old Tokens', enabled: false },
];
const missing: api.DungeonIssue = {
  code: 'reward_shards_unset',
  severity: 'error',
  path: 'rooms[0].actions[0].rewards.tables[0].body.guaranteed[0].grant',
  message:
    'Room "Entrance", activity "fight", loot table "Basic run", reward "shards": this dungeon has no Baddie Shard currency set, so it cannot pay Shards.',
};
const brokenItem = {
  ...missing,
  code: 'reward_item_disabled',
  message:
    'Room "Entrance", activity "fight", loot table "Basic run", reward "item": "Old Token" is disabled. Enable it or pick another item.',
};
const definition = (): api.DungeonDefinition => ({
  ...fixture().draft,
  settings: {
    progressionCurrency: null,
    defeatCurrencyRetentionBasisPoints: 5000,
    abandonCurrencyRetentionBasisPoints: 0,
  },
  rooms: [
    {
      ...fixture().draft.rooms[0]!,
      actions: [
        {
          id: 'fight',
          type: 'combat',
          label: '',
          optional: false,
          outcomes: {},
          advance: 'confirm',
          waves: [{ enemy: { key: 'golem' } }],
          rewards: {
            guaranteed: [],
            chances: [],
            tables: [{ id: 'basic', table: 'basic_run', draws: 2 }],
          },
        },
      ],
    },
  ],
});
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  world.stored = { ...fixture(), draft: definition(), issues: [missing] };
  vi.mocked(api.getDungeonReference).mockResolvedValue({
    ...reference,
    currencies,
    lootTables: [
      { key: 'basic_run', name: 'Basic run', tier: null, archived: false, contentHash: 'hash' },
    ],
  });
  vi.mocked(api.validateDungeon).mockImplementation(async (draft) => ({
    definition: draft,
    contentHash: 'hash',
    issues: draft.settings.progressionCurrency ? [] : [missing],
    publishable: draft.settings.progressionCurrency !== null,
  }));
  const save = vi.mocked(api.saveDungeonDraft).getMockImplementation()!;
  vi.mocked(api.saveDungeonDraft).mockImplementation(async (...args) => {
    const saved = await save(...args);
    world.stored = { ...saved, issues: saved.draft.settings.progressionCurrency ? [] : [missing] };
    return structuredClone(world.stored);
  });
});

it('changes an existing None draft, validates immediately, saves/reloads and preserves publication and other content', async () => {
  const initial = structuredClone(world.stored);
  const user = userEvent.setup();
  const page = renderAt();
  const field = await screen.findByLabelText('Progression currency');
  await waitFor(() => expect(field).toBeEnabled());
  expect(field).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
  await user.selectOptions(field, 'ascension_currency');
  // The selection itself asks the server; no Save/Check again is needed.
  expect(api.validateDungeon).toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.queryByText('Dungeon progression currency needs attention.'),
    ).not.toBeInTheDocument(),
  );
  expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  expect(api.publishDungeon).not.toHaveBeenCalled();
  expect(world.stored).toEqual(initial);
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft saved. Publication is unchanged.');
  expect(world.stored.draft).toEqual({
    ...initial.draft,
    settings: { ...initial.draft.settings, progressionCurrency: 'ascension_currency' },
  });
  expect(world.stored.layout).toEqual(initial.layout);
  expect(world.stored.published).toEqual(initial.published);
  expect(vi.mocked(api.saveDungeonDraft).mock.lastCall![1].expectedRevision).toBe(
    initial.draftRevision,
  );
  expect(api.publishDungeon).not.toHaveBeenCalled();
  page.unmount();
  renderAt();
  expect(await screen.findByLabelText('Progression currency')).toHaveValue('ascension_currency');
  expect(
    screen.queryByText('Dungeon progression currency needs attention.'),
  ).not.toBeInTheDocument();
});

it('the Shard checklist action opens Dungeon Settings and focuses the selector from a room', async () => {
  const user = userEvent.setup();
  renderAt();
  await user.click(await screen.findByRole('button', { name: 'Canvas room Entrance' }));
  expect(screen.queryByLabelText('Progression currency')).not.toBeInTheDocument();
  const navigation = screen.getByRole('button', {
    name: 'Show me: Dungeon progression currency needs attention.',
  });
  expect(navigation).toHaveTextContent('Dungeon settings');
  await user.click(navigation);
  const field = await screen.findByLabelText('Progression currency');
  expect(field).toHaveFocus();
  expect(screen.getByLabelText('Map inspector')).not.toHaveTextContent('Open the table to fix it');
});

it('read-only authors can inspect the setting but cannot change or save it', async () => {
  const user = userEvent.setup();
  renderAt(undefined, ['dungeons.read']);
  const field = await screen.findByLabelText('Progression currency');
  expect(field).toBeDisabled();
  await within(field).findByRole('option', { name: 'Baddie Shards' });
  await user.selectOptions(field, 'ascension_currency');
  expect(field).toHaveValue('');
  expect(api.validateDungeon).not.toHaveBeenCalled();
  expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
});

it.each(['retired_currency', 'unknown_currency'])(
  'preserves unavailable stored currency %s until explicitly replaced',
  async (key) => {
    world.stored.draft.settings.progressionCurrency = key;
    const user = userEvent.setup();
    renderAt();
    const field = await screen.findByLabelText('Progression currency');
    await waitFor(() => expect(field).toBeEnabled());
    expect(field).toHaveValue(key);
    expect(
      within(field).getByRole('option', {
        name:
          key === 'retired_currency' ? 'Old Tokens (disabled)' : 'unknown_currency (unavailable)',
      }),
    ).toBeDisabled();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    await user.selectOptions(field, 'ascension_currency');
    expect(field).toHaveValue('ascension_currency');
  },
);

it('genuine transitive loot errors still identify the table and navigate to its activity', () => {
  const draft = definition();
  const refs = [{ key: 'basic_run', name: 'Basic run' }];
  const text = bundleIssueText(
    brokenItem,
    draft.rooms[0]!.actions[0]!.rewards!,
    rewardNames([]),
    [],
    refs,
  );
  expect(text.text).toContain('Open the table to fix it.');
  const friendly = friendlyIssue(brokenItem, draft, {
    ...reference,
    lootTables: [{ ...refs[0]!, tier: null, archived: false, contentHash: 'hash' }],
  });
  expect(friendly).toMatchObject({ target: { kind: 'room', id: 'entrance' }, actionId: 'fight' });
  expect(friendly.settingsField).toBeUndefined();
  const shard = bundleIssueText(
    missing,
    draft.rooms[0]!.actions[0]!.rewards!,
    rewardNames([]),
    [],
    refs,
  );
  expect(shard.text).toContain('Dungeon Settings');
  expect(shard.text).not.toContain('Open the table');
});

it.each([null, 'ascension_currency'])(
  'new drafts explicitly keep the selected currency %s without changing the None default',
  async (currency) => {
    const user = userEvent.setup();
    renderAt('/admin/dungeons/new');
    const field = await screen.findByLabelText('Progression currency');
    await waitFor(() => expect(field).toBeEnabled());
    expect(field).toHaveValue('');
    await user.type(screen.getByLabelText('Dungeon name'), 'New dungeon');
    await user.click(screen.getByRole('checkbox', { name: 'Waifu Valley' }));
    if (currency) await user.selectOptions(field, currency);
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(api.createDungeon).toHaveBeenCalled());
    expect(vi.mocked(api.createDungeon).mock.lastCall![0].settings).toEqual({
      progressionCurrency: currency,
      defeatCurrencyRetentionBasisPoints: 5000,
      abandonCurrencyRetentionBasisPoints: 0,
    });
  },
);
