/**
 * The Dungeon Loot editor's working model: the form an author edits, the
 * schema-compatible body it becomes, and the plain-language reading of
 * rewards, problems and odds. Pure — no React and no requests.
 *
 * The form keeps what the author typed (a percentage, a share) as text, so a
 * half-typed or invalid number is explained beside its field instead of being
 * silently corrected. Nothing here rolls loot or works out a drop's odds:
 * those come from the server's Test Roll analysis. The one sum done locally is
 * a share's slice of its group, which is the definition of a share.
 */
import type {
  DungeonAnalysedReward,
  DungeonLootTable,
  DungeonLootTableBody,
  DungeonRewardAnalysis,
  DungeonRewardGrant,
  EquipmentRewardSelector,
} from '@/api/adminDungeonLootTables';
import type { DungeonIssue, DungeonReferenceData } from '@/api/adminDungeons';
import { formatNumber } from '@/lib/format';

/** Mirrors the server's `DUNGEON_REWARD_LIMITS`; the server stays authoritative. */
export const LOOT_LIMITS = {
  guaranteed: 12,
  chances: 20,
  pools: 6,
  poolPicks: 10,
  poolEntries: 40,
  share: 1_000_000,
  tableRolls: 10,
  name: 100,
  description: 600,
} as const;

export const LOOT_TIERS = ['common', 'rare', 'boss', 'legendary'] as const;
export type LootTier = (typeof LOOT_TIERS)[number];
export const TIER_LABELS: Record<LootTier, string> = {
  common: 'Common',
  rare: 'Rare',
  boss: 'Boss',
  legendary: 'Legendary',
};

// ── Reward types ────────────────────────────────────────────────────────────

export type RewardKind = 'shards' | 'waifubux' | 'essence' | 'item' | 'equipment' | 'affection';
export const REWARD_KINDS: ReadonlyArray<{ kind: RewardKind; label: string; max: number }> = [
  { kind: 'shards', label: 'Baddie Shards', max: 1_000_000 },
  { kind: 'waifubux', label: 'WaifuBux', max: 1_000_000 },
  { kind: 'essence', label: 'Essence', max: 100_000 },
  { kind: 'item', label: 'Item', max: 999 },
  { kind: 'equipment', label: 'Equipment', max: 1 },
  { kind: 'affection', label: 'Affection', max: 500 },
];
const kindInfo = (kind: RewardKind) => REWARD_KINDS.find((k) => k.kind === kind)!;
export const kindOfGrant = (grant: DungeonRewardGrant): RewardKind =>
  grant.type === 'currency' ? grant.currency : grant.type;
/** Shards and WaifuBux are held until the run ends; everything else is given at once. */
export const isAtRisk = (kind: RewardKind) => kind === 'shards' || kind === 'waifubux';

/** What the reward form holds while the author is still choosing. */
export interface RewardDraft {
  kind: RewardKind | null;
  /** The single amount, or the lowest amount of a range. */
  amount: string;
  /** The highest amount; read only while `ranged`. */
  max: string;
  ranged: boolean;
  item: string;
  selector: EquipmentRewardSelector;
}
export const emptyRewardDraft = (): RewardDraft => ({
  kind: null,
  amount: '1',
  max: '1',
  ranged: false,
  item: '',
  selector: {},
});
export function draftOfGrant(grant: DungeonRewardGrant): RewardDraft {
  const draft = { ...emptyRewardDraft(), kind: kindOfGrant(grant) };
  if (grant.type === 'equipment') return { ...draft, selector: grant.selector };
  const range = grant.type === 'item' ? grant.quantity : grant.amount;
  return {
    ...draft,
    amount: String(range.min),
    max: String(range.max),
    ranged: range.max !== range.min,
    item: grant.type === 'item' ? grant.item : '',
  };
}
const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
/** The grant a finished draft stores, or what the author still has to do. */
export function grantOfDraft(
  draft: RewardDraft,
): { grant: DungeonRewardGrant } | { problem: string } {
  if (!draft.kind) return { problem: 'Choose what to give.' };
  if (draft.kind === 'equipment') return { grant: { type: 'equipment', selector: draft.selector } };
  if (draft.kind === 'item' && !draft.item) return { problem: 'Choose an item.' };
  const limit = kindInfo(draft.kind).max;
  const min = whole(draft.amount);
  const max = draft.ranged ? whole(draft.max) : min;
  const inRange = (n: number | null): n is number => n !== null && n >= 1 && n <= limit;
  if (!inRange(min) || !inRange(max))
    return { problem: `Enter a whole number from 1 to ${formatNumber(limit)}.` };
  if (max < min) return { problem: 'The highest amount must be at least the lowest.' };
  const range = { min, max };
  if (draft.kind === 'item') return { grant: { type: 'item', item: draft.item, quantity: range } };
  if (draft.kind === 'affection') return { grant: { type: 'affection', amount: range } };
  return { grant: { type: 'currency', currency: draft.kind, amount: range } };
}

