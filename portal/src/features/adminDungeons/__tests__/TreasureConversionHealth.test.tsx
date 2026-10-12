import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
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
beforeEach(() => {
  dungeon = install();
  installLoot();
  stubObjectUrls();
  vi.mocked(api.getDungeonReference).mockResolvedValue({ ...reference, items: ITEMS });
});

const LEGACY: api.DungeonLegacyReward = {
  rewardTable: 'loot',
  equipmentRewardTable: null,
  currency: { min: 3, max: 8 },
};
const base = { label: '', optional: false, outcomes: {} };
function legacyDungeon(): api.DungeonDefinition {
  return {
    ...fixture().draft,
    settings: {
      progressionCurrency: 'ascension_currency',
      defeatCurrencyRetentionBasisPoints: 5000,
      abandonCurrencyRetentionBasisPoints: 0,
    },
    rooms: [
      {
        id: 'entrance',
        name: 'Vault',
        extraction: true,
        actions: [{ ...base, id: 'a_chest', type: 'reward', reward: LEGACY }],
      },
    ],
  };
}
const REWARDS: api.DungeonRewardBundle = {
  guaranteed: [
    {
      id: 'g_shards',
      grant: { type: 'currency', currency: 'shards', amount: { min: 3, max: 8 } },
    },
  ],
  chances: [],
  tables: [{ id: 't_1', table: 'converted_loot', draws: 1 }],
};
function plan(patch: Partial<api.DungeonTreasureConversionPlan> = {}) {
  const value: api.DungeonTreasureConversionPlan = {
    dungeonKey: 'tunnels',
    roomId: 'entrance',
    actionId: 'a_chest',
    roomName: 'Vault',
    draftRevision: 4,
    legacy: LEGACY,
    rewards: REWARDS,
    tables: [
      {
        sourceTable: 'loot',
        sourceContentHash: 'sha256:source',
        draws: 1,
        action: 'create',
        key: 'converted_loot',
        name: 'loot (converted)',
        description: 'Converted.',
        contentHash: 'abc',
        body: {
          guaranteed: [
            {
              id: 'waifubux',
              grant: { type: 'currency', currency: 'waifubux', amount: { min: 20, max: 40 } },
            },
          ],
          chances: [],
          pools: [
            {
              id: 'g1',
              name: 'salvage',
              draws: 2,
              entries: [
                {
                  id: 'i1',
                  weight: 3,
                  grant: { type: 'item', item: 'velvet_charm', quantity: { min: 2, max: 2 } },
                },
                { id: 'e1', weight: 1, grant: { type: 'equipment', selector: { rarity: 'R' } } },
                { id: 'none', weight: 12, nothing: true },
              ],
            },
          ],
        },
      },
    ],
    omitted: [
      { table: 'loot', reason: 'never_paid', text: '5–10 Essence' },
      { table: 'loot', reason: 'never_paid', text: '30 player XP' },
      { table: 'loot', reason: 'disabled', text: 'Group "bonus" is switched off.' },
    ],
    blockers: [],
    issues: [],
    waifubuxAtRisk: true,
    retention: { defeatBasisPoints: 5000, abandonBasisPoints: 0 },
    planHash: 'sha256:plan',
    ...patch,
  };
  return value;
}
async function open(permissions?: string[]) {
  dungeon.stored = { ...fixture(), draft: legacyDungeon() };
  renderAt('/admin/dungeons/definitions/tunnels', permissions);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Canvas room entrance' }));
  // The room's only activity opens by itself.
  await screen.findByTestId('legacy-treasure-note');
  return user;
}
const convertButton = () => screen.getByRole('button', { name: 'Convert to Dungeon Rewards' });
function converted(): api.DungeonTreasureConversionResult {
  const draft = legacyDungeon();
  draft.rooms[0]!.actions[0] = { ...base, id: 'a_chest', type: 'reward', rewards: REWARDS };
  dungeon.stored = { ...dungeon.stored, draft, draftRevision: 5, draftDiffers: true };
  return {
    dungeon: structuredClone(dungeon.stored),
    createdTables: ['converted_loot'],
    reusedTables: [],
    replayed: false,
  };
}

