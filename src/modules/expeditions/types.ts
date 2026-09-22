/**
 * Shared expedition shapes: the snapshot written at deployment, and the views
 * the service hands back.
 *
 * The snapshot is the interesting one. Everything else here is a projection.
 */
import type {
  ExpeditionRewardTable,
  ExpeditionType,
  MatchQuality,
  RegionalExpedition,
} from '../content/schemas';
import type {
  Affinity,
  ExpeditionOutcome,
  ExpeditionStatus,
  PlayerExpeditionRow,
} from '../../db/schema';
import type { RaceCode } from '../cards/race';
import type { ExpeditionRewardPayload } from './expeditionRewards';
import type { SuitabilityFactor } from './expeditionMath';
import type { MatchAssessment } from './expeditionMatch';

/**
 * Current version of the persisted snapshot's own shape.
 *
 * Distinct from `EXPEDITION_LOGIC_VERSION`, which versions the *maths*. This
 * versions the *envelope*: if a future phase adds a field resolution depends
 * on, old rows still carry the old shape and the reader must know which it is
 * holding. Stored inside the snapshot rather than beside it so the two can
 * never be separated.
 */
export const EXPEDITION_PLAN_VERSION = 1;

/**
 * Everything resolution needs, copied out of content at deployment.
 *
 * This is the immutable contract. Once it is written, resolving the mission
 * reads nothing from the live content snapshot — not the definition, not the
 * tables, not `tables.expeditions`. That is what lets content be retuned,
 * disabled, re-authored or deployed afresh while a mission is in flight, and
 * still have that mission finish under the rules it was started under.
 *
 * What is deliberately **not** here: the suitability config. The chances it
 * produced are already persisted as columns, and persisting the inputs as well
 * would be storing the same fact twice — with the usual consequence that the
 * two disagree and nobody knows which one is real.
 *
 * What is deliberately here but not strictly needed to *resolve*: the display
 * block. A mission whose definition has been deleted from content still has to
 * render its own name on the active screen, and "Unknown Expedition" is a
 * worse answer than three fields of duplicated text.
 */
export interface ExpeditionResolutionPlan {
  planVersion: number;
  /** Identity of the definition this came from, for audit and history. */
  definition: {
    key: string;
    name: string;
    description: string;
    emoji: string | null;
    type: ExpeditionType;
    durationMinutes: number;
    recommendedLevel: number;
  };
  /**
   * The three payout tables, copied whole. `null` where the definition named
   * none — a mission with no failure table pays nothing on a failure, and one
   * with no bonus table pays an ordinary success even when it excels.
   *
   * Also `null` on a row that has already resolved or been cancelled: the
   * tables are trimmed at that point because nothing can roll them again. The
   * `definition` block above is deliberately kept, so a finished mission can
   * still name itself even if content has since deleted it.
   */
  successTable: ExpeditionRewardTable | null;
  bonusTable: ExpeditionRewardTable | null;
  failureTable: ExpeditionRewardTable | null;
}

/** One deployable copy, with the match quality the player is shown. */
export interface ExpeditionCandidate {
  waifuId: number;
  name: string;
  level: number;
  /**
   * How well she fits the mission's stated requirements, with the per-axis
   * verdicts that explain it. `match.quality` is what the player reads; the
   * verdicts drive the chips, so the UI never re-derives a tick or a cross.
   * `match.score` is internal, like `successChance`.
   */
  match: MatchAssessment;
  /**
   * Her affinity and race, resolved the same way the maths resolved them.
   *
   * Carried so a UI can *explain* a match without being handed the chance that
   * produced it — "Dominant ✓ • Demon ✗" is the non-numeric account of why a
   * match is what it is. A presentation layer must never re-derive these:
   * race in particular is content, not a column, and a second resolver would
   * drift from the one the chance was computed with.
   */
  affinity: Affinity;
  race: RaceCode;
  /** Present and non-empty means she cannot be sent; the UI greys her out. */
  unavailableReasons: string[];
  /**
   * Internal. Never serialized to a client — the API resource type omits it,
   * and the Discord layer renders the match quality. Kept on the domain object because
   * `deploy` re-derives rather than trusting it, and tests assert on it.
   */
  successChance: number;
  factors: SuitabilityFactor[];
}