// ── Names ───────────────────────────────────────────────────────────────────

export interface EquipmentPiece {
  key: string;
  name: string;
  slot: string;
  rarity: string;
}
/** Readable names for the slugs and keys a reward stores. */
export interface RewardNames {
  item: (slug: string) => string;
  equipment: (key: string) => string;
  /** How many pieces a selector can currently drop, when the server has said. */
  matches: (selector: EquipmentRewardSelector) => number | undefined;
}
/** The server's own identity for a selector (`equipmentSelectorKey`), used to read its pools. */
export function selectorKey(selector: EquipmentRewardSelector): string {
  const keys = selector.definitionKeys ? [...selector.definitionKeys].sort().join(',') : '*';
  return `slot=${selector.slot ?? '*'};rarity=${selector.rarity ?? '*'};keys=${keys}`;
}
export function rewardNames(
  items: DungeonReferenceData['items'] | undefined,
  ...pools: Array<Record<string, EquipmentPiece[]> | undefined>
): RewardNames {
  const itemNames = new Map((items ?? []).map((i) => [i.slug, i.name]));
  const pieces = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const pool of pools)
    for (const [key, list] of Object.entries(pool ?? {})) {
      counts.set(key, list.length);
      for (const piece of list) pieces.set(piece.key, piece.name);
    }
  return {
    item: (slug) => itemNames.get(slug) ?? 'an item that no longer exists',
    equipment: (key) => pieces.get(key) ?? 'an unavailable piece',
    matches: (selector) => counts.get(selectorKey(selector)),
  };
}
export const SLOT_LABELS: Record<string, string> = {
  attack: 'Attack',
  defense: 'Defense',
  health: 'Health',
};
export function describeSelector(selector: EquipmentRewardSelector, names?: RewardNames): string {
  const keys = selector.definitionKeys ?? [];
  if (keys.length === 1 && names) return names.equipment(keys[0]!);
  const kind = [selector.rarity, selector.slot && SLOT_LABELS[selector.slot]]
    .filter(Boolean)
    .join(' ');
  if (keys.length > 0) return `One of ${keys.length} chosen ${kind ? `${kind} ` : ''}pieces`;
  return kind ? `${kind} gear` : 'Any gear';
}
const rangeText = (range: { min: number; max: number }) =>
  range.min === range.max
    ? formatNumber(range.min)
    : `${formatNumber(range.min)}–${formatNumber(range.max)}`;
/** `2–4 Bent Gear`, `500 WaifuBux`, `R Attack gear (4 possible)`. */
export function describeGrant(grant: DungeonRewardGrant, names: RewardNames): string {
  switch (grant.type) {
    case 'currency':
      return `${rangeText(grant.amount)} ${kindInfo(grant.currency).label}`;
    case 'item':
      return `${rangeText(grant.quantity)} ${names.item(grant.item)}`;
    case 'affection':
      return `${rangeText(grant.amount)} Affection`;
    case 'equipment': {
      const count = names.matches(grant.selector);
      const single = (grant.selector.definitionKeys ?? []).length === 1;
      const text = describeSelector(grant.selector, names);
      return count === undefined || single ? text : `${text} (${count} possible)`;
    }
  }
}
export function rewardLabel(reward: DungeonAnalysedReward, names: RewardNames): string {
  if (reward.type === 'currency') return kindInfo(reward.currency).label;
  if (reward.type === 'item') return names.item(reward.item);
  if (reward.type === 'equipment') return names.equipment(reward.definitionKey);
  return 'Affection';
}

