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
import { appliedBuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';

/** A fired `essence_gain` bonus, shaped exactly as the domain hands one over. */
function essenceBonus(value = 30, name = 'Extra Serving') {
  return appliedBuddyBonus(
    {
      name,
      flavorText: `${name}: +${value}% Essence gained.`,
      effectId: 'essence_gain',
      value,
    },
    { base: 40, final: 52 },
  );
}

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

  it('marks a Buddy-adjusted Essence quote with a star', () => {
    // The compact form: the number is already the adjusted one, and the star
    // points at the board-level line that names the bonus. A per-quest
    // breakdown would repeat the same sentence under every quest.
    const out = formatRewardSummary({
      waifubux: 50,
      essence: 52,
      essenceBonus: essenceBonus(),
      items: [{ name: 'Basic Charm', emoji: '🧿', quantity: 1 }],
    });
    expect(out).toBe('50 WaifuBux, 52 Essence ✨, 🧿 Basic Charm ×1');
  });

  it('leaves an unbonused quote exactly as it always rendered', () => {
    // The no-bonus path is byte-for-byte what shipped, which is what keeps the
    // post-claim summary — which never sets `essenceBonus` — untouched.
    const out = formatRewardSummary({ waifubux: 50, essence: 40, items: [] });
    expect(out).toBe('50 WaifuBux, 40 Essence');
    expect(out).not.toContain('✨');
  });

  it('never stars a reward bundle with no Essence in it', () => {
    const out = formatRewardSummary({
      waifubux: 25,
      essence: 0,
      essenceBonus: essenceBonus(),
      items: [{ name: 'Basic Charm', emoji: '🧿', quantity: 1 }],
    });
    expect(out).toBe('25 WaifuBux, 🧿 Basic Charm ×1');
  });

  it('leaves Waifubux and items untouched when Essence is adjusted', () => {
    const plain = formatRewardSummary({
      waifubux: 50,
      essence: 40,
      items: [{ name: 'Silk Charm', emoji: null, quantity: 2 }],
    });
    const bonused = formatRewardSummary({
      waifubux: 50,
      essence: 52,
      essenceBonus: essenceBonus(),
      items: [{ name: 'Silk Charm', emoji: null, quantity: 2 }],
    });
    // Only the Essence clause differs; `essence_gain` scales Essence and
    // nothing else.
    expect(plain.replace('40 Essence', 'X')).toBe(bonused.replace('52 Essence ✨', 'X'));
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

  it('names the Essence Buddy Bonus once, under every quote it explains', () => {
    const { embed } = questsView(
      [questRow({ rewardsLabel: '25 WaifuBux, 52 Essence ✨' })],
      false,
      {
        ...noBonus,
        essenceBonusNote: '✨ Essence shown includes ✨ Extra Serving: +30% from your Buddy.',
      },
    );
    const desc = embed.data.description ?? '';
    expect(desc).toContain('52 Essence ✨');
    expect(desc).toContain('Extra Serving: +30%');
    // Once for the whole board, not once per quest.
    expect(desc.match(/Extra Serving/g)).toHaveLength(1);
  });

  it('omits the note entirely when no Buddy raises Essence', () => {
    const { embed } = questsView([questRow()], false, {
      ...noBonus,
      essenceBonusNote: null,
    });
    expect(embed.data.description ?? '').not.toContain('✨ Essence shown includes');
  });

  it('handles an empty quest list', () => {
    const { embed } = questsView([], false, noBonus);
    expect(embed.data.description).toContain('No quests today');
  });
});
