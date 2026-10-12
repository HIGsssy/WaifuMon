import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as loot from '@/api/adminDungeonLootTables';
import * as dungeons from '@/api/adminDungeons';
import { HOARD_BODY, READ, install, renderLoot, rollResult, table } from './lootFixtures';

let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
});
const HOARD = '/admin/dungeons/loot/scrapheap_boss_hoard';
const CACHE = '/admin/dungeons/loot/tunnel_cache';
const section = (id: 'guaranteed' | 'chances' | 'pools') => screen.getByTestId(`section-${id}`);
const saveButton = () => screen.getByRole('button', { name: 'Save table' });
const percents = () => screen.getAllByTestId('share-percent').map((e) => e.textContent);
async function opened(path: string, permissions?: string[]) {
  renderLoot(path, permissions);
  await screen.findByLabelText('Table name');
  return userEvent.setup();
}
const lastUpdate = () => vi.mocked(loot.updateDungeonLootTable).mock.lastCall![1];

describe('creating a loot table', () => {
  it('builds guaranteed rewards of every type without typing an id, and publishes nothing', async () => {
    const user = await opened('/admin/dungeons/loot/new');
    expect(screen.getByRole('heading', { name: 'New loot table' })).toBeVisible();
    await user.type(screen.getByLabelText('Table name'), 'Vault Loot');
    await user.selectOptions(screen.getByLabelText('Tier'), 'rare');
    const guaranteed = within(section('guaranteed'));
    const add = async (type: string, fill?: () => Promise<void>) => {
      await user.click(guaranteed.getByRole('button', { name: '+ Add guaranteed reward' }));
      await user.click(screen.getByRole('radio', { name: type }));
      await fill?.();
      await user.click(screen.getByRole('button', { name: 'Add reward' }));
    };
    const amount = (value: string) => async () => {
      await user.clear(screen.getByLabelText(/^(Amount|How many)$/));
      await user.type(screen.getByLabelText(/^(Amount|How many)$/), value);
    };
    await add('Baddie Shards', amount('40'));
    await add('WaifuBux', amount('500'));
    await add('Essence', amount('5'));
    await add('Item', async () => {
      await user.type(screen.getByLabelText('Search items'), 'bent');
      await user.click(screen.getByRole('button', { name: /Bent Gear/ }));
      await amount('2')();
    });
    await add('Equipment', async () => {
      await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'R');
      await screen.findByText(/^2 pieces can drop/);
    });
    await add('Affection', amount('3'));
    expect(guaranteed.getAllByTestId('guaranteed-row').map((r) => r.textContent)).toEqual([
      '40 Baddie Shards',
      '500 WaifuBux',
      '5 Essence',
      '2 Bent Gear',
      expect.stringMatching(/^R gear/),
      '3 Affection',
    ]);
    expect(screen.getByTestId('repeat-example')).toHaveTextContent(
      '40 Baddie Shards here means 120 Baddie Shards when a dungeon rolls this table 3 times',
    );

    await user.click(screen.getByRole('button', { name: 'Create table' }));
    await waitFor(() => expect(loot.createDungeonLootTable).toHaveBeenCalled());
    const input = vi.mocked(loot.createDungeonLootTable).mock.lastCall![0];
    expect(input).toMatchObject({ key: 'vault_loot', name: 'Vault Loot', tier: 'rare' });
    expect(input.body.guaranteed.map((e) => e.grant)).toEqual([
      { type: 'currency', currency: 'shards', amount: { min: 40, max: 40 } },
      { type: 'currency', currency: 'waifubux', amount: { min: 500, max: 500 } },
      { type: 'currency', currency: 'essence', amount: { min: 5, max: 5 } },
      { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 2 } },
      { type: 'equipment', selector: { rarity: 'R' } },
      { type: 'affection', amount: { min: 3, max: 3 } },
    ]);
    const ids = input.body.guaranteed.map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^g_[0-9a-f]{32}$/);
    // The new table opens in the editor, and no dungeon was published on the way.
    expect(await screen.findByRole('heading', { name: 'Loot table — Vault Loot' })).toBeVisible();
    expect(dungeons.publishDungeon).not.toHaveBeenCalled();
  });

  it('waits for a name, and explains a key that is already taken', async () => {
    const user = await opened('/admin/dungeons/loot/new');
    const create = screen.getByRole('button', { name: 'Create table' });
    expect(create).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Table name'), 'Tunnel Cache');
    await user.click(create);
    expect(await screen.findByText(/Another loot table already uses this key/)).toBeVisible();
    const key = screen.getByLabelText('Table key');
    expect(key).toHaveValue('tunnel_cache');
    await user.clear(key);
    await user.type(key, 'Tunnel Cache!');
    expect(screen.getByText(/The table key needs lower-case letters/)).toBeVisible();
    expect(create).toBeDisabled();
    await user.clear(key);
    await user.type(key, 'tunnel_cache_two');
    await user.click(create);
    await waitFor(() =>
      expect(loot.createDungeonLootTable).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: 'tunnel_cache_two' }),
      ),
    );
  });
});

