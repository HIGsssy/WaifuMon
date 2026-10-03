/**
 * Authoring validation for a dungeon zone — everything the zone schema cannot
 * know from the document alone.
 *
 *   1. **Schema** — `DungeonZoneDefinitionSchema`. A failure stops here.
 *   2. **References** — every pool entry names an enemy or event that exists;
 *      every band and bonus names a reward table that exists; the zone names a
 *      progression currency that exists. Missing is an error; present but
 *      disabled is a warning (the generator simply skips it).
 *   3. **Reachability** — the rules against the run lengths the zone can
 *      produce: an extraction depth past the end, a depth range no node can
 *      fall in, a required type with nothing eligible to place, a final depth
 *      with no boss, a limit below a requirement.
 *   4. **Trial runs** — when nothing above is wrong, the real generator is run
 *      over a fixed set of seeds. Rules that are each plausible can still be
 *      jointly unsatisfiable; this is where that shows up. On an enabled zone
 *      any failed seed is an error. On a disabled zone it is a warning, so a
 *      zone can always be saved switched off while it is being worked on.
 *
 * Pure: the caller supplies the content, tables and currencies to check against.
 */
import { DungeonGenerationError } from '../../shared/errors';
import {
  eligiblePoolEntries,
  generateDungeon,
  nodeTypeAllowedAtDepth,
  type DungeonContentCatalogue,
} from './dungeonGenerator';
import {
  DUNGEON_POOL_KEYS,
  DUNGEON_WEIGHTED_NODE_TYPES,
  DungeonZoneDefinitionSchema,
  possibleFinalDepths,
  type DungeonNodeType,
  type DungeonZoneDefinition,
} from './zoneDefinition';

export interface DungeonZoneIssue {
  /** `pools.combat[2].enemyKey` — where the editor shows it. */
  path: string;
  message: string;
  /** An error refuses the save; a warning is shown and saved through. */
  severity: 'error' | 'warning';
}

export interface DungeonZoneValidationContext {
  catalogue: DungeonContentCatalogue;
  /** Reward tables a band may name (the `expedition` kind), by id. */
  rewardTables: ReadonlyMap<string, { enabled: boolean }>;
  /** Progression currencies, by stable key. */
  currencies: ReadonlyMap<string, { enabled: boolean }>;
  /** Skip the trial runs — for callers that are about to generate anyway. */
  skipTrialRuns?: boolean;
}

export interface DungeonZoneValidation {
  /** The parsed zone when the schema accepted it. */
  zone: DungeonZoneDefinition | null;
  issues: DungeonZoneIssue[];
}

/** Seeds the trial runs use. Fixed, so validating the same zone twice agrees. */
export const ZONE_TRIAL_SEEDS = 200;

export function zodIssuePath(path: readonly (string | number)[]): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : out ? `.${part}` : part;
  return out || 'zone';
}