// ── Items ───────────────────────────────────────────────────────────────────

export type ItemRef = DungeonReferenceData['items'][number];
export const ITEM_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'capture', label: 'Charms' },
  { id: 'salvage', label: 'Salvage' },
  { id: 'consumable', label: 'Consumables' },
  { id: 'other', label: 'Other' },
] as const;
export type ItemFilter = (typeof ITEM_FILTERS)[number]['id'];
const CATEGORY_LABELS: Record<string, string> = {
  capture: 'Charm',
  salvage: 'Salvage',
  consumable: 'Consumable',
  key: 'Key item',
};
export const categoryLabel = (category: string) => CATEGORY_LABELS[category] ?? 'Other';
export function itemMatchesFilter(item: ItemRef, filter: ItemFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'other') return !['capture', 'salvage', 'consumable'].includes(item.category);
  return item.category === filter;
}
/** Why an item cannot be dungeon loot, or null when it can. */
export function itemUnusable(item: ItemRef): string | null {
  if (item.maxOwned !== null)
    return `Limited to ${item.maxOwned} per player, so it cannot be dungeon loot`;
  if (!item.enabled) return 'Disabled';
  return null;
}

// ── The form ────────────────────────────────────────────────────────────────

export interface GuaranteedRow {
  id: string;
  grant: DungeonRewardGrant;
}
export interface ChanceRow extends GuaranteedRow {
  /** As typed, e.g. `25` or `0.5`. */
  percent: string;
}
export type PoolRow =
  | { id: string; share: string; grant: DungeonRewardGrant }
  | { id: string; share: string; nothing: true };
export interface PoolForm {
  id: string;
  name: string;
  picks: string;
  entries: PoolRow[];
}
export interface LootForm {
  name: string;
  description: string;
  tier: LootTier | null;
  guaranteed: GuaranteedRow[];
  chances: ChanceRow[];
  pools: PoolForm[];
}
/** A stable entry ID. Authors never see or type one; it survives reordering. */
export const newEntryId = (prefix: 'g' | 'c' | 'p' | 'e' | 't', uuid = () => crypto.randomUUID()) =>
  `${prefix}_${uuid().replaceAll('-', '')}`;
export const emptyForm = (): LootForm => ({
  name: '',
  description: '',
  tier: null,
  guaranteed: [],
  chances: [],
  pools: [],
});
export const percentText = (basisPoints: number) => String(Number((basisPoints / 100).toFixed(2)));
export function formOfBody(body: DungeonLootTableBody) {
  return {
    guaranteed: body.guaranteed.map((e) => ({ id: e.id, grant: e.grant })),
    chances: body.chances.map((e) => ({
      id: e.id,
      percent: percentText(e.chanceBasisPoints),
      grant: e.grant,
    })),
    pools: body.pools.map((pool) => ({
      id: pool.id,
      name: pool.name,
      picks: String(pool.draws),
      entries: pool.entries.map((e): PoolRow =>
        'grant' in e
          ? { id: e.id, share: String(e.weight), grant: e.grant }
          : { id: e.id, share: String(e.weight), nothing: true },
      ),
    })),
  };
}
export const formOf = (
  table: Pick<DungeonLootTable, 'name' | 'description' | 'tier' | 'body'>,
): LootForm => ({
  name: table.name,
  description: table.description,
  tier: table.tier,
  ...formOfBody(table.body),
});

/** A percentage as typed → basis points, or the friendly reason it will not do. */
export function parsePercent(
  text: string,
): { basisPoints: number } | { problem: string; always?: true } {
  const value = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value))
    return { problem: 'Enter a percentage such as 25 or 0.5, with up to two decimals.' };
  const basisPoints = Math.round(Number(value) * 100);
  if (basisPoints === 0) return { problem: 'A 0% drop never happens. Remove it instead.' };
  if (basisPoints === 10_000)
    return {
      problem: 'A 100% drop always happens, so it belongs with the always-given rewards.',
      always: true,
    };
  if (basisPoints > 10_000) return { problem: 'A chance cannot be more than 100%.' };
  return { basisPoints };
}
export function parseShare(text: string): { share: number } | { problem: string } {
  const value = whole(text);
  if (value === 0) return { problem: 'A share of 0 can never be picked. Remove it instead.' };
  if (value === null || value > LOOT_LIMITS.share)
    return { problem: `Enter a whole number from 1 to ${formatNumber(LOOT_LIMITS.share)}.` };
  return { share: value };
}
/** Each row's slice of its group, as a fraction; null for a row whose share is not usable yet. */
export function shareFractions(entries: PoolRow[]): Array<number | null> {
  const shares = entries.map((e) => {
    const parsed = parseShare(e.share);
    return 'share' in parsed ? parsed.share : null;
  });
  const total = shares.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  return shares.map((s) => (s === null || total === 0 ? null : s / total));
}