describe('editing a loot table', () => {
  it('saves edits with the table’s revision, explains republishing, and publishes nothing', async () => {
    const user = await opened(HOARD);
    expect(await screen.findByTestId('republish-note')).toHaveTextContent(
      '2 dungeons use this table. They keep paying the old version until each is published again.',
    );
    expect(screen.getByTestId('where-used')).toHaveTextContent(
      'Service Tunnels — in its draft · live in published revision 4',
    );
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('No unsaved changes');
    await user.type(screen.getByLabelText('Description'), ' Retuned.');
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
    await user.click(saveButton());
    await waitFor(() =>
      expect(loot.updateDungeonLootTable).toHaveBeenCalledWith('scrapheap_boss_hoard', {
        expectedRevision: 3,
        name: 'Scrapheap Boss Hoard',
        description: 'Main loot for the Service Tunnels foreman. Retuned.',
        tier: 'boss',
        body: HOARD_BODY,
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Saved. 2 dungeons use this table. They keep paying the old version until each is published again.',
    );
    expect(dungeons.publishDungeon).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
  });

  it('adds independent chance drops in percent and handles 0% and 100% kindly', async () => {
    const user = await opened(CACHE);
    const chances = within(section('chances'));
    await user.click(chances.getByRole('button', { name: '+ Add chance drop' }));
    await user.click(screen.getByRole('radio', { name: 'Item' }));
    await user.type(screen.getByLabelText('Search items'), 'velvet');
    await user.click(screen.getByRole('button', { name: /Velvet Charm/ }));
    const confirm = screen.getByRole('button', { name: 'Add chance drop' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a percentage such as 25 or 0.5');
    await user.type(screen.getByLabelText('Chance percent'), '25');
    await user.click(confirm);
    const row = chances.getByTestId('chance-row');
    expect(row).toHaveTextContent('% chance:1 Velvet Charm');
    const chance = screen.getByLabelText('Chance of 1 Velvet Charm');
    expect(chance).toHaveValue('25');

    await user.clear(chance);
    await user.type(chance, '0');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      'A 0% drop never happens. Remove it instead.',
    );
    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId('save-blocked')).toHaveTextContent(
      'Fix 1 highlighted field to save.',
    );
    await user.clear(chance);
    await user.type(chance, '0.5');
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalled());
    expect(lastUpdate().body!.chances).toEqual([
      {
        id: expect.stringMatching(/^c_[0-9a-f]{32}$/),
        chanceBasisPoints: 50,
        grant: { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } },
      },
    ]);

    // 100% is not a chance: the editor offers to move it where it belongs.
    const again = await screen.findByLabelText('Chance of 1 Velvet Charm');
    await user.clear(again);
    await user.type(again, '100');
    expect(screen.getByText(/A 100% drop always happens/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move to “Every time”' }));
    expect(chances.queryByTestId('chance-row')).not.toBeInTheDocument();
    expect(within(section('guaranteed')).getAllByTestId('guaranteed-row')).toHaveLength(3);
  });

  it('edits weighted groups by share with live percentages and an explicit Nothing', async () => {
    const user = await opened(HOARD);
    expect(percents()).toEqual(['60%', '15%', '25%']);
    const nothing = screen.getByLabelText('Share of Nothing in Boss gear');
    await user.clear(nothing);
    // Recalculated as the author types, with no request in between.
    expect(percents()).toEqual(['80%', '20%', '—']);
    await user.type(nothing, '75');
    expect(percents()).toEqual(['40%', '10%', '50%']);
    await user.clear(nothing);
    await user.type(nothing, '0');
    expect(screen.getByText('A share of 0 can never be picked. Remove it instead.')).toBeVisible();
    await user.clear(nothing);
    await user.type(nothing, '25');

    // A second group: a name, picks, a reward and a deliberate Nothing row.
    const pools = within(section('pools'));
    await user.click(pools.getByRole('button', { name: '+ Add another group of random picks' }));
    const group = pools.getAllByTestId('pool-card')[1]!;
    expect(within(group).getByText('Give this group a name.')).toBeVisible();
    expect(within(group).getByText('Add at least one choice, or remove this group.')).toBeVisible();
    await user.type(within(group).getByLabelText('Group name'), 'Bonus scrap');
    const picks = within(group).getByLabelText('Picks from Bonus scrap');
    await user.clear(picks);
    await user.type(picks, '2');
    await user.click(within(group).getByRole('button', { name: '+ Add reward' }));
    await user.click(screen.getByRole('radio', { name: 'Item' }));
    await user.click(
      within(screen.getByTestId('item-picker')).getByRole('button', { name: /Bent Gear/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Add choice' }));
    expect(within(group).getByText(/every pick gives something/)).toBeVisible();
    await user.click(within(group).getByRole('button', { name: '+ Add “Nothing”' }));
    expect(within(group).getByRole('button', { name: '+ Add “Nothing”' })).toBeDisabled();
    const share = within(group).getByLabelText('Share of Nothing in Bonus scrap');
    await user.clear(share);
    await user.type(share, '3');
    expect(
      within(group)
        .getAllByTestId('share-percent')
        .map((e) => e.textContent),
    ).toEqual(['25%', '75%']);
    // The normal editor speaks of shares; the stored word never appears.
    expect(document.body.textContent).not.toMatch(/weight/i);

    await user.click(saveButton());
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalled());
    expect(lastUpdate().body!.pools[0]).toEqual(HOARD_BODY.pools[0]);
    expect(lastUpdate().body!.pools[1]).toEqual({
      id: expect.stringMatching(/^p_[0-9a-f]{32}$/),
      name: 'Bonus scrap',
      draws: 2,
      entries: [
        {
          id: expect.stringMatching(/^e_[0-9a-f]{32}$/),
          weight: 1,
          grant: { type: 'item', item: 'bent_gear', quantity: { min: 1, max: 1 } },
        },
        { id: expect.stringMatching(/^e_[0-9a-f]{32}$/), weight: 3, nothing: true },
      ],
    });
  });

  it('never shows a tiny positive share as 0%', async () => {
    const user = await opened(HOARD);
    for (const [label, value] of [
      ['Share of R gear (2 possible) in Boss gear', '1'],
      ['Share of Nothing in Boss gear', '999999'],
    ] as const) {
      const input = await screen.findByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    // 1 and 15 parts in a million, and all but those: none of them is 0% or 100%.
    expect(percents()).toEqual(['less than 0.01%', 'less than 0.01%', 'more than 99.99%']);
  });

  it('keeps entry IDs when rewards are reordered and edited', async () => {
    const user = await opened(CACHE);
    await user.click(screen.getByRole('button', { name: 'Move 10 Baddie Shards down' }));
    expect(screen.getByRole('button', { name: 'Move 10 Baddie Shards down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Edit 50 WaifuBux' }));
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '75');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(saveButton());
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalled());
    expect(lastUpdate().body!.guaranteed).toEqual([
      {
        id: 'bux',
        grant: { type: 'currency', currency: 'waifubux', amount: { min: 75, max: 75 } },
      },
      {
        id: 'shards',
        grant: { type: 'currency', currency: 'shards', amount: { min: 10, max: 10 } },
      },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Remove 75 WaifuBux' }));
    expect(screen.getAllByTestId('guaranteed-row')).toHaveLength(1);
  });

  it('discards changes only after asking', async () => {
    const user = await opened(CACHE);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.type(screen.getByLabelText('Table name'), ' II');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache II');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache');
    expect(loot.updateDungeonLootTable).not.toHaveBeenCalled();
  });

  it('shows dependency problems beside their rows and still lets a repair be saved', async () => {
    world.tables.push(
      table('broken', 'Broken Loot', {
        guaranteed: [
          { id: 'token', grant: { type: 'item', item: 'old_token', quantity: { min: 1, max: 1 } } },
        ],
        chances: [
          {
            id: 'badge',
            chanceBasisPoints: 500,
            grant: { type: 'item', item: 'founders_badge', quantity: { min: 1, max: 1 } },
          },
        ],
        pools: [],
      }),
    );
    const user = await opened('/admin/dungeons/loot/broken');
    const token = (await screen.findByText('1 Old Token')).closest('li')!;
    expect(token).toHaveTextContent('Fix: Old Token is disabled. Enable it or pick another item.');
    expect(screen.getByTestId('chance-row')).toHaveTextContent(
      'Fix: Founder’s Badge is limited to 1 per player, so it cannot be dungeon loot.',
    );
    expect(screen.getByTestId('save-warning')).toHaveTextContent('2 rewards need repair');
    // No entry id leaks into what the author reads.
    expect(document.body.textContent).not.toMatch(/"x"|reward "/);

    await user.click(screen.getByRole('button', { name: 'Edit 1 Old Token' }));
    await user.click(screen.getByRole('button', { name: /Tonic/ }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // One problem repaired, one left: the table can still be saved.
    await waitFor(() =>
      expect(screen.getByTestId('save-warning')).toHaveTextContent('1 reward needs repair'),
    );
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalled());
    expect(lastUpdate().body!.guaranteed[0]).toEqual({
      id: 'token',
      grant: { type: 'item', item: 'tonic', quantity: { min: 1, max: 1 } },
    });
    expect(await screen.findByTestId('chance-row')).toHaveTextContent('Fix: Founder’s Badge');
  });

  it('is view-only without dungeon write access, but can still test-roll', async () => {
    const user = await opened(HOARD, READ);
    expect(screen.getByText('View only')).toBeVisible();
    expect(screen.getByLabelText('Table name')).toBeDisabled();
    expect(screen.getByLabelText('Share of Nothing in Boss gear')).toBeDisabled();
    for (const name of [/Save table/, /Discard/, /^\+ Add/, /^Remove/, /^Edit/, /^Move/, 'Archive'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-actions')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    expect(await screen.findByTestId('test-roll-got')).toBeVisible();
  });

  it('archives from the editor, then allows delete, keeping unsaved edits', async () => {
    const user = await opened(CACHE);
    await user.type(screen.getByLabelText('Table name'), ' II');
    expect(screen.getByText('Archive a table before deleting it.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive table' }));
    expect(await screen.findByText('Archived')).toBeVisible();
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache II');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete table' }));
    await waitFor(() =>
      expect(loot.deleteDungeonLootTable).toHaveBeenCalledWith('tunnel_cache', 2),
    );
    expect(await screen.findByRole('heading', { name: 'Dungeon Loot Tables' })).toBeVisible();
  });
});

describe('odds', () => {
  it('summarises the server’s analysis and expands to every reward’s odds', async () => {
    const user = await opened(HOARD);
    expect(await screen.findByTestId('odds-summary')).toHaveTextContent(
      'On average per roll: 2.25 Essence, 3 Bent Gear and 0.75 gear pieces.',
    );
    expect(screen.getByTestId('odds-nothing')).toHaveTextContent(
      'This table always gives something.',
    );
    expect(
      screen.getByText('Each pick from “Boss gear” comes up empty 25% of the time.'),
    ).toBeVisible();
    expect(screen.queryByTestId('all-odds')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'See all odds' }));
    const odds = within(screen.getByTestId('all-odds'));
    const cells = (name: string) =>
      within(odds.getByText(name).closest('tr')!)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells('Essence')).toEqual(['Essence', '30%', '2.25', 'Kept']);
    expect(cells('Bent Gear')).toEqual(['Bent Gear', '100%', '3', 'Kept']);
    expect(cells('Heart Locket')).toEqual(['Gear: Heart Locket', '15%', '0.15', 'Kept']);
    // Group choices compete within one pick; chance drops are separate rolls.
    expect(odds.getByTestId('pick-odds')).toHaveTextContent(
      'Each pick from “Boss gear” gives one of:Bolt Cutter — 30%Iron Plate — 30%Heart Locket — 15%Nothing — 25%',
    );
    expect(odds.getByText(/Chance drops each roll on their own/)).toBeVisible();
    expect(odds.getByText(/Choices in a group compete/)).toBeVisible();
    expect(odds.getByText(/Rolling a loot table more than once repeats everything/)).toBeVisible();
    // The figures are the server's: the table body was sent as it stands, rolled once.
    expect(loot.testRollDungeonLootTable).toHaveBeenLastCalledWith(
      { tableBody: HOARD_BODY, draws: 1, seed: 0 },
      expect.anything(),
    );
    await user.selectOptions(screen.getByLabelText('Number of rolls'), '3');
    await waitFor(() =>
      expect(loot.testRollDungeonLootTable).toHaveBeenLastCalledWith(
        { tableBody: HOARD_BODY, draws: 3, seed: 0 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/On average from 3 rolls:/)).toBeVisible();
  });

  it('shows tiny odds with decimals, and the chance of getting nothing', async () => {
    vi.mocked(loot.testRollDungeonLootTable).mockImplementation(async (input) =>
      rollResult(input.tableBody, {
        analysis: {
          resolverVersion: 1,
          snapshotHash: 'sha256:x',
          rewards: [
            {
              reward: { type: 'currency', currency: 'shards' },
              riskClass: 'at_risk',
              expectedQuantity: 0.0004,
              chanceAtLeastOnce: 0.00004,
              contributions: [],
            },
            {
              reward: { type: 'item', item: 'velvet_charm' },
              riskClass: 'secured',
              expectedQuantity: 0.005,
              chanceAtLeastOnce: 0.005,
              contributions: [],
            },
          ],
          expectedEquipmentPieces: 0,
          chanceAnyEquipment: 0,
          equipmentCandidateCount: 0,
          noRewardChance: 0.99496,
          sources: [],
        },
      }),
    );
    const user = await opened(CACHE);
    expect(await screen.findByTestId('odds-summary')).toHaveTextContent(
      'On average per roll: less than 0.01 Baddie Shards and 0.01 Velvet Charm.',
    );
    expect(screen.getByTestId('odds-nothing')).toHaveTextContent(
      'Chance of getting nothing at all per roll: 99.5%.',
    );
    await user.click(screen.getByRole('button', { name: 'See all odds' }));
    const odds = screen.getByTestId('all-odds');
    expect(odds).toHaveTextContent('Baddie Shardsless than 0.01%less than 0.01At risk');
    expect(odds).toHaveTextContent('Velvet Charm0.5%0.01Kept');
    expect(within(odds).queryByText('0%')).not.toBeInTheDocument();
  });

  it('asks once the table has sat still, and never shows an older answer over a newer one', async () => {
    const user = await opened(HOARD);
    await screen.findByTestId('odds-summary');
    const calls = vi.mocked(loot.testRollDungeonLootTable).mock.calls.length;
    const answers: Array<() => void> = [];
    // Answers are held back, and each reports the share it was asked about.
    vi.mocked(loot.testRollDungeonLootTable).mockImplementation(
      (input) =>
        new Promise((resolve) =>
          answers.push(() =>
            resolve(
              rollResult(input.tableBody, {
                analysis: {
                  resolverVersion: 1,
                  snapshotHash: 'sha256:x',
                  rewards: [
                    {
                      reward: { type: 'currency', currency: 'waifubux' },
                      riskClass: 'at_risk',
                      expectedQuantity: input.tableBody.pools[0]!.entries[2]!.weight,
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
              }),
            ),
          ),
        ),
    );
    const share = screen.getByLabelText('Share of Nothing in Boss gear');
    const retype = async (value: string) => {
      await user.clear(share);
      await user.type(share, value);
    };
    // Four keystrokes, each a valid share on its own, are one request once typing stops.
    await retype('7000');
    await waitFor(() => expect(answers).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(vi.mocked(loot.testRollDungeonLootTable).mock.calls).toHaveLength(calls + 1);
    await retype('9000');
    await waitFor(() => expect(answers).toHaveLength(2));
    // The newer answer arrives first; the older one must not replace it.
    answers[1]!();
    expect(await screen.findByText('On average per roll: 9,000 WaifuBux.')).toBeVisible();
    answers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('odds-summary')).toHaveTextContent('9,000 WaifuBux');
  });
});

describe('Test Roll', () => {
  it('rolls the unsaved table and shows what dropped, missed and came up Nothing', async () => {
    const user = await opened(HOARD);
    // An unsaved change: the test roll must use it, and must not save it.
    const nothing = screen.getByLabelText('Share of Nothing in Boss gear');
    await user.clear(nothing);
    await user.type(nothing, '40');
    const unsaved = structuredClone(HOARD_BODY);
    unsaved.pools[0]!.entries[2]!.weight = 40;
    vi.mocked(loot.testRollDungeonLootTable).mockImplementation(async (input) => {
      const result = rollResult(input.tableBody, { seed: input.seed ?? 424242 });
      const lines = [...result.roll!.lines];
      lines.push({
        ...lines[2]!,
        dropId: 'd4',
        tableDraw: 0,
        entryId: 'none',
        hit: false,
        missReason: 'nothing',
        rolls: { pool: { value: 90, weight: 40, totalWeight: 115 } },
      });
      delete (lines[3] as { grant?: unknown }).grant;
      return {
        ...result,
        roll: { ...result.roll!, atRisk: { shards: 12, waifubux: 0 }, lines },
        ...(input.simulate
          ? {
              simulation: {
                kind: 'observed' as const,
                runs: input.simulate,
                averages: [
                  {
                    reward: { type: 'item' as const, item: 'bent_gear' },
                    riskClass: 'secured' as const,
                    averageQuantity: 2.98,
                  },
                ],
                nothingRate: 0,
                nothingResults: 340,
              },
            }
          : {}),
      };
    });
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    const dialog = within(await screen.findByTestId('test-roll'));
    expect(dialog.getByText(/It\s+awards nothing to any player/)).toBeVisible();
    await dialog.findByTestId('test-roll-got');
    expect(loot.testRollDungeonLootTable).toHaveBeenLastCalledWith({
      tableBody: unsaved,
      draws: 1,
    });
    expect(loot.updateDungeonLootTable).not.toHaveBeenCalled();

    const got = dialog.getByTestId('test-roll-got');
    expect(got).toHaveTextContent('At risk 12 Baddie Shards');
    expect(got).toHaveTextContent('Kept 3 Bent Gear, Iron Plate');
    // Definitions only: no invented stats.
    expect(got).toHaveTextContent('Its stats are rolled only when it really drops');
    expect(dialog.getAllByTestId('line-hit').map((l) => l.textContent)).toEqual([
      'Every time: 3 Bent Gear',
      '“Boss gear” picked: Iron Plate',
    ]);
    expect(dialog.getAllByTestId('line-miss').map((l) => l.textContent)).toEqual([
      'Missed (30% chance): 5–10 Essence',
      '“Boss gear” picked Nothing',
    ]);
    expect(dialog.getByTestId('test-roll-seed')).toHaveTextContent('Seed 424242.');
    expect(dialog.queryByTestId('test-roll-simulation')).not.toBeInTheDocument();

    // The seed reproduces the roll, and a simulation is run only when asked for.
    await user.click(dialog.getByRole('button', { name: 'Use this seed' }));
    expect(dialog.getByLabelText('Seed')).toHaveValue('424242');
    await user.click(dialog.getByLabelText(/Also simulate 1,000 rolls/));
    await user.selectOptions(dialog.getByLabelText('Rolls in this test'), '2');
    await user.click(dialog.getByRole('button', { name: 'Roll again' }));
    await waitFor(() =>
      expect(loot.testRollDungeonLootTable).toHaveBeenLastCalledWith({
        tableBody: unsaved,
        draws: 2,
        seed: 424242,
        simulate: 1000,
      }),
    );
    const simulation = await dialog.findByTestId('test-roll-simulation');
    expect(simulation).toHaveTextContent('Across 1,000 simulated rolls');
    expect(simulation).toHaveTextContent('Bent Gear: 2.98 on average');
    expect(loot.updateDungeonLootTable).not.toHaveBeenCalled();
    // Closing the preview leaves the unsaved change exactly where it was.
    await user.click(screen.getByRole('button', { name: 'Close test roll' }));
    expect(screen.getByLabelText('Share of Nothing in Boss gear')).toHaveValue('40');
    expect(saveButton()).toBeEnabled();
  });

  it('says a roll gave nothing, and reports a table that cannot be rolled as an error', async () => {
    world.tables.push(
      table('risky', 'Risky', {
        guaranteed: [],
        chances: [
          {
            id: 'token',
            chanceBasisPoints: 100,
            grant: { type: 'item', item: 'tonic', quantity: { min: 1, max: 1 } },
          },
        ],
        pools: [],
      }),
    );
    const user = await opened('/admin/dungeons/loot/risky');
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    expect(await screen.findByText('This roll gave nothing.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close test roll' }));

    await user.click(screen.getByRole('button', { name: 'Edit 1 Tonic' }));
    await user.click(screen.getByRole('radio', { name: 'Equipment' }));
    await user.selectOptions(screen.getByLabelText('Equipment rarity'), 'R');
    await screen.findByText(/^2 pieces can drop/);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // The matching gear disappears before the roll: an error, not an empty roll.
    vi.mocked(loot.testRollDungeonLootTable).mockImplementation(async (input) => ({
      ...rollResult(input.tableBody),
      roll: null,
      analysis: null,
      issues: [
        {
          code: 'reward_equipment_empty',
          severity: 'error',
          path: 'rooms[0].actions[0].rewards.tables[0].body.chances[0].grant',
          message:
            'Room "Preview", activity "reward", loot table "Test table", reward "token": none',
        },
      ],
    }));
    await user.click(screen.getByRole('button', { name: 'Test roll' }));
    const blocked = await screen.findByTestId('test-roll-blocked');
    expect(blocked).toHaveTextContent('This table cannot be rolled yet.');
    expect(blocked).toHaveTextContent('No gear matches “R gear”. Loosen the choice.');
    expect(screen.queryByText('This roll gave nothing.')).not.toBeInTheDocument();
  });

  it('cannot be rolled while a field is unusable', async () => {
    const user = await opened(HOARD);
    const chance = screen.getByLabelText('Chance of 5–10 Essence');
    await user.clear(chance);
    expect(screen.getByRole('button', { name: 'Test roll' })).toBeDisabled();
    expect(screen.getByText('Fix the highlighted fields to see the odds.')).toBeVisible();
  });
});

describe('safe editing', () => {
  it('keeps local edits on a stale save and lets the author review the newer version', async () => {
    const user = await opened(CACHE);
    await user.type(screen.getByLabelText('Table name'), ' Mine');
    // Another administrator saves first.
    world.tables = world.tables.map((t) =>
      t.key === 'tunnel_cache'
        ? {
            ...t,
            name: 'Tunnel Cache (retuned)',
            revision: 2,
            updatedBy: 'Vex',
            body: {
              ...t.body,
              guaranteed: [
                {
                  id: 'shards',
                  grant: { type: 'currency', currency: 'shards', amount: { min: 99, max: 99 } },
                },
              ],
            },
          }
        : t,
    );
    await user.click(saveButton());
    const banner = await screen.findByTestId('conflict-banner');
    expect(banner).toHaveTextContent('Someone else saved this table while you were editing it.');
    expect(banner).toHaveTextContent('revision 2, saved by Vex');
    expect(banner).toHaveTextContent('Your changes are still on this page and were not saved');
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache Mine');
    expect(screen.getAllByTestId('guaranteed-row')).toHaveLength(2);
    // Nothing is overwritten by pressing Save again.
    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId('save-blocked')).toHaveTextContent(
      'Review the newer version before saving.',
    );
    expect(loot.updateDungeonLootTable).toHaveBeenCalledTimes(1);

    await user.click(within(banner).getByRole('button', { name: 'Review their version' }));
    const theirs = await screen.findByTestId('table-summary');
    expect(theirs).toHaveTextContent('Tunnel Cache (retuned)');
    expect(theirs).toHaveTextContent('99 Baddie Shards');
    await user.click(screen.getByRole('button', { name: 'Keep my changes' }));
    expect(screen.queryByTestId('conflict-banner')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache Mine');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saving now replaces revision 2 with your version.',
    );
    await user.click(saveButton());
    await waitFor(() => expect(loot.updateDungeonLootTable).toHaveBeenCalledTimes(2));
    expect(lastUpdate()).toMatchObject({ expectedRevision: 2, name: 'Tunnel Cache Mine' });
    expect(lastUpdate().body!.guaranteed).toHaveLength(2);
  });

  it('can take the other administrator’s version instead', async () => {
    const user = await opened(CACHE);
    await user.type(screen.getByLabelText('Table name'), ' Mine');
    world.tables = world.tables.map((t) =>
      t.key === 'tunnel_cache' ? { ...t, name: 'Theirs', revision: 2 } : t,
    );
    await user.click(saveButton());
    await user.click(await screen.findByRole('button', { name: 'Review their version' }));
    await user.click(await screen.findByRole('button', { name: 'Use their version' }));
    expect(screen.getByLabelText('Table name')).toHaveValue('Theirs');
    expect(screen.getByRole('status')).toHaveTextContent('Their version is loaded.');
    expect(loot.updateDungeonLootTable).toHaveBeenCalledTimes(1);
  });

  it('asks before navigating away from unsaved changes', async () => {
    const user = await opened(CACHE);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // Nothing to lose yet, so leaving is not questioned.
    expect(confirm).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Table name'), ' II');
    await user.click(screen.getByRole('link', { name: 'Back to loot tables' }));
    expect(confirm).toHaveBeenCalledWith('Discard unsaved loot table changes and leave this page?');
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache II');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('link', { name: 'Back to loot tables' }));
    expect(await screen.findByRole('heading', { name: 'Dungeon Loot Tables' })).toBeVisible();
  });

  it('leaves freely when there is nothing unsaved', async () => {
    const user = await opened(CACHE);
    const confirm = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('link', { name: 'Back to loot tables' }));
    expect(await screen.findByRole('heading', { name: 'Dungeon Loot Tables' })).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a table that does not exist', async () => {
    renderLoot('/admin/dungeons/loot/nope');
    expect(await screen.findByText('Loot table not found')).toBeVisible();
  });
});
