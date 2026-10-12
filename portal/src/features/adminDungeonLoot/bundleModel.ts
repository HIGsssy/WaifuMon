/**
 * An activity's reward bundle as its author reads it: the one-line summary,
 * when it is paid, which rewards are at risk, and the server's reward problems
 * in creator language. Pure — no React and no requests.
 *
 * Nothing here decides what a reward pays or how a run settles. Risk class is
 * a property of the reward type, and the retention figures quoted are the
 * dungeon's own stored settings.
 */
import type {
  DungeonLootTable,
  DungeonLootTableBody,
  DungeonRewardGrant,
} from '@/api/adminDungeonLootTables';
import type {
  DungeonAction,
  DungeonDefinition,
  DungeonIssue,
  DungeonReferenceData,
  DungeonRewardBundle,
} from '@/api/adminDungeons';
import {
  TIER_LABELS,
  describeGrant,
  describeSelector,
  isAtRisk,
  kindOfGrant,
  percentText,
  type ItemRef,
  type RewardNames,
} from './lootModel';

/** Mirrors the server's `DUNGEON_REWARD_LIMITS` for one activity; the server stays authoritative. */
export const BUNDLE_LIMITS = { guaranteed: 12, chances: 12, tables: 4, draws: 10 } as const;

export const emptyBundle = (): DungeonRewardBundle => ({ guaranteed: [], chances: [], tables: [] });
export const bundleIsEmpty = (bundle: DungeonRewardBundle) =>
  bundle.guaranteed.length + bundle.chances.length + bundle.tables.length === 0;
/** Which activities pay rewards on success. */
export const paysRewards = (action: DungeonAction) =>
  action.type === 'combat' || action.type === 'boss' || action.type === 'reward';
/** A treasure still on the old shape: its `reward` is left exactly as stored. */
export const isLegacyTreasure = (action: DungeonAction) =>
  action.type === 'reward' && action.rewards === undefined;
/**
 * The action with this bundle. A fight with no rewards stores no bundle at all,
 * so adding and removing a reward leaves the definition as it was. A treasure
 * keeps its (empty) bundle, because it must carry one reward shape or the other.
 */
export function withBundle(action: DungeonAction, bundle: DungeonRewardBundle): DungeonAction {
  if (action.type !== 'reward' && bundleIsEmpty(bundle)) {
    const { rewards: _removed, ...rest } = action;
    return rest as DungeonAction;
  }
  return { ...action, rewards: bundle };
}

/** When the bundle is paid, in the activity's own terms. Never per wave, never on failure. */
export function payoutTiming(action: DungeonAction): string {
  if (action.type === 'reward') return 'Paid once, when the player opens this treasure.';
  const many = (action.waves?.length ?? 0) > 1;
  const fight = action.type === 'boss' ? 'boss fight' : 'fight';
  const skipped = action.optional ? ' or skipped' : '';
  return many
    ? `Paid once, when the player wins the final wave of the ${fight}. Earlier waves pay nothing, and neither does a lost${skipped} fight.`
    : `Paid once, when the player wins the ${fight}. A lost${skipped} fight pays nothing.`;
}

const percentOf = (basisPoints: number) => `${percentText(basisPoints)}%`;
/** How Shards and WaifuBux settle in this dungeon, from its stored settings. */
export function riskExplanation(settings: DungeonDefinition['settings']): {
  atRisk: string;
  kept: string;
} {
  const defeat = settings.defeatCurrencyRetentionBasisPoints;
  const abandon = settings.abandonCurrencyRetentionBasisPoints ?? defeat;
  return {
    atRisk: `At risk: Baddie Shards and WaifuBux earned in this run are held until it ends. They are banked in full when the player extracts or completes the dungeon. In this dungeon the player keeps ${percentOf(defeat)} on defeat and ${percentOf(abandon)} on abandoning.`,
    kept: 'Kept: Essence, items, equipment and Affection are given straight away and never taken back.',
  };
}

export type TableRisk = 'at_risk' | 'kept' | 'mixed' | 'empty';
const grantsOfBody = (body: DungeonLootTableBody): DungeonRewardGrant[] => [
  ...body.guaranteed.map((e) => e.grant),
  ...body.chances.map((e) => e.grant),
  ...body.pools.flatMap((pool) => pool.entries.flatMap((e) => ('grant' in e ? [e.grant] : []))),
];
/** Whether everything a table can give is at risk, kept, or a mixture. */
export function tableRisk(body: DungeonLootTableBody): TableRisk {
  const risks = new Set(grantsOfBody(body).map((grant) => isAtRisk(kindOfGrant(grant))));
  if (risks.size === 0) return 'empty';
  if (risks.size === 2) return 'mixed';
  return risks.has(true) ? 'at_risk' : 'kept';
}
export const TABLE_RISK_TEXT: Record<TableRisk, { label: string; detail: string }> = {
  at_risk: {
    label: 'At risk',
    detail: 'Everything this table gives is Baddie Shards or WaifuBux.',
  },
  kept: { label: 'Kept', detail: 'Nothing this table gives can be lost.' },
  mixed: {
    label: 'Mixed',
    detail:
      'Mixed rewards: the Baddie Shards and WaifuBux it gives are at risk; everything else it gives is kept.',
  },
  empty: { label: 'Gives nothing', detail: 'This table has no rewards yet.' },
};