/** Something the author must fix before the table can be saved or rolled. */
export interface FormProblem {
  /** `name`, `description`, an entry ID, or `<pool id>:name` / `:picks` / `:entries`. */
  at: string;
  message: string;
}
/** The schema-compatible body, or null with the reasons while the form cannot make one. */
export function bodyOf(form: LootForm): {
  body: DungeonLootTableBody | null;
  problems: FormProblem[];
} {
  const problems: FormProblem[] = [];
  const bodyProblems = () => problems.filter((p) => p.at !== 'name' && p.at !== 'description');
  if (!form.name.trim()) problems.push({ at: 'name', message: 'Give the table a name.' });
  else if (form.name.trim().length > LOOT_LIMITS.name)
    problems.push({ at: 'name', message: `Keep the name to ${LOOT_LIMITS.name} characters.` });
  if (form.description.trim().length > LOOT_LIMITS.description)
    problems.push({
      at: 'description',
      message: `Keep the description to ${LOOT_LIMITS.description} characters.`,
    });
  const chances = form.chances.map((row) => {
    const parsed = parsePercent(row.percent);
    if ('problem' in parsed) problems.push({ at: row.id, message: parsed.problem });
    return {
      id: row.id,
      chanceBasisPoints: 'problem' in parsed ? 0 : parsed.basisPoints,
      grant: row.grant,
    };
  });
  const pools = form.pools.map((pool) => {
    const draws = whole(pool.picks);
    if (!pool.name.trim())
      problems.push({ at: `${pool.id}:name`, message: 'Give this group a name.' });
    if (draws === null || draws < 1 || draws > LOOT_LIMITS.poolPicks)
      problems.push({
        at: `${pool.id}:picks`,
        message: `Picks must be a whole number from 1 to ${LOOT_LIMITS.poolPicks}.`,
      });
    if (pool.entries.length === 0)
      problems.push({
        at: `${pool.id}:entries`,
        message: 'Add at least one choice, or remove this group.',
      });
    return {
      id: pool.id,
      name: pool.name.trim(),
      draws: draws ?? 0,
      entries: pool.entries.map((row) => {
        const parsed = parseShare(row.share);
        if ('problem' in parsed) problems.push({ at: row.id, message: parsed.problem });
        const weight = 'problem' in parsed ? 0 : parsed.share;
        return 'grant' in row
          ? { id: row.id, weight, grant: row.grant }
          : { id: row.id, weight, nothing: true as const };
      }),
    };
  });
  if (bodyProblems().length > 0) return { body: null, problems };
  return {
    body: {
      guaranteed: form.guaranteed.map((r) => ({ id: r.id, grant: r.grant })),
      chances,
      pools,
    },
    problems,
  };
}