describe('converting a legacy treasure', () => {
  beforeEach(() => {
    vi.spyOn(api, 'planTreasureConversion').mockImplementation(async () => plan());
    vi.spyOn(api, 'convertTreasure').mockImplementation(async () => converted());
  });

  it('previews what is paid now, what will be paid, the new table and what is left out, and changes nothing', async () => {
    const user = await open();
    await user.click(convertButton());
    const dialog = within(await screen.findByTestId('treasure-conversion'));
    expect(api.planTreasureConversion).toHaveBeenCalledWith(
      'tunnels',
      { roomId: 'entrance', actionId: 'a_chest' },
      expect.anything(),
    );
    const today = within(await dialog.findByTestId('conversion-legacy'));
    expect(today.getByText('3–8 Baddie Shards')).toBeVisible();
    expect(today.getByText('Reward table: loot')).toBeVisible();
    expect(today.getByText('Gear reward table: none')).toBeVisible();

    const after = within(dialog.getByTestId('conversion-result'));
    expect(after.getByText('Always: 3–8 Baddie Shards')).toBeVisible();
    expect(after.getByText('Loot table “loot (converted)”, rolled once')).toBeVisible();

    const table = within(dialog.getByTestId('conversion-tables'));
    expect(table.getByText(/New:/)).toHaveTextContent('New: “loot (converted)”');
    expect(table.getByText('Always: 20–40 WaifuBux')).toBeVisible();
    // 3 : 1 : 12 shares, shown as the odds an author can check.
    expect(
      table.getByText(/“salvage”, picked twice: 18\.8% 2 Velvet Charm · 6\.25% .* · 75% nothing/),
    ).toBeVisible();
    expect(
      table.getByText(/That table is not changed and keeps working for expeditions/),
    ).toBeVisible();

    const never = within(dialog.getByTestId('conversion-never-paid'));
    expect(never.getByText('5–10 Essence (loot)')).toBeVisible();
    expect(never.getByText('30 player XP (loot)')).toBeVisible();
    expect(
      dialog.getByText(/never paid by a dungeon, so leaving them out changes nothing/),
    ).toBeVisible();
    expect(
      within(dialog.getByTestId('conversion-switched-off')).getByText(
        'Group "bonus" is switched off.',
      ),
    ).toBeVisible();
    // Keys and hashes are not what the author reads.
    expect(dialog.getByTestId('conversion-tables')).not.toHaveTextContent(/converted_loot|sha256/);
    expect(api.convertTreasure).not.toHaveBeenCalled();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });

  it('spells out the WaifuBux risk change and never calls the conversion identical', async () => {
    const user = await open();
    await user.click(convertButton());
    const warnings = await screen.findByTestId('conversion-warnings');
    expect(warnings).toHaveTextContent(
      'Today this treasure pays its WaifuBux straight away, and the player keeps them whatever happens next.',
    );
    expect(warnings).toHaveTextContent(
      'After converting, its WaifuBux are at risk until the player extracts or completes the dungeon.',
    );
    // The dungeon's own rates, not a generic sentence.
    expect(warnings).toHaveTextContent(
      'a defeated player keeps 50% and a player who abandons keeps 0%, so some or all of those WaifuBux can be lost.',
    );
    expect(warnings).toHaveTextContent(
      'a given run will not get the same loot it would have got before',
    );
    expect(warnings).toHaveTextContent(
      'Revisions already published keep paying the old way until you publish this dungeon again.',
    );
    expect(screen.getByTestId('treasure-conversion')).not.toHaveTextContent(
      /identical behaviour|behaves identically|no change in behaviour/i,
    );
  });

  it('leaves the treasure exactly as it was when the author cancels', async () => {
    const user = await open();
    await user.click(convertButton());
    await screen.findByTestId('conversion-warnings');
    await user.click(screen.getByRole('button', { name: 'Cancel, keep it as it is' }));
    await waitFor(() =>
      expect(screen.queryByTestId('treasure-conversion')).not.toBeInTheDocument(),
    );
    expect(api.convertTreasure).not.toHaveBeenCalled();
    // Still the old settings, still editable, still nothing to save.
    expect(screen.getByTestId('legacy-treasure-note')).toBeVisible();
    expect(screen.getByLabelText('Progression currency min')).toHaveValue(3);
    expect(screen.getByLabelText('Progression currency min')).toBeEnabled();
    expect(screen.queryByTestId('activity-rewards')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('converts only on confirmation, then edits the treasure with the Rewards section, unpublished', async () => {
    const user = await open();
    await user.click(convertButton());
    await user.click(await screen.findByRole('button', { name: 'Convert this treasure' }));
    await waitFor(() =>
      expect(api.convertTreasure).toHaveBeenCalledWith('tunnels', {
        roomId: 'entrance',
        actionId: 'a_chest',
        expectedRevision: 4,
        expectedPlanHash: 'sha256:plan',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('treasure-conversion')).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText(
        'Treasure converted, with 1 new loot table. Publication is unchanged.',
      ),
    ).toBeVisible();
    // The same room and activity, now with T14's Rewards section instead of the old fields.
    const rewards = within(await screen.findByTestId('activity-rewards'));
    expect(screen.queryByTestId('legacy-treasure-note')).not.toBeInTheDocument();
    expect(rewards.getByText('3–8 Baddie Shards')).toBeVisible();
    expect(rewards.getByRole('button', { name: '+ Add guaranteed reward' })).toBeEnabled();
    expect(rewards.getByRole('button', { name: '+ Add chance drop' })).toBeEnabled();
    // Nothing was published, and the draft is saved as converted.
    expect(api.publishDungeon).not.toHaveBeenCalled();
    expect(screen.getByTestId('publication-state')).toHaveTextContent('Dungeon changed');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByText('Draft 5')).toBeVisible();
  });

  it('asks for the draft to be saved first when the page holds unsaved changes', async () => {
    const user = await open();
    await user.clear(screen.getByLabelText('Progression currency max'));
    await user.type(screen.getByLabelText('Progression currency max'), '9');
    expect(convertButton()).toBeDisabled();
    expect(
      within(screen.getByTestId('convert-treasure')).getByText(/Save your draft first/),
    ).toBeVisible();
    expect(api.planTreasureConversion).not.toHaveBeenCalled();
    // Saving makes it available again, with the edit kept.
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(convertButton()).toBeEnabled());
    expect(screen.getByLabelText('Progression currency max')).toHaveValue(9);
  });

  it('explains what blocks a conversion and offers nothing to confirm', async () => {
    vi.mocked(api.planTreasureConversion).mockResolvedValue(
      plan({
        rewards: null,
        tables: [],
        blockers: [
          {
            code: 'conversion_table_missing',
            table: 'loot',
            message:
              'The reward table "loot" no longer exists. Clear it from this treasure, save, then convert.',
          },
        ],
      }),
    );
    const user = await open();
    await user.click(convertButton());
    expect(await screen.findByTestId('conversion-blockers')).toHaveTextContent(
      'The reward table "loot" no longer exists. Clear it from this treasure, save, then convert.',
    );
    expect(screen.getByText(/Nothing has been changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Convert this treasure' })).toBeDisabled();
    expect(screen.queryByTestId('conversion-result')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(api.convertTreasure).not.toHaveBeenCalled();
  });

  it('lists what will need fixing after converting, without ids', async () => {
    vi.mocked(api.planTreasureConversion).mockResolvedValue(
      plan({
        issues: [
          {
            code: 'reward_item_capped',
            severity: 'error',
            path: 'rooms[0].actions[0].rewards.tables[0].body.pools[0].entries[0].grant',
            message:
              'Room "Vault", activity "a_chest", loot table "loot (converted)", reward "i1": "Founder’s Badge" is limited to 1 per player, so it cannot be dungeon loot.',
          },
        ],
      }),
    );
    const user = await open();
    await user.click(convertButton());
    const issues = await screen.findByTestId('conversion-issues');
    expect(issues).toHaveTextContent('Fix: the loot table “loot (converted)”');
    expect(issues).toHaveTextContent('is limited to 1 per player');
    expect(issues).not.toHaveTextContent(/a_chest|rooms\[|"i1"/);
    // Dependency problems do not stop a conversion; they stop a publish.
    expect(screen.getByRole('button', { name: 'Convert this treasure' })).toBeEnabled();
  });

  it('does not apply a preview that has gone stale, and shows the new one on request', async () => {
    vi.mocked(api.convertTreasure).mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'DUNGEON_CONVERSION_STALE',
        message:
          'The treasure or a reward table it uses changed since this preview. Review the conversion again.',
      }),
    );
    const user = await open();
    await user.click(convertButton());
    await user.click(await screen.findByRole('button', { name: 'Convert this treasure' }));
    const error = within(await screen.findByTestId('conversion-error'));
    expect(error.getByText('Something changed since this preview was made')).toBeVisible();
    expect(error.getByText(/Nothing was changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Convert this treasure' })).toBeDisabled();
    vi.mocked(api.planTreasureConversion).mockResolvedValue(plan({ planHash: 'sha256:newer' }));
    await user.click(error.getByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(api.planTreasureConversion).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Convert this treasure' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Convert this treasure' }));
    await waitFor(() =>
      expect(api.convertTreasure).toHaveBeenLastCalledWith(
        'tunnels',
        expect.objectContaining({ expectedPlanHash: 'sha256:newer' }),
      ),
    );
  });

  it('is not offered to an admin who cannot edit', async () => {
    await open(['dungeons.read']);
    expect(convertButton()).toBeDisabled();
    expect(
      within(screen.getByTestId('convert-treasure')).getByText(
        'Converting needs permission to edit dungeons.',
      ),
    ).toBeVisible();
    expect(api.planTreasureConversion).not.toHaveBeenCalled();
  });
});

const entry = (patch: Partial<api.DungeonRewardHealthEntry>): api.DungeonRewardHealthEntry => ({
  key: 'tunnels',
  name: 'Tunnels',
  enabled: true,
  revision: 2,
  status: 'healthy',
  problems: [],
  draftErrors: 0,
  activeRuns: 0,
  activeRevisions: [],
  ...patch,
});

describe('Reward Health', () => {
  it('says so when every published reward can be delivered', async () => {
    vi.mocked(api.getDungeonRewardHealth).mockResolvedValue({
      dungeons: [
        entry({}),
        entry({ key: 'old', name: 'Old Mine', status: 'no_rewards' }),
        entry({ key: 'new', name: 'New Cave', status: 'unpublished', revision: null }),
      ],
    });
    renderAt('/admin/dungeons');
    const panel = within(await screen.findByTestId('reward-health'));
    expect(await panel.findByTestId('reward-health-ok')).toHaveTextContent(
      'Every published dungeon can deliver its rewards, and so can every older revision a run is still on.',
    );
    expect(panel.getByTestId('reward-health-counts')).toHaveTextContent(
      '1 dungeon healthy · 1 published with the older treasure settings only (nothing frozen to check) · 1 not published',
    );
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names each broken published reward, why, and what to do, apart from draft-only problems and loot changes', async () => {
    // The listed dungeon's loot has merely changed since publication.
    dungeon.stored = {
      ...fixture(),
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [
        {
          kind: 'table',
          tableKey: 'hoard',
          name: 'Hoard',
          status: 'changed',
          publishedHash: 'a',
          currentHash: 'b',
        },
      ],
    };
    vi.mocked(api.getDungeonRewardHealth).mockResolvedValue({
      dungeons: [
        entry({}),
        entry({
          key: 'vault',
          name: 'Deep Vault',
          revision: 7,
          status: 'broken',
          draftErrors: 2,
          problems: [
            {
              type: 'item',
              reason: 'item_capped',
              key: 'founders_badge',
              name: 'Founder’s Badge',
              message:
                '"Founder’s Badge" is now limited to 1 per player, so it cannot be dungeon loot.',
              hint: "Remove the per-player limit from the item, or replace it in the draft's rewards and publish again.",
            },
            {
              type: 'equipment',
              reason: 'equipment_missing',
              key: 'iron_blade',
              name: 'Iron Blade',
              message:
                'Gear "Iron Blade" (iron_blade) no longer exists, so this revision\'s loot cannot be paid.',
              hint: 'Publish the draft again so the revision freezes gear that exists.',
            },
            {
              type: 'snapshot',
              reason: 'snapshot_corrupt',
              key: null,
              name: 'Revision 7',
              message:
                "The frozen copy of this revision's rewards does not match its recorded hash, so it is not trusted.",
              hint: 'Publish the draft again to freeze a fresh copy of its rewards.',
            },
          ],
        }),
        entry({ key: 'wip', name: 'Work in Progress', draftErrors: 3 }),
      ],
    });
    renderAt('/admin/dungeons');
    const panel = within(await screen.findByTestId('reward-health'));
    expect(await panel.findByRole('alert')).toHaveTextContent(
      '1 published dungeon has rewards that cannot be delivered.',
    );
    const vault = within(panel.getByTestId('reward-health-vault'));
    expect(vault.getByRole('link', { name: 'Deep Vault' })).toHaveAttribute(
      'href',
      '/admin/dungeons/definitions/vault',
    );
    expect(vault.getByText('Broken published rewards')).toBeVisible();
    expect(vault.getByText('Published 7')).toBeVisible();
    expect(vault.getByText(/is now limited to 1 per player/)).toBeVisible();
    expect(vault.getByText(/Remove the per-player limit from the item/)).toBeVisible();
    expect(vault.getByText(/Gear "Iron Blade" \(iron_blade\) no longer exists/)).toBeVisible();
    expect(vault.getByText(/does not match its recorded hash/)).toBeVisible();
    expect(
      vault.getByText('Its draft also has 2 problems to fix before it can be published again.'),
    ).toBeVisible();

    // A draft problem is the author's to-do, not broken rewards.
    const drafts = within(panel.getByTestId('reward-health-drafts'));
    expect(drafts.getByText(/Players are not affected/)).toBeVisible();
    expect(drafts.getByRole('link', { name: 'Work in Progress' })).toBeVisible();
    expect(drafts.queryByText('Deep Vault')).not.toBeInTheDocument();
    expect(panel.queryByTestId('reward-health-wip')).not.toBeInTheDocument();

    // "Loot changed" stays a publication status; it is not a health problem.
    expect(await screen.findByTestId('publication-state-tunnels')).toHaveTextContent(
      'Loot changed',
    );
    expect(panel.queryByTestId('reward-health-tunnels')).not.toBeInTheDocument();
    expect(
      panel.getByText(/A loot table edited since a dungeon was published is not a problem here/),
    ).toBeVisible();
  });

  it('shows runs in progress on a broken older revision, apart from a healthy current publication', async () => {
    const capped: api.DungeonRewardHealthProblem = {
      type: 'item',
      reason: 'item_capped',
      key: 'old_prize',
      name: 'Old Prize',
      message: '"Old Prize" is now limited to 1 per player, so it cannot be dungeon loot.',
      hint: 'Remove the per-player limit from the item so these runs can be paid. Publishing again does not change a run in progress.',
    };
    vi.mocked(api.getDungeonRewardHealth).mockResolvedValue({
      dungeons: [
        // Healthy now, but three runs are still on revision 4, which cannot pay.
        entry({
          key: 'vault',
          name: 'Deep Vault',
          revision: 6,
          activeRuns: 2,
          activeRevisions: [
            { revision: 5, activeRuns: 1, status: 'healthy', problems: [] },
            { revision: 4, activeRuns: 3, status: 'broken', problems: [capped] },
          ],
        }),
        // Both at once: the current publication and an older revision.
        entry({
          key: 'mine',
          name: 'Old Mine',
          revision: 2,
          status: 'broken',
          activeRuns: 1,
          problems: [
            {
              ...capped,
              key: 'new_prize',
              name: 'New Prize',
              message: '"New Prize" is now limited to 1 per player, so it cannot be dungeon loot.',
              hint: "Remove the per-player limit from the item, or replace it in the draft's rewards and publish again.",
            },
          ],
          activeRevisions: [{ revision: 1, activeRuns: 1, status: 'broken', problems: [capped] }],
        }),
        // Runs on a healthy older revision are nothing to report.
        entry({
          key: 'fine',
          name: 'Fine Cave',
          activeRevisions: [{ revision: 1, activeRuns: 9, status: 'healthy', problems: [] }],
        }),
      ],
    });
    renderAt('/admin/dungeons');
    const panel = within(await screen.findByTestId('reward-health'));
    expect(await panel.findByTestId('reward-health-stranded')).toHaveTextContent(
      '2 dungeons have runs in progress on an older revision whose rewards cannot be delivered. Publishing again does not change a run that has already started.',
    );
    expect(panel.queryByTestId('reward-health-ok')).not.toBeInTheDocument();

    const vault = within(panel.getByTestId('reward-health-vault'));
    expect(vault.getByText('Current publication is healthy')).toBeVisible();
    expect(vault.getByText('Runs in progress affected')).toBeVisible();
    expect(vault.queryByText('Broken published rewards')).not.toBeInTheDocument();
    expect(panel.queryByTestId('reward-health-vault-current')).not.toBeInTheDocument();
    const older = within(panel.getByTestId('reward-health-vault-revision-4'));
    expect(
      older.getByText('Revision 4, no longer published, with 3 runs still in progress:'),
    ).toBeVisible();
    expect(older.getByText(/"Old Prize" is now limited to 1 per player/)).toBeVisible();
    expect(older.getByText(/Publishing again does not change a run in progress/)).toBeVisible();
    // The healthy older revision is not listed as a problem.
    expect(panel.queryByTestId('reward-health-vault-revision-5')).not.toBeInTheDocument();

    const mine = within(panel.getByTestId('reward-health-mine'));
    expect(mine.getByText('Broken published rewards')).toBeVisible();
    expect(
      within(panel.getByTestId('reward-health-mine-current')).getByText(
        'Published revision 2, which new runs start on (1 run in progress on it):',
      ),
    ).toBeVisible();
    expect(
      within(panel.getByTestId('reward-health-mine-revision-1')).getByText(
        'Revision 1, no longer published, with 1 run still in progress:',
      ),
    ).toBeVisible();

    expect(panel.queryByTestId('reward-health-fine')).not.toBeInTheDocument();
    // Counts only: nothing identifies a player.
    expect(screen.getByTestId('reward-health')).not.toHaveTextContent(/player ?id|discord|@/i);
  });

  it('reports a failed check instead of looking healthy', async () => {
    vi.mocked(api.getDungeonRewardHealth).mockRejectedValue(
      new PortalApiError({ status: 500, code: 'INTERNAL', message: 'Check failed' }),
    );
    renderAt('/admin/dungeons');
    const panel = within(await screen.findByTestId('reward-health'));
    expect(await panel.findByText('Could not check reward health')).toBeVisible();
    expect(panel.queryByTestId('reward-health-ok')).not.toBeInTheDocument();
  });
});
