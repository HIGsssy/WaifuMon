/**
 * Dungeon runs — generating one for a player and storing it.
 *
 * Generation and storage only. A run is created `active`, on its start node,
 * with nothing banked; nothing here moves it through the graph, fights, pays
 * or extracts — that is `dungeonPlayService`, which starts runs through
 * {@link DungeonRunService.startRun} with the player's fighter snapshot and
 * then advances `current_node_id`, `current_hp`, `unbanked_currency`,
 * `secured_rewards` and `node_states`.
 *
 * ## Starting a run
 *
 *   1. load the zone row as it stands, and refuse a missing or disabled one;
 *   2. validate it against this server (references and reachability);
 *   3. generate from the seed with the same generator the Admin preview uses;
 *   4. resolve everything the graph selected — enemies, events, the currency,
 *      and each reward table with the Equipment definitions it may pay;
 *   5. store the graph and that snapshot.
 *
 * ## Snapshot semantics
 *
 * From then on the stored `graph` is authoritative and the `zone_snapshot` is
 * the only content the run reads. Editing or disabling the zone, an enemy, an
 * event or a reward table afterwards reaches the next run and never this one.
 *
 * The snapshot also records the zone definition and the content catalogue the
 * generator saw, so {@link DungeonRunService.reproduceGraph} can regenerate
 * the same graph from the stored seed — for debugging, not for play.
 *
 * ## One active run
 *
 * `dungeon_runs_one_active_uq` allows one `active` row per player. A second
 * start is refused with {@link DungeonRunActiveError} whether it loses the
 * check here or the race at the index.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { dungeonRuns, players, rewardTables, type DungeonRunRow, type DungeonRunStatus } from '../../db/schema';
import {
  DungeonRunActiveError,
  DungeonZoneInvalidError,
  DungeonZoneUnavailableError,
  EquipmentRewardConfigError,
  PlayerNotFoundError,
  uniqueViolationConstraint,
} from '../../shared/errors';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { ExpeditionRewardTable } from '../content/schemas';
import { listRewardableDefinitions } from '../equipment/equipmentRewardService';
import type { ProgressionCurrencyService } from '../progressionCurrency/progressionCurrencyService';
import {
  equipmentSelectorsOf,
  resolveEquipmentPools,
  type EquipmentRewardCandidate,
} from '../rewardTables/rewardTableCore';
import { parseRewardTableRow } from '../rewardTables/rewardTableStore';
import {
  DUNGEON_GENERATOR_VERSION,
  enemyKeysOf,
  eventKeysOf,
  generateDungeon,
  type DungeonContentCatalogue,
  type DungeonContentRef,
  type DungeonGraph,
} from './dungeonGenerator';
import {
  loadDungeonValidationContext,
  randomDungeonSeed,
  type DungeonContentSource,
} from './dungeonZoneService';
import {
  dungeonCatalogueFromContent,
  dungeonRegionsFromContent,
  parseDungeonZoneRow,
  readDungeonZoneRow,
} from './dungeonZoneStore';
import type { DungeonEventDefinition } from './eventDefinitions';
import type {
  DungeonFighter,
  DungeonNodeStates,
  DungeonSecuredReward,
  DungeonSettlement,
} from './dungeonRunState';
import { DUNGEON_POOL_KEYS, DungeonZoneDefinitionSchema, type DungeonZoneDefinition } from './zoneDefinition';
import { hasErrors, validateDungeonZone } from './zoneValidation';

export const DUNGEON_RUN_SNAPSHOT_FORMAT = 'waifumon-dungeon-run-snapshot' as const;
export const DUNGEON_RUN_SNAPSHOT_VERSION = 1 as const;

/** A reward table as a run was promised it, with the gear it may pay. */
export interface DungeonRewardTableSnapshot {
  table: ExpeditionRewardTable;
  /** Eligible Equipment definitions per selector, keyed by `equipmentSelectorKey`. */
  equipmentPools: Record<string, EquipmentRewardCandidate[]>;
}