export function hasErrors(issues: readonly DungeonZoneIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function validateDungeonZone(input: unknown, ctx: DungeonZoneValidationContext): DungeonZoneValidation {
  const parsed = DungeonZoneDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      zone: null,
      issues: parsed.error.issues.map((i) => ({
        path: zodIssuePath(i.path),
        message: i.message,
        severity: 'error',
      })),
    };
  }
  const zone = parsed.data;
  const gen = zone.generation;
  const issues: DungeonZoneIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warning = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  const finalDepths = possibleFinalDepths(gen);
  /** The deepest depth a non-final node can ever sit at. */
  const deepestInterior = finalDepths.max - 1;

  // ── 2. references ─────────────────────────────────────────────────────────
  for (const poolKey of DUNGEON_POOL_KEYS) {
    const lookup = poolKey === 'event' ? ctx.catalogue.events : ctx.catalogue.enemies;
    const what = poolKey === 'event' ? 'event' : 'enemy';
    zone.pools[poolKey].forEach((entry, i) => {
      const field = 'enemyKey' in entry ? 'enemyKey' : 'eventKey';
      const contentKey = 'enemyKey' in entry ? entry.enemyKey : entry.eventKey;
      const at = `pools.${poolKey}[${i}]`;
      const found = lookup.get(contentKey);
      if (!found) error(`${at}.${field}`, `"${contentKey}" is not a known ${what}`);
      else if (!found.enabled && entry.enabled) {
        warning(`${at}.${field}`, `${what} "${contentKey}" is disabled, so this entry is never drawn`);
      }
      if (entry.enabled && entry.minDepth > finalDepths.max) {
        warning(`${at}.minDepth`, `no run reaches depth ${entry.minDepth} (the deepest is ${finalDepths.max})`);
      }
    });
  }

  const checkTable = (path: string, id: string | null) => {
    if (id === null) return;
    const table = ctx.rewardTables.get(id);
    if (!table) error(path, `"${id}" is not an expedition reward table`);
    else if (!table.enabled) warning(path, `reward table "${id}" is disabled, so it pays nothing`);
  };
  zone.rewards.bands.forEach((band, i) => {
    checkTable(`rewards.bands[${i}].rewardTable`, band.rewardTable);
    checkTable(`rewards.bands[${i}].equipmentRewardTable`, band.equipmentRewardTable);
    if (band.enabled && band.minDepth > finalDepths.max) {
      warning(`rewards.bands[${i}].minDepth`, `no run reaches depth ${band.minDepth} (the deepest is ${finalDepths.max})`);
    }
  });
  checkTable('rewards.completion.rewardTable', zone.rewards.completion.rewardTable);
  checkTable('rewards.extraction.rewardTable', zone.rewards.extraction.rewardTable);

  const currency = ctx.currencies.get(zone.rewards.currencyKey);
  if (!currency) error('rewards.currencyKey', `"${zone.rewards.currencyKey}" is not a progression currency`);
  else if (!currency.enabled) {
    warning('rewards.currencyKey', `currency "${zone.rewards.currencyKey}" is disabled, so runs will not pay it`);
  }

  // ── 3. reachability ───────────────────────────────────────────────────────
  if (gen.extraction.minDepth > deepestInterior) {
    error(
      'generation.extraction.minDepth',
      `extraction depth ${gen.extraction.minDepth} is past the last node a run can extract at (depth ${deepestInterior})`,
    );
  } else if (gen.extraction.minPoints > 0 && gen.extraction.minDepth > finalDepths.min - 1) {
    error(
      'generation.extraction.minDepth',
      `the shortest run ends at depth ${finalDepths.min}, so it has no node at depth ` +
        `${gen.extraction.minDepth} or deeper to hold a guaranteed extraction point`,
    );
  }
  if (gen.extraction.minPoints > 0 && gen.extraction.nodeTypes.every((t) => t === 'boss')) {
    error('generation.extraction.nodeTypes', 'a guaranteed extraction point needs a node type that offers extraction');
  }

  const isRequired = (type: DungeonNodeType) => gen.required.some((g) => g.types.includes(type));
  /** Whether `type` can be placed at any interior depth of any run. */
  const placeable = (type: DungeonNodeType): boolean => {
    for (let depth = 1; depth <= deepestInterior; depth++) {
      if (nodeTypeAllowedAtDepth(zone, type, depth, ctx.catalogue)) return true;
    }
    return false;
  };

  for (const [type, range] of Object.entries(gen.depthRanges) as [DungeonNodeType, { minDepth: number }][]) {
    if (range.minDepth <= deepestInterior || type === 'boss') continue;
    const inUse = isRequired(type) || (type in gen.nodeWeights && gen.nodeWeights[type as keyof typeof gen.nodeWeights] > 0);
    const message = `${type} cannot appear before depth ${range.minDepth}, but no run has a node that deep (the deepest is ${deepestInterior})`;
    if (inUse) error(`generation.depthRanges.${type}.minDepth`, message);
    else warning(`generation.depthRanges.${type}.minDepth`, message);
  }

  const whyUnplaceable = (type: DungeonNodeType): string =>
    type === 'reward'
      ? 'no reward band covers a reward node at any depth it may appear'
      : type === 'event' || type === 'combat' || type === 'elite' || type === 'miniboss'
        ? `the ${type} pool has no enabled, weighted entry that is eligible at a depth it may appear`
        : 'no depth allows it';

  for (const type of DUNGEON_WEIGHTED_NODE_TYPES) {
    if (gen.nodeWeights[type] > 0 && !placeable(type)) {
      warning(`generation.nodeWeights.${type}`, `${type} has a weight but can never be placed: ${whyUnplaceable(type)}`);
    }
  }
  gen.required.forEach((group, i) => {
    const at = `generation.required[${i}]`;
    const types = group.types.filter((t) => t !== 'boss' || gen.boss.required);
    if (!types.some((t) => (t === 'boss' ? true : placeable(t)))) {
      error(at, `nothing can satisfy "at least ${group.min} ${group.types.join('/')}": ${whyUnplaceable(group.types[0]!)}`);
    }
    if (group.min > finalDepths.min - 1 && !group.types.includes('boss')) {
      error(`${at}.min`, `the shortest run has only ${finalDepths.min - 1} nodes before the final one`);
    }
    gen.limits.forEach((limit, j) => {
      if (group.types.every((t) => limit.types.includes(t)) && limit.max < group.min) {
        error(
          `generation.limits[${j}].max`,
          `at most ${limit.max} ${limit.types.join('/')} contradicts "at least ${group.min} ${group.types.join('/')}"`,
        );
      }
    });
  });

  if (gen.boss.required) {
    const missing: number[] = [];
    for (let depth = finalDepths.min; depth <= finalDepths.max; depth++) {
      if (eligiblePoolEntries(zone, 'boss', depth, ctx.catalogue).length === 0) missing.push(depth);
    }
    if (missing.length > 0) {
      error(
        'pools.boss',
        missing.length === finalDepths.max - finalDepths.min + 1
          ? 'a boss is required, but the boss pool has no enabled, weighted entry naming an enabled enemy'
          : `a boss is required, but no boss is eligible when a run ends at depth ${missing.join(', ')}`,
      );
    }
  }

  // ── 4. trial runs ─────────────────────────────────────────────────────────
  if (!ctx.skipTrialRuns && !hasErrors(issues)) {
    let failed = 0;
    let firstReason: string | null = null;
    for (let seed = 1; seed <= ZONE_TRIAL_SEEDS; seed++) {
      try {
        generateDungeon(zone, ctx.catalogue, seed);
      } catch (err) {
        if (!(err instanceof DungeonGenerationError)) throw err;
        failed += 1;
        firstReason ??= err.diagnostics.lastFailure;
      }
    }
    if (failed > 0) {
      const message =
        failed === ZONE_TRIAL_SEEDS
          ? `these rules cannot produce a run: ${firstReason}`
          : `${failed} of ${ZONE_TRIAL_SEEDS} trial runs could not be generated: ${firstReason}`;
      issues.push({ path: 'generation', message, severity: zone.enabled ? 'error' : 'warning' });
    }
  }

  return { zone, issues };
}
