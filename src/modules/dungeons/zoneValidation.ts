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
 * An **authored** zone has no generator to reason about: steps 3 and 4 are
 * replaced by the layout's own rules (`authoredLayout.ts` — one start, one
 * final room, no loops, nothing unreachable) and by each room's references.
 * Layout problems are errors on an enabled zone and warnings on a disabled
 * one, for the same reason trial runs are.
 *
 * Messages are written for the author: they name rooms by what they are
 * called and say what to do, never a document path.
 *
 * Pure: the caller supplies the content, tables and currencies to check against.
 */
import { DungeonGenerationError } from '../../shared/errors';
import { analyseAuthoredLayout, roomLabel, validateAuthoredLayout } from './authoredLayout';
import {
  eligiblePoolEntries,
  extractionWindowsOf,
  generateDungeon,
  nodeTypeAllowedAtDepth,
  type DungeonContentCatalogue,
} from './dungeonGenerator';
import {
  DUNGEON_POOL_KEYS,
  DUNGEON_WEIGHTED_NODE_TYPES,
  DungeonZoneDefinitionSchema,
  authoredLayoutOf,
  depthInRange,
  isEnemyNodeType,
  layoutModeOf,
  possibleFinalDepths,
  restRulesOf,
  rewardBandFor,
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
  /** The region catalogue, by region id — what `availableRegions` may name. */
  regions: ReadonlyMap<string, { name: string; enabled: boolean }>;
  /**
   * Managed artwork assets, by id — what `artworkAssetId`, `backgroundAssetId`
   * and a background's `assetId` may name. Omitted, asset references are not
   * checked (a caller with no asset table to check against).
   */
  assets?: ReadonlyMap<string, { name: string; status: 'active' | 'disabled' | 'deleted' }> | undefined;
  /** Skip the trial runs — for callers that are about to generate anyway. */
  skipTrialRuns?: boolean;
  /**
   * The enemies the stored zone already names — given by a caller that is
   * about to *write* (an empty set for a new zone). A disabled enemy outside
   * it is a new reference and is refused; one inside it is an existing
   * reference, kept with a warning. Omitted (a read, a run start), every
   * reference to a disabled enemy is an existing one.
   */
  previousEnemyKeys?: ReadonlySet<string> | undefined;
}

export interface DungeonZoneValidation {
  /** The parsed zone when the schema accepted it. */
  zone: DungeonZoneDefinition | null;
  issues: DungeonZoneIssue[];
}

/** What a schema path is called on the editor, so a shape error reads as a sentence. */
const FIELD_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^key$/, 'Key'],
  [/^name$/, 'Name'],
  [/^description$/, 'Description'],
  [/^order$/, 'Order'],
  [/^tags/, 'Tags'],
  [/^availableRegions/, 'Available in'],
  [/^artworkAssetId$|^artworkPath$/, 'Zone cover'],
  [/^backgroundAssetId$|^backgroundArtworkPath$/, 'Default background'],
  [/^backgrounds/, 'Background pool'],
  [/^generation\.minNodes$/, 'Shortest run'],
  [/^generation\.maxNodes$/, 'Longest run'],
  [/^generation\.branching/, 'Branching'],
  [/^generation\.extraction/, 'Extraction'],
  [/^generation\.rest/, 'Rest rules'],
  [/^generation\.nodeWeights/, 'Room type weights'],
  [/^generation\.depthRanges/, 'Room type depths'],
  [/^generation\.required/, 'Guarantees'],
  [/^generation\.limits/, 'Limits'],
  [/^generation\.firstNodeType/, 'First room'],
  [/^generation/, 'Generation rules'],
  [/^nodeSettings\.rest/, 'Rest heal'],
  [/^pools\.(\w+)/, 'Enemy and event pools'],
  [/^rewards\.bands/, 'Reward bands'],
  [/^rewards\.completion/, 'Completion bonus'],
  [/^rewards\.extraction/, 'Extraction bonus'],
  [/^rewards/, 'Rewards'],
  [/^authored\.startRoomId/, 'Start room'],
];

/**
 * A schema issue in the author's terms: `Room "Repair Bay": …` for anything
 * inside a room, the editor's own label for a field it shows, and the bare
 * message otherwise. The path is kept beside it for the editor to place it.
 */
