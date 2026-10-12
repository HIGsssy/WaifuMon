/** Pure v2 reward validation; callers supply catalogues and shared selector resolution. */
import {
  DungeonLootTableBodySchema,
  validateDungeonRewardBundleWork,
  validateDungeonRewardWork,
  DUNGEON_REWARD_LIMITS,
  type DungeonLootTableBody,
  type DungeonRewardBundle,
  type DungeonRewardGrant,
} from '../content/dungeonRewards';
import type { DungeonDefinition } from '../content/dungeonDefinition';
import {
  describeEquipmentSelector,
  equipmentSelectorKey,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from '../../equipment/rewardSelector';
import type { DungeonIssue, DungeonValidationContext } from './dungeonValidation';

export interface DungeonRewardItem {
  name: string;
  category: string;
  enabled: boolean;
  maxOwned: number | null;
}
export interface DungeonRewardLootTable {
  name: string;
  archivedAt: Date | string | null;
  body: unknown;
  /** Catalogue provenance a reward snapshot records. Validation reads neither. */
  tier?: string | null | undefined;
  revision?: number | undefined;
}
export interface DungeonRewardValidationContext {
  lootTables?: ReadonlyMap<string, DungeonRewardLootTable> | undefined;
  items?: ReadonlyMap<string, DungeonRewardItem> | undefined;
  /** Supply eligibleRewardDefinitions against the caller's authoritative equipment catalogue. */
  resolveEquipmentSelector?:
    ((selector: EquipmentRewardSelector) => readonly RewardableDefinition[]) | undefined;
}
export type DungeonRewardEquipmentPools = Record<string, RewardableDefinition[]>;
export interface DungeonLootBodyValidation {
  body: DungeonLootTableBody | null;
  issues: DungeonIssue[];
  equipmentPools: DungeonRewardEquipmentPools;
}
const add = (
  issues: DungeonIssue[],
  code: DungeonIssue['code'],
  path: string,
  message: string,
  severity: DungeonIssue['severity'] = 'error',
) => issues.push({ code, severity, path, message });

function checkGrant(
  grant: DungeonRewardGrant,
  path: string,
  label: string,
  ctx: DungeonValidationContext,
  issues: DungeonIssue[],
  pools: DungeonRewardEquipmentPools,
  currencyKey?: string | null,
) {
  if (grant.type === 'item' && ctx.items) {
    const item = ctx.items.get(grant.item);
    if (!item)
      add(
        issues,
        'reward_item_missing',
        path,
        `${label}: item "${grant.item}" no longer exists. Pick another item.`,
      );
    else {
      if (!item.enabled)
        add(
          issues,
          'reward_item_disabled',
          path,
          `${label}: "${item.name}" is disabled. Enable it or pick another item.`,
        );
      if (item.maxOwned !== null)
        add(
          issues,
          'reward_item_capped',
          path,
          `${label}: "${item.name}" is limited to ${item.maxOwned} per player, so it cannot be dungeon loot.`,
        );
    }
  }
  if (grant.type === 'equipment' && ctx.resolveEquipmentSelector) {
    const key = equipmentSelectorKey(grant.selector);
    try {
      const eligible = ctx.resolveEquipmentSelector(grant.selector);
      if (!eligible.length) throw new Error('empty');
      pools[key] = eligible.map((d) => ({ ...d })).sort((a, b) => a.key.localeCompare(b.key));
    } catch {
      add(
        issues,
        'reward_equipment_empty',
        path,
        `${label}: no eligible gear matches "${describeEquipmentSelector(grant.selector)}". Loosen the choice or repair its selected definitions.`,
      );
    }
  }
  if (grant.type === 'currency' && grant.currency === 'shards' && currencyKey !== undefined) {
    if (!currencyKey)
      add(
        issues,
        'reward_shards_unset',
        path,
        `${label}: this dungeon has no Baddie Shard currency set, so it cannot pay Shards.`,
      );
    else if (ctx.currencies && !ctx.currencies.get(currencyKey)?.enabled)
      add(
        issues,
        'reward_shards_unset',
        path,
        `${label}: the configured Baddie Shard currency "${currencyKey}" is missing or disabled. Choose an available progression currency.`,
      );
  }
}
function checkEntries(
  body: DungeonLootTableBody,
  path: string,
  label: string,
  ctx: DungeonValidationContext,
  issues: DungeonIssue[],
  pools: DungeonRewardEquipmentPools,
  currencyKey?: string | null,
) {
  for (const list of ['guaranteed', 'chances'] as const)
    body[list].forEach((entry, i) =>
      checkGrant(
        entry.grant,
        `${path}.${list}[${i}].grant`,
        `${label}, reward "${entry.id}"`,
        ctx,
        issues,
        pools,
        currencyKey,
      ),
    );
  body.pools.forEach((pool, p) => {
    if (pool.entries.every((e) => 'nothing' in e))
      add(
        issues,
        'reward_pool_all_nothing',
        `${path}.pools[${p}]`,
        `${label}: "${pool.name}" can only ever give Nothing.`,
        'warning',
      );
    pool.entries.forEach((entry, e) => {
      if ('grant' in entry)
        checkGrant(
          entry.grant,
          `${path}.pools[${p}].entries[${e}].grant`,
          `${label}, pool "${pool.name}", reward "${entry.id}"`,
          ctx,
          issues,
          pools,
          currencyKey,
        );
    });
  });
}
/** No per-dungeon Shards check here: a reusable table has no configured dungeon currency. */
export function validateDungeonLootTableBody(
  raw: unknown,
  ctx: DungeonValidationContext = {},
  label = 'Loot table',
): DungeonLootBodyValidation {
  const parsed = DungeonLootTableBodySchema.safeParse(raw);
  const issues: DungeonIssue[] = [];
  const equipmentPools: DungeonRewardEquipmentPools = {};
  if (!parsed.success) {
    for (const i of parsed.error.issues)
      add(issues, 'schema', ['body', ...i.path].join('.'), `${label}: ${i.message}`);
    return { body: null, issues, equipmentPools };
  }
  checkEntries(parsed.data, 'body', label, ctx, issues, equipmentPools);
  if (!parsed.data.guaranteed.length && !parsed.data.chances.length && !parsed.data.pools.length)
    add(
      issues,
      'reward_empty',
      'body',
      `${label}: this Rewards section gives nothing yet.`,
      'warning',
    );
  // A table drawn once is already one activity's minimum work.
  const work = validateDungeonRewardBundleWork(
    { guaranteed: [], chances: [], tables: [{ id: 'validation', table: 'table', draws: 1 }] },
    new Map([['table', parsed.data]]),
  );
  issues.push(...work.issues.map((i) => workIssue(i, label, 'body')));
  return { body: parsed.data, issues, equipmentPools };
}
function workIssue(
  issue: { code: string; path: string; message: string },
  label: string,
  path = issue.path,
): DungeonIssue {
  const code =
    issue.code === 'reward_too_many_equipment'
      ? 'reward_too_much_gear'
      : (issue.code as DungeonIssue['code']);
  const quantity = /(?:instances|draws|affection|total) (\d+)/.exec(issue.message)?.[1] ?? '';
  let message = issue.message;
  if (code === 'reward_too_much_gear')
    message = `this activity could drop up to ${quantity} gear pieces at once. The limit is ${DUNGEON_REWARD_LIMITS.equipmentPerActivity}.`;
  if (code === 'reward_too_many_draws')
    message = `this activity makes too many random picks (${quantity}). The limit is ${DUNGEON_REWARD_LIMITS.resolvedDrawsPerActivity}.`;
  if (code === 'reward_affection_too_large')
    message = `this activity could give ${quantity} Affection. The limit is ${DUNGEON_REWARD_LIMITS.affectionPerActivity}.`;
  if (code === 'reward_currency_too_large')
    message = `the dungeon could bank ${quantity} ${path.endsWith('waifubux') ? 'WaifuBux' : 'Baddie Shards'}. The limit is ${DUNGEON_REWARD_LIMITS.atRiskCurrencyPerDungeon}.`;
  return { code, severity: 'error', path, message: `${label}: ${message}` };
}
export function validateDungeonRewards(
  definition: DungeonDefinition,
  ctx: DungeonValidationContext,
  options: { checkShardsConfiguration?: boolean } = {},
): { issues: DungeonIssue[]; equipmentPools: DungeonRewardEquipmentPools } {
  const issues: DungeonIssue[] = [];
  const equipmentPools: DungeonRewardEquipmentPools = {};
  const bodies = new Map<string, DungeonLootTableBody>();
  let hasNewRewards = false;
  definition.rooms.forEach((room, r) =>
    room.actions.forEach((action, a) => {
      if (!('rewards' in action) || !action.rewards) return;
      hasNewRewards = true;
      const bundle: DungeonRewardBundle = action.rewards;
      const path = `rooms[${r}].actions[${a}].rewards`;
      const label = `Room "${room.name || room.id}", activity "${action.label || action.id}"`;
      if (!bundle.guaranteed.length && !bundle.chances.length && !bundle.tables.length)
        add(
          issues,
          'reward_empty',
          path,
          `${label}: this Rewards section gives nothing yet.`,
          'warning',
        );
      for (const list of ['guaranteed', 'chances'] as const)
        bundle[list].forEach((entry, i) =>
          checkGrant(
            entry.grant,
            `${path}.${list}[${i}].grant`,
            `${label}, reward "${entry.id}"`,
            ctx,
            issues,
            equipmentPools,
            options.checkShardsConfiguration === false ? undefined : definition.settings.progressionCurrency,
          ),
        );
      bundle.tables.forEach((ref, i) => {
        if (!ctx.lootTables) return; // Portable validation has no external catalogue.
        const table = ctx.lootTables.get(ref.table);
        const refPath = `${path}.tables[${i}]`;
        if (!table) {
          add(
            issues,
            'reward_table_missing',
            refPath,
            `${label}: loot table "${ref.table}" no longer exists. Remove it or pick another dungeon loot table.`,
          );
          return;
        }
        const tableLabel = `${label}, loot table "${table.name}"`;
        if (table.archivedAt !== null)
          add(
            issues,
            'reward_table_archived',
            refPath,
            `${tableLabel} is archived. Restore it or pick another.`,
          );
        const parsed = DungeonLootTableBodySchema.safeParse(table.body);
        if (!parsed.success) {
          add(
            issues,
            'reward_table_invalid',
            refPath,
            `${tableLabel} has invalid reward settings. Open the loot table and repair its structure.`,
          );
          return;
        }
        bodies.set(ref.table, parsed.data);
        checkEntries(
          parsed.data,
          `${refPath}.body`,
          tableLabel,
          ctx,
          issues,
          equipmentPools,
          options.checkShardsConfiguration === false ? undefined : definition.settings.progressionCurrency,
        );
        if (
          !parsed.data.guaranteed.length &&
          !parsed.data.chances.length &&
          !parsed.data.pools.length
        )
          add(
            issues,
            'reward_empty',
            refPath,
            `${tableLabel}: this Rewards section gives nothing yet.`,
            'warning',
          );
      });
    }),
  );
  const abandon = definition.settings.abandonCurrencyRetentionBasisPoints;
  if (abandon !== undefined && abandon > definition.settings.defeatCurrencyRetentionBasisPoints) {
    add(
      issues,
      'reward_abandon_more_than_defeat',
      'settings.abandonCurrencyRetentionBasisPoints',
      `Dungeon "${definition.name}": leaving early keeps more Baddie Shards than losing a fight. Review the retention settings.`,
      'warning',
    );
  }
  if (hasNewRewards) {
    const work = validateDungeonRewardWork(definition, bodies);
    for (const i of work.issues) {
      if (i.code === 'reward_table_unresolved') continue; // Precise missing/body issues above; omitted context stays portable.
      const at = /^rooms\[(\d+)\].actions\[(\d+)\]/.exec(i.path);
      const room = at ? definition.rooms[Number(at[1])] : undefined;
      const action = at ? room?.actions[Number(at[2])] : undefined;
      issues.push(
        workIssue(
          i,
          room && action
            ? `Room "${room.name || room.id}", activity "${action.label || action.id}"`
            : `Dungeon "${definition.name}"`,
        ),
      );
    }
  }
  return { issues, equipmentPools };
}
/** Friendly codes for reward shape refinements before the complete definition can parse. */
export function rewardShapeIssue(raw: unknown, path: string, message: string): DungeonIssue | null {
  const at = /^rooms\[(\d+)\].actions\[(\d+)\]/.exec(path);
  if (!at) return null;
  const room = (raw as DungeonDefinition)?.rooms?.[Number(at[1])];
  const action = room?.actions?.[Number(at[2])];
  if (!room || !action) return null;
  const label = `Room "${room.name || room.id}", activity "${action.label || action.id}"`;
  if (
    action.type === 'reward' &&
    action.reward !== undefined &&
    action.rewards !== undefined &&
    message.includes('exactly one')
  )
    return {
      code: 'reward_legacy_mixed',
      severity: 'error',
      path,
      message: `${label}: this treasure uses both the old and new reward settings. Convert it.`,
    };
  if (path.includes('.rewards') && message.startsWith('worst-case')) {
    const code = message.includes('equipment instances')
      ? 'reward_too_many_equipment'
      : message.includes('resolved draws')
        ? 'reward_too_many_draws'
        : 'reward_affection_too_large';
    return workIssue({ code, path, message }, label);
  }
  if (path.includes('.rewards'))
    return {
      code: 'schema',
      severity: 'error',
      path,
      message: `${label}: a reward setting needs repair. ${message}`,
    };
  return null;
}