type TableRef = DungeonReferenceData['lootTables'][number];
/** A loot table's readable name, from whichever list is to hand. */
export function tableNameOf(
  key: string,
  tables: ReadonlyArray<Pick<DungeonLootTable, 'key' | 'name'> | TableRef> | undefined,
): string {
  return tables?.find((t) => t.key === key)?.name ?? 'a deleted loot table';
}
export const tierText = (tier: DungeonLootTable['tier']) => (tier ? TIER_LABELS[tier] : '');

/** `40–60 Baddie Shards · 500 WaifuBux · 25% 1 Velvet Charm · Boss Hoard ×2`. */
export function rewardsSummary(
  bundle: DungeonRewardBundle,
  names: RewardNames,
  tables: ReadonlyArray<Pick<DungeonLootTable, 'key' | 'name'> | TableRef> | undefined,
): string {
  const parts = [
    ...bundle.guaranteed.map((e) => describeGrant(e.grant, names)),
    ...bundle.chances.map(
      (e) => `${percentOf(e.chanceBasisPoints)} ${describeGrant(e.grant, names)}`,
    ),
    ...bundle.tables.map(
      (t) => `${tableNameOf(t.table, tables)}${t.draws > 1 ? ` ×${t.draws}` : ''}`,
    ),
  ];
  return parts.length ? parts.join(' · ') : 'No rewards yet';
}

export interface BundleIssueText {
  /** The bundle entry (a reward or a table reference) the issue belongs beside, if any. */
  at: string | null;
  /** What the entry is, in words: `“1 Old Token”` or `the loot table “Boss Hoard”`. */
  subject: string;
  /** What is wrong and what to do, without any identifier. */
  text: string;
}
/**
 * One of the server's reward issues for an activity, located and reworded.
 * Accepts the path a dungeon validation reports (`rooms[r].actions[a].rewards…`)
 * and the one a Test Roll reports for its stand-in activity.
 */
export function bundleIssueText(
  issue: Pick<DungeonIssue, 'code' | 'path' | 'message'>,
  bundle: DungeonRewardBundle,
  names: RewardNames,
  items: readonly ItemRef[],
  tables: ReadonlyArray<Pick<DungeonLootTable, 'key' | 'name'> | TableRef> | undefined,
): BundleIssueText {
  const within = /\.rewards\.(guaranteed|chances|tables)\[(\d+)\](\.body\b)?/.exec(issue.path);
  const list = within?.[1] as 'guaranteed' | 'chances' | 'tables' | undefined;
  const index = Number(within?.[2]);
  if (issue.code === 'reward_shards_unset')
    return {
      at: list ? (bundle[list][index]?.id ?? null) : null,
      subject: '',
      text: 'This dungeon needs an available progression currency to pay Baddie Shards. Choose one in Dungeon Settings.',
    };
  // The server's sentence, without the label that quotes room, activity and entry ids.
  const rest = issue.message
    .replace(
      /^Room "[^"]*", activity "[^"]*"(?:, (?:loot table|pool|reward) "[^"]*")*(?::\s*|\s+)/,
      '',
    )
    .replace(/^./, (c) => c.toUpperCase());
  if (list === 'tables') {
    const ref = bundle.tables[index];
    const name = ref ? tableNameOf(ref.table, tables) : 'a loot table';
    const subject = `the loot table “${name}”`;
    let text = rest;
    if (issue.code === 'reward_table_missing')
      text = 'This loot table was deleted. Remove it or pick another.';
    else if (issue.code === 'reward_table_archived')
      text = `“${name}” is archived. Restore it or pick another.`;
    else if (issue.code === 'reward_table_invalid')
      text = `“${name}” has settings that cannot be read. Open the table and repair it.`;
    else if (issue.code === 'reward_empty') text = `“${name}” gives nothing yet.`;
    else if (within?.[3])
      text = `A reward inside “${name}” needs repair. ${rest} Open the table to fix it.`;
    return {
      at: ref?.id ?? null,
      subject: issue.code === 'reward_table_missing' ? 'a loot table' : subject,
      text,
    };
  }
  const entry = list ? bundle[list][index] : undefined;
  if (!entry) return { at: null, subject: '', text: rest };
  const grant = entry.grant;
  const item = grant.type === 'item' ? items.find((i) => i.slug === grant.item) : undefined;
  let text = rest;
  if (issue.code === 'reward_item_missing') text = 'This item no longer exists. Pick another item.';
  else if (issue.code === 'reward_item_disabled')
    text = `${item?.name ?? 'This item'} is disabled. Enable it or pick another item.`;
  else if (issue.code === 'reward_item_capped')
    text = `${item?.name ?? 'This item'} is limited to ${item?.maxOwned ?? 'a few'} per player, so it cannot be dungeon loot.`;
  else if (issue.code === 'reward_equipment_empty')
    text = `No gear matches “${grant.type === 'equipment' ? describeSelector(grant.selector, names) : 'this choice'}”. Loosen the choice.`;
  return { at: entry.id, subject: `“${describeGrant(grant, names)}”`, text };
}
