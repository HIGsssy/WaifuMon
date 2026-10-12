import { describe, expect, it } from 'vitest';
import { friendlyIssue } from '../dungeonText';
import { starterDungeon } from '../dungeonModel';
import type { DungeonIssue } from '@/api/adminDungeons';

const definition = starterDungeon('text', 'Friendly Tunnels', []);
const codes = [
  'reward_item_missing',
  'reward_item_capped',
  'reward_item_disabled',
  'reward_equipment_empty',
  'reward_table_missing',
  'reward_table_archived',
  'reward_table_invalid',
  'reward_too_much_gear',
  'reward_too_many_draws',
  'reward_affection_too_large',
  'reward_currency_too_large',
  'reward_pool_all_nothing',
  'reward_legacy_mixed',
];
describe('friendly reward validation messages', () => {
  it.each(['guaranteed[0].grant', 'tables[0].body.guaranteed[0].grant'])(
    'directs missing Shard currency at %s to dungeon settings',
    (path) => {
      const friendly = friendlyIssue(
        {
          code: 'reward_shards_unset',
          severity: 'error',
          path: `rooms[0].actions[0].rewards.${path}`,
          message: 'This dungeon has no progression currency set.',
        },
        definition,
      );
      expect(friendly).toMatchObject({
        level: 'fix',
        target: { kind: 'room', id: definition.rooms[0]!.id },
        actionId: null,
        settingsField: 'progressionCurrency',
      });
      expect(friendly.help).toContain('Dungeon Settings');
      expect(friendly.help).not.toContain('Open the table');
    },
  );
  it.each(codes)('renders %s as author-facing text with a room target', (code) => {
    const room = definition.rooms[0]!;
    const issue: DungeonIssue = {
      code,
      severity: code === 'reward_pool_all_nothing' ? 'warning' : 'error',
      path: 'rooms[0].actions[0].rewards.tables[0].body.guaranteed[0]',
      message: `Room "${room.id}", activity "treasure": "Velvet Charm" in loot table "Boss Hoard" needs repair. Pick another item.`,
    };
    const friendly = friendlyIssue(issue, definition);
    expect(friendly.title).toContain('Velvet Charm');
    expect(friendly.title).toContain('Boss Hoard');
    expect(friendly.title).not.toContain(issue.path);
    expect(friendly.title).not.toContain(code);
    expect(friendly.target).toEqual({ kind: 'room', id: room.id });
    expect(friendly.level).toBe(issue.severity === 'warning' ? 'review' : 'fix');
  });
  it('renders the retention warning as a dungeon setting to review', () => {
    const result = friendlyIssue(
      {
        code: 'reward_abandon_more_than_defeat',
        severity: 'warning',
        path: 'settings.abandonCurrencyRetentionBasisPoints',
        message:
          'Leaving early keeps more Baddie Shards than losing a fight. Review the retention settings.',
      },
      definition,
    );
    expect(result.level).toBe('review');
    expect(result.title).toContain('Review the retention settings');
    expect(result.target).toBeNull();
  });
  it('keeps empty v2 rewards at review level', () => {
    const result = friendlyIssue(
      {
        code: 'reward_empty',
        severity: 'warning',
        path: 'rooms[0].actions[0].rewards',
        message: 'This Rewards section gives nothing yet.',
      },
      definition,
    );
    expect(result.level).toBe('review');
    expect(result.title).toContain('Rewards section gives nothing');
  });
});