function describeSchemaIssue(input: unknown, path: readonly (string | number)[], message: string): string {
  const text = zodIssuePath(path);
  if (path[0] === 'authored' && path[1] === 'rooms' && typeof path[2] === 'number') {
    const room = (input as { authored?: { rooms?: unknown[] } } | null)?.authored?.rooms?.[path[2]] as
      | { id?: unknown; name?: unknown }
      | undefined;
    const called =
      typeof room?.name === 'string' && room.name.trim() !== ''
        ? room.name.trim()
        : typeof room?.id === 'string' && room.id !== ''
          ? room.id
          : `#${path[2] + 1}`;
    return `Room "${called}": ${message}`;
  }
  const label = FIELD_LABELS.find(([pattern]) => pattern.test(text))?.[1];
  return label ? `${label}: ${message}` : message;
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
        message: describeSchemaIssue(input, i.path, i.message),
        severity: 'error',
      })),
    };
  }
  const zone = parsed.data;
  const gen = zone.generation;
  const issues: DungeonZoneIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warning = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  const authored = layoutModeOf(zone) === 'authored';
  const layout = authored ? analyseAuthoredLayout(zone) : null;
  /** How deep a run goes. An authored layout too broken to measure constrains nothing. */
  const finalDepths = layout
    ? (layout.routeLength ?? { min: 1, max: Number.POSITIVE_INFINITY })
    : possibleFinalDepths(gen);
  /** The deepest depth a non-final node can ever sit at. */
  const deepestInterior = finalDepths.max - 1;

  // ── 2. references ─────────────────────────────────────────────────────────
  // Pools feed the generator; an authored zone keeps them but never draws from them.
  for (const poolKey of authored ? [] : DUNGEON_POOL_KEYS) {
    const lookup = poolKey === 'event' ? ctx.catalogue.events : ctx.catalogue.enemies;
    const what = poolKey === 'event' ? 'event' : 'enemy';
    zone.pools[poolKey].forEach((entry, i) => {
      const field = 'enemyKey' in entry ? 'enemyKey' : 'eventKey';
      const contentKey = 'enemyKey' in entry ? entry.enemyKey : entry.eventKey;
      const at = `pools.${poolKey}[${i}]`;
      const found = lookup.get(contentKey);
      if (!found) error(`${at}.${field}`, `"${contentKey}" is not a known ${what}`);
      else if (!found.enabled && what === 'enemy' && ctx.previousEnemyKeys && !ctx.previousEnemyKeys.has(contentKey)) {
        error(
          `${at}.${field}`,
          `${found.name} is disabled and cannot be added. Enable it in Enemies first, or choose another enemy.`,
        );
      } else if (!found.enabled && entry.enabled) {
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
    // Depth tuning is a generator concern: an authored layout pays what its rooms say.
    if (!authored && band.enabled && band.minDepth > finalDepths.max) {
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

  zone.availableRegions.forEach((id, i) => {
    const region = ctx.regions.get(id);
    if (!region) error(`availableRegions[${i}]`, `"${id}" is not a region`);
    else if (!region.enabled) {
      warning(`availableRegions[${i}]`, `region "${region.name}" is not released, so no player can be there`);
    }
  });
  if (zone.availableRegions.length === 0) {
    const message = 'choose at least one region — a zone with none cannot be started anywhere';
    // A disabled zone may be saved half-authored; an enabled one must be reachable.
    if (zone.enabled) error('availableRegions', message);
    else warning('availableRegions', message);
  }

  // Managed artwork. A reference to nothing is an authoring mistake; a
  // disabled asset is a choice — the zone simply shows its shipped art.
  if (ctx.assets) {
    const assets = ctx.assets;
    const checkAsset = (path: string, id: string | null) => {
      if (id === null) return;
      const asset = assets.get(id);
      if (!asset || asset.status === 'deleted') error(path, 'that artwork no longer exists — choose another or clear it');
      else if (asset.status === 'disabled') {
        warning(path, `artwork "${asset.name}" is disabled, so the shipped artwork is shown instead`);
      }
    };
    checkAsset('artworkAssetId', zone.artworkAssetId);
    checkAsset('backgroundAssetId', zone.backgroundAssetId);
    zone.backgrounds.forEach((bg, i) => checkAsset(`backgrounds[${i}].assetId`, bg.assetId));
  }
  if (authored) {
    validateAuthoredRooms(zone, ctx, issues);
    return { zone, issues };
  }

  zone.backgrounds.forEach((bg, i) => {
    if (bg.enabled && bg.minDepth > finalDepths.max) {
      warning(`backgrounds[${i}].minDepth`, `no run reaches depth ${bg.minDepth} (the deepest is ${finalDepths.max})`);
    }
  });

  // ── 3. reachability ───────────────────────────────────────────────────────
  const rest = restRulesOf(gen);
  if (rest.minDepth > deepestInterior && (rest.minNodes > 0 || rest.beforeBoss || gen.nodeWeights.rest > 0)) {
    error(
      'generation.rest.minDepth',
      `a rest cannot appear before depth ${rest.minDepth}, but no run has a node that deep (the deepest is ${deepestInterior})`,
    );
  }
  if (rest.minNodes > finalDepths.min - 1) {
    error('generation.rest.minNodes', `the shortest run has only ${finalDepths.min - 1} nodes before the final one`);
  }
  gen.limits.forEach((limit, j) => {
    if (limit.types.length === 1 && limit.types[0] === 'rest' && limit.max < Math.max(rest.minNodes, rest.beforeBoss ? 1 : 0)) {
      error(
        `generation.limits[${j}].max`,
        `at most ${limit.max} rest contradicts the rest rules (${rest.beforeBoss ? 'a rest before the boss' : `at least ${rest.minNodes}`})`,
      );
    }
  });
  if (rest.beforeBoss) {
    const at = 'generation.rest.beforeBoss';
    if (!gen.boss.required) {
      error(at, 'a rest before the boss needs a boss — switch "Ends on a boss" on, or this off');
    } else {
      if (rest.maxNodes === 0) error('generation.rest.maxNodes', 'a rest before the boss needs at least one rest allowed');
      // The rest sits at (final depth − 1) of whatever length the run rolls.
      const first = finalDepths.min - 1;
      const last = finalDepths.max - 1;
      if (first < 2) {
        error(at, `the shortest run has ${finalDepths.min} depths — too short for a start, a rest and a boss; raise Min nodes`);
      }
      const generic = gen.depthRanges.rest;
      const blocked: number[] = [];
      for (let depth = Math.max(first, 1); depth <= last; depth++) {
        if (!depthInRange(depth, rest) || !depthInRange(depth, generic)) blocked.push(depth);
      }
      if (blocked.length > 0) {
        error(
          at,
          `runs end at depth ${finalDepths.min}–${finalDepths.max}, so the rest before the boss sits at depth ` +
            `${first}–${last}; the rest depth range excludes depth ${blocked.join(', ')}`,
        );
      }
      const { minBranches, maxLength } = gen.branching;
      if (minBranches > 0 && gen.maxNodes - minBranches < 3 + minBranches + Math.max(0, minBranches - 1)) {
        error(at, `no run is long enough for ${minBranches} required fork(s) and a rest before the boss that no fork bypasses (forks up to ${maxLength} long)`);
      }
    }
  }

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
  extractionWindowsOf(zone).forEach((window, i) => {
    const path = `generation.extraction.windows[${i}]`;
    // A window nothing can be placed in: fatal when required, dead weight when optional.
    const unplaceable = window.required ? error : warning;
    if (window.maxDepth !== null && window.maxDepth < gen.extraction.minDepth) {
      unplaceable(path, `the window ends at depth ${window.maxDepth}, above the extraction depth ${gen.extraction.minDepth}`);
    } else if (Math.max(window.minDepth, gen.extraction.minDepth) > deepestInterior) {
      unplaceable(path, `no run has a node at depth ${window.minDepth} or deeper that can offer extraction (the deepest is ${deepestInterior})`);
    } else if (window.required && Math.max(window.minDepth, gen.extraction.minDepth) > finalDepths.min - 1) {
      error(
        path,
        `the shortest run ends at depth ${finalDepths.min}, so a required window starting at depth ` +
          `${window.minDepth} cannot always be placed — make it optional or start it shallower`,
      );
    }
  });
  if (
    (gen.extraction.minPoints > 0 || extractionWindowsOf(zone).length > 0) &&
    gen.extraction.nodeTypes.every((t) => t === 'boss')
  ) {
    error('generation.extraction.nodeTypes', 'a guaranteed extraction point needs a node type that offers extraction');
  }

  const firstType = gen.firstNodeType ?? null;
  if (firstType !== null && !nodeTypeAllowedAtDepth(zone, firstType, 1, ctx.catalogue)) {
    error(
      'generation.firstNodeType',
      `Every run is set to start with a ${firstType} room, but a ${firstType} cannot be placed first: ` +
        (firstType === 'exit'
          ? 'an Exit is only legal from the extraction depth'
          : firstType === 'rest'
            ? 'the Rest rules do not allow a Rest at depth 1'
            : `nothing in its pool or reward bands is available at depth 1, or its depth range starts later`),
    );
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

/**
 * An authored zone's rooms: the layout's own rules, then what each room names.
 *
 * A reference to something that does not exist is always an error. Everything
 * else — a broken layout, a disabled enemy — is an error on an enabled zone
 * and a warning on a disabled one, so a layout can be saved while it is being
 * built and cannot be switched on until it is whole.
 */
function validateAuthoredRooms(
  zone: DungeonZoneDefinition,
  ctx: DungeonZoneValidationContext,
  issues: DungeonZoneIssue[],
): void {
  const draft: DungeonZoneIssue['severity'] = zone.enabled ? 'error' : 'warning';
  for (const issue of validateAuthoredLayout(zone)) issues.push({ ...issue, severity: draft });

  const { depths } = analyseAuthoredLayout(zone);
  authoredLayoutOf(zone).rooms.forEach((room, i) => {
    const at = `authored.rooms[${i}]`;
    const called = `Room "${roomLabel(room)}"`;
    const push = (path: string, message: string, severity: DungeonZoneIssue['severity']) =>
      issues.push({ path: `${at}.${path}`, message, severity });

    if (isEnemyNodeType(room.type) && room.enemyKey !== null) {
      const enemy = ctx.catalogue.enemies.get(room.enemyKey);
      if (!enemy) push('enemyKey', `${called} uses an enemy that no longer exists — choose another.`, 'error');
      else if (!enemy.enabled && ctx.previousEnemyKeys && !ctx.previousEnemyKeys.has(room.enemyKey)) {
        push(
          'enemyKey',
          `${called}: ${enemy.name} is disabled and cannot be added. Enable it in Enemies first, or choose another enemy.`,
          'error',
        );
      } else if (!enemy.enabled) {
        // An existing reference survives the enemy being switched off: the room
        // is hand-placed, so there is nothing to fall back to. It keeps fighting
        // the enemy as it stands, and says so until an admin swaps it.
        push(
          'enemyKey',
          `${called} uses ${enemy.name}, which is disabled. The room still fights it — choose another enemy, or re-enable this one.`,
          'warning',
        );
      }
    }
    if (room.type === 'event' && room.eventKey !== null) {
      const event = ctx.catalogue.events.get(room.eventKey);
      if (!event) push('eventKey', `${called} uses an event that no longer exists — choose another.`, 'error');
      else if (!event.enabled) push('eventKey', `${called} uses ${event.name}, which is disabled — choose another event.`, draft);
    }

    for (const field of ['rewardTable', 'equipmentRewardTable'] as const) {
      const id = room.reward?.[field] ?? null;
      if (id === null) continue;
      const table = ctx.rewardTables.get(id);
      if (!table) push(`reward.${field}`, `${called} pays from reward table "${id}", which does not exist.`, 'error');
      else if (!table.enabled) push(`reward.${field}`, `${called} pays from reward table "${id}", which is disabled — it pays nothing.`, 'warning');
    }
    const depth = depths.get(room.id);
    if (room.type === 'reward' && room.reward === null && depth !== undefined) {
      if (rewardBandFor(zone.rewards.bands, 'reward', depth) === null) {
        push('reward', `${called} is a Reward room that pays nothing — give it a reward, or add a default reward for Reward rooms.`, 'warning');
      }
    }

    if (ctx.assets) {
      const slots = [
        ['backgroundAssetId', room.backgroundAssetId, 'background'],
        ['scene.spriteAssetId', room.scene?.spriteAssetId ?? null, 'enemy sprite'],
        ['scene.artworkAssetId', room.scene?.artworkAssetId ?? null, 'enemy artwork'],
      ] as const;
      for (const [field, id, what] of slots) {
        if (id === null) continue;
        const asset = ctx.assets.get(id);
        if (!asset || asset.status === 'deleted') {
          push(field, `${called}: its ${what} no longer exists — choose another or clear it.`, 'error');
        } else if (asset.status === 'disabled') {
          push(field, `${called}: its ${what} "${asset.name}" is disabled, so the default is shown instead.`, 'warning');
        }
      }
    }
  });
}
