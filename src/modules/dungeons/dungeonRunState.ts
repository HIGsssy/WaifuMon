/**
 * Dungeon run state — the shapes a playable run stores, and the pure rules
 * that move it: who may go where, what a node does when it is resolved, what
 * it pays, and what is banked when the run ends.
 *
 * Pure: no database, no Discord, no clock. `dungeonPlayService` applies these
 * inside its transactions and `dungeonPlaythrough` (the balance simulation)
 * applies the very same functions in memory, so a simulated run and a real one
 * cannot disagree about a number.
 *
 * ## Everything reads the snapshot
 *
 * Enemy stats, event effects, rest healing, reward bands, reward tables and
 * the defeat retention all come from the run's `DungeonRunSnapshot`, frozen
 * when the run was generated. Nothing here takes live content.
 *
 * ## Combat
 *
 * No dungeon-specific combat math. A combat node builds an ordinary
 * `CombatState` — the fighter's snapshotted ATK / DEF / max HP with the run's
 * *current* HP, against the snapshotted enemy at full HP — and runs the
 * existing engine with the basic-attack controllers.
 *
 * The engine's damage variance is rolled from an `Rng` seeded per node:
 * `dungeonCombatSeed(run seed, node id)`, an md5 derivation of stable run
 * data. It is a stream of its own — nothing here continues the generator's
 * stream — so a node's fight is a function of the run's seed, the node, and
 * the HP the fighter arrived with. Asking again gives the same fight; there is
 * no way to reroll one. (A resolved node is in any case read back from its
 * stored resolution, never fought again.)
 *
 * ## Deterministic rewards
 *
 * Every reward draw is derived from the run's seed and the node, through the
 * same keyed draws expeditions use (`expeditionRandom`) and the same table
 * roller (`rollExpeditionTable`). So what a node pays is a function of the
 * stored seed and snapshot: reproducible for debugging, and identical however
 * many times it is asked for. The Equipment *instance* (multiplier, affix) is
 * rolled once by the Equipment service when the drop is granted.
 *
 * ## Rounding
 *
 * One rule everywhere a share of something is taken (rest healing, event HP
 * changes, defeat retention): multiply, divide by 10,000, round **toward
 * zero**. A 25% retention of 3 banks 0; of 4 banks 1.
 */
