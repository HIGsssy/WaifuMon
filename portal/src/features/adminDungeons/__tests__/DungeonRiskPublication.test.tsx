import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as loot from '@/api/adminDungeonLootTables';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { ITEMS, install as installLoot } from '@/features/adminDungeonLoot/__tests__/lootFixtures';
import { fixture, install, reference, renderAt } from './dungeonFixtures';

// jsdom cannot lay out the canvas; rooms are picked from a plain list instead.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: ({
      nodes,
      onNodeClick,
    }: {
      nodes: Array<{ id: string }>;
      onNodeClick: (e: null, n: { id: string }) => void;
    }) => (
      <div>
        {nodes.map((n) => (
          <button key={n.id} onClick={() => onNodeClick(null, n)}>
            Canvas room {n.id}
          </button>
        ))}
      </div>
    ),
  };
});

let dungeon: ReturnType<typeof install>;
let catalogue: ReturnType<typeof installLoot>;
beforeEach(() => {
  dungeon = install();
  catalogue = installLoot();
  stubObjectUrls();
  vi.mocked(api.getDungeonReference).mockImplementation(async () => ({
    ...reference,
    items: ITEMS,
    lootTables: catalogue.tables.map((t) => ({
      key: t.key,
      name: t.name,
      tier: t.tier,
      archived: t.archivedAt !== null,
      contentHash: t.contentHash,
    })),
  }));
});

type Settings = api.DungeonDefinition['settings'];
const LEGACY_RISK: Settings = {
  progressionCurrency: null,
  defeatCurrencyRetentionBasisPoints: 5000,
};
const withSettings = (settings: Settings): api.DungeonDefinition => ({
  ...fixture().draft,
  settings,
});

async function open(patch: Partial<api.DungeonDetail> = {}, permissions?: string[]) {
  dungeon.stored = { ...fixture(), ...patch };
  renderAt('/admin/dungeons/definitions/tunnels', permissions);
  await screen.findByLabelText('Dungeon name');
  return userEvent.setup();
}
const risk = () => within(screen.getByTestId('currency-risk'));
const defeat = () => risk().getByLabelText('If the player is defeated');
const abandon = () => risk().getByLabelText('If the player abandons the run');
async function savedSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
  return vi.mocked(api.saveDungeonDraft).mock.lastCall![1].definition!.settings;
}

