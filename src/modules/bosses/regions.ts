/**
 * Boss-side view of the shared region primitive.
 *
 * The canonical list now lives in `modules/locations/regions.ts` — a region is
 * a player-facing place, not a boss-scheduling detail, so travel owns it. This
 * module stays as the boss subsystem's import site and narrows one thing:
 *
 * `REGIONS` here is the set of regions that may **host bosses**, which is not
 * the same question as which regions a player may stand in. Twin Peeks is a
 * travel destination with its own encounter pool and no boss roster; widening
 * this list to include it would make `bossEncounters.regions` default to a
 * region with no drawable boss, and `validateBossContent` would (correctly)
 * refuse to boot. Boss content and boss scheduling therefore keep exactly the
 * behavior they had before travel existed, and this list widens the day a
 * Twin Peeks boss is authored.
 */
import { REGIONS as ALL_REGIONS } from '../locations/regions';

export { DEFAULT_REGION, isRegion, regionLabel } from '../locations/regions';
export type { Region } from '../locations/regions';

/** Every region a player can be in — the superset this module narrows from. */
export { ALL_REGIONS };

/** Regions that may schedule and host bosses. Deliberately narrower. */
export const REGIONS = ['waifu-valley'] as const;
/** A region that boss content may name. */
export type BossRegion = (typeof REGIONS)[number];
