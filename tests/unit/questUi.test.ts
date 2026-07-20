/**
 * Daily Quests UI helpers — reward formatting and the quest board view.
 * These are the pure pieces of the claim-visibility fix: every quest shows a
 * reward preview, claimed quests keep showing what they awarded, and claim
 * results (or "nothing to claim") render on the board itself.
 */
import { describe, expect, it } from 'vitest';
import {
  formatRewardSummary,
  questsView,
  type QuestRow,
} from '../../src/discord/commands/waifumon';

function questRow(overrides: Partial<QuestRow> = {}): QuestRow {
  return {
    id: 1,
    slug: 'test_q',
    title: 'Warm-Up Hunt',
    description: 'Spend 5 Hunt Energy.',
    target: 5,
    progress: 2,
    completedAt: null,
    claimedAt: null,
    rewardsLabel: '25 WaifuBux, 🧿 Basic Charm ×1',
    ...overrides,
  };
}

describe('formatRewardSummary', () => {
  it('formats waifubux, essence, and named items in order', () => {
    const out = formatRewardSummary({
      waifubux: 50,
      essence: 10,
      items: [
        { name: 'Basic Charm', emoji: '🧿', quantity: 1 },
        { name: 'Silk Charm', emoji: null, quantity: 1 },
      ],
    });
    expect(out).toBe('50 WaifuBux, 10 Essence, 🧿 Basic Charm ×1, • Silk Charm ×1');
  });

  it('aggregates duplicate items by name', () => {
    const out = formatRewardSummary({
      waifubux: 0,
      essence: 0,
      items: [
        { name: 'Basic Charm', emoji: '🧿', quantity: 1 },
        { name: 'Basic Charm', emoji: '🧿', quantity: 2 },
      ],
    });
    expect(out).toBe('🧿 Basic Charm ×3');
  });

  it('omits zero components', () => {
    expect(formatRewardSummary({ waifubux: 15, essence: 0, items: [] })).toBe('15 WaifuBux');
  });
});

describe('questsView', () => {
  const noBonus = { bonusPreview: null, bonusClaimed: false };

  it('shows a reward preview for in-progress quests with progress/target', () => {
    const { embed } = questsView([questRow()], false, noBonus);
    const desc = embed.data.description ?? '';
    expect(desc).toContain('**Warm-Up Hunt**');
    expect(desc).toContain('⏳ In Progress (2/5)');
    expect(desc).toContain('_Spend 5 Hunt Energy._');
    expect(desc).toContain('Rewards: 25 WaifuBux, 🧿 Basic Charm ×1');
  });

  it('marks completed-unclaimed quests as ready to claim with an enabled button', () => {
    const { embed, components } = questsView(
      [questRow({ progress: 5, completedAt: new Date() })],
      true,
      noBonus,
    );
    expect(embed.data.description).toContain('🎁 Complete — ready to claim (5/5)');
    const claimBtn = components[0]!.components[0]!;
    expect(claimBtn.data).toMatchObject({ disabled: false });
  });

  it('claimed quests stay visibly claimed and keep their reward summary', () => {
    const { embed, components } = questsView(
      [questRow({ progress: 5, completedAt: new Date(), claimedAt: new Date() })],
      false,
      noBonus,
    );
    const desc = embed.data.description ?? '';
    expect(desc).toContain('✅ Claimed (5/5)');
    expect(desc).toContain('Rewards: 25 WaifuBux, 🧿 Basic Charm ×1');
    const claimBtn = components[0]!.components[0]!;
    expect(claimBtn.data).toMatchObject({ disabled: true });
  });

  it('shows the all-complete bonus preview and its claimed state', () => {
    const pending = questsView([questRow()], false, {
      bonusPreview: '50 WaifuBux, • Silk Charm ×1',
      bonusClaimed: false,
    });
    expect(pending.embed.data.description).toContain(
      '🏆 **All-complete bonus** — complete all quests to earn: 50 WaifuBux, • Silk Charm ×1',
    );
    const claimed = questsView([questRow()], false, {
      bonusPreview: '50 WaifuBux, • Silk Charm ×1',
      bonusClaimed: true,
    });
    expect(claimed.embed.data.description).toContain(
      '🏆 **All-complete bonus** — ✅ Claimed · 50 WaifuBux, • Silk Charm ×1',
    );
  });

  it('renders claim-result notice lines on the board', () => {
    const { embed } = questsView([questRow()], false, {
      ...noBonus,
      noticeLines: [
        'Claimed rewards: 50 WaifuBux, 🧿 Basic Charm ×1',
        '🎉 All-complete bonus: 50 WaifuBux',
      ],
    });
    const field = embed.data.fields?.find((f) => f.name === '🧾 Claim Results');
    expect(field?.value).toContain('Claimed rewards: 50 WaifuBux, 🧿 Basic Charm ×1');
    expect(field?.value).toContain('🎉 All-complete bonus: 50 WaifuBux');
  });

  it('renders the nothing-to-claim notice', () => {
    const { embed } = questsView([questRow()], false, {
      ...noBonus,
      noticeLines: ['No completed quests are ready to claim yet.'],
    });
    const field = embed.data.fields?.find((f) => f.name === '🧾 Claim Results');
    expect(field?.value).toBe('No completed quests are ready to claim yet.');
  });

  it('handles an empty quest list', () => {
    const { embed } = questsView([], false, noBonus);
    expect(embed.data.description).toContain('No quests today');
  });
});