describe('Currency Risk', () => {
  it('creates a new dungeon with 50% on defeat and 0% on abandoning written out', async () => {
    renderAt('/admin/dungeons/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Dungeon name'), 'Deep Vault');
    await user.click(await screen.findByLabelText('Waifu Valley'));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(api.createDungeon).toHaveBeenCalled());
    expect(vi.mocked(api.createDungeon).mock.lastCall![0].settings).toStrictEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 5000,
      abandonCurrencyRetentionBasisPoints: 0,
    });
  });

  it('shows the stored settings of an existing dungeon, in percent and never basis points', async () => {
    await open({
      draft: withSettings({
        progressionCurrency: null,
        defeatCurrencyRetentionBasisPoints: 2550,
        abandonCurrencyRetentionBasisPoints: 10000,
      }),
    });
    expect(within(defeat()).getByRole('option', { selected: true })).toHaveTextContent(
      'Custom: Keep 25.5%',
    );
    expect(within(abandon()).getByRole('option', { selected: true })).toHaveTextContent(
      'Keep everything (100%)',
    );
    // A custom value opens the percentages without being asked.
    expect(risk().getByLabelText('Kept on defeat')).toHaveValue('25.5');
    const explanation = screen.getByTestId('risk-explanation');
    expect(explanation).toHaveTextContent('Finishing the dungeon or extracting always keeps 100%.');
    expect(explanation).toHaveTextContent('Being defeated keeps 25.5%.');
    expect(explanation).toHaveTextContent('Abandoning the run keeps 100%.');
    expect(explanation).toHaveTextContent(
      'Equipment, items, charms, salvage, Essence and affection are always kept.',
    );
    expect(explanation).toHaveTextContent('Only currency earned during that run is at risk.');
    expect(screen.getByTestId('currency-risk')).not.toHaveTextContent(/basis|2550|10000/i);
  });

  it('shows abandoning following defeat when no separate setting is stored, and saves without adding one', async () => {
    const user = await open({ draft: withSettings(LEGACY_RISK) });
    expect(within(abandon()).getByRole('option', { selected: true })).toHaveTextContent(
      'Same as defeat: Keep half (50%)',
    );
    expect(screen.getByTestId('risk-abandon-fallback')).toHaveTextContent(
      'abandoning keeps what defeat keeps: 50%',
    );
    expect(screen.getByTestId('risk-explanation')).toHaveTextContent(
      'Abandoning the run keeps 50%.',
    );
    expect(screen.queryByTestId('risk-warning')).not.toBeInTheDocument();
    // Nothing is dirty just from opening it.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();

    // An unrelated edit, saved: the settings go back exactly as stored.
    await user.type(screen.getByLabelText('Dungeon description'), 'Dusty.');
    expect(await savedSettings(user)).toStrictEqual(LEGACY_RISK);

    // Changing only the defeat rate still leaves abandoning to follow it.
    await user.selectOptions(defeat(), 'Keep nothing (0%)');
    expect(screen.getByTestId('risk-explanation')).toHaveTextContent(
      'Abandoning the run keeps 0%.',
    );
    expect(await savedSettings(user)).toStrictEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 0,
    });
  });

  it('stores presets and custom percentages as chosen, and holds back an unusable percentage', async () => {
    const user = await open({ draft: withSettings(LEGACY_RISK) });
    await user.selectOptions(defeat(), 'Keep everything (100%)');
    await user.selectOptions(abandon(), 'Keep half (50%)');
    expect(screen.queryByTestId('risk-abandon-fallback')).not.toBeInTheDocument();
    expect(await savedSettings(user)).toStrictEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 10000,
      abandonCurrencyRetentionBasisPoints: 5000,
    });

    await user.click(risk().getByRole('button', { name: /Advanced: custom percentages/ }));
    const custom = risk().getByLabelText('Kept on abandoning');
    await user.clear(custom);
    await user.type(custom, '12.5');
    expect(within(abandon()).getByRole('option', { selected: true })).toHaveTextContent(
      'Custom: Keep 12.5%',
    );
    expect((await savedSettings(user)).abandonCurrencyRetentionBasisPoints).toBe(1250);

    // 150% is explained and never reaches the draft.
    const kept = risk().getByLabelText('Kept on defeat');
    await user.clear(kept);
    await user.type(kept, '150');
    expect(risk().getByRole('alert')).toHaveTextContent(
      'A player cannot keep more than 100%. The dungeon still says 15%.',
    );
    await user.clear(kept);
    await user.type(kept, '80');
    expect((await savedSettings(user)).defeatCurrencyRetentionBasisPoints).toBe(8000);

    // Abandoning can always go back to following defeat, which removes its own setting.
    await user.selectOptions(abandon(), 'Same as defeat: Keep 80%');
    expect(await savedSettings(user)).toStrictEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 8000,
    });
  });

  it('warns, without blocking, when abandoning keeps more than defeat', async () => {
    const user = await open({ draft: withSettings(LEGACY_RISK) });
    await user.selectOptions(abandon(), 'Keep everything (100%)');
    expect(screen.getByTestId('risk-warning')).toHaveTextContent(
      'Abandoning keeps more than being defeated',
    );
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await user.selectOptions(defeat(), 'Keep everything (100%)');
    expect(screen.queryByTestId('risk-warning')).not.toBeInTheDocument();
  });

  it('is visible but locked for a reader', async () => {
    await open({ draft: withSettings(LEGACY_RISK) }, ['dungeons.read']);
    expect(defeat()).toBeDisabled();
    expect(abandon()).toBeDisabled();
    expect(screen.getByTestId('risk-explanation')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish draft' })).not.toBeInTheDocument();
    expect(screen.getByTestId('publication-state')).toBeVisible();
  });
});

