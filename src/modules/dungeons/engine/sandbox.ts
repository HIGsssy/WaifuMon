/**
 * The sandbox: a run that is played by the real engine and changes nothing.
 *
 * It is not a second implementation of anything. `createDungeonSandbox` holds
 * a run state in memory, hands every input to `stepDungeon` — the function
 * live gameplay calls — and gives each effect to `sandboxEffectsPort`, which
 * writes it down and does nothing else. No inventory, currency, ownership or
 * progression can move, because nothing here can reach them.
 *
 * This is the basic pathway. The Portal simulation interface (forced
 * outcomes, Monte Carlo reports, deadlock search) is a later phase and is
 * built on exactly this.
 */
import type { CombatEvent } from '../../combat/combatTypes';
import type { DungeonDefinition } from '../content/dungeonDefinition';
import { dungeonRngSource } from './seeds';
import { isDungeonRewardPlanV2 } from './rewards';
import { currentAction, startDungeonRun, stepDungeon } from './step';
import type {
  DungeonEffect,
  DungeonEffectReceipt,
  DungeonEffectsPort,
  DungeonEngineContext,
  DungeonInput,
  DungeonLogEntry,
  DungeonRefusal,
  DungeonRunState,
  DungeonStepResult,
  EngineDependencies,
  EngineFighter,
} from './types';
import { describeDungeonRun, type DungeonRunCoreView } from './view';

/** Records every effect and grants nothing. Gear is reported with no instance behind it. */
export function sandboxEffectsPort(recorded: DungeonEffect[] = []): DungeonEffectsPort & { readonly recorded: DungeonEffect[] } {
  return {
    recorded,
    async apply(effect): Promise<DungeonEffectReceipt> {
      recorded.push(effect);
      if (effect.type === 'capture_attempt') return { type: 'capture_attempt', key: effect.key, simulated: true, success: effect.attempt.success };
      if (effect.type === 'rescue_grant') return { type: 'rescue_grant', grantKey: effect.grantKey, simulated: true };
      if (effect.type === 'grant_rewards') {
        if (isDungeonRewardPlanV2(effect.plan)) {
          return {
            type: 'grant_rewards', claimKey: effect.claimKey,
            waifubux: 0,
            items: effect.plan.secured.items.map(({ item, quantity }) => ({ slug: item, quantity })),
            equipment: [], plan: effect.plan,
          };
        }
        return {
          type: 'grant_rewards',
          claimKey: effect.claimKey,
          waifubux: effect.plan.waifubux,
          items: effect.plan.items,
          equipment: [],
        };
      }
      if (effect.type === 'consume_items') return { type: 'consume_items', key: effect.key, items: effect.items };
      return { type: 'settle_run', banked: effect.end.banked, bankingSkipped: null, balanceAfter: null };
    },
  };
}

/** Carry out a step's effects in order, through whichever port. */
export async function applyDungeonEffects(port: DungeonEffectsPort, effects: readonly DungeonEffect[]): Promise<DungeonEffectReceipt[]> {
  const receipts: DungeonEffectReceipt[] = [];
  for (const effect of effects) receipts.push(await port.apply(effect));
  return receipts;
}

export interface DungeonSandboxStep {
  status: DungeonStepResult['status'];
  refusal: DungeonRefusal | null;
  view: DungeonRunCoreView;
  effects: DungeonEffect[];
  log: DungeonLogEntry[];
}

export interface DungeonSandbox {
  /** What is being played. Author-facing: it includes a puzzle's accepted answers. */
  readonly definition: DungeonDefinition;
  readonly state: DungeonRunState;
  readonly view: DungeonRunCoreView;
  /** Every effect any step has produced, in order. None was carried out. */
  readonly effects: readonly DungeonEffect[];
  readonly log: readonly DungeonLogEntry[];
  readonly combat: readonly { roomId: string; actionId: string; waveIndex: number; events: CombatEvent[] }[];
  /** Step with the current step number filled in, as a button drawn from `view` would. */
  input(input: DungeonInput): Promise<DungeonSandboxStep>;
}

export interface DungeonSandboxOptions {
  definition: DungeonDefinition;
  dependencies: EngineDependencies;
  rewards?: DungeonEngineContext['rewards'];
  fighter: EngineFighter;
  seed: number;
  combatRules?: DungeonEngineContext['combatRules'];
  playerFlags?: DungeonEngineContext['playerFlags'];
  /** Item quantities to assume the player holds, by slug. Nothing is spent: consumption is only recorded. */
  inventory?: DungeonEngineContext['inventory'];
  encounterFacts?: DungeonEngineContext['encounterFacts'];
  /** Authoring-only facts refreshed after simulated spends/grants; never a live service port. */
  encounterFactsFor?: (state: DungeonRunState | null, effects: readonly DungeonEffect[]) => DungeonEngineContext['encounterFacts'];
  rng?: import('./types').DungeonRngSource;
  initialFlags?: string[];
  completedRooms?: string[];
}

