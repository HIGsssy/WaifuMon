/**
 * Wire types for what the server says about a draft's events: pool odds and
 * choices as a player in an imagined run would meet them.
 *
 * Type-only and import-free, like `dungeonImportTypes.ts`, so the backend's
 * tests can check these against the engine's own types without the Portal
 * build ever depending on bot source.
 */

/**
 * An imagined run to judge events against. Assumed only: the server reads no
 * real run or inventory for it.
 */
export interface DungeonEventScenario {
  /** Things the run remembers (run flags that are set). */
  flags: string[];
  completedRooms: string[];
  /** Events the run has already met, for once-per-run pool entries. */
  seenEvents: string[];
  /** Item slug → how many the player holds. */
  inventory: Record<string, number>;
  /** Buddy strength. 200 is an average Buddy. */
  currentSp: number;
  /** The player arrived from another room, so turning back is possible. */
  canTurnBack: boolean;
}
export interface DungeonEventPoolOdds {
  totalWeight: number;
  /** The chance no event is presented; 1 when nothing is in the draw. */
  nothingProbability: number;
  entries: Array<{
    id: string;
    eventId: string | null;
    weight: number;
    eligible: boolean;
    reason: 'condition' | 'already_seen' | null;
    /** Unrounded, 0–1. */
    probability: number;
  }>;
}
export interface DungeonEventPoolAnalysis {
  poolId: string;
  /** Every entry in the draw. */
  base: DungeonEventPoolOdds;
  /** As the scenario stands. */
  scenario: DungeonEventPoolOdds;
}
/** One choice as a player in some situation meets it: the engine's own reading. */
export interface DungeonEventChoiceView {
  id: string;
  label: string;
  description: string;
  available: boolean;
  unavailableReason: 'requires' | 'items' | 'no_way_back' | null;
  unavailableText: string;
  check: { chanceBasisPoints: number; sp: number | null } | null;
  items: Array<{ item: string; quantity: number; consume: boolean; owned: number }>;
  consumesOnSelect: boolean;
  walksAway: boolean;
}
export interface DungeonEventChoicePreview extends DungeonEventChoiceView {
  /** Unavailable and left off the player's screen. */
  hidden: boolean;
  /** A skill check's chance for the weakest, an average and the strongest Buddy, in basis points. */
  chances: { weakest: number; average: number; strongest: number } | null;
}
export interface DungeonEventPreview {
  eventId: string;
  choices: DungeonEventChoicePreview[];
}
