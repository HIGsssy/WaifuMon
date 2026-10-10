import type {
  DungeonAction,
  DungeonReferenceData,
  DungeonRoom,
  DungeonIssue,
} from '@/api/adminDungeons';

export const ACTION_TYPES = [
  'combat',
  'boss',
  'reward',
  'rest',
  'gate',
  'set_flag',
  'leave',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_OUTCOMES: Record<ActionType, string[]> = {
  combat: ['victory', 'defeat'],
  boss: ['victory', 'defeat'],
  reward: ['claimed'],
  rest: ['done'],
  gate: ['passed', 'blocked'],
  set_flag: ['done'],
  leave: [],
};
export function actionId(actions: DungeonAction[], uuid = () => crypto.randomUUID()) {
  const ids = new Set(actions.map((a) => a.id));
  for (;;) {
    const id = `a_${uuid().replaceAll('-', '')}`;
    if (!ids.has(id)) return id;
  }
}
export function createAction(
  type: ActionType,
  actions: DungeonAction[],
  reference?: DungeonReferenceData,
): DungeonAction {
  const base = { id: actionId(actions), type, label: '', optional: false, outcomes: {} };
  switch (type) {
    case 'combat':
    case 'boss':
      return {
        ...base,
        waves: [{ enemy: { key: reference?.enemies.find((e) => e.enabled)?.key ?? '' } }],
        advance: 'confirm',
      };
    case 'reward':
      return {
        ...base,
        reward: { rewardTable: null, equipmentRewardTable: null, currency: { min: 0, max: 0 } },
      };
    case 'rest':
      return { ...base, healBasisPoints: 3000 };
    case 'gate':
      return {
        ...base,
        requires: { type: 'flag', flag: '', scope: 'run', equals: true },
        blockedText: '',
      };
    case 'set_flag':
      return { ...base, flag: '', scope: 'run', value: true };
    case 'leave':
      return base;
  }
}
export function duplicateAction(actions: DungeonAction[], id: string) {
  const index = actions.findIndex((a) => a.id === id);
  if (index < 0) return actions;
  const copy = { ...structuredClone(actions[index]!), id: actionId(actions) };
  return [...actions.slice(0, index + 1), copy, ...actions.slice(index + 1)];
}
export function moveEntry<T>(entries: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
export function routingProblems(room: DungeonRoom) {
  return room.actions.flatMap((action, index) => {
    const routes = Object.entries(action.outcomes ?? {});
    if (action.next) routes.push(['next', action.next]);
    return routes.flatMap(([via, destination]) => {
      if (destination.type !== 'action') return [];
      const target = room.actions.findIndex((a) => a.id === destination.actionId);
      if (target > index) return [];
      return [
        {
          actionId: action.id,
          via,
          targetId: destination.actionId,
          message:
            target < 0
              ? 'Target action was removed or is missing.'
              : 'Target action must be later in this room.',
        },
      ];
    });
  });
}
export function actionIssues(issues: DungeonIssue[], roomIndex: number, actionIndex: number) {
  const prefix = `rooms[${roomIndex}].actions[${actionIndex}]`;
  return issues.filter(
    (i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`),
  );
}
export function actionSummary(action: DungeonAction) {
  if (action.type === 'combat' || action.type === 'boss')
    return `${action.waves?.length ?? 0} waves · ${action.advance ?? 'confirm'}`;
  if (action.type === 'reward')
    return `${action.reward?.rewardTable ?? 'No table'} · currency ${action.reward?.currency.min ?? 0}–${action.reward?.currency.max ?? 0}`;
  if (action.type === 'rest') return `Heal ${(action.healBasisPoints ?? 3000) / 100}%`;
  if (action.type === 'set_flag')
    return `${action.flag || 'Choose flag'} = ${action.value ?? true}`;
  if (action.type === 'gate') return 'Condition gate';
  return action.connectionId ? `Connection ${action.connectionId}` : 'Complete room';
}
