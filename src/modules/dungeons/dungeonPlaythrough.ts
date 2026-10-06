/**
 * Balance simulation: play many generated runs in memory and summarise how
 * they went — completion, defeat, depth, HP left, currency banked, gear found.
 *
 * It plays with the same pure rules a real run uses (`dungeonRunState.ts`):
 * the same engine fights, the same reward draws, the same settlement
 * arithmetic. Nothing is written anywhere, no player is involved, and no
 * Equipment instance is rolled — a gear drop is counted by the rarity of the
 * base definition it selected.
 *
 * Deterministic: seeds are `firstSeed`, `firstSeed + 1`, …, and a fork is
 * chosen by a rule, not a dice roll, so the same inputs give the same report.
 *
 * A simulated player follows one {@link PlaythroughPolicy}:
 *
 *   - at a fork, the side whose first node suits their HP: a rest when hurt,
 *     otherwise the side that is not a fight if there is one;
 *   - at an extraction point, they leave when HP is at or below the policy's
 *     threshold, otherwise they push on. {@link PLAYTHROUGH_POLICIES} names
 *     the ones the balance reports use: aggressive (never leaves), cautious
 *     (leaves at ≤50% HP), conservative (leaves at ≤70% HP) and first_exit
 *     (leaves at the first opportunity — what the shallow loop alone pays).
 *
 * "Reaching the first extraction" means resolving a node that offers
 * extraction and still standing — the first moment the player *could* have
 * cashed out, whether or not their policy did.
 */
import { DungeonGenerationError } from '../../shared/errors';
import { buildDungeonGraph } from './authoredLayout';
import type { DungeonContentCatalogue, DungeonGraphNode } from './dungeonGenerator';
import type { DungeonRunSnapshot } from './dungeonRunService';
import {
  dungeonCombatSeed,
  enemyOf,
  eventEffect,
  eventOf,
  fightEnemy,
  hpAfterEvent,
  hpAfterRest,
  nodeOf,
  outgoingNodes,
  restHealBasisPoints,
  rollNodeRewards,
  rollRunBonus,
  settleCurrency,
  type DungeonFighter,
  type DungeonRunOutcome,
} from './dungeonRunState';
import { BASIS_POINTS, isEnemyNodeType } from './zoneDefinition';

export interface PlaythroughPolicy {
  /** Extract at an extraction point when HP is at or below this share of max; null never extracts. */
  extractAtHpBasisPoints: number | null;
}

/** The extraction strategies the balance reports compare. */
export const PLAYTHROUGH_POLICIES = [
  { key: 'aggressive', label: 'never extracts', extractAtHpBasisPoints: null },
  { key: 'cautious', label: 'extracts at ≤50% HP', extractAtHpBasisPoints: 5_000 },
  { key: 'conservative', label: 'extracts at ≤70% HP', extractAtHpBasisPoints: 7_000 },
  { key: 'first_exit', label: 'extracts at the first opportunity', extractAtHpBasisPoints: 10_000 },
] as const satisfies readonly ({ key: string; label: string } & PlaythroughPolicy)[];

export interface PlaythroughResult {
  seed: number;
  outcome: Exclude<DungeonRunOutcome, 'abandoned'>;
  depth: number;
  depthCount: number;
  finalHp: number;
  earned: number;
  banked: number;
  waifubux: number;
  /** Gear drops by rarity. */
  equipment: Record<string, number>;
  fights: number;
  /** Combat rounds fought, all fights. */
  rounds: number;
  /** HP the fighter's Lifesteal restored, all fights. */
  lifestealHealed: number;
  playerCrits: number;
  playerBonusAttacks: number;
  /** Depth of the first extraction opportunity the run survived to; null when it never reached one. */
  firstExtractionDepth: number | null;
  /** Extraction opportunities the run survived to, the one it left at included. */
  extractionOpportunities: number;
  /** The enemy that ended the run, when one did. */
  defeatedBy: string | null;
  /** The depth the run was defeated at; null otherwise. */
  defeatedAtDepth: number | null;
}

/** Everything a run reads, minus the catalogue: built once per simulation. */
export type PlaythroughSnapshot = Pick<DungeonRunSnapshot, 'zone' | 'enemies' | 'events' | 'rewardTables'>;

/**
 * Play one generated run to its end.
 *
 * @throws {DungeonGenerationError} when the zone cannot generate for `seed`.
 */