const HOARD_CHANGED: api.DungeonRewardDependencyChange = {
  kind: 'table',
  tableKey: 'scrapheap_boss_hoard',
  name: 'Scrapheap Boss Hoard',
  status: 'changed',
  publishedHash: 'sha256:aaa',
  currentHash: 'sha256:bbb',
};
const state = () => screen.getByTestId('publication-state');
const details = () => screen.getByTestId('publication-details');

describe('publication status', () => {
  it('says Loot changed when only a loot table changed, never that the draft matches', async () => {
    await open({
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [HOARD_CHANGED],
    });
    expect(state()).toHaveTextContent('Loot changed');
    expect(screen.queryByText(/matches publication/i)).not.toBeInTheDocument();
    expect(details()).toHaveTextContent(
      'The dungeon itself is as published, but the loot it uses has changed.',
    );
    const line = within(details()).getByText(
      'Loot table “Scrapheap Boss Hoard” gives different rewards now.',
    );
    // Keys and hashes stay in the hover title.
    expect(line).toHaveAttribute('title', expect.stringContaining('scrapheap_boss_hoard'));
    expect(details()).not.toHaveTextContent(/sha256|scrapheap_boss_hoard/);
  });

  it('tells a matching draft, a changed dungeon and unsaved edits apart', async () => {
    const user = await open({
      draftDiffers: false,
      dependenciesDiffer: false,
      dependencyChanges: [],
    });
    expect(state()).toHaveTextContent('Matches publication');
    expect(screen.queryByTestId('loot-changes')).not.toBeInTheDocument();
    // An edit that is not saved yet is already a change to the dungeon.
    await user.type(screen.getByLabelText('Dungeon description'), 'x');
    expect(state()).toHaveTextContent('Dungeon changed');
  });

  it('reports a saved definition change on its own', async () => {
    await open({ draftDiffers: true, dependenciesDiffer: false, dependencyChanges: [] });
    expect(state()).toHaveTextContent('Dungeon changed');
    expect(details()).toHaveTextContent('The dungeon itself has changed since it was published.');
  });

  it('distinguishes a change to both the dungeon and its loot', async () => {
    await open({
      draftDiffers: true,
      dependenciesDiffer: false,
      dependencyChanges: [HOARD_CHANGED],
    });
    expect(state()).toHaveTextContent('Dungeon and loot changed');
    expect(details()).toHaveTextContent(
      'Both the dungeon itself and the loot it uses have changed',
    );
  });

  it('explains deleted, archived and unreadable tables and gear changes in plain words', async () => {
    await open({
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [
        { ...HOARD_CHANGED, tableKey: 'gone', name: 'Lost Cache', status: 'missing' },
        { ...HOARD_CHANGED, tableKey: 'old', name: 'Old Stash', status: 'archived' },
        { ...HOARD_CHANGED, tableKey: 'bad', name: 'Garbled', status: 'invalid' },
        {
          kind: 'equipment',
          selectorKey: 'sel:r:attack',
          description: 'Any R Attack Equipment',
          status: 'changed',
          added: ['iron_blade', 'tin_blade'],
          removed: ['rust_blade'],
        },
        {
          kind: 'equipment',
          selectorKey: 'sel:sr:charm',
          description: 'Any SR Charm Equipment',
          status: 'empty',
          added: [],
          removed: ['gold_charm'],
        },
      ],
    });
    expect(state()).toHaveTextContent('Loot needs repair');
    const list = within(details());
    expect(
      list.getByText(
        'Loot table “Lost Cache” was deleted. Remove it from the dungeon or pick another table.',
      ),
    ).toBeVisible();
    expect(
      list.getByText('Loot table “Old Stash” is archived. Restore it or pick another table.'),
    ).toBeVisible();
    expect(list.getByText(/Loot table “Garbled” can no longer be read/)).toBeVisible();
    expect(
      list.getByText(
        'Any R Attack Equipment: 2 more pieces can drop now and 1 piece can no longer drop.',
      ),
    ).toHaveAttribute('title', 'added: iron_blade, tin_blade · removed: rust_blade');
    expect(
      list.getByText(/Any SR Charm Equipment: no gear matches this choice any more/),
    ).toBeVisible();
    expect(details()).not.toHaveTextContent(/iron_blade|sel:r/);
  });

  it('shows the same status on the dungeon list', async () => {
    dungeon.stored = {
      ...fixture(),
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [HOARD_CHANGED],
    };
    renderAt('/admin/dungeons');
    expect(await screen.findByTestId('publication-state-tunnels')).toHaveTextContent(
      'Loot changed',
    );
    expect(screen.getByTestId('loot-changes-tunnels')).toHaveTextContent(
      'Loot table “Scrapheap Boss Hoard” gives different rewards now.',
    );
    expect(screen.queryByText('Draft matches publication')).not.toBeInTheDocument();
  });
});