/** Reorders by position only: every entry keeps its ID. */
export function moved<T>(list: T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = base || 'loot_table';
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${root.slice(0, 64 - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ── Numbers for people ──────────────────────────────────────────────────────

const trimZeros = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);
/**
 * A probability in [0, 1] as a percentage. Small odds gain decimals, and a
 * positive chance is never shown as 0% (nor a chance short of certain as 100%).
 */
export function formatChance(probability: number): string {
  if (!(probability > 0)) return '0%';
  if (probability >= 1) return '100%';
  const percent = probability * 100;
  let text = trimZeros(percent.toFixed(percent < 10 ? 2 : 1));
  if (text === '0' || text === '100') text = trimZeros(percent.toFixed(2));
  if (text === '0') return 'less than 0.01%';
  if (text === '100') return 'more than 99.99%';
  return `${text}%`;
}
/** An average quantity: whole when it is whole, two decimals otherwise, never a false zero. */
export function formatAverage(quantity: number): string {
  if (!(quantity > 0)) return '0';
  if (quantity < 0.005) return 'less than 0.01';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(quantity);
}
/** `a`, `a and b`, `a, b and c`. */
export function listText(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
/** `3 Bent Gear`, `2.25 Essence`, `0.75 gear pieces` — the averages the server worked out. */
export function averageParts(analysis: DungeonRewardAnalysis, names: RewardNames): string[] {
  const parts = analysis.rewards
    .filter((r) => r.reward.type !== 'equipment')
    .map((r) => `${formatAverage(r.expectedQuantity)} ${rewardLabel(r.reward, names)}`);
  if (analysis.expectedEquipmentPieces > 0)
    parts.push(
      `${formatAverage(analysis.expectedEquipmentPieces)} gear ${analysis.expectedEquipmentPieces === 1 ? 'piece' : 'pieces'}`,
    );
  return parts;
}

// ── Problems the server reports ─────────────────────────────────────────────

export interface FriendlyLootIssue {
  /** The entry or group it belongs beside, or null for the table as a whole. */
  at: string | null;
  severity: 'error' | 'warning';
  text: string;
  /** The server's own wording and location, for a hover title. */
  raw: string;
}
/**
 * The server's issues in creator language, each beside the row it is about.
 * `body` must be the body that was validated, since paths are positions in it.
 */
export function friendlyLootIssues(
  issues: readonly DungeonIssue[],
  body: DungeonLootTableBody,
  names: RewardNames,
  items: readonly ItemRef[] = [],
): FriendlyLootIssue[] {
  return issues.map((issue) => {
    // A Test Roll reports the same positions beneath the activity it wraps the table in.
    const parts = issue.path
      .replace(/^.*\.tables\[\d+\](?=\.body|$)\.?/, '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.');
    const index = (n: number) => Number(parts[n]);
    let at: string | null = null;
    let grant: DungeonRewardGrant | undefined;
    let poolName = '';
    if (parts[1] === 'guaranteed' || parts[1] === 'chances') {
      const entry = body[parts[1]][index(2)];
      at = entry?.id ?? null;
      grant = entry?.grant;
    } else if (parts[1] === 'pools') {
      const pool = body.pools[index(2)];
      poolName = pool?.name ?? '';
      const entry = parts[3] === 'entries' ? pool?.entries[index(4)] : undefined;
      at = entry?.id ?? pool?.id ?? null;
      grant = entry && 'grant' in entry ? entry.grant : undefined;
    }
    const item =
      grant?.type === 'item'
        ? items.find((i) => i.slug === (grant as { item: string }).item)
        : undefined;
    // The server prefixes its message with a label that quotes entry IDs; keep only the sentence.
    const sentence = issue.message.replace(/^(?:Loot table|Room )[^:]*:\s*/, '');
    let text = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    switch (issue.code) {
      case 'reward_item_missing':
        text = 'This item no longer exists. Pick another item.';
        break;
      case 'reward_item_disabled':
        text = `${item?.name ?? 'This item'} is disabled. Enable it or pick another item.`;
        break;
      case 'reward_item_capped':
        text = `${item?.name ?? 'This item'} is limited to ${item?.maxOwned ?? 'a few'} per player, so it cannot be dungeon loot.`;
        break;
      case 'reward_equipment_empty':
        text = `No gear matches “${grant?.type === 'equipment' ? describeSelector(grant.selector, names) : 'this choice'}”. Loosen the choice.`;
        break;
      case 'reward_pool_all_nothing':
        text = `“${poolName}” can only ever give Nothing.`;
        break;
      case 'reward_empty':
        text = 'This table gives nothing yet. Add a reward to any section.';
        break;
      case 'reward_too_much_gear':
      case 'reward_too_many_draws':
      case 'reward_affection_too_large':
        text = text.replace(/^This activity/, 'One roll of this table');
        break;
      case 'schema':
        text = 'Something here is not filled in correctly. Check its numbers and try again.';
        break;
    }
    return {
      at,
      severity: issue.severity,
      text,
      raw: `${issue.code} · ${issue.path} · ${issue.message}`,
    };
  });
}
