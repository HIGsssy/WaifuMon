/** Pure selection and encounter decisions. Live policy never filters a frozen draw. */
import {
  type DungeonSpeciesPool,
  type EncounterAction,
  type DungeonDefinition,
  type DungeonEncounterOutcome,
} from '../content/dungeonDefinition';
import { evaluateCondition, type ConditionFacts } from './conditions';
import { DungeonEngineContentError } from './combat';
import type {
  DungeonCaptureAttempt,
  DungeonEncounterInstance,
  DungeonEngineContext,
  DungeonRngSource,
  DungeonRunState,
  DungeonEffect,
  DungeonInput,
  DungeonRefusal,
} from './types';

export const encounterInstanceKey = (
  roomId: string,
  actionId: string,
): string => `${roomId}:${actionId}`;
export const encounterGrantKey = (
  runKey: string,
  roomId: string,
  actionId: string,
): string => `dungeon:${runKey}:${roomId}:${actionId}`;
export function seenEncounterSpecies(
  state: Pick<DungeonRunState, 'encounters'>,
): Set<string> {
  return new Set(
    Object.values(state.encounters ?? {}).flatMap((i) =>
      i.species === null ? [] : [i.species],
    ),
  );
}
/** The same analysis drives server previews and the weighted walk. No catalogue facts here. */
export function analyseSpeciesPool(
  pool: DungeonSpeciesPool,
  facts: ConditionFacts,
  seen: ReadonlySet<string> = new Set(),
) {
  const judged = pool.entries.map((entry) => {
    const species = 'species' in entry ? entry.species : null;
    const reason = !evaluateCondition(entry.when, facts)
      ? ('condition' as const)
      : 'species' in entry && entry.oncePerRun && seen.has(entry.species)
        ? ('already_seen' as const)
        : null;
    return {
      id: entry.id,
      species,
      weight: entry.weight,
      eligible: reason === null,
      reason,
    };
  });
  const totalWeight = judged.reduce(
    (sum, e) => sum + (e.eligible ? e.weight : 0),
    0,
  );
  const entries = judged.map((e) => ({
    ...e,
    probability: e.eligible && totalWeight > 0 ? e.weight / totalWeight : 0,
  }));
  return {
    totalWeight,
    entries,
    nothingProbability:
      totalWeight === 0
        ? 1
        : entries.reduce(
            (sum, e) => sum + (e.species === null ? e.probability : 0),
            0,
          ),
  };
}
export function selectDungeonEncounter(
  definition: DungeonDefinition,
  action: EncounterAction,
  place: { roomId: string; actionId: string },
  state: DungeonRunState,
  facts: ConditionFacts,
  rng: DungeonRngSource,
): DungeonEncounterInstance {
  const base = { selectedStep: state.step, attempts: [] };
  if (action.source.kind === 'species')
    return { ...base, species: action.source.species, status: 'offered' };
  const pool = definition.speciesPools?.find(
    (p) => p.id === (action.source.kind === 'pool' ? action.source.poolId : ''),
  );
  if (!pool)
    throw new DungeonEngineContentError(
      `Missing species pool for ${place.roomId}:${place.actionId}`,
    );
  const analysis = analyseSpeciesPool(pool, facts, seenEncounterSpecies(state));
  const eligible = analysis.entries.filter((e) => e.eligible);
  const roll =
    analysis.totalWeight === 0
      ? null
      : rng
          .stream('encounter', place.roomId, place.actionId, 'pool')
          .intInclusive(0, analysis.totalWeight - 1);
  let remaining = roll ?? 0;
  const entry =
    roll === null
      ? undefined
      : eligible.find((e) => (remaining -= e.weight) < 0);
  const species = entry?.species ?? null;
  return {
    ...base,
    species,
    status: species === null ? 'nothing' : 'offered',
    pool: {
      poolId: pool.id,
      entryId: entry?.id ?? null,
      eligible: eligible.map((e) => e.id),
      totalWeight: analysis.totalWeight,
      roll,
    },
  };
}
/** Recheck at offer and before an attempt, without spending anything on refusal. */
export function checkEncounterAvailability(
  instance: DungeonEncounterInstance,
  ctx: DungeonEngineContext,
  action: EncounterAction,
): void {
  if (instance.status !== 'offered' || instance.species === null) return;
  const fact = Object.hasOwn(
    ctx.encounterFacts?.species ?? {},
    instance.species,
  )
    ? ctx.encounterFacts?.species[instance.species]
    : undefined;
  const direct = action.type === 'rescue' && action.mode === 'direct';
  if (!fact?.available || (direct && !fact.directRescue?.available)) {
    instance.status = 'unavailable';
    instance.unavailableReason = !fact?.available
      ? (fact?.reason ?? 'missing')
      : (fact.directRescue?.reason ?? 'direct_not_permitted');
  }
}
export function captureRules(action: EncounterAction) {
  if (action.type === 'rescue' && action.mode === 'direct') return null;
  if (!action.capture)
    throw new DungeonEngineContentError(
      'Capture encounter has no capture rules',
    );
  return action.capture;
}
export function encounterItems(
  action: EncounterAction,
  ctx: DungeonEngineContext,
) {
  const rules = captureRules(action);
  if (!rules) return [];
  return Object.entries(ctx.encounterFacts?.items ?? {})
    .filter(
      ([item, f]) =>
        f.owned >= 1 &&
        f.eligible &&
        f.permitted &&
        Number.isFinite(f.chance) &&
        f.chance >= 0 &&
        f.chance <= 1 &&
        (!rules.allowedItems || rules.allowedItems.includes(item)) &&
        (rules.allowGuaranteedItems || !f.guaranteed),
    )
    .map(([item, f]) => ({
      item,
      owned: f.owned,
      guaranteed: f.guaranteed,
      chance: f.guaranteed ? 1 : f.chance,
    }));
}
export function encounterResultText(
  definition: DungeonDefinition,
  action: EncounterAction,
  instance: DungeonEncounterInstance,
  outcome: DungeonEncounterOutcome,
): string {
  const authored = action.results?.[outcome]?.text;
  if (authored !== undefined) return authored;
  const pool = definition.speciesPools?.find(
    (p) => p.id === instance.pool?.poolId,
  );
  const entry = pool?.entries.find((e) => e.id === instance.pool?.entryId);
  return outcome === 'nothing' && entry && 'nothing' in entry
    ? (entry.text ?? '')
    : '';
}
/** Decides an input, returning a terminal outcome, an open encounter, or a refusal. */
export function decideEncounterInput(
  state: DungeonRunState,
  action: EncounterAction,
  input: DungeonInput,
  ctx: DungeonEngineContext,
  rng: DungeonRngSource,
):
  | {
      outcome: DungeonEncounterOutcome | null;
      effects: DungeonEffect[];
      attempt?: DungeonCaptureAttempt;
    }
  | DungeonRefusal {
  const { roomId, actionId } = state.cursor;
  if (!actionId) return 'encounter_not_offered';
  const instance = state.encounters?.[encounterInstanceKey(roomId, actionId)];
  if (instance?.status !== 'offered') return 'encounter_not_offered';
  if (input.type === 'leave_encounter') return { outcome: 'left', effects: [] };
  const direct = action.type === 'rescue' && action.mode === 'direct';
  if (
    (input.type === 'rescue' && !direct) ||
    ((input.type === 'capture' || input.type === 'select_item') && direct)
  )
    return 'not_available';
  checkEncounterAvailability(instance, ctx, action);
  if (instance.unavailableReason !== undefined)
    return { outcome: 'unavailable', effects: [] };
  const grantKey = encounterGrantKey(ctx.runKey, roomId, actionId);
  if (input.type === 'rescue') {
    instance.grantKey = grantKey;
    return {
      outcome: 'rescued',
      effects: [
        {
          type: 'rescue_grant',
          grantKey,
          roomId,
          actionId,
          species: instance.species!,
          spRoll: rng.stream('encounter', roomId, actionId, 'sp').next(),
        },
      ],
    };
  }
  const items = encounterItems(action, ctx);
  if (input.type === 'select_item') {
    if (!items.some((i) => i.item === input.item))
      return 'capture_item_unavailable';
    instance.selectedItem = input.item;
    return { outcome: null, effects: [] };
  }
  if (input.type !== 'capture') return 'encounter_not_offered';
  if (!instance.selectedItem) return 'capture_item_required';
  const item = items.find((i) => i.item === instance.selectedItem);
  if (!item) return 'capture_item_unavailable';
  const rules = captureRules(action)!;
  if (instance.attempts.length >= rules.maxAttempts)
    return 'encounter_not_offered';
  const n = instance.attempts.length + 1;
  const roll = rng.stream('encounter', roomId, actionId, 'attempt', n).next();
  const attempt = {
    n,
    item: item.item,
    chance: item.chance,
    roll,
    success: item.guaranteed || roll < item.chance,
    step: state.step,
  };
  instance.attempts.push(attempt);
  if (attempt.success) instance.grantKey = grantKey;
  const effect: DungeonEffect = {
    type: 'capture_attempt',
    key: `run:${ctx.runKey}:${roomId}:${actionId}:capture:${n}`,
    grantKey,
    roomId,
    actionId,
    species: instance.species!,
    mode: action.type === 'rescue' ? 'rescue' : 'wild',
    attempt,
    guaranteed: item.guaranteed,
    consumesMicrodose:
      !item.guaranteed &&
      ctx.encounterFacts?.items?.[item.item]?.consumesMicrodose === true,
    spRoll: rng.stream('encounter', roomId, actionId, 'sp').next(),
  };
  return {
    effects: [effect],
    attempt,
    outcome: attempt.success
      ? action.type === 'rescue'
        ? 'rescued'
        : 'captured'
      : n >= rules.maxAttempts
        ? 'escaped'
        : null,
  };
}
export function describeOfferedEncounter(
  state: DungeonRunState,
  ctx: DungeonEngineContext,
) {
  const room = ctx.definition.rooms.find((r) => r.id === state.cursor.roomId);
  const action = room?.actions.find((a) => a.id === state.cursor.actionId);
  if (!action || (action.type !== 'wild_encounter' && action.type !== 'rescue'))
    return null;
  const instance =
    state.encounters?.[encounterInstanceKey(room!.id, action.id)];
  if (instance?.status !== 'offered' || !instance.species) return null;
  const fact = ctx.encounterFacts?.species[instance.species];
  const direct = action.type === 'rescue' && action.mode === 'direct';
  const available =
    fact?.available === true &&
    (!direct || fact.directRescue?.available === true);
  return {
    species: instance.species,
    name: fact?.name ?? instance.species,
    rarity: fact?.rarity ?? null,
    intro: action.intro,
    mode:
      action.type === 'rescue' && action.mode === 'direct'
        ? ('direct' as const)
        : ('capture' as const),
    available,
    unavailableReason: available
      ? null
      : !fact?.available
        ? (fact?.reason ?? 'missing')
        : (fact.directRescue?.reason ?? 'direct_not_permitted'),
    selectedItem: instance.selectedItem ?? null,
    attemptsLeft: Math.max(
      0,
      (captureRules(action)?.maxAttempts ?? 0) - instance.attempts.length,
    ),
    items: encounterItems(action, ctx),
    canLeave: true as const,
  };
}
export type DungeonEncounterView = NonNullable<
  ReturnType<typeof describeOfferedEncounter>
>;