/** Everything a run needs from authored content, frozen when it was generated. */
export interface DungeonRunSnapshot {
  format: typeof DUNGEON_RUN_SNAPSHOT_FORMAT;
  version: typeof DUNGEON_RUN_SNAPSHOT_VERSION;
  zone: DungeonZoneDefinition;
  zoneRevision: number;
  zoneContentHash: string;
  /** What the generator saw for every key the zone's pools name — for reproduction. */
  catalogue: { enemies: DungeonContentRef[]; events: DungeonContentRef[] };
  /** The full definition of every enemy the graph placed. */
  enemies: Record<string, CombatEnemyDefinition>;
  events: Record<string, DungeonEventDefinition>;
  /** The currency's display metadata; null when the zone names none this server has. */
  currency: {
    key: string;
    singularName: string;
    pluralName: string;
    description: string;
    icon: string | null;
    enabled: boolean;
  } | null;
  /** Every table the run can pay from. Null for one that was disabled: it pays nothing. */
  rewardTables: Record<string, DungeonRewardTableSnapshot | null>;
}

export interface DungeonRun {
  id: number;
  playerId: number;
  zoneKey: string;
  zoneRevision: number;
  seed: number;
  generatorVersion: number;
  status: DungeonRunStatus;
  graph: DungeonGraph;
  snapshot: DungeonRunSnapshot;
  currentNodeId: string | null;
  currentHp: number | null;
  unbankedCurrency: number;
  securedRewards: DungeonSecuredReward[];
  /** The Buddy and stats snapshotted at start; null for a run that cannot be played. */
  fighter: DungeonFighter | null;
  nodeStates: DungeonNodeStates;
  /** How the run ended; null while it is active. */
  settlement: DungeonSettlement | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface DungeonRunService {
  /**
   * Generate and store a run. `seed` is for reproduction; omitted, one is drawn.
   *
   * With a `fighter` the run starts *entered* on its first node at full HP and
   * can be played. Without one it is a generated snapshot only. Pass `tx` to
   * make the insert part of a larger transaction (the caller then owns the
   * mapping of a lost race at the one-active-run index).
   *
   * @throws {DungeonZoneUnavailableError} for a missing or disabled zone.
   * @throws {DungeonZoneInvalidError} when the zone no longer validates here.
   * @throws {DungeonGenerationError} when the rules cannot produce a run.
   * @throws {DungeonRunActiveError} when the player already has an active run.
   */
  startRun(
    input: { playerId: number; zoneKey: string; seed?: number; fighter?: DungeonFighter },
    tx?: DbOrTx,
  ): Promise<DungeonRun>;
  getRun(runId: number): Promise<DungeonRun | null>;
  getActiveRun(playerId: number): Promise<DungeonRun | null>;
  /**
   * End the player's active run without settling it: nothing is banked. The
   * player-facing abandon is `dungeonPlayService.abandon`, which settles.
   * Null when there is none.
   */
  abandonActiveRun(playerId: number): Promise<DungeonRun | null>;
  /** Regenerate a run's graph from its stored seed and snapshot. */
  reproduceGraph(run: Pick<DungeonRun, 'seed' | 'snapshot'>): DungeonGraph;
}

export interface DungeonRunServiceDeps {
  db: Db;
  getContent: () => DungeonContentSource;
  currencies: Pick<ProgressionCurrencyService, 'get'>;
}

export function toDungeonRun(row: DungeonRunRow): DungeonRun {
  return {
    id: row.id,
    playerId: row.playerId,
    zoneKey: row.zoneKey,
    zoneRevision: row.zoneRevision,
    seed: row.seed,
    generatorVersion: row.generatorVersion,
    status: row.status,
    graph: row.graph as unknown as DungeonGraph,
    snapshot: row.zoneSnapshot as unknown as DungeonRunSnapshot,
    currentNodeId: row.currentNodeId,
    currentHp: row.currentHp,
    unbankedCurrency: row.unbankedCurrency,
    securedRewards: row.securedRewards as unknown as DungeonSecuredReward[],
    fighter: (row.fighter as unknown as DungeonFighter | null) ?? null,
    nodeStates: row.nodeStates as unknown as DungeonNodeStates,
    settlement: (row.settlement as unknown as DungeonSettlement | null) ?? null,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

/** The catalogue a snapshot recorded, back in the shape the generator takes. */
export function catalogueFromSnapshot(snapshot: DungeonRunSnapshot): DungeonContentCatalogue {
  return {
    enemies: new Map(snapshot.catalogue.enemies.map((e) => [e.key, e])),
    events: new Map(snapshot.catalogue.events.map((e) => [e.key, e])),
  };
}

export function createDungeonRunService(deps: DungeonRunServiceDeps): DungeonRunService {
  const { db } = deps;

  /** Each reward table the graph can pay from, as it stands now. */
  async function snapshotRewardTables(
    tx: DbOrTx,
    zone: DungeonZoneDefinition,
    graph: DungeonGraph,
  ): Promise<DungeonRunSnapshot['rewardTables']> {
    const bandIds = new Set(graph.nodes.map((n) => n.rewardBandId));
    const ids = new Set<string>();
    for (const band of zone.rewards.bands) {
      if (!bandIds.has(band.id)) continue;
      if (band.rewardTable) ids.add(band.rewardTable);
      if (band.equipmentRewardTable) ids.add(band.equipmentRewardTable);
    }
    for (const bonus of [zone.rewards.completion, zone.rewards.extraction]) {
      if (bonus.rewardTable) ids.add(bonus.rewardTable);
    }
    const out: DungeonRunSnapshot['rewardTables'] = {};
    if (ids.size === 0) return out;

    const rows = await tx
      .select()
      .from(rewardTables)
      .where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, [...ids])));
    const definitions = await listRewardableDefinitions(tx);
    for (const id of ids) {
      const row = rows.find((r) => r.tableId === id);
      if (!row) {
        throw new DungeonZoneInvalidError([
          { path: 'rewards', message: `"${id}" is not an expedition reward table`, severity: 'error' },
        ]);
      }
      const table = parseRewardTableRow(row) as ExpeditionRewardTable;
      if (!row.enabled || !table.enabled) {
        out[id] = null;
        continue;
      }
      try {
        out[id] = { table, equipmentPools: resolveEquipmentPools(equipmentSelectorsOf([table]), definitions) };
      } catch (err) {
        if (!(err instanceof EquipmentRewardConfigError)) throw err;
        throw new DungeonZoneInvalidError([
          {
            path: 'rewards',
            message: `reward table "${id}" has an Equipment reward this server cannot pay: ${err.message}`,
            severity: 'error',
          },
        ]);
      }
    }
    return out;
  }