export function playDungeon(
  content: PlaythroughSnapshot,
  catalogue: DungeonContentCatalogue,
  fighter: Pick<DungeonFighter, 'attack' | 'defense' | 'maxHp' | 'modifiers'>,
  seed: number,
  policy: PlaythroughPolicy,
): PlaythroughResult {
  const graph = buildDungeonGraph(content.zone, catalogue, seed);
  const snapshot = content as DungeonRunSnapshot;
  const combatant: DungeonFighter = {
    formulaVersion: 0,
    waifuId: 0,
    speciesSlug: 'simulated',
    name: 'Simulated Buddy',
    level: 0,
    currentSp: 0,
    gear: {} as DungeonFighter['gear'],
    ...fighter,
  };

  let hp = combatant.maxHp;
  let earned = 0;
  let waifubux = 0;
  let fights = 0;
  let rounds = 0;
  let lifestealHealed = 0;
  let playerCrits = 0;
  let playerBonusAttacks = 0;
  let firstExtractionDepth: number | null = null;
  let extractionOpportunities = 0;
  const equipment: Record<string, number> = {};
  let node: DungeonGraphNode = nodeOf(graph, graph.startNodeId)!;

  const pay = (plan: { currency: number; waifubux: number; equipment: readonly { rarity: string }[] }) => {
    earned += plan.currency;
    waifubux += plan.waifubux;
    for (const drop of plan.equipment) equipment[drop.rarity] = (equipment[drop.rarity] ?? 0) + 1;
  };
  const end = (outcome: PlaythroughResult['outcome'], defeatedBy: string | null = null): PlaythroughResult => {
    if (outcome === 'completed') pay(rollRunBonus(snapshot, graph, 'completion'));
    if (outcome === 'extracted') pay(rollRunBonus(snapshot, graph, 'extraction'));
    const retention = outcome === 'defeated' ? content.zone.rewards.defeatCurrencyRetentionBasisPoints : BASIS_POINTS;
    return {
      seed,
      outcome,
      depth: node.depth,
      depthCount: graph.depthCount,
      finalHp: hp,
      earned,
      banked: settleCurrency(earned, retention).banked,
      waifubux,
      equipment,
      fights,
      rounds,
      lifestealHealed,
      playerCrits,
      playerBonusAttacks,
      firstExtractionDepth,
      extractionOpportunities,
      defeatedBy,
      defeatedAtDepth: outcome === 'defeated' ? node.depth : null,
    };
  };

  for (;;) {
    if (isEnemyNodeType(node.type)) {
      const enemy = enemyOf(snapshot, node)!;
      const fight = fightEnemy(combatant, hp, enemy, dungeonCombatSeed(graph.seed, node.id));
      fights += 1;
      rounds += fight.rounds;
      lifestealHealed += fight.lifestealHealed;
      playerCrits += fight.playerCrits;
      playerBonusAttacks += fight.playerBonusAttacks;
      hp = fight.hpAfter;
      if (fight.result !== 'player_victory') return end('defeated', enemy.key);
      pay(rollNodeRewards(snapshot, graph, node));
    } else if (node.type === 'rest') {
      hp = hpAfterRest(combatant, hp, restHealBasisPoints(snapshot, node));
    } else if (node.type === 'event') {
      hp = hpAfterEvent(combatant, hp, eventEffect(eventOf(snapshot, node)).hpChangeBasisPoints);
      pay(rollNodeRewards(snapshot, graph, node));
    } else if (node.type === 'reward') {
      pay(rollNodeRewards(snapshot, graph, node));
    }

    if (node.terminal) return end('completed');
    if (node.extraction) {
      firstExtractionDepth ??= node.depth;
      extractionOpportunities += 1;
    }
    const hurt = policy.extractAtHpBasisPoints != null && hp * BASIS_POINTS <= combatant.maxHp * policy.extractAtHpBasisPoints;
    if (node.extraction && hurt) return end('extracted');

    const next = outgoingNodes(graph, node);
    const wounded = hp * 2 <= combatant.maxHp;
    node =
      (wounded ? next.find((n) => n.type === 'rest') : undefined) ??
      next.find((n) => !isEnemyNodeType(n.type)) ??
      next[0]!;
  }
}

