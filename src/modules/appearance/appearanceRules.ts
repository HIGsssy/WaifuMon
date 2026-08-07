/**
 * Appearance unlock rules — pure, total, deterministic, side-effect free.
 *
 * The whole of V1's unlock logic lives in one function over one small context
 * object. That is the point: `isUnlocked` is safe to call from the Platform
 * API, from Discord, from a Portal mock, and from a unit test, and it can never
 * disagree with itself between surfaces.
 *
 * **Derived, not persisted.** Both V1 sources are pure functions of state the
 * database already holds — `owned` is "the row exists", `level` is
 * `player_waifus.level`. Nothing records that an appearance was unlocked, which
 * is what makes retroactive content free: ship Level-20 artwork today and every
 * copy already past Level 20 has it unlocked the instant the loader sees it, no
 * backfill, no migration, no reconciler.
 *
 * **Cosmetic invariant.** This module *reads* level; it writes nothing and
 * returns nothing gameplay consumes. No stat, XP grant, affection tick,
 * evolution step, or capture roll is reachable from here.
 *
 * Future grant-driven sources (event, seasonal, achievement, promotion,
 * admin_grant) become one more field on {@link AppearanceUnlockContext} and one
 * more case below — see `.ai/appearanceplan.md` § Future Appearance Sources.
 */
import type { AppearanceUnlock } from '../content/schemas';
import type { ResolvedAppearance } from './appearanceContent';

export { formatUnlockLabel } from './appearanceContent';

/**
 * Everything V1 needs to decide any unlock.
 *
 * `level` is the *waifu's* level (per owned copy), never the player's — a
 * player's account level says nothing about one Waifumon's wardrobe.
 */
export interface AppearanceUnlockContext {
  /** Per-copy level from `player_waifus.level`. */
  level: number;
}

/** Whether this owned copy has earned the appearance. Total; never throws. */
export function isUnlocked(
  unlock: AppearanceUnlock,
  ctx: AppearanceUnlockContext,
): boolean {
  switch (unlock.type) {
    case 'owned':
      // The context only exists for an owned copy, so ownership is implied.
      return true;
    case 'level':
      return ctx.level >= unlock.atLevel;
    default: {
      const _never: never = unlock;
      void _never;
      // Unreachable in V1 (the content schema rejects reserved types), and a
      // conservative false is the right answer if it ever is: an unimplemented
      // source must never hand out artwork by accident.
      return false;
    }
  }
}

/** Convenience: the same decision, given a resolved appearance. */
export function isAppearanceUnlocked(
  appearance: ResolvedAppearance,
  ctx: AppearanceUnlockContext,
): boolean {
  return isUnlocked(appearance.unlock, ctx);
}

/**
 * Unlocked appearances this copy has not been notified about.
 *
 * Pure — it decides *what* to announce; persisting the acknowledgement is
 * `appearanceService.acknowledgeUnlocks`'s job, inside a transaction.
 */
export function detectNewlyUnlocked(
  appearances: readonly ResolvedAppearance[],
  ctx: AppearanceUnlockContext,
  seenAppearances: readonly string[],
): ResolvedAppearance[] {
  const seen = new Set(seenAppearances);
  return appearances.filter((a) => !seen.has(a.id) && isAppearanceUnlocked(a, ctx));
}