describe('publish confirmation', () => {
  it('says a loot-only publication changes loot, lists it, and publishes only when confirmed', async () => {
    const user = await open({
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [HOARD_CHANGED],
    });
    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByTestId('publish-explanation')).toHaveTextContent(
      'The dungeon itself has not changed. This publishes changes to the loot it uses:',
    );
    expect(
      dialog.getByText('Loot table “Scrapheap Boss Hoard” gives different rewards now.'),
    ).toBeVisible();
    expect(dialog.getByText(/freezes it into a new revision that never changes/)).toBeVisible();
    expect(api.publishDungeon).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.publishDungeon).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    await user.click(await screen.findByRole('button', { name: 'Publish now' }));
    expect(await screen.findByText('Published revision 3.')).toBeInTheDocument();
    expect(api.publishDungeon).toHaveBeenCalledWith('tunnels', 4);
  });

  it.each([
    [
      { draftDiffers: true, dependencyChanges: [] },
      'This publishes your changes to the dungeon itself. The shared loot it uses has not changed.',
    ],
    [
      { draftDiffers: true, dependencyChanges: [HOARD_CHANGED] },
      'This publishes your changes to the dungeon itself, and changes to the loot it uses:',
    ],
    [
      { draftDiffers: false, dependencyChanges: [] },
      'Nothing has changed since the last publication, so no new revision will be made.',
    ],
    [{ published: null, draftDiffers: true }, 'This is the first publication of this dungeon.'],
  ] as Array<[Partial<api.DungeonDetail>, string]>)('describes %j', async (patch, text) => {
    const user = await open(patch);
    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    expect(await screen.findByTestId('publish-explanation')).toHaveTextContent(text);
  });
});

const hoardRef = { id: 't_hoard', table: 'scrapheap_boss_hoard', draws: 1 };
function bossDungeon(): api.DungeonDefinition {
  return {
    ...fixture().draft,
    rooms: [
      {
        id: 'entrance',
        name: 'Vault',
        extraction: true,
        actions: [
          {
            id: 'a_boss',
            type: 'boss',
            label: '',
            optional: false,
            outcomes: {},
            advance: 'confirm',
            waves: [{ enemy: { key: 'golem' } }],
            rewards: { guaranteed: [], chances: [], tables: [hoardRef] },
          },
        ],
      },
    ],
  };
}
const BROKEN_TABLE: api.DungeonIssue = {
  code: 'reward_item_disabled',
  severity: 'error',
  path: 'rooms[0].actions[0].rewards.tables[0].body.guaranteed[0].grant',
  message:
    'Room "Vault", activity "a_boss", loot table "Scrapheap Boss Hoard", reward "scrap": "Old Token" is disabled. Enable it or pick another item.',
};
const report = (definition: api.DungeonDefinition, issues: api.DungeonIssue[]) => ({
  definition,
  contentHash: 'hash',
  issues,
  publishable: issues.length === 0,
});
const checklist = (text: string) =>
  screen.findByRole('button', { name: `Checklist: ${text}. Show it` });

