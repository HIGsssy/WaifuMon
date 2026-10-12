import { describe, expect, it } from 'vitest';
import { pinnedRewardBonuses } from '../../../src/modules/dungeons/dungeonFighter';
import type { BuddyBonus } from '../../../src/modules/buddyBonus/buddyBonusEffects';
import {
  WAIFU_UNAVAILABILITY_REASONS, WAIFU_UNAVAILABILITY_LABELS, WAIFU_UNAVAILABILITY_BADGES,
} from '../../../src/modules/collection/waifuAvailability';
import { WaifuReleaseBlockedError, WaifuUnavailableError } from '../../../src/shared/errors';

const bonus = (effectId: BuddyBonus['effectId']): BuddyBonus => ({ effectId, value: 17.5, name: 'Pinned Bonus', flavorText: '' });

describe('pinned dungeon reward bonuses', () => {
  it.each(['affection_gain', 'essence_gain'] as const)('pins %s and the available source metadata', (effectId) => {
    const authored = bonus(effectId);
    const pinned = pinnedRewardBonuses('test_species', authored);
    expect(pinned).toEqual({
      affectionGainPercent: effectId === 'affection_gain' ? 17.5 : 0,
      essenceGainPercent: effectId === 'essence_gain' ? 17.5 : 0,
      source: { speciesSlug: 'test_species', effectId, bonusName: 'Pinned Bonus' },
    });
    authored.value = 99;
    authored.name = 'Reloaded';
    expect(pinned.source?.bonusName).toBe('Pinned Bonus');
    expect(pinned.affectionGainPercent + pinned.essenceGainPercent).toBe(17.5);
  });

  it('new runs without an applicable reward bonus pin zero and no source', () => {
    for (const authored of [null, bonus('buddy_xp_gain')]) {
      expect(pinnedRewardBonuses('test_species', authored)).toEqual({ affectionGainPercent: 0, essenceGainPercent: 0, source: null });
    }
  });

  it('provides dungeon wording for shared availability and both refusal errors', () => {
    expect(WAIFU_UNAVAILABILITY_REASONS).toContain('in_dungeon');
    expect(WAIFU_UNAVAILABILITY_BADGES.in_dungeon).toBe('In Dungeon');
    const message = 'She is in a dungeon run. Finish or abandon the run first.';
    expect(WAIFU_UNAVAILABILITY_LABELS.in_dungeon).toBe(message);
    expect(new WaifuReleaseBlockedError(['buddy', 'in_dungeon']).userMessage).toBe(message);
    expect(new WaifuUnavailableError(['in_dungeon']).userMessage).toBe(message);
  });
});