export function createDungeonSandbox(options: DungeonSandboxOptions): DungeonSandbox {
  const ctx: DungeonEngineContext = {
    definition: options.definition,
    dependencies: options.dependencies,
    rewards: options.rewards,
    fighter: options.fighter,
    runKey: `sandbox-${options.seed}`,
    playerFlags: options.playerFlags,
    inventory: options.inventory,
    encounterFacts: options.encounterFactsFor?.(null, []) ?? options.encounterFacts,
    combatRules: options.combatRules,
  };
  const rng = options.rng ?? dungeonRngSource(options.seed);
  const port = sandboxEffectsPort();
  const log: DungeonLogEntry[] = [];
  const combat: DungeonStepResult['combat'] = [];

  // Seed authoring condition facts before entering the actual entrance. The
  // bootstrap room exists only in memory; production startDungeonRun is unchanged.
  const seeded = (options.initialFlags?.length ?? 0) + (options.completedRooms?.length ?? 0) > 0;
  const bootstrap = '__sandbox_bootstrap__';
  const bootCtx = seeded ? { ...ctx, definition: { ...ctx.definition, entranceRoomId: bootstrap,
    rooms: [...ctx.definition.rooms, { id: bootstrap, name: 'Sandbox setup', kind: 'room' as const, description: '', background: null, extraction: false, actions: [] }],
    connections: [...ctx.definition.connections, { id: bootstrap, from: bootstrap, to: ctx.definition.entranceRoomId, kind: 'path' as const, label: '', lockedText: '' }],
  } } : ctx;
  let started = startDungeonRun(bootCtx, options.seed, rng);
  if (seeded) {
    started.state.flags = Object.fromEntries((options.initialFlags ?? []).map((f) => [f, true]));
    for (const id of options.completedRooms ?? []) started.state.rooms[id] = { visits: 1, completed: true, resumeAt: null, actions: {} };
    started = stepDungeon(started.state, { type: 'move', connectionId: bootstrap }, bootCtx, rng);
    delete started.state.rooms[bootstrap];
    started.state.step = 0;
    started.state.cursor.cameFrom = null;
  }
  let state = started.state;
  log.push(...started.log);
  combat.push(...started.combat);

  return {
    definition: options.definition,
    get state() {
      return state;
    },
    get view() {
      if (options.encounterFactsFor) ctx.encounterFacts = options.encounterFactsFor(state, port.recorded);
      return describeDungeonRun(state, ctx, rng);
    },
    effects: port.recorded,
    log,
    combat,
    async input(input) {
      if (options.encounterFactsFor) ctx.encounterFacts = options.encounterFactsFor(state, port.recorded);
      const result = stepDungeon(state, { expectedStep: state.step, ...input }, ctx, rng);
      if (result.status === 'applied') {
        state = result.state;
        log.push(...result.log);
        combat.push(...result.combat);
        await applyDungeonEffects(port, result.effects);
      }
      return {
        status: result.status,
        refusal: result.refusal,
        view: describeDungeonRun(state, ctx, rng),
        effects: result.effects,
        log: result.log,
      };
    },
  };
}

/**
 * Play a run to its end by always taking the first thing on offer: advance an
 * action, else the first open connection. A convenience for tests and for
 * checking that a dungeon can be finished at all — not a balance simulation.
 * A puzzle is answered with its first accepted answer, read from the
 * definition the author is playing.
 *
 * `choose` overrides the default at any point; returning null accepts it.
 */
export async function autoPlayDungeonSandbox(
  sandbox: DungeonSandbox,
  options: { maxSteps?: number; choose?: (view: DungeonRunCoreView) => DungeonInput | null } = {},
): Promise<{ steps: number; view: DungeonRunCoreView; stoppedBy: 'ended' | 'stuck' | 'max_steps' | 'refused' }> {
  const maxSteps = options.maxSteps ?? 2000;
  let steps = 0;
  for (;;) {
    const view = sandbox.view;
    if (view.phase === 'ended') return { steps, view, stoppedBy: 'ended' };
    if (steps >= maxSteps) return { steps, view, stoppedBy: 'max_steps' };
    let input = options.choose?.(view) ?? null;
    if (!input) {
      if (view.phase === 'action' && view.action?.event) {
        // An event takes a choice: the first available one that goes somewhere, else the first available.
        const choices = view.action.event.choices.filter((c) => c.available);
        const choice = choices.find((c) => !c.walksAway) ?? choices[0];
        if (!choice) return { steps, view, stoppedBy: 'stuck' };
        input = { type: 'choose', choiceId: choice.id };
      } else if (view.phase === 'action' && view.action?.encounter) {
        const e = view.action.encounter;
        input = e.mode === 'direct' ? { type: 'rescue' } : e.selectedItem ? { type: 'capture' } : e.items[0] ? { type: 'select_item', item: e.items[0].item } : { type: 'leave_encounter' };
      } else if (view.phase === 'action' && view.action?.puzzle) {
        const at = currentAction(sandbox.state, sandbox.definition);
        const answer = at?.action.type === 'text_puzzle' ? at.action.answers.find((a) => a.trim() !== '') : undefined;
        if (answer === undefined) return { steps, view, stoppedBy: 'stuck' };
        input = { type: 'answer', answer };
      } else if (view.phase === 'action') input = { type: 'advance' };
      else {
        // Prefer a way on over a way back, so a cyclic map is walked forward.
        const open = view.connections.filter((c) => c.open);
        const next = open.find((c) => !c.toRoomCompleted) ?? open[0];
        if (!next) return { steps, view, stoppedBy: 'stuck' };
        input = { type: 'move', connectionId: next.id };
      }
    }
    const result = await sandbox.input(input);
    if (result.status === 'refused') return { steps, view: result.view, stoppedBy: 'refused' };
    steps += 1;
  }
}
