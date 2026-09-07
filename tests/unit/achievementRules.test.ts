/**
 * Pure achievement evaluation — locked/in-progress/unlocked, hidden-safe
 * presentation, tier independence, and summary counts. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAchievement,
  newlyUnlockedIds,
  resolveAchievements,
  summarize,
  HIDDEN_DESCRIPTION,
  HIDDEN_NAME,
  type AchievementDefinition,
  type MetricSnapshot,
} from '../../src/modules/achievements/achievementRules';

const ZERO: MetricSnapshot = {
  level: 0,
  xp: 0,
  hunts: 0,
  captures: 0,
  distinct_species: 0,
  boss_participations: 0,
  regions_visited: 1,
  buddy_set: 0,
  buddy_affection: 0,
  first_sr: 0,
  first_ssr: 0,
  first_ur: 0,
  first_lr: 0,
};

function snapshot(overrides: Partial<MetricSnapshot>): MetricSnapshot {
  return { ...ZERO, ...overrides };
}

const hunter2: AchievementDefinition = {
  id: 'hunter_2',
  name: 'Getting the Hang of It',
  description: 'Complete 25 hunts.',
  category: 'hunting',
  hidden: false,
  series: 'hunter',
  tier: 2,
  icon: '🏹',
  criteria: { metric: 'hunts', target: 25 },
};

const hidden: AchievementDefinition = {
  id: 'secret',
  name: 'Soulbound',
  description: 'Reach 5000 Affection.',
  category: 'special',
  hidden: true,
  series: null,
  tier: null,
  icon: '🔮',
  criteria: { metric: 'buddy_affection', target: 5000 },
};

describe('evaluateAchievement — derived state', () => {
  it('is locked with zero progress when the metric is untouched', () => {
    const r = evaluateAchievement(hunter2, ZERO, null);
    expect(r.status).toBe('locked');
    expect(r.unlocked).toBe(false);
    expect(r.progress).toEqual({ current: 0, target: 25 });
    expect(r.unlockedAt).toBeNull();
  });

  it('reports in-progress with clamped current below target', () => {
    const r = evaluateAchievement(hunter2, snapshot({ hunts: 10 }), null);
    expect(r.status).toBe('in_progress');
    expect(r.unlocked).toBe(false);
    expect(r.progress).toEqual({ current: 10, target: 25 });
  });

  it('unlocks when the metric reaches the target', () => {
    const r = evaluateAchievement(hunter2, snapshot({ hunts: 25 }), null);
    expect(r.status).toBe('unlocked');
    expect(r.unlocked).toBe(true);
    expect(r.progress).toEqual({ current: 25, target: 25 });
  });

  it('clamps current to target when the metric overshoots', () => {
    const r = evaluateAchievement(hunter2, snapshot({ hunts: 999 }), null);
    expect(r.progress).toEqual({ current: 25, target: 25 });
  });

  it('stays unlocked from a persisted row even if the metric later dips', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const r = evaluateAchievement(hunter2, ZERO, when);
    expect(r.unlocked).toBe(true);
    expect(r.status).toBe('unlocked');
    expect(r.unlockedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('evaluateAchievement — hidden presentation', () => {
  it('hidden + locked leaks no name, description, criteria, or progress', () => {
    const r = evaluateAchievement(hidden, snapshot({ buddy_affection: 100 }), null);
    expect(r.name).toBe(HIDDEN_NAME);
    expect(r.description).toBe(HIDDEN_DESCRIPTION);
    expect(r.progress).toBeNull();
    expect(r.series).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.icon).toBeNull();
    // The real criteria value never appears anywhere on the resolved object.
    expect(JSON.stringify(r)).not.toContain('5000');
    expect(JSON.stringify(r)).not.toContain('Soulbound');
  });

  it('hidden + unlocked reveals the normal presentation', () => {
    const r = evaluateAchievement(hidden, snapshot({ buddy_affection: 5000 }), null);
    expect(r.name).toBe('Soulbound');
    expect(r.description).toBe('Reach 5000 Affection.');
    expect(r.progress).toEqual({ current: 5000, target: 5000 });
    expect(r.icon).toBe('🔮');
  });
});

describe('tiered achievements resolve independently', () => {
  const hunter1: AchievementDefinition = { ...hunter2, id: 'hunter_1', tier: 1, criteria: { metric: 'hunts', target: 1 } };
  const hunter3: AchievementDefinition = { ...hunter2, id: 'hunter_3', tier: 3, criteria: { metric: 'hunts', target: 100 } };

  it('unlocks lower tiers while higher tiers stay in progress', () => {
    const resolved = resolveAchievements(
      [hunter1, hunter2, hunter3],
      snapshot({ hunts: 30 }),
      new Map(),
    );
    expect(resolved.map((r) => r.status)).toEqual(['unlocked', 'unlocked', 'in_progress']);
  });
});

describe('newlyUnlockedIds', () => {
  it('returns only ids at/over target without a persisted row', () => {
    const already = new Map<string, Date>([['hunter_2', new Date()]]);
    const newly = newlyUnlockedIds(
      [hunter2, { ...hunter2, id: 'hunter_x', criteria: { metric: 'hunts', target: 5 } }],
      snapshot({ hunts: 25 }),
      already,
    );
    expect(newly).toEqual([{ id: 'hunter_x', progress: 25 }]);
  });
});

describe('summarize', () => {
  it('counts unlocked and computes a whole-number completion percent', () => {
    const resolved = resolveAchievements(
      [
        hunter2,
        { ...hunter2, id: 'a' },
        { ...hunter2, id: 'b' },
        { ...hunter2, id: 'c' },
      ],
      snapshot({ hunts: 25 }),
      new Map(),
    );
    // All four share the same metric/target, so all unlock.
    expect(summarize(resolved)).toEqual({ total: 4, unlocked: 4, completionPercent: 100 });
  });

  it('rounds partial completion', () => {
    const resolved = resolveAchievements(
      [hunter2, { ...hunter2, id: 'locked', criteria: { metric: 'hunts', target: 1000 } }, { ...hunter2, id: 'locked2', criteria: { metric: 'hunts', target: 1000 } }],
      snapshot({ hunts: 25 }),
      new Map(),
    );
    expect(summarize(resolved)).toEqual({ total: 3, unlocked: 1, completionPercent: 33 });
  });
});
