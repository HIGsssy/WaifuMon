import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as loot from '@/api/adminDungeonLootTables';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import {
  HOARD_BODY,
  ITEMS,
  install as installLoot,
  table,
} from '@/features/adminDungeonLoot/__tests__/lootFixtures';
import { RoomInspector } from '../RoomInspector';
import { addTemplateRoom } from '../dungeonRoomTemplates';
import { fixture, install, reference, renderAt, renderWith } from './dungeonFixtures';

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

const LEGACY: api.DungeonAction = {
  id: 'a_old',
  type: 'reward',
  label: '',
  optional: false,
  outcomes: {},
  reward: { rewardTable: 'loot', equipmentRewardTable: null, currency: { min: 5, max: 9 } },
};
const base = { label: '', optional: false, outcomes: {} };
/** One room holding a two-wave fight, a boss, a legacy treasure and a new treasure. */
function vault(patch: Partial<Record<'fight' | 'boss', api.DungeonRewardBundle>> = {}) {
  const draft: api.DungeonDefinition = {
    ...fixture().draft,
    settings: {
      progressionCurrency: 'ascension_currency',
      defeatCurrencyRetentionBasisPoints: 5000,
    },
    rooms: [
      {
        id: 'entrance',
        name: 'Vault',
        extraction: true,
        actions: [
          {
            ...base,
            id: 'a_fight',
            type: 'combat',
            advance: 'confirm',
            waves: [{ enemy: { key: 'slime' } }, { enemy: { key: 'golem' } }],
            ...(patch.fight ? { rewards: patch.fight } : {}),
          },
          {
            ...base,
            id: 'a_boss',
            type: 'boss',
            advance: 'confirm',
            waves: [{ enemy: { key: 'golem' } }],
            ...(patch.boss ? { rewards: patch.boss } : {}),
          },
          LEGACY,
          {
            ...base,
            id: 'a_new',
            type: 'reward',
            rewards: { guaranteed: [], chances: [], tables: [] },
          },
        ],
      },
    ],
  };
  return draft;
}
const shards: api.DungeonRewardBundle['guaranteed'][number] = {
  id: 'g_shards',
  grant: { type: 'currency', currency: 'shards', amount: { min: 40, max: 60 } },
};
const charm: api.DungeonRewardBundle['guaranteed'][number] = {
  id: 'g_charm',
  grant: { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } },
};
const hoardRef = { id: 't_hoard', table: 'scrapheap_boss_hoard', draws: 1 };