import { createHash } from 'node:crypto';
import { CombatBuddyRequiredError, CombatLoadoutIncompleteError } from '../../shared/errors';
import { seededRng } from '../../shared/random';
import { basicAttackController } from '../combat/combatController';
import { simulateCombat } from '../combat/combatSimulator';
import { createCombatState } from '../combat/combatState';
import type { CombatEndReason, CombatEvent, CombatResultKind, CombatRules } from '../combat/combatTypes';
import { enemyCombatantInput, type CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { CombatStats } from '../equipment/equipmentMath';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from '../equipment/vocabulary';
import { expeditionDrawInt } from '../expeditions/expeditionRandom';
import {
  mergeGrants,
  rollExpeditionTable,
  type ExpeditionEquipmentDraw,
  type ExpeditionItemGrant,
} from '../expeditions/expeditionRewards';
import type { DungeonGraph, DungeonGraphNode } from './dungeonGenerator';
import type { DungeonRunSnapshot } from './dungeonRunService';
import type { DungeonEventDefinition } from './eventDefinitions';
import { BASIS_POINTS, isEnemyNodeType, type DungeonRewardBand } from './zoneDefinition';

// ── fighter ─────────────────────────────────────────────────────────────────

export interface DungeonFighterGear {
  equipmentId: number;
  definitionKey: string;
  /** Display name — base name plus affix suffix — as it read at the start. */
  name: string;
  rarity: string;
  multiplierBp: number;
}

/**
 * The Buddy and stats a run fights with, snapshotted at start and never
 * recalculated. Self-describing, so the run screen needs nothing live.
 */
export interface DungeonFighter {
  /** `EQUIPMENT_FORMULA_VERSION` the stats were derived under. */
  formulaVersion: number;
  waifuId: number;
  speciesSlug: string;
  name: string;
  level: number;
  currentSp: number;
  attack: number;
  defense: number;
  maxHp: number;
  gear: Record<EquipmentSlot, DungeonFighterGear>;
}

/**
 * Freeze a combat-stat calculation into a run's fighter.
 *
 * @throws {CombatBuddyRequiredError} without an active Buddy.
 * @throws {CombatLoadoutIncompleteError} with an empty Attack, Defense or Health slot.
 */
export function fighterFromCombatStats(stats: CombatStats): DungeonFighter {
  if (stats.buddy == null) throw new CombatBuddyRequiredError();
  const { attack, defense, maxHp } = stats.stats;
  if (!stats.isComplete || attack == null || defense == null || maxHp == null) {
    throw new CombatLoadoutIncompleteError();
  }
  const gear = {} as Record<EquipmentSlot, DungeonFighterGear>;
  for (const slot of EQUIPMENT_SLOTS) {
    const item = stats.loadout.slots[slot]!;
    gear[slot] = {
      equipmentId: item.equipmentId,
      definitionKey: item.definitionKey,
      name: item.name,
      rarity: item.rarity,
      multiplierBp: item.multiplierBp,
    };
  }
  return {
    formulaVersion: stats.formulaVersion,
    waifuId: stats.buddy.waifuId,
    speciesSlug: stats.buddy.speciesSlug,
    name: stats.buddy.name,
    level: stats.buddy.level,
    currentSp: stats.buddy.currentSp,
    attack,
    defense,
    maxHp,
    gear,
  };
}

// ── node state ──────────────────────────────────────────────────────────────

/**
 * Where a node is in its lifecycle. A node with no stored state has not been
 * entered; whether it is *available* is read off the graph (see
 * {@link availableNodes}). V1 resolves a node in one step, so `resolved` and
 * `completed` are written together as `completed`; `entered` is the state an
 * interactive fight will sit in between button presses.
 */
export type DungeonNodeStatus = 'entered' | 'completed';

/** A gear drop a node won: base definition chosen, instance not yet rolled. */
export type DungeonEquipmentDraw = ExpeditionEquipmentDraw;

/** What resolving something paid, before any of it is granted. */
export interface DungeonRewardPlan {
  /** Unbanked progression currency. */
  currency: number;
  waifubux: number;
  items: ExpeditionItemGrant[];
  equipment: DungeonEquipmentDraw[];
}

/** A granted Equipment instance, as the run records it. */
export interface DungeonEquipmentGrant {
  /** Position among the gear this node (or bonus) paid — part of the grant key. */
  rewardIndex: number;
  equipmentId: number;
  definitionKey: string;
  displayName: string;
  slot: EquipmentSlot;
  rarity: string;
  rolledMultiplierBp: number;
}

/** What resolving something paid, as granted. */
export interface DungeonRewards {
  currency: number;
  waifubux: number;
  items: ExpeditionItemGrant[];
  equipment: DungeonEquipmentGrant[];
}

export const NO_REWARDS: DungeonRewards = Object.freeze({ currency: 0, waifubux: 0, items: [], equipment: [] });

export function hasRewards(r: {
  currency: number;
  waifubux: number;
  items: readonly unknown[];
  equipment: readonly unknown[];
}): boolean {
  return r.currency > 0 || r.waifubux > 0 || r.items.length > 0 || r.equipment.length > 0;
}

/** What resolving a node did. Stored on the node's state; numbers, never prose. */
export type DungeonNodeResolution =
  | {
      kind: 'combat';
      enemyKey: string;
      enemyName: string;
      result: CombatResultKind;
      reason: CombatEndReason;
      rounds: number;
      hpBefore: number;
      hpAfter: number;
      enemyMaxHp: number;
      enemyHpAfter: number;
      rewards: DungeonRewards;
    }
  | { kind: 'rest'; healBasisPoints: number; hpBefore: number; hpAfter: number }
  | {
      kind: 'event';
      eventKey: string;
      hpChangeBasisPoints: number;
      hpBefore: number;
      hpAfter: number;
      rewards: DungeonRewards;
    }
  | { kind: 'reward'; rewards: DungeonRewards }
  | { kind: 'exit' };

export interface DungeonNodeState {
  status: DungeonNodeStatus;
  /** ISO timestamps. */
  enteredAt: string;
  completedAt: string | null;
  resolution: DungeonNodeResolution | null;
}

export type DungeonNodeStates = Record<string, DungeonNodeState>;

/** A reward a run has already handed to the player for good. */
export type DungeonSecuredReward =
  | ({ kind: 'equipment'; source: string } & DungeonEquipmentGrant)
  | { kind: 'waifubux'; source: string; amount: number }
  | { kind: 'item'; source: string; slug: string; quantity: number };

/** `source` for a secured reward: the node id, or the bonus that paid it. */
export function securedRewardsOf(source: string, rewards: DungeonRewards): DungeonSecuredReward[] {
  return [
    ...rewards.equipment.map((e) => ({ kind: 'equipment' as const, source, ...e })),
    ...(rewards.waifubux > 0 ? [{ kind: 'waifubux' as const, source, amount: rewards.waifubux }] : []),
    ...rewards.items.map((i) => ({ kind: 'item' as const, source, slug: i.slug, quantity: i.quantity })),
  ];
}

// ── settlement ──────────────────────────────────────────────────────────────

export type DungeonRunOutcome = 'extracted' | 'defeated' | 'completed' | 'abandoned';

/** How a run ended and what was banked. Stored on the run once, when it ends. */
export interface DungeonSettlement {
  outcome: DungeonRunOutcome;
  /** `stalemate`: the fight hit the round limit with both sides standing. */
  cause: 'extraction' | 'boss_defeated' | 'exit_reached' | 'hp_zero' | 'stalemate' | 'abandoned';
  nodeId: string | null;
  depth: number;
  finalHp: number;
  /** Unbanked currency carried into the settlement, bonus excluded. */
  earned: number;
  /** The completion or extraction bonus, already included in what is banked. */
  bonusCurrency: number;
  /** Share of `earned + bonusCurrency` kept: 10000 unless defeated or abandoned. */
  retentionBasisPoints: number;
  banked: number;
  lost: number;
  /** Why nothing could be banked, when the zone's currency is missing or disabled. */
  bankingSkipped: 'no_currency' | 'currency_disabled' | null;
  /** The permanent balance after banking; null when nothing was banked. */
  balanceAfter: number | null;
  /** Secured rewards the completion or extraction bonus paid. */
  bonusRewards: DungeonRewards;
}

/** `amount × basisPoints / 10000`, rounded toward zero. */
export function shareOf(amount: number, basisPoints: number): number {
  return Math.trunc((amount * basisPoints) / BASIS_POINTS);
}

/** What is banked and what is lost when `total` unbanked currency is settled. */
export function settleCurrency(total: number, retentionBasisPoints: number): { banked: number; lost: number } {
  const banked = Math.min(total, Math.max(0, shareOf(total, retentionBasisPoints)));
  return { banked, lost: total - banked };
}

// ── graph reads ─────────────────────────────────────────────────────────────

export function nodeOf(graph: DungeonGraph, nodeId: string | null | undefined): DungeonGraphNode | null {
  if (nodeId == null) return null;
  return graph.nodes.find((n) => n.id === nodeId) ?? null;
}

/** The nodes reachable in one step from `node`, in edge order. */
export function outgoingNodes(graph: DungeonGraph, node: DungeonGraphNode): DungeonGraphNode[] {
  return node.outgoing.flatMap((edgeId) => {
    const edge = graph.edges.find((e) => e.id === edgeId);
    const to = edge ? nodeOf(graph, edge.to) : null;
    return to ? [to] : [];
  });
}

/**
 * The nodes the player may enter now: the outgoing nodes of the current node,
 * once it is completed. Empty while the current node is unresolved, on the
 * terminal node, and always for a finished run.
 */
export function availableNodes(
  graph: DungeonGraph,
  states: DungeonNodeStates,
  currentNodeId: string | null,
): DungeonGraphNode[] {
  const current = nodeOf(graph, currentNodeId);
  if (!current || states[current.id]?.status !== 'completed') return [];
  return outgoingNodes(graph, current);
}

// ── reward draws ────────────────────────────────────────────────────────────

/** Which of a node's (or the run's) payouts a draw belongs to. */
const DRAW_SLOT = { band: 0, bandGear: 1, completion: 2, extraction: 3 } as const;
const DRAW_NODE_SPAN = 4096;
const DRAW_SLOT_SPAN = 8;

/**
 * The id every draw for one payout is keyed on: unique per seed, node and
 * payout slot. `ordinal` is the node's 1-based position in the graph; 0 for a
 * run-level bonus.
 */
export function dungeonDrawId(seed: number, ordinal: number, slot: keyof typeof DRAW_SLOT): number {
  return seed * DRAW_NODE_SPAN + ordinal * DRAW_SLOT_SPAN + DRAW_SLOT[slot];
}

function nodeOrdinal(graph: DungeonGraph, node: DungeonGraphNode): number {
  return graph.nodes.findIndex((n) => n.id === node.id) + 1;
}

function rollTable(
  snapshot: DungeonRunSnapshot,
  tableId: string | null,
  drawId: number,
  kind: 'success' | 'bonus',
): Pick<DungeonRewardPlan, 'waifubux' | 'items' | 'equipment'> {
  // A table disabled when the run started was promised nothing.
  const entry = tableId ? snapshot.rewardTables[tableId] : null;
  if (!entry) return { waifubux: 0, items: [], equipment: [] };
  const roll = rollExpeditionTable({
    table: entry.table,
    expeditionId: drawId,
    kind,
    equipmentPools: entry.equipmentPools,
  });
  // Dungeons pay a table's WaifuBux, items and gear. Essence and XP on a
  // shared table are expedition rewards and are not paid here.
  return { waifubux: roll.waifubux, items: roll.items, equipment: roll.equipment };
}

function rollCurrency(range: { min: number; max: number }, drawId: number): number {
  return range.max <= 0 ? 0 : expeditionDrawInt(drawId, 'success:dungeon-currency', range.min, range.max);
}

/**
 * What a node pays from, or null: an authored room's own reward when it has
 * one, else the snapshotted band. Never the live zone.
 */
export function bandOf(
  snapshot: DungeonRunSnapshot,
  node: DungeonGraphNode,
): Pick<DungeonRewardBand, 'rewardTable' | 'equipmentRewardTable' | 'currency'> | null {
  if (node.reward) return node.reward;
  if (node.rewardBandId == null) return null;
  return snapshot.zone.rewards.bands.find((b) => b.id === node.rewardBandId) ?? null;
}

/**
 * Whether resolving `node` pays its band: a won fight, a reward node, or an
 * event authored to. Rest and exit nodes never pay, whatever band covers them.
 */
export function nodePaysBand(snapshot: DungeonRunSnapshot, node: DungeonGraphNode): boolean {
  if (isEnemyNodeType(node.type) || node.type === 'reward') return true;
  if (node.type === 'event') return eventOf(snapshot, node)?.paysReward === true;
  return false;
}

/** What `node`'s band pays. Same seed, same node → same plan. */
export function rollNodeRewards(
  snapshot: DungeonRunSnapshot,
  graph: DungeonGraph,
  node: DungeonGraphNode,
): DungeonRewardPlan {
  const band = bandOf(snapshot, node);
  if (!band || !nodePaysBand(snapshot, node)) return { currency: 0, waifubux: 0, items: [], equipment: [] };
  const ordinal = nodeOrdinal(graph, node);
  const ordinary = rollTable(snapshot, band.rewardTable, dungeonDrawId(graph.seed, ordinal, 'band'), 'success');
  const gear = rollTable(snapshot, band.equipmentRewardTable, dungeonDrawId(graph.seed, ordinal, 'bandGear'), 'bonus');
  return {
    currency: rollCurrency(band.currency, dungeonDrawId(graph.seed, ordinal, 'band')),
    waifubux: ordinary.waifubux + gear.waifubux,
    items: mergeGrants([...ordinary.items, ...gear.items]),
    equipment: [...ordinary.equipment, ...gear.equipment],
  };
}

/** The zone's one-off completion or extraction bonus. */
export function rollRunBonus(
  snapshot: DungeonRunSnapshot,
  graph: DungeonGraph,
  which: 'completion' | 'extraction',
): DungeonRewardPlan {
  const bonus = snapshot.zone.rewards[which];
  const drawId = dungeonDrawId(graph.seed, 0, which);
  const table = rollTable(snapshot, bonus.rewardTable, drawId, 'success');
  return { currency: rollCurrency(bonus.currency, drawId), ...table, items: mergeGrants(table.items) };
}

/** The stable grant key of one gear drop: run, node (or bonus) and its index there. */
export function dungeonEquipmentGrantKey(runId: number, source: string, rewardIndex: number): string {
  return `dungeon:${runId}:${source}:${rewardIndex}`;
}

// ── node resolution ─────────────────────────────────────────────────────────

export function enemyOf(snapshot: DungeonRunSnapshot, node: DungeonGraphNode): CombatEnemyDefinition | null {
  return node.content?.kind === 'enemy' ? (snapshot.enemies[node.content.key] ?? null) : null;
}

export function eventOf(snapshot: DungeonRunSnapshot, node: DungeonGraphNode): DungeonEventDefinition | null {
  return node.content?.kind === 'event' ? (snapshot.events[node.content.key] ?? null) : null;
}

/** Events snapshotted before effects existed carry neither field. */
export function eventEffect(event: DungeonEventDefinition | null): { hpChangeBasisPoints: number; paysReward: boolean } {
  return { hpChangeBasisPoints: event?.hpChangeBasisPoints ?? 0, paysReward: event?.paysReward ?? false };
}

/** What a rest restores: the node's own heal (an authored room's) when it has one, else the zone's. */
export function restHealBasisPoints(snapshot: DungeonRunSnapshot, node?: Pick<DungeonGraphNode, 'restHealBasisPoints'>): number {
  if (node?.restHealBasisPoints != null) return node.restHealBasisPoints;
  // Zones snapshotted before `nodeSettings` existed heal nothing rather than guess.
  return snapshot.zone.nodeSettings?.rest.healBasisPoints ?? 0;
}

/** HP after a rest: never above max, never below where it was. */
export function hpAfterRest(fighter: Pick<DungeonFighter, 'maxHp'>, currentHp: number, healBasisPoints: number): number {
  return Math.min(fighter.maxHp, currentHp + Math.max(0, shareOf(fighter.maxHp, healBasisPoints)));
}

/** HP after an event's change: clamped to `1..maxHp` — an event never ends a run. */
export function hpAfterEvent(
  fighter: Pick<DungeonFighter, 'maxHp'>,
  currentHp: number,
  hpChangeBasisPoints: number,
): number {
  return Math.min(fighter.maxHp, Math.max(1, currentHp + shareOf(fighter.maxHp, hpChangeBasisPoints)));
}

export interface DungeonCombatOutcome {
  result: CombatResultKind;
  reason: CombatEndReason;
  rounds: number;
  actions: number;
  hpBefore: number;
  hpAfter: number;
  enemyMaxHp: number;
  enemyHpAfter: number;
  /** The seed the fight's damage rolls were drawn from. */
  combatSeed: number;
  /** The engine's structured events — kept for the run history, never shown raw. */
  events: CombatEvent[];
}

/**
 * Fight one enemy with the existing engine: the fighter's snapshotted stats
 * at the run's current HP, the snapshotted enemy at full HP, basic attacks on
 * both sides, damage rolls drawn from `seededRng(combatSeed)`. `rules`
 * overrides the engine's default rules; production passes none.
 */
export function fightEnemy(
  fighter: DungeonFighter,
  currentHp: number,
  enemy: CombatEnemyDefinition,
  combatSeed: number,
  rules?: Partial<CombatRules>,
): DungeonCombatOutcome {
  const initial = createCombatState({
    player: {
      id: `buddy:${fighter.waifuId}`,
      name: fighter.name,
      attack: fighter.attack,
      defense: fighter.defense,
      maxHp: fighter.maxHp,
      currentHp,
    },
    enemy: enemyCombatantInput(enemy),
    ...(rules ? { rules } : {}),
  });
  const outcome = simulateCombat(
    initial,
    { player: basicAttackController, enemy: basicAttackController },
    { rng: seededRng(combatSeed) },
  );
  return {
    result: outcome.result,
    reason: outcome.reason,
    rounds: outcome.rounds,
    actions: outcome.actions,
    hpBefore: currentHp,
    hpAfter: outcome.finalState.player.currentHp,
    enemyMaxHp: initial.enemy.maxHp,
    enemyHpAfter: outcome.finalState.enemy.currentHp,
    combatSeed,
    events: outcome.events,
  };
}

/**
 * Versioned salt for a dungeon fight's seed. Frozen: changing it would make an
 * unresolved node of a run in progress fight differently than it would have.
 */
export const DUNGEON_COMBAT_SEED_SALT = 'waifumon.dungeon.combat.v1';

/**
 * The seed of one node's fight: the first 32 bits of
 * `md5("<run seed>:<node id>:combat:<salt>")`. Stable run data only, and
 * independent of the layout generator's own stream.
 */
export function dungeonCombatSeed(runSeed: number, nodeId: string, salt: string = DUNGEON_COMBAT_SEED_SALT): number {
  const digest = createHash('md5').update(`${runSeed}:${nodeId}:combat:${salt}`, 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16);
}