/** Opens the boss, then its loot table beside it, and edits the table so it can be saved. */
async function tableOpened(detail: Partial<api.DungeonDetail>) {
  dungeon.stored = { ...fixture(), draftDiffers: false, draft: bossDungeon(), ...detail };
  renderAt();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Canvas room entrance' }));
  // The room's only activity opens by itself.
  await screen.findByLabelText('Times Scrapheap Boss Hoard is rolled');
  const editTable = async () => {
    await user.click(screen.getByRole('button', { name: 'Open table Scrapheap Boss Hoard' }));
    const sheet = within(await screen.findByTestId('loot-table-sheet'));
    await user.type(await sheet.findByLabelText('Description'), ' Retuned.');
    return sheet;
  };
  const saveTable = async (sheet: Awaited<ReturnType<typeof editTable>>) => {
    await user.click(sheet.getByRole('button', { name: 'Save table' }));
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Close loot table' }));
    await waitFor(() => expect(screen.queryByTestId('loot-table-sheet')).not.toBeInTheDocument());
  };
  return { user, editTable, saveTable };
}

describe('saving a loot table beside the dungeon', () => {
  it('re-checks the dungeon, clears the repaired issue and shows Loot changed, with no dungeon edit', async () => {
    let repaired = false;
    vi.mocked(api.validateDungeon).mockImplementation(async (definition) =>
      report(definition, repaired ? [] : [BROKEN_TABLE]),
    );
    const { editTable, saveTable } = await tableOpened({ issues: [BROKEN_TABLE] });
    expect(await checklist('1 to fix')).toBeVisible();
    expect(state()).toHaveTextContent('Matches publication');
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
    expect(api.validateDungeon).not.toHaveBeenCalled();

    const sheet = await editTable();
    // What the server will say once the table is saved.
    repaired = true;
    dungeon.stored = {
      ...dungeon.stored,
      issues: [],
      dependenciesDiffer: true,
      dependencyChanges: [HOARD_CHANGED],
    };
    const references = vi.mocked(api.getDungeonReference).mock.calls.length;
    await saveTable(sheet);

    expect(await checklist('Nothing to fix')).toBeVisible();
    expect(api.validateDungeon).toHaveBeenCalledWith(bossDungeon(), undefined);
    await waitFor(() => expect(state()).toHaveTextContent('Loot changed'));
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeEnabled();
    // The names and archived flags the editor lists are read again too.
    await waitFor(() =>
      expect(vi.mocked(api.getDungeonReference).mock.calls.length).toBeGreaterThan(references),
    );
    // Nothing was saved or published to get there, and the author is where they were.
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    expect(api.publishDungeon).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled')).toBeVisible();
  });

  it('checks the unsaved dungeon as it stands and never replaces it with the saved draft', async () => {
    const { user, editTable, saveTable } = await tableOpened({});
    await user.selectOptions(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled'), '3');
    const edited = bossDungeon();
    edited.rooms[0]!.actions[0]!.rewards!.tables = [{ ...hoardRef, draws: 3 }];
    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalledTimes(1));
    const sheet = await editTable();
    dungeon.stored = {
      ...dungeon.stored,
      dependenciesDiffer: true,
      dependencyChanges: [HOARD_CHANGED],
    };
    await saveTable(sheet);

    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.validateDungeon).mock.lastCall![0]).toEqual(edited);
    // The status is refreshed from the server, the draft is not.
    await waitFor(() => expect(state()).toHaveTextContent('Dungeon and loot changed'));
    expect(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled')).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
    expect(vi.mocked(api.saveDungeonDraft).mock.lastCall![1]).toMatchObject({
      definition: edited,
      expectedRevision: 4,
    });
  });

  it('ignores an older validation answer that arrives after a newer one', async () => {
    let answerFirst = () => {};
    vi.mocked(api.validateDungeon)
      .mockImplementationOnce(
        (definition) =>
          new Promise((resolve) => {
            answerFirst = () => resolve(report(definition, [BROKEN_TABLE]));
          }),
      )
      .mockImplementation(async (definition) => report(definition, []));
    const { user, editTable, saveTable } = await tableOpened({});
    // The first check, about the table as it was, is still unanswered…
    await user.selectOptions(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled'), '2');
    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalledTimes(1));
    // …when the table is repaired and the dungeon is checked again.
    await saveTable(await editTable());
    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalledTimes(2));
    expect(await checklist('Nothing to fix')).toBeVisible();

    answerFirst();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await checklist('Nothing to fix')).toBeVisible();
    expect(screen.queryByText(/needs repair/)).not.toBeInTheDocument();
  });
});
