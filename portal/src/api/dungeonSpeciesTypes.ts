/** Wire-only authoring types. No backend imports or policy calculations. */
export type DungeonSpeciesUnavailableReason =
  | 'missing'
  | 'disabled'
  | 'not_permitted'
  | 'direct_not_permitted'
  | 'direct_limit_missing'
  | 'player_limit';
export interface DungeonSpeciesRef {
  slug: string;
  name: string;
  rarity: string;
  race: string;
  affinity: string;
  enabled: boolean;
  /** Published Region Pool memberships; absent only on older cached reference responses. */
  regions?: string[];
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  /** Judged by species content alone; the dungeon's own Species access is applied by the editor. */
  permitted: boolean;
  unavailableReason: DungeonSpeciesUnavailableReason | null;
  /** Whether this dungeon's Species access can admit her (enabled, not region-exclusive). */
  dungeonPolicyAllowed: boolean;
  dungeonAccess: Array<{
    dungeon: string;
    perPlayerLimit?: number | 'unlimited';
    directRescue?: boolean;
  }>;
  perPlayerLimit: number | 'unlimited' | null;
  directRescue: { available: boolean; reason: DungeonSpeciesUnavailableReason | null };
}
export interface DungeonSpeciesScenario {
  flags: string[];
  completedRooms: string[];
  seenSpecies: string[];
  acquisitions: Record<string, number>;
}
export interface DungeonSpeciesPoolOdds {
  totalWeight: number;
  nothingProbability: number;
  unavailableProbability: number;
  rarityDistribution: Record<string, number>;
  obtainableRarityDistribution: Record<string, number>;
  entries: Array<{
    id: string;
    species: string | null;
    weight: number;
    eligible: boolean;
    reason: 'condition' | 'already_seen' | null;
    probability: number;
    rarity: string | null;
    unavailableReason: DungeonSpeciesUnavailableReason | null;
  }>;
}
export interface DungeonSpeciesPoolAnalysis {
  poolId: string;
  base: DungeonSpeciesPoolOdds;
  scenario: DungeonSpeciesPoolOdds;
}

export interface DungeonSpeciesRegion { id: string; name: string }