  async function activeRow(tx: DbOrTx, playerId: number, lock = false): Promise<DungeonRunRow | undefined> {
    const query = tx
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.playerId, playerId), eq(dungeonRuns.status, 'active')));
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  return {
    async startRun({ playerId, zoneKey, seed, fighter }, outer) {
      try {
        const body = async (tx: DbOrTx) => {
          const [player] = await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId));
          if (!player) throw new PlayerNotFoundError(playerId);
          if (await activeRow(tx, playerId)) throw new DungeonRunActiveError(playerId);

          const row = await readDungeonZoneRow(tx, zoneKey);
          if (!row) throw new DungeonZoneUnavailableError(zoneKey, 'missing');
          if (!row.enabled) throw new DungeonZoneUnavailableError(zoneKey, 'disabled');

          const content = deps.getContent();
          const catalogue = dungeonCatalogueFromContent(content);
          // The generation below is the real trial, so the validator's own are skipped.
          const ctx = await loadDungeonValidationContext(tx, catalogue, dungeonRegionsFromContent(content));
          const { zone, issues } = validateDungeonZone(parseDungeonZoneRow(row), { ...ctx, skipTrialRuns: true });
          if (!zone || hasErrors(issues)) throw new DungeonZoneInvalidError(issues);

          const runSeed = seed ?? randomDungeonSeed();
          const graph = generateDungeon(zone, catalogue, runSeed);

          const named = (pool: 'enemies' | 'events') => {
            const keys = new Set<string>();
            for (const poolKey of DUNGEON_POOL_KEYS) {
              if ((poolKey === 'event') !== (pool === 'events')) continue;
              for (const entry of zone.pools[poolKey]) keys.add('enemyKey' in entry ? entry.enemyKey : entry.eventKey);
            }
            return [...keys].sort().flatMap((key) => {
              const ref = catalogue[pool].get(key);
              return ref ? [ref] : [];
            });
          };
          const pick = <T extends { key: string }>(list: readonly T[] | undefined, keys: string[]) =>
            Object.fromEntries((list ?? []).filter((c) => keys.includes(c.key)).map((c) => [c.key, c]));
          const currency = await deps.currencies.get(zone.rewards.currencyKey, tx);

          const snapshot: DungeonRunSnapshot = {
            format: DUNGEON_RUN_SNAPSHOT_FORMAT,
            version: DUNGEON_RUN_SNAPSHOT_VERSION,
            zone,
            zoneRevision: row.revision,
            zoneContentHash: row.contentHash,
            catalogue: { enemies: named('enemies'), events: named('events') },
            enemies: pick(content.combatEnemies, enemyKeysOf(graph)),
            events: pick(content.dungeonEvents, eventKeysOf(graph)),
            currency: currency && {
              key: currency.key,
              singularName: currency.singularName,
              pluralName: currency.pluralName,
              description: currency.description,
              icon: currency.icon,
              enabled: currency.enabled,
            },
            rewardTables: await snapshotRewardTables(tx, zone, graph),
          };

          const [inserted] = await tx
            .insert(dungeonRuns)
            .values({
              playerId,
              zoneKey: zone.key,
              zoneRevision: row.revision,
              seed: runSeed,
              generatorVersion: DUNGEON_GENERATOR_VERSION,
              graph: graph as unknown as Record<string, unknown>,
              zoneSnapshot: snapshot as unknown as Record<string, unknown>,
              currentNodeId: graph.startNodeId,
              ...(fighter
                ? {
                    fighter: fighter as unknown as Record<string, unknown>,
                    currentHp: fighter.maxHp,
                    nodeStates: {
                      [graph.startNodeId]: {
                        status: 'entered',
                        enteredAt: new Date().toISOString(),
                        completedAt: null,
                        resolution: null,
                      },
                    } satisfies DungeonNodeStates,
                  }
                : {}),
            })
            .returning();
          return toDungeonRun(inserted!);
        };
        return outer ? await body(outer) : await db.transaction(body);
      } catch (err) {
        // The loser of two concurrent starts meets the index, not the check.
        if (uniqueViolationConstraint(err) === 'dungeon_runs_one_active_uq') throw new DungeonRunActiveError(playerId);
        throw err;
      }
    },

    async getRun(runId) {
      const [row] = await db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId));
      return row ? toDungeonRun(row) : null;
    },

    async getActiveRun(playerId) {
      const row = await activeRow(db, playerId);
      return row ? toDungeonRun(row) : null;
    },

    async abandonActiveRun(playerId) {
      return db.transaction(async (tx) => {
        const row = await activeRow(tx, playerId, true);
        if (!row) return null;
        const now = new Date();
        const [updated] = await tx
          .update(dungeonRuns)
          .set({ status: 'abandoned', completedAt: now, updatedAt: now })
          .where(eq(dungeonRuns.id, row.id))
          .returning();
        return toDungeonRun(updated!);
      });
    },

    reproduceGraph(run) {
      return generateDungeon(
        DungeonZoneDefinitionSchema.parse(run.snapshot.zone),
        catalogueFromSnapshot(run.snapshot),
        run.seed,
      );
    },
  };
}