export interface PlaythroughReport {
  runs: number;
  /** Seeds the generator could not satisfy; excluded from every rate below. */
  invalid: number;
  /** 0..1 of valid runs. */
  completionRate: number;
  extractionRate: number;
  defeatRate: number;
  averageDepth: number;
  /** Depth reached as a share of the run's length, 0..1. */
  averageProgress: number;
  /** HP left, as a share of max, over runs that extracted or completed; null when none did. */
  averageHpShareAtExit: number | null;
  /** Share of runs that survived to an extraction opportunity, whatever they then did. */
  firstExtractionReachRate: number;
  /** Mean depth of that first opportunity, over the runs that reached one; null when none did. */
  averageFirstExtractionDepth: number | null;
  /** Extraction opportunities a run survived to, on average. */
  averageExtractionOpportunities: number;
  /** Fights per run, and combat rounds per fight. */
  averageFights: number;
  averageRoundsPerFight: number;
  /** HP Lifesteal restored per fight, and per run. */
  averageLifestealPerFight: number;
  averageLifestealPerRun: number;
  averageEarned: number;
  averageBanked: number;
  averageWaifubux: number;
  /** Gear drops per run, by rarity. */
  equipmentPerRun: Record<string, number>;
  /** Gear drops per run, all rarities. Every drop is secured the moment it is found. */
  averageEquipment: number;
  /** Share of runs that secured at least one piece of gear. */
  equipmentRunRate: number;
  /** What ended the defeated runs, most frequent first. */
  defeatedBy: { enemyKey: string; runs: number }[];
  /** Defeats by the depth they happened at. */
  defeatsByDepth: Record<number, number>;
}

/** Play `runs` consecutive seeds with one fighter and policy, and summarise them. */
export function simulateDungeonPlaythroughs(
  content: PlaythroughSnapshot,
  catalogue: DungeonContentCatalogue,
  fighter: Pick<DungeonFighter, 'attack' | 'defense' | 'maxHp' | 'modifiers'>,
  opts: { runs: number; firstSeed?: number; policy: PlaythroughPolicy },
): PlaythroughReport {
  const results: PlaythroughResult[] = [];
  let invalid = 0;
  for (let i = 0; i < opts.runs; i++) {
    try {
      results.push(playDungeon(content, catalogue, fighter, (opts.firstSeed ?? 1) + i, opts.policy));
    } catch (err) {
      if (!(err instanceof DungeonGenerationError)) throw err;
      invalid += 1;
    }
  }
  const n = results.length || 1;
  const count = (outcome: PlaythroughResult['outcome']) => results.filter((r) => r.outcome === outcome).length;
  const sum = (pick: (r: PlaythroughResult) => number) => results.reduce((total, r) => total + pick(r), 0);
  const exited = results.filter((r) => r.outcome !== 'defeated');

  const equipmentPerRun: Record<string, number> = {};
  for (const r of results) {
    for (const [rarity, drops] of Object.entries(r.equipment)) {
      equipmentPerRun[rarity] = (equipmentPerRun[rarity] ?? 0) + drops / n;
    }
  }
  const killers = new Map<string, number>();
  for (const r of results) if (r.defeatedBy) killers.set(r.defeatedBy, (killers.get(r.defeatedBy) ?? 0) + 1);
  const defeatsByDepth: Record<number, number> = {};
  for (const r of results) {
    if (r.defeatedAtDepth != null) defeatsByDepth[r.defeatedAtDepth] = (defeatsByDepth[r.defeatedAtDepth] ?? 0) + 1;
  }
  const reached = results.filter((r) => r.firstExtractionDepth != null);

  return {
    runs: results.length,
    invalid,
    completionRate: count('completed') / n,
    extractionRate: count('extracted') / n,
    defeatRate: count('defeated') / n,
    averageDepth: sum((r) => r.depth) / n,
    averageProgress: sum((r) => r.depth / r.depthCount) / n,
    averageHpShareAtExit: exited.length
      ? exited.reduce((total, r) => total + r.finalHp / fighter.maxHp, 0) / exited.length
      : null,
    firstExtractionReachRate: reached.length / n,
    averageFirstExtractionDepth: reached.length
      ? reached.reduce((total, r) => total + r.firstExtractionDepth!, 0) / reached.length
      : null,
    averageExtractionOpportunities: sum((r) => r.extractionOpportunities) / n,
    averageFights: sum((r) => r.fights) / n,
    averageRoundsPerFight: sum((r) => r.rounds) / (sum((r) => r.fights) || 1),
    averageLifestealPerFight: sum((r) => r.lifestealHealed) / (sum((r) => r.fights) || 1),
    averageLifestealPerRun: sum((r) => r.lifestealHealed) / n,
    averageEarned: sum((r) => r.earned) / n,
    averageBanked: sum((r) => r.banked) / n,
    averageWaifubux: sum((r) => r.waifubux) / n,
    equipmentPerRun,
    averageEquipment: Object.values(equipmentPerRun).reduce((a, b) => a + b, 0),
    equipmentRunRate: results.filter((r) => Object.keys(r.equipment).length > 0).length / n,
    defeatedBy: [...killers].map(([enemyKey, runs]) => ({ enemyKey, runs })).sort((a, b) => b.runs - a.runs),
    defeatsByDepth,
  };
}
