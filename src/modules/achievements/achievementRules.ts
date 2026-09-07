/**
 * Achievement evaluation — the pure core (Achievements & Leaderboards, Phase 1).
 *
 * This module knows nothing about the database, Fastify, or React. It turns a
 * player's **metric snapshot** plus their **persisted unlock rows** into
 * resolved, hidden-safe achievement state. Keeping the rules here — not in SQL
 * and not in the Portal — is the whole point of §2/§18: an achievement is a
 * content definition evaluated in one place, never a scattered `if` in a
 * gameplay handler and never a calculation duplicated in the client.
 *
 * A resolved achievement is already presentation-safe: a hidden achievement
 * that is still locked carries no name, description, criteria, or progress —
 * only the fact that a hidden badge exists. The backend never ships hidden
 * criteria and the Portal never has to decide what to redact.
 */

/**
 * Every metric an achievement may test. Each is a plain number derived from
 * canonical current/durable player state — see `achievementService` for how
 * each is queried. Boolean-shaped facts (a rarity ever captured, a buddy ever
 * set) are exposed as 0/1 so a single `{ metric, target }` criteria model
 * covers counts and one-shots alike.
 */
export const ACHIEVEMENT_METRICS = [
  'level',
  'xp',
  'hunts',
  'captures',
  'distinct_species',
  'boss_participations',
  'regions_visited',
  'buddy_set',
  'buddy_affection',
  'first_sr',
  'first_ssr',
  'first_ur',
  'first_lr',
] as const;

export type AchievementMetric = (typeof ACHIEVEMENT_METRICS)[number];

export type MetricSnapshot = Record<AchievementMetric, number>;

export const ACHIEVEMENT_CATEGORIES = [
  'hunting',
  'collection',
  'rarity',
  'buddy',
  'progression',
  'travel',
  'bosses',
  'special',
] as const;

export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export interface AchievementCriteria {
  metric: AchievementMetric;
  /** The value the metric must reach for the badge to unlock. */
  target: number;
}

/**
 * A content-authored achievement. Lives in `content/achievements.json`; adding
 * or retiring one is a content edit, never a migration or a code change.
 */
export interface AchievementDefinition {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  /** A hidden achievement reveals nothing about itself until it is unlocked. */
  hidden: boolean;
  /** Groups a tiered series (e.g. `hunter`), for presentation only. */
  series: string | null;
  /** Tier within the series, 1-based. */
  tier: number | null;
  /** Optional badge/emoji reference; presentation only. */
  icon: string | null;
  criteria: AchievementCriteria;
}

export type AchievementStatus = 'locked' | 'in_progress' | 'unlocked';

export interface ResolvedProgress {
  current: number;
  target: number;
}

/**
 * A resolved achievement, safe to serialise to any surface. For a hidden,
 * still-locked achievement, `name`/`description` are the generic placeholders
 * and `progress`/`series`/`tier`/`icon` are null — nothing about its criteria
 * leaves the backend.
 */
export interface ResolvedAchievement {
  id: string;
  category: AchievementCategory;
  hidden: boolean;
  status: AchievementStatus;
  unlocked: boolean;
  unlockedAt: string | null;
  name: string;
  description: string;
  icon: string | null;
  series: string | null;
  tier: number | null;
  progress: ResolvedProgress | null;
}

export interface AchievementSummary {
  total: number;
  unlocked: number;
  /** Whole-number percent 0–100. */
  completionPercent: number;
}

export const HIDDEN_NAME = '???';
export const HIDDEN_DESCRIPTION = 'Hidden Achievement';

function metricValue(snapshot: MetricSnapshot, metric: AchievementMetric): number {
  const raw = snapshot[metric];
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Resolve one definition against a snapshot and any persisted unlock.
 *
 * `unlockedAt` is the durable first-earned timestamp when one exists. A badge
 * with a persisted unlock stays unlocked forever, even if the live metric has
 * since dipped below target — an earned achievement never reverts.
 */
export function evaluateAchievement(
  def: AchievementDefinition,
  snapshot: MetricSnapshot,
  unlockedAt: Date | string | null,
): ResolvedAchievement {
  const value = metricValue(snapshot, def.criteria.metric);
  const target = def.criteria.target;
  const alreadyUnlocked = unlockedAt !== null && unlockedAt !== undefined;
  const meetsTarget = value >= target;
  const unlocked = alreadyUnlocked || meetsTarget;

  const status: AchievementStatus = unlocked
    ? 'unlocked'
    : value > 0
      ? 'in_progress'
      : 'locked';

  const unlockedAtIso =
    unlockedAt instanceof Date
      ? unlockedAt.toISOString()
      : typeof unlockedAt === 'string'
        ? unlockedAt
        : null;

  // Hidden + locked: reveal only that a hidden badge exists.
  const concealed = def.hidden && !unlocked;

  return {
    id: def.id,
    category: def.category,
    hidden: def.hidden,
    status,
    unlocked,
    unlockedAt: unlockedAtIso,
    name: concealed ? HIDDEN_NAME : def.name,
    description: concealed ? HIDDEN_DESCRIPTION : def.description,
    icon: concealed ? null : def.icon,
    series: concealed ? null : def.series,
    tier: concealed ? null : def.tier,
    progress: concealed ? null : { current: Math.min(value, target), target },
  };
}

export function resolveAchievements(
  definitions: readonly AchievementDefinition[],
  snapshot: MetricSnapshot,
  unlockedAtById: ReadonlyMap<string, Date | string>,
): ResolvedAchievement[] {
  return definitions.map((def) =>
    evaluateAchievement(def, snapshot, unlockedAtById.get(def.id) ?? null),
  );
}

export function summarize(resolved: readonly ResolvedAchievement[]): AchievementSummary {
  const total = resolved.length;
  const unlocked = resolved.reduce((n, a) => n + (a.unlocked ? 1 : 0), 0);
  const completionPercent = total === 0 ? 0 : Math.round((unlocked / total) * 100);
  return { total, unlocked, completionPercent };
}

/**
 * The ids a resolve pass found newly unlocked — qualified now but with no
 * persisted row yet. The service stamps these with an `unlocked_at`.
 */
export function newlyUnlockedIds(
  definitions: readonly AchievementDefinition[],
  snapshot: MetricSnapshot,
  unlockedAtById: ReadonlyMap<string, Date | string>,
): { id: string; progress: number }[] {
  const out: { id: string; progress: number }[] = [];
  for (const def of definitions) {
    if (unlockedAtById.has(def.id)) continue;
    const value = metricValue(snapshot, def.criteria.metric);
    if (value >= def.criteria.target) out.push({ id: def.id, progress: value });
  }
  return out;
}
