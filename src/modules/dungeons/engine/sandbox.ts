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
import { startDungeonRun, stepDungeon } from './step';
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
      if (effect.type === 'grant_rewards') {
        return {
          type: 'grant_rewards',
          claimKey: effect.claimKey,
          waifubux: effect.plan.waifubux,
          items: effect.plan.items,
          equipment: [],
        };
      }
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
  fighter: EngineFighter;
  seed: number;
  combatRules?: DungeonEngineContext['combatRules'];
  playerFlags?: DungeonEngineContext['playerFlags'];
}

export function createDungeonSandbox(options: DungeonSandboxOptions): DungeonSandbox {
  const ctx: DungeonEngineContext = {
    definition: options.definition,
    dependencies: options.dependencies,
    fighter: options.fighter,
    runKey: `sandbox-${options.seed}`,
    playerFlags: options.playerFlags,
    combatRules: options.combatRules,
  };
  const rng = dungeonRngSource(options.seed);
  const port = sandboxEffectsPort();
  const log: DungeonLogEntry[] = [];
  const combat: DungeonStepResult['combat'] = [];

  const started = startDungeonRun(ctx, options.seed, rng);
  let state = started.state;
  log.push(...started.log);
  combat.push(...started.combat);

  return {
    get state() {
      return state;
    },
    get view() {
      return describeDungeonRun(state, ctx, rng);
    },
    effects: port.recorded,
    log,
    combat,
    async input(input) {
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
      if (view.phase === 'action') input = { type: 'advance' };
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