let dungeon: ReturnType<typeof install>;
let catalogue: ReturnType<typeof installLoot>;
beforeEach(() => {
  dungeon = install();
  catalogue = installLoot();
  stubObjectUrls();
  catalogue.tables.push(
    table(
      'mixed_cache',
      'Mixed Cache',
      {
        guaranteed: [shards, charm],
        chances: [],
        pools: [],
      },
      { description: 'Shards and a charm.' },
    ),
  );
  // The dungeon editor's own reference data, with this catalogue's items and tables.
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

async function opened(
  draft: api.DungeonDefinition,
  activity: RegExp,
  options: { permissions?: string[]; issues?: api.DungeonIssue[] } = {},
) {
  dungeon.stored = { ...fixture(), draft, issues: options.issues ?? [] };
  const view = renderAt('/admin/dungeons/definitions/tunnels', options.permissions);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Canvas room entrance' }));
  await user.click(await screen.findByRole('button', { name: activity }));
  return { user, view };
}
const FIGHT = /^Activity 1: Fight\./;
const BOSS = /^Activity 2: Boss fight\./;
const rewards = () => within(screen.getByTestId('activity-rewards'));
const group = (id: 'guaranteed' | 'chances' | 'tables') =>
  within(screen.getByTestId(`section-${id}`));
async function saved(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
  return vi.mocked(api.saveDungeonDraft).mock.lastCall![1].definition!.rooms[0]!.actions;
}
async function addGuaranteed(
  user: ReturnType<typeof userEvent.setup>,
  type: string,
  fill: () => Promise<void>,
) {
  await user.click(group('guaranteed').getByRole('button', { name: '+ Add guaranteed reward' }));
  await user.click(screen.getByRole('radio', { name: type }));
  await fill();
  await user.click(screen.getByRole('button', { name: 'Add reward' }));
}
const amount = (user: ReturnType<typeof userEvent.setup>, value: string) => async () => {
  const input = screen.getByLabelText(/^(Amount|How many)$/);
  await user.clear(input);
  await user.type(input, value);
};

describe('Rewards on a fight', () => {
  it('configures guaranteed rewards of every type on a multi-wave fight, with risk labels', async () => {
    const { user } = await opened(vault(), FIGHT);
    // Collapsed on a plain fight: one line, and nothing stored yet.
    const toggle = screen.getByRole('button', { name: 'Rewards: No rewards yet' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByTestId('payout-timing')).toHaveTextContent(
      'Paid once, when the player wins the final wave of the fight. Earlier waves pay nothing, and neither does a lost fight.',
    );
    for (const heading of ['Guaranteed', 'Chance drops', 'Loot tables'])
      expect(rewards().getByRole('heading', { name: heading })).toBeVisible();

    await addGuaranteed(user, 'Baddie Shards', amount(user, '40'));
    await addGuaranteed(user, 'WaifuBux', amount(user, '500'));
    await addGuaranteed(user, 'Essence', amount(user, '5'));
    await addGuaranteed(user, 'Item', async () => {
      await user.click(screen.getByRole('button', { name: 'Charms' }));
      await user.click(
        within(screen.getByTestId('item-picker')).getByRole('button', { name: /Velvet Charm/ }),
      );
    });
    await addGuaranteed(user, 'Equipment', async () => {
      await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'R');
      await screen.findByText(/^2 pieces can drop: Bolt Cutter, Iron Plate/);
    });
    await addGuaranteed(user, 'Affection', amount(user, '3'));

    const rows = group('guaranteed').getAllByTestId('guaranteed-row');
    expect(rows.map((row) => within(row).getByTestId('risk-chip').textContent)).toEqual([
      'At risk',
      'At risk',
      'Kept',
      'Kept',
      'Kept',
      'Kept',
    ]);
    expect(rows[0]).toHaveTextContent('40 Baddie Shards');
    // The explanation quotes this dungeon's own retention settings.
    expect(screen.getByTestId('risk-explanation')).toHaveTextContent(
      'In this dungeon the player keeps 50% on defeat and 50% on abandoning.',
    );
    expect(screen.getByTestId('rewards-summary')).toHaveTextContent(
      '40 Baddie Shards · 500 WaifuBux · 5 Essence · 1 Velvet Charm · R gear',
    );
    // The fight itself is still edited exactly as before.
    expect(screen.getByLabelText('Wave 1 enemy')).toHaveValue('slime');
    expect(screen.getByLabelText('Wave 2 enemy')).toHaveValue('golem');
    await user.click(screen.getByRole('button', { name: 'Move wave 2 up' }));

    const [fight] = await saved(user);
    expect(fight!.waves).toEqual([{ enemy: { key: 'golem' } }, { enemy: { key: 'slime' } }]);
    expect(fight!.rewards!.guaranteed.map((e) => e.grant)).toEqual([
      { type: 'currency', currency: 'shards', amount: { min: 40, max: 40 } },
      { type: 'currency', currency: 'waifubux', amount: { min: 500, max: 500 } },
      { type: 'currency', currency: 'essence', amount: { min: 5, max: 5 } },
      { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } },
      { type: 'equipment', selector: { rarity: 'R' } },
      { type: 'affection', amount: { min: 3, max: 3 } },
    ]);
    for (const entry of fight!.rewards!.guaranteed) expect(entry.id).toMatch(/^g_[0-9a-f]{32}$/);
    expect(fight!.rewards).toMatchObject({ chances: [], tables: [] });
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });

  it('keeps entry IDs while reordering and editing, and stores no bundle once it is empty', async () => {
    const { user } = await opened(
      vault({ fight: { guaranteed: [shards, charm], chances: [], tables: [] } }),
      FIGHT,
    );
    await user.click(
      screen.getByRole('button', { name: /^Rewards: 40–60 Baddie Shards · 1 Velvet Charm/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Move 40–60 Baddie Shards down' }));
    await user.click(screen.getByRole('button', { name: 'Edit 1 Velvet Charm' }));
    await amount(user, '2')();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    let [fight] = await saved(user);
    expect(fight!.rewards!.guaranteed).toEqual([
      {
        id: 'g_charm',
        grant: { type: 'item', item: 'velvet_charm', quantity: { min: 2, max: 2 } },
      },
      shards,
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove 2 Velvet Charm' }));
    await user.click(screen.getByRole('button', { name: 'Remove 40–60 Baddie Shards' }));
    [fight] = await saved(user);
    expect(fight).not.toHaveProperty('rewards');
  });

  it('says the single-wave wording, and mentions skipping only when the fight can be skipped', async () => {
    const draft = vault();
    draft.rooms[0]!.actions[1]!.optional = true;
    await opened(draft, BOSS);
    expect(screen.getByTestId('payout-timing')).toHaveTextContent(
      'Paid once, when the player wins the boss fight. A lost or skipped fight pays nothing.',
    );
  });
});

describe('Rewards on a boss', () => {
  it('opens ready to use and takes independent chance drops in percent', async () => {
    const { user } = await opened(vault(), BOSS);
    // A boss is where loot goes: its Rewards section is already open.
    expect(screen.getByRole('button', { name: 'Rewards: No rewards yet' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(group('chances').getByRole('button', { name: '+ Add chance drop' }));
    await user.click(screen.getByRole('radio', { name: 'Item' }));
    await user.click(
      within(screen.getByTestId('item-picker')).getByRole('button', { name: /Velvet Charm/ }),
    );
    await user.type(screen.getByLabelText('Chance percent'), '25');
    await user.click(screen.getByRole('button', { name: 'Add chance drop' }));
    const row = group('chances').getByTestId('chance-row');
    expect(within(row).getByTestId('risk-chip')).toHaveTextContent('Kept');
    expect(screen.getByTestId('rewards-summary')).toHaveTextContent('25% 1 Velvet Charm');

    // An unusable percentage is explained and never reaches the draft.
    const chance = screen.getByLabelText('Chance of 1 Velvet Charm');
    await user.clear(chance);
    await user.type(chance, '0');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      'A 0% drop never happens. Remove it instead. The draft still says 25% until this is a usable percentage.',
    );
    let [, boss] = await saved(user);
    expect(boss!.rewards!.chances).toEqual([
      {
        id: expect.stringMatching(/^c_[0-9a-f]{32}$/),
        chanceBasisPoints: 2500,
        grant: { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } },
      },
    ]);
    await user.clear(chance);
    await user.type(chance, '12.5');
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
    [, boss] = await saved(user);
    expect(boss!.rewards!.chances[0]!.chanceBasisPoints).toBe(1250);

    // 100% belongs with the guaranteed rewards, and keeps its identity when moved there.
    await user.clear(chance);
    await user.type(chance, '100');
    await user.click(screen.getByRole('button', { name: 'Move to “Guaranteed”' }));
    [, boss] = await saved(user);
    expect(boss!.rewards!.chances).toEqual([]);
    expect(boss!.rewards!.guaranteed.map((e) => e.id)).toEqual([
      expect.stringMatching(/^c_[0-9a-f]{32}$/),
    ]);
  });

  it('a new boss fight shows where its loot goes without inventing any', async () => {
    function Harness() {
      const [definition, setDefinition] = useState(fixture().draft);
      return (
        <>
          <RoomInspector
            room={definition.rooms[0]!}
            definition={definition}
            reference={reference}
            issues={[]}
            disabled={false}
            onChange={setDefinition}
            onSelect={() => {}}
            onAddNext={() => {}}
            onDelete={() => {}}
          />
          <output data-testid="definition">{JSON.stringify(definition)}</output>
        </>
      );
    }
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add Boss fight' }));
    expect(screen.getByRole('button', { name: 'Rewards: No rewards yet' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const add of ['+ Add guaranteed reward', '+ Add chance drop', '+ Add loot table'])
      expect(screen.getByRole('button', { name: add })).toBeEnabled();
    expect(screen.getByTestId('payout-timing')).toHaveTextContent('wins the boss fight');
    const stored = JSON.parse(
      screen.getByTestId('definition').textContent!,
    ) as api.DungeonDefinition;
    expect(stored.rooms[0]!.actions[0]).not.toHaveProperty('rewards');
    // The Boss room template makes the same activity, and a Treasure room the new reward shape.
    const boss = addTemplateRoom(fixture().draft, {}, 'boss').definition.rooms.at(-1)!.actions[0]!;
    expect(boss).toMatchObject({ type: 'boss', waves: [{ enemy: { key: '' } }] });
    expect(boss).not.toHaveProperty('rewards');
    const treasure = addTemplateRoom(fixture().draft, {}, 'treasure').definition.rooms.at(-1)!;
    expect(treasure.actions[0]).toMatchObject({
      rewards: { guaranteed: [], chances: [], tables: [] },
    });
    expect(treasure.actions[0]).not.toHaveProperty('reward');
  });
});

describe('loot tables on an activity', () => {
  it('attaches a table by name, sets its rolls, and labels at-risk, kept and mixed tables', async () => {
    const { user } = await opened(vault(), BOSS);
    const add = () => user.click(group('tables').getByRole('button', { name: '+ Add loot table' }));
    await add();
    const picker = within(screen.getByTestId('loot-table-picker'));
    // Archived tables cannot be newly referenced.
    expect(await picker.findByRole('button', { name: 'Add Tunnel Cache' })).toBeVisible();
    expect(picker.queryByRole('button', { name: /Old Stash/ })).not.toBeInTheDocument();
    expect(picker.getByRole('button', { name: 'Add Mixed Cache' })).toHaveTextContent(
      'Shards and a charm.',
    );
    await user.type(picker.getByLabelText('Search loot tables'), 'hoard');
    expect(picker.getAllByRole('button', { name: /^Add / })).toHaveLength(1);
    await user.click(picker.getByRole('button', { name: 'Add Scrapheap Boss Hoard' }));
    await add();
    await user.click(await screen.findByRole('button', { name: 'Add Tunnel Cache' }));
    await add();
    await user.click(await screen.findByRole('button', { name: 'Add Mixed Cache' }));

    const rows = group('tables').getAllByTestId('table-row');
    expect(rows[0]).toHaveTextContent('Scrapheap Boss Hoard · Boss');
    expect(rows.map((row) => within(row).getByTestId('risk-chip').textContent)).toEqual([
      'Kept',
      'At risk',
      'Mixed',
    ]);
    expect(within(rows[2]!).getByTestId('mixed-note')).toHaveTextContent(
      'Mixed rewards: the Baddie Shards and WaifuBux it gives are at risk; everything else it gives is kept.',
    );
    expect(within(rows[0]!).queryByTestId('mixed-note')).not.toBeInTheDocument();
    expect(
      group('tables').getByText(/published dungeon keeps the loot it was published with/),
    ).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled'), '2');
    expect(rows[0]).toHaveTextContent('Rolled 2 times');
    await user.click(screen.getByRole('button', { name: 'Remove Tunnel Cache' }));
    await user.click(screen.getByRole('button', { name: 'Move Mixed Cache up' }));
    expect(screen.getByTestId('rewards-summary')).toHaveTextContent(
      'Mixed Cache · Scrapheap Boss Hoard ×2',
    );
    const [, boss] = await saved(user);
    expect(boss!.rewards!.tables).toEqual([
      { id: expect.stringMatching(/^t_[0-9a-f]{32}$/), table: 'mixed_cache', draws: 1 },
      { id: expect.stringMatching(/^t_[0-9a-f]{32}$/), table: 'scrapheap_boss_hoard', draws: 2 },
    ]);
  });

  it('shows odds for the whole bundle, referenced tables included, and test-rolls the unsaved bundle', async () => {
    const bundle = { guaranteed: [shards], chances: [], tables: [hoardRef] };
    const { user } = await opened(vault({ boss: bundle }), BOSS);
    expect(await screen.findByTestId('odds-summary')).toHaveTextContent(
      'On average: 50 Baddie Shards, 2.25 Essence, 3 Bent Gear and 0.75 gear pieces.',
    );
    expect(screen.getByTestId('odds-nothing')).toHaveTextContent(
      'This activity always gives something.',
    );
    expect(screen.getByTestId('odds-risk')).toHaveTextContent(
      'At risk until the run ends: 50 Baddie Shards on average. Everything else is kept.',
    );
    await user.click(screen.getByRole('button', { name: 'See all odds' }));
    const odds = within(screen.getByTestId('all-odds'));
    expect(odds.getByText('Baddie Shards').closest('tr')).toHaveTextContent('100%50At risk');
    // Gear that could drop is named, as definitions.
    expect(odds.getByText('Heart Locket').closest('tr')).toHaveTextContent('15%0.15Kept');
    expect(odds.getByTestId('pick-odds')).toHaveTextContent(
      'Each pick from “Boss gear” in Scrapheap Boss Hoard gives one of:',
    );

    // An unsaved change: two rolls of the table. Odds and Test Roll both follow it.
    await user.selectOptions(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled'), '2');
    expect(await screen.findByText(/4\.5 Essence, 6 Bent Gear and 1\.5 gear pieces/)).toBeVisible();
    const unsaved = { ...bundle, tables: [{ ...hoardRef, draws: 2 }] };
    expect(loot.testRollDungeonRewards).toHaveBeenLastCalledWith(
      { bundle: unsaved, seed: 0, progressionCurrency: 'ascension_currency' },
      expect.anything(),
    );
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    const roll = within(await screen.findByTestId('test-roll'));
    expect(roll.getByText('Test roll — Boss fight in Vault')).toBeVisible();
    expect(roll.getByText(/It awards nothing to any player/)).toBeVisible();
    const got = await roll.findByTestId('test-roll-got');
    expect(got).toHaveTextContent('At risk 40 Baddie Shards');
    expect(got).toHaveTextContent('Kept 3 Bent Gear, 3 Bent Gear, Iron Plate, Iron Plate');
    expect(roll.getAllByTestId('roll-group').map((g) => g.textContent)).toEqual([
      'This activity’s own rewards',
      'Scrapheap Boss Hoard, roll 1 of 2',
      'Scrapheap Boss Hoard, roll 2 of 2',
    ]);
    expect(roll.getAllByTestId('line-miss')[0]).toHaveTextContent(
      'Missed (30% chance): 5–10 Essence',
    );
    expect(loot.testRollDungeonRewards).toHaveBeenLastCalledWith({
      bundle: unsaved,
      progressionCurrency: 'ascension_currency',
    });
    expect(roll.queryByLabelText('Rolls in this test')).not.toBeInTheDocument();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });

  it('never shows an older odds answer over a newer one', async () => {
    const { user } = await opened(
      vault({ boss: { guaranteed: [], chances: [], tables: [hoardRef] } }),
      BOSS,
    );
    await screen.findByTestId('odds-summary');
    const answers: Array<() => void> = [];
    vi.mocked(loot.testRollDungeonRewards).mockImplementation(
      (input) =>
        new Promise((resolve) =>
          answers.push(() => resolve({ ...bundleAnswer(input.bundle.tables[0]!.draws) })),
        ),
    );
    const draws = screen.getByLabelText('Times Scrapheap Boss Hoard is rolled');
    await user.selectOptions(draws, '3');
    await waitFor(() => expect(answers).toHaveLength(1));
    await user.selectOptions(draws, '5');
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!();
    expect(await screen.findByText('On average: 5 WaifuBux.')).toBeVisible();
    answers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('odds-summary')).toHaveTextContent('On average: 5 WaifuBux.');
  });

  it('opens a table beside the dungeon without losing unsaved dungeon edits', async () => {
    const { user } = await opened(
      vault({ boss: { guaranteed: [], chances: [], tables: [hoardRef] } }),
      BOSS,
    );
    // An unsaved dungeon change first.
    await user.selectOptions(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled'), '3');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Open table Scrapheap Boss Hoard' }));
    const sheet = within(await screen.findByTestId('loot-table-sheet'));
    expect(sheet.getByText(/Your dungeon stays as you left it behind this panel/)).toBeVisible();
    const name = await sheet.findByLabelText('Table name');
    expect(name).toHaveValue('Scrapheap Boss Hoard');
    // Inside the dungeon it never navigates away.
    expect(sheet.queryByRole('link')).not.toBeInTheDocument();
    expect(sheet.queryByTestId('table-actions')).not.toBeInTheDocument();

    // Unsaved table edits are not dropped by closing the panel either.
    await user.type(sheet.getByLabelText('Description'), ' Retuned.');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Close loot table' }));
    expect(confirm).toHaveBeenCalledWith(
      'Discard unsaved loot table changes and close this panel?',
    );
    expect(screen.getByTestId('loot-table-sheet')).toBeVisible();
    await user.click(sheet.getByRole('button', { name: 'Save table' }));
    await waitFor(() =>
      expect(loot.updateDungeonLootTable).toHaveBeenCalledWith(
        'scrapheap_boss_hoard',
        expect.objectContaining({ expectedRevision: 3, body: HOARD_BODY }),
      ),
    );
    confirm.mockClear();
    await user.click(screen.getByRole('button', { name: 'Close loot table' }));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('loot-table-sheet')).not.toBeInTheDocument());

    // The dungeon is exactly where the author left it: still unsaved, still 3 rolls.
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled')).toHaveValue('3');
    const [, boss] = await saved(user);
    expect(boss!.rewards!.tables).toEqual([{ ...hoardRef, draws: 3 }]);
  });
});

/** A held-back odds answer that reports how many rolls it was asked about. */
function bundleAnswer(draws: number): loot.DungeonTestRollResult {
  return {
    seed: 0,
    roll: null,
    issues: [],
    items: {},
    equipmentPools: {},
    analysis: {
      resolverVersion: 1,
      snapshotHash: 'sha256:x',
      rewards: [
        {
          reward: { type: 'currency', currency: 'waifubux' },
          riskClass: 'at_risk',
          expectedQuantity: draws,
          chanceAtLeastOnce: 1,
          contributions: [],
        },
      ],
      expectedEquipmentPieces: 0,
      chanceAnyEquipment: 0,
      equipmentCandidateCount: 0,
      noRewardChance: 0,
      sources: [],
    },
  };
}

describe('validation, legacy treasure and saving', () => {
  it('explains broken reward dependencies beside their rows, without ids, and keeps warnings apart', async () => {
    const at = 'rooms[0].actions[1].rewards';
    const label = 'Room "Vault", activity "a_boss"';
    const error = (code: string, path: string, message: string): api.DungeonIssue => ({
      code,
      severity: 'error',
      path: `${at}.${path}`,
      message: `${label}${message}`,
    });
    const bundle: api.DungeonRewardBundle = {
      guaranteed: [
        { id: 'g_tok', grant: { type: 'item', item: 'old_token', quantity: { min: 1, max: 1 } } },
        {
          id: 'g_badge',
          grant: { type: 'item', item: 'founders_badge', quantity: { min: 1, max: 1 } },
        },
        { id: 'g_gone', grant: { type: 'item', item: 'vanished', quantity: { min: 1, max: 1 } } },
        shards,
      ],
      chances: [
        {
          id: 'c_gear',
          chanceBasisPoints: 500,
          grant: { type: 'equipment', selector: { rarity: 'N', slot: 'health' } },
        },
      ],
      tables: [
        { id: 't_gone', table: 'deleted_table', draws: 1 },
        { id: 't_old', table: 'old_stash', draws: 1 },
      ],
    };
    const draft = vault({ boss: bundle });
    draft.settings.progressionCurrency = null;
    await opened(draft, BOSS, {
      issues: [
        error(
          'reward_item_disabled',
          'guaranteed[0].grant',
          ', reward "g_tok": "Old Token" is disabled. Enable it or pick another item.',
        ),
        error(
          'reward_item_capped',
          'guaranteed[1].grant',
          ', reward "g_badge": "Founder’s Badge" is limited to 1 per player, so it cannot be dungeon loot.',
        ),
        error(
          'reward_item_missing',
          'guaranteed[2].grant',
          ', reward "g_gone": item "vanished" no longer exists. Pick another item.',
        ),
        error(
          'reward_shards_unset',
          'guaranteed[3].grant',
          ', reward "g_shards": this dungeon has no Baddie Shard currency set, so it cannot pay Shards.',
        ),
        error(
          'reward_equipment_empty',
          'chances[0].grant',
          ', reward "c_gear": no eligible gear matches "Any N health Equipment". Loosen the choice or repair its selected definitions.',
        ),
        error(
          'reward_table_missing',
          'tables[0]',
          ': loot table "deleted_table" no longer exists. Remove it or pick another dungeon loot table.',
        ),
        error(
          'reward_table_archived',
          'tables[1]',
          ', loot table "Old Stash" is archived. Restore it or pick another.',
        ),
        {
          ...error('reward_too_much_gear', '', ''),
          path: at,
          message: `${label}: this activity could drop up to 14 gear pieces at once. The limit is 10.`,
        },
        {
          code: 'reward_empty',
          severity: 'warning',
          path: 'rooms[0].actions[3].rewards',
          message: 'Room "Vault", activity "a_new": this Rewards section gives nothing yet.',
        },
      ],
    });
    const row = (text: string) => rewards().getByText(text).closest('li')!;
    expect(row('1 Old Token')).toHaveTextContent(
      'Fix: Old Token is disabled. Enable it or pick another item.',
    );
    expect(row('1 Founder’s Badge')).toHaveTextContent(
      'Fix: Founder’s Badge is limited to 1 per player, so it cannot be dungeon loot.',
    );
    expect(row('1 an item that no longer exists')).toHaveTextContent(
      'Fix: This item no longer exists. Pick another item.',
    );
    expect(row('40–60 Baddie Shards')).toHaveTextContent(
      'Fix: This dungeon needs an available progression currency to pay Baddie Shards. Choose one in Dungeon Settings.',
    );
    expect(group('chances').getByTestId('chance-row')).toHaveTextContent(
      'Fix: No gear matches “N Health gear”. Loosen the choice.',
    );
    const [gone, archived] = group('tables').getAllByTestId('table-row');
    expect(gone).toHaveTextContent('This loot table was deleted. Remove it or pick another.');
    expect(archived).toHaveTextContent('Fix: “Old Stash” is archived. Restore it or pick another.');
    expect(
      rewards().getByText(/This activity could drop up to 14 gear pieces at once/),
    ).toBeVisible();

    // The card's own list names the room, the activity and the reward.
    const boss = screen.getByRole('button', { name: BOSS }).closest('li')!;
    expect(boss).toHaveTextContent(
      'Vault: “1 Old Token” in the boss fight needs attention. Old Token is disabled.',
    );
    expect(boss).toHaveTextContent(
      'Vault: the loot table “Old Stash” in the boss fight needs attention.',
    );
    expect(boss).toHaveTextContent('Vault: the boss fight’s rewards need attention.');
    // A warning stays a warning, on its own activity, and never blocks.
    const treasure = screen.getByRole('button', { name: /^Activity 4: Treasure\./ }).closest('li')!;
    expect(treasure).toHaveTextContent('Vault: the treasure Rewards section gives nothing yet.');
    expect(
      within(treasure)
        .getByText(/gives nothing yet/)
        .closest('li'),
    ).toHaveClass('text-ink-muted');
    expect(screen.getByRole('button', { name: /^Checklist: 8 to fix/ })).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /g_tok|g_badge|c_gear|a_boss|deleted_table|"old_token"/,
    );
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
  });

  it('leaves a legacy treasure exactly as stored and never mixes the two reward shapes', async () => {
    const { user } = await opened(vault(), /^Activity 3: Treasure\. loot/);
    expect(screen.getByLabelText('Reward table')).toHaveValue('loot');
    expect(screen.getByLabelText('Progression currency min')).toHaveValue(5);
    expect(screen.getByTestId('legacy-treasure-note')).toHaveTextContent(
      'until you convert it to the new Rewards',
    );
    expect(screen.queryByTestId('activity-rewards')).not.toBeInTheDocument();
    // Another activity changes; the legacy treasure is saved back byte for byte.
    await user.click(
      screen.getByRole('button', { name: /^Activity 4: Treasure\. No rewards yet/ }),
    );
    expect(screen.queryByLabelText('Reward table')).not.toBeInTheDocument();
    expect(screen.getByTestId('payout-timing')).toHaveTextContent(
      'Paid once, when the player opens this treasure.',
    );
    await addGuaranteed(user, 'WaifuBux', amount(user, '50'));
    const actions = await saved(user);
    expect(actions[2]).toEqual(LEGACY);
    expect(actions[3]).not.toHaveProperty('reward');
    expect(actions[3]!.rewards!.guaranteed).toHaveLength(1);
  });

  it('keeps the reward bundle through saving and reopening the draft', async () => {
    const { user, view } = await opened(vault(), FIGHT);
    await user.click(screen.getByRole('button', { name: 'Rewards: No rewards yet' }));
    await addGuaranteed(user, 'WaifuBux', amount(user, '500'));
    await user.click(group('tables').getByRole('button', { name: '+ Add loot table' }));
    await user.click(await screen.findByRole('button', { name: 'Add Scrapheap Boss Hoard' }));
    const [fight] = await saved(user);
    expect(await screen.findByText('Draft saved. Publication is unchanged.')).toBeVisible();
    view.unmount();

    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Canvas room entrance' }));
    const card = await screen.findByRole('button', {
      name: /^Activity 1: Fight\. Slime, then Rust Golem\. Rewards: 500 WaifuBux · Scrapheap Boss Hoard/,
    });
    await user.click(card);
    await user.click(screen.getByRole('button', { name: /^Rewards: 500 WaifuBux/ }));
    expect(group('guaranteed').getByTestId('guaranteed-row')).toHaveTextContent('500 WaifuBux');
    expect(group('tables').getByTestId('table-row')).toHaveTextContent('Scrapheap Boss Hoard');
    expect(dungeon.stored.draft.rooms[0]!.actions[0]!.rewards).toEqual(fight!.rewards);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('lets a reader see rewards, odds and a test roll, but change nothing', async () => {
    const bundle = {
      guaranteed: [shards],
      chances: [{ id: 'c_charm', chanceBasisPoints: 2500, grant: charm.grant }],
      tables: [hoardRef],
    };
    const { user } = await opened(vault({ boss: bundle }), BOSS, {
      permissions: ['dungeons.read'],
    });
    expect(group('guaranteed').getByTestId('guaranteed-row')).toHaveTextContent(
      '40–60 Baddie Shards',
    );
    expect(screen.getByLabelText('Chance of 1 Velvet Charm')).toBeDisabled();
    expect(screen.getByLabelText('Times Scrapheap Boss Hoard is rolled')).toBeDisabled();
    for (const name of [
      /^\+ Add/,
      /^Remove 40/,
      /^Edit 40/,
      /^Move 40/,
      'Remove Scrapheap Boss Hoard',
    ])
      expect(rewards().queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('odds-summary')).toHaveTextContent('On average:');
    await user.click(screen.getByRole('button', { name: 'See all odds' }));
    expect(screen.getByTestId('all-odds')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    expect(await screen.findByTestId('test-roll-got')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close test roll' }));
    // The table opens for viewing too.
    await user.click(screen.getByRole('button', { name: 'Open table Scrapheap Boss Hoard' }));
    const sheet = within(await screen.findByTestId('loot-table-sheet'));
    expect(await sheet.findByLabelText('Table name')).toBeDisabled();
    expect(sheet.queryByRole('button', { name: 'Save table' })).not.toBeInTheDocument();
  });
});
