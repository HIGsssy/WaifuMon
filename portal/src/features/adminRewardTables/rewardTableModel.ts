/**
 * Pure helpers behind the reward table editor: how a group's numbers read to
 * an author (chance as a percentage, each row's share of the pick), which
 * server issues belong to which row, and the blank shapes new rows start from.
 *
 * The server is the authority on validity — the editor asks it on every change
 * (`validate`) — so nothing here re-implements a rule. These only shape what
 * is shown.
 */
import type {
  EquipmentRewardRowDoc,
  EquipmentSelectorPreview,
  ItemRewardRowDoc,
  RewardGroupDoc,
  RewardTableDoc,
  RewardTableIssue,
  RewardTableKind,
} from '@/api/adminRewardTables';

export const BASIS_POINTS = 10_000;

/** 2500 → "25%", 25 → "0.25%". */
export function chancePercentLabel(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/** A typed percentage back to basis points, or null when it is not one. */
export function basisPointsFromPercent(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export const groupChance = (g: RewardGroupDoc) => g.chanceBasisPoints ?? BASIS_POINTS;
export const groupRolls = (g: RewardGroupDoc) => g.rolls ?? 1;
export const isEnabled = (x: { enabled?: boolean }) => x.enabled !== false;

/**
 * Each row's share of its group's weighted pick, as a percentage — over the
 * *enabled* rows of both kinds, exactly as the server's pick normalises.
 * Disabled rows (and every row of a disabled group) get null.
 */
export function rowShares(group: RewardGroupDoc): { items: (number | null)[]; equipment: (number | null)[] } {
  const live = isEnabled(group);
  const items = group.entries;
  const gear = group.equipment ?? [];
  const total =
    items.filter(isEnabled).reduce((n, r) => n + (r.weight > 0 ? r.weight : 0), 0) +
    gear.filter(isEnabled).reduce((n, r) => n + (r.weight > 0 ? r.weight : 0), 0);
  const share = (r: { enabled?: boolean; weight: number }) =>
    live && isEnabled(r) && total > 0 && r.weight > 0 ? (r.weight / total) * 100 : null;
  return { items: items.map(share), equipment: gear.map(share) };
}

export function sharePercentLabel(share: number | null): string {
  if (share === null) return '—';
  return `${share >= 10 ? Math.round(share) : Number(share.toFixed(1))}%`;
}

/**
 * The one-line group summary: whether and how often it fires, and what it
 * can pay. `gearCandidates` is the number of distinct base definitions the
 * group's enabled gear rows can hand out (from the server preview), or null
 * while the preview is loading or the group pays no gear.
 */
export function groupSummary(group: RewardGroupDoc, gearCandidates: number | null): string {
  if (!isEnabled(group)) return 'Disabled — never rolls';
  const items = group.entries.filter(isEnabled).length;
  const gear = (group.equipment ?? []).filter(isEnabled).length;
  const parts = [
    `Chance ${chancePercentLabel(groupChance(group))}`,
    `Rolls ${groupRolls(group)}`,
    `${items} item row${items === 1 ? '' : 's'}`,
  ];
  if (gear > 0) {
    parts.push(
      `${gear} gear row${gear === 1 ? '' : 's'}` +
        (gearCandidates === null ? '' : ` · ${gearCandidates} candidate${gearCandidates === 1 ? '' : 's'}`),
    );
  }
  return parts.join(' · ');
}

// ── issues by path ──────────────────────────────────────────────────────────

/** Where an issue belongs in the editor. */
export type IssueTarget =
  | { kind: 'table' }
  | { kind: 'group'; group: number }
  | { kind: 'item'; group: number; row: number }
  | { kind: 'equipment'; group: number; row: number };

export function issueTarget(path: string): IssueTarget {
  const row = /^groups\[(\d+)\]\.(entries|equipment)\[(\d+)\]/.exec(path);
  if (row) {
    return {
      kind: row[2] === 'entries' ? 'item' : 'equipment',
      group: Number(row[1]),
      row: Number(row[3]),
    };
  }
  const group = /^groups\[(\d+)\]/.exec(path);
  if (group) return { kind: 'group', group: Number(group[1]) };
  return { kind: 'table' };
}

/** The issues addressed to exactly this target. */
export function issuesFor(issues: readonly RewardTableIssue[], target: IssueTarget): RewardTableIssue[] {
  return issues.filter((issue) => {
    const t = issueTarget(issue.path);
    if (t.kind !== target.kind) return false;
    if (t.kind === 'table' || target.kind === 'table') return true;
    if (t.group !== target.group) return false;
    return t.kind === 'group' || (target.kind !== 'group' && 'row' in t && t.row === target.row);
  });
}

// ── blank shapes ────────────────────────────────────────────────────────────

/** Quantity is explicit on both kinds: boss rows require it, and it reads clearer. */
export function newItemRow(itemId: string): ItemRewardRowDoc {
  return { itemId, enabled: true, weight: 1, quantity: 1 };
}

export function newEquipmentRow(): EquipmentRewardRowDoc {
  return { enabled: true, weight: 1 };
}

/** A group id not yet used in the table: `group-2`, `group-3`… */
export function nextGroupId(table: RewardTableDoc): string {
  const taken = new Set(table.groups.map((g) => g.id));
  for (let n = table.groups.length + 1; ; n += 1) {
    if (!taken.has(`group-${n}`)) return `group-${n}`;
  }
}

/**
 * Marks a group added in this editing session. Its id stays editable until it
 * is saved; once on the server an id keys deterministic draws and is fixed.
 * Never sent: {@link tidyGroup} strips it.
 */
export const DRAFT_GROUP = '__draft';

export function newGroup(table: RewardTableDoc): RewardGroupDoc {
  return {
    id: nextGroupId(table),
    enabled: true,
    rolls: 1,
    chanceBasisPoints: BASIS_POINTS,
    entries: [],
    [DRAFT_GROUP]: true,
  };
}

export function newTable(kind: RewardTableKind, id: string): RewardTableDoc {
  return kind === 'boss'
    ? { id, enabled: true, buddyXp: 0, groups: [] }
    : { id, enabled: true, waifuXp: 0, playerXp: 0, groups: [] };
}

/**
 * The group as it is sent: no draft marker, and no empty optional `equipment`
 * list, so an untouched group saves exactly as it loaded.
 */
export function tidyGroup(group: RewardGroupDoc): RewardGroupDoc {
  const { [DRAFT_GROUP]: _draft, ...rest } = group;
  if (rest.equipment && rest.equipment.length === 0) {
    const { equipment: _dropped, ...withoutGear } = rest;
    return withoutGear as RewardGroupDoc;
  }
  return rest as RewardGroupDoc;
}

/** The selector fields of a gear row — what the preview endpoint takes. */
export function selectorOf(row: EquipmentRewardRowDoc): Record<string, unknown> {
  const { enabled: _e, weight: _w, ...selector } = row;
  return selector;
}

export const KIND_LABELS: Record<RewardTableKind, string> = { boss: 'Boss', expedition: 'Expedition' };

export const REFERENCE_ROLE_LABELS = {
  boss: 'Boss',
  success: 'Mission reward',
  bonus: 'Exceptional bonus',
  failure: 'Failure consolation',
} as const;

const SLOT_LABELS: Record<string, string> = { attack: 'Attack', defense: 'Defense', health: 'Health' };

/** "R Attack · 3 eligible: Combat Knife, Semi-Auto Sidearm, Throbbing Mace" */
export function previewLine(row: EquipmentRewardRowDoc, preview: EquipmentSelectorPreview | undefined): string {
  const rarity = typeof row.rarity === 'string' ? `${row.rarity} ` : 'Any rarity ';
  const slot = typeof row.slot === 'string' ? SLOT_LABELS[row.slot] ?? row.slot : 'any slot';
  const head = `${rarity}${slot}`;
  if (!preview) return `${head} · checking…`;
  if (preview.eligible.length === 0) return `${head} · nothing eligible`;
  return `${head} · ${preview.eligible.length} eligible: ${preview.eligible.map((d) => d.name).join(', ')}`;
}