/** One mission on the board, with the player's standing on it. */
export interface ExpeditionBoardEntry {
  definition: RegionalExpedition;
}

/**
 * One region's board, plus the player's standing across every region.
 *
 * There is no slot count here any more. Concurrency is regional — one active
 * mission per region, as many regions as the player can reach — so "2 of 3
 * slots free" is not a fact about this player, and a number that has to be
 * raised by hand every time a region gains expedition content is exactly what
 * this shape is designed not to have.
 */
export interface ExpeditionBoard {
  regionId: string;
  entries: ExpeditionBoardEntry[];
  /** When this board is replaced. Rendered as a countdown. */
  rotatesAt: Date;
  /**
   * The player's open mission **in this region**, active or waiting to be
   * collected. Non-null means no further deployment here until it is settled.
   */
  regionMission: ExpeditionView | null;
  /**
   * Open missions in every *other* region, so the board can show which regions
   * are already busy without a second call. These never block deployment here.
   */
  elsewhere: ExpeditionView[];
  /** Convenience: the feature is on and this region is free. */
  canDeploy: boolean;
  /** False when content has switched the feature off. */
  enabled: boolean;
}

/**
 * A mission as a caller sees it.
 *
 * Carries the match quality but **not** `successChance` or `resolutionRoll`: those stay
 * on the row. Every surface — Discord, the Platform API, anything later — gets
 * its odds from the same place, so a client cannot leak what the UI hides.
 */
export interface ExpeditionView {
  id: number;
  /**
   * Which slot within `region` this mission holds. Always 1 today — regions,
   * not slots, are the concurrency axis. Carried through for the per-region
   * ladder the column is kept for; see the schema.
   */
  slotIndex: number;
  expeditionKey: string;
  region: string;
  waifuId: number;
  /**
   * The deployed copy's display name, resolved at read time.
   *
   * Read live rather than snapshotted, unlike the mission's own name: a
   * nickname the player sets mid-flight should show up, and unlike content,
   * an owned copy cannot be deleted out from under the row.
   */
  waifuName: string;
  /** From the snapshot, so a deleted definition still renders. */
  name: string;
  emoji: string | null;
  description: string;
  status: ExpeditionStatus;
  /**
   * The match quality the player was shown at deployment. `null` for a row
   * deployed under the legacy success-band vocabulary, which is not translated.
   */
  match: MatchQuality | null;
  startedAt: Date;
  completesAt: Date;
  resolvedAt: Date | null;
  claimedAt: Date | null;
  cancelledAt: Date | null;
  outcome: ExpeditionOutcome | null;
  /** Null until resolved. The resolved payload, never a table reference. */
  rewards: ExpeditionRewardPayload | null;
  /** 0 once due. Derived from the database clock, not Node's. */
  secondsRemaining: number;
  /** True when `completes_at` has passed and the row is still active. */
  isDue: boolean;
}

/** What `claim` actually granted, for the result screen. */
export interface ExpeditionClaimResult {
  expedition: ExpeditionView;
  outcome: ExpeditionOutcome;
  rewards: ExpeditionRewardPayload;
  /** Post-grant balances, so the result screen needs no second read. */
  waifubuxAfter: number;
  essenceAfter: number;
  /** Essence actually credited after the Buddy Bonus, which may exceed base. */
  essenceGranted: number;
  /** Item stacks as granted, with the item names resolved for display. */
  itemsGranted: { slug: string; name: string; quantity: number }[];
  waifuLeveledUp: boolean;
}

export type { PlayerExpeditionRow };
