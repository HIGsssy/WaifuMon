/**
 * Global World Encounter runtime settings — the live-tuning seam.
 *
 * The engine asks this service for its four tuning values on every roll, so a
 * change saved in Portal Admin is felt by the next hunt. That is the whole
 * point: these are the numbers an operator wants to move while watching a
 * server, and requiring a redeploy (or even a content reload) to move them
 * makes them useless for that.
 *
 * ## Reading is on a hot path, so it is cached
 *
 * `tryRollForHunt` runs on every hunt. Hitting Postgres each time to learn a
 * probability would be a query per hunt for a value that changes a few times a
 * month. So reads go through a small TTL cache.
 *
 * The TTL is short (a few seconds) and is a **backstop, not the mechanism**:
 * `update()` refreshes the cache in the same call, so in the normal deployment
 * — bot and Platform API in one process, which is how `src/index.ts` wires it
 * — a save is visible immediately. The TTL is what bounds staleness for a
 * deployment that runs the API separately from the bot, where a write in one
 * process cannot invalidate the other's memory.
 *
 * ## The row seeds itself
 *
 * A deployment that migrates and never opens the panel has no row. Rather than
 * make every caller handle that, the first read inserts one from
 * {@link WORLD_ENCOUNTER_SETTINGS_DEFAULTS} — values chosen to match the
 * shipped `content/tables.json` exactly, so behaviour is unchanged until
 * somebody deliberately changes it.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { worldEncounterSettings, type WorldEncounterSettingsRow } from '../../db/schema';
import type { Logger } from '../../shared/logger';

/** The one row's primary key. The table's CHECK constraint pins it to this. */
const SETTINGS_ID = 1;

export interface WorldEncounterSettings {
  huntChance: number;
  travelChance: number;
  defaultExpirySeconds: number;
  forceTrigger: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * What a fresh install gets. These mirror the shipped `content/tables.json`
 * numbers, so migrating this table changes nothing until an operator does.
 */
export const WORLD_ENCOUNTER_SETTINGS_DEFAULTS = {
  huntChance: 0.35,
  travelChance: 0.2,
  defaultExpirySeconds: 600,
  forceTrigger: false,
} as const;

/** Bounds the API and the table's CHECK constraints both enforce. */
export const SETTINGS_BOUNDS = {
  chance: { min: 0, max: 1 },
  /**
   * Thirty seconds is the shortest expiry a player could plausibly answer;
   * a day is the longest that still means "this encounter is current".
   */
  expirySeconds: { min: 30, max: 86_400 },
} as const;

export interface WorldEncounterSettingsPatch {
  huntChance?: number | undefined;
  travelChance?: number | undefined;
  defaultExpirySeconds?: number | undefined;
  forceTrigger?: boolean | undefined;
}

export interface WorldEncounterSettingsService {
  /** Cached read. Cheap enough to call on every hunt. */
  get(): Promise<WorldEncounterSettings>;
  /**
   * Synchronous best-effort read for callers that cannot await — returns the
   * cached row, or the defaults before the first load has completed. The
   * engine's `getConfig()` is one of these: it is called from inside a
   * transaction where an extra round trip would widen the lock window.
   */
  getCached(): WorldEncounterSettings;
  /** Force the next `get()` to re-read. Used by tests and by ops tooling. */
  invalidate(): void;
  /**
   * Apply a partial change. Validates, writes, and refreshes the cache so the
   * caller's own process sees the new values immediately.
   */
  update(
    patch: WorldEncounterSettingsPatch,
    actor?: string | null,
  ): Promise<WorldEncounterSettings>;
}

export class WorldEncounterSettingsValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super('World encounter settings validation failed');
    this.name = 'WorldEncounterSettingsValidationError';
    this.issues = issues;
  }
}

export interface WorldEncounterSettingsServiceDeps {
  db: Db;
  logger: Logger;
  /** Cache lifetime. Short by design — see the module comment. */
  ttlMs?: number | undefined;
}

const DEFAULT_TTL_MS = 5_000;

function rowToSettings(row: WorldEncounterSettingsRow): WorldEncounterSettings {
  return {
    huntChance: row.huntChance,
    travelChance: row.travelChance,
    defaultExpirySeconds: row.defaultExpirySeconds,
    forceTrigger: row.forceTrigger,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Validate a patch against the same bounds the table enforces.
 *
 * Exported so the API route and its tests can check a payload without a
 * database, and so there is exactly one statement of what "valid" means.
 */
export function validateSettingsPatch(patch: WorldEncounterSettingsPatch): string[] {
  const issues: string[] = [];
  const chance = (name: string, value: number | undefined) => {
    if (value === undefined) return;
    if (!Number.isFinite(value)) {
      issues.push(`${name} must be a number.`);
      return;
    }
    if (value < SETTINGS_BOUNDS.chance.min || value > SETTINGS_BOUNDS.chance.max) {
      issues.push(
        `${name} must be between ${SETTINGS_BOUNDS.chance.min} and ${SETTINGS_BOUNDS.chance.max}.`,
      );
    }
  };
  chance('huntChance', patch.huntChance);
  chance('travelChance', patch.travelChance);

  if (patch.defaultExpirySeconds !== undefined) {
    const value = patch.defaultExpirySeconds;
    if (!Number.isInteger(value)) {
      issues.push('defaultExpirySeconds must be a whole number of seconds.');
    } else if (
      value < SETTINGS_BOUNDS.expirySeconds.min ||
      value > SETTINGS_BOUNDS.expirySeconds.max
    ) {
      issues.push(
        `defaultExpirySeconds must be between ${SETTINGS_BOUNDS.expirySeconds.min} and ` +
          `${SETTINGS_BOUNDS.expirySeconds.max}.`,
      );
    }
  }
  return issues;
}

export function createWorldEncounterSettingsService(
  deps: WorldEncounterSettingsServiceDeps,
): WorldEncounterSettingsService {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  let cached: WorldEncounterSettings = {
    ...WORLD_ENCOUNTER_SETTINGS_DEFAULTS,
    updatedAt: null,
    updatedBy: null,
  };
  let expiresAt = 0;
  /** De-duplicates concurrent first reads into one query. */
  let inFlight: Promise<WorldEncounterSettings> | null = null;

  async function load(): Promise<WorldEncounterSettings> {
    const [existing] = await deps.db
      .select()
      .from(worldEncounterSettings)
      .where(eq(worldEncounterSettings.id, SETTINGS_ID));
    if (existing) return rowToSettings(existing);

    // First read on a fresh install. `onConflictDoNothing` keeps two racing
    // readers from both trying to create the singleton.
    await deps.db
      .insert(worldEncounterSettings)
      .values({ id: SETTINGS_ID, ...WORLD_ENCOUNTER_SETTINGS_DEFAULTS })
      .onConflictDoNothing();
    const [seeded] = await deps.db
      .select()
      .from(worldEncounterSettings)
      .where(eq(worldEncounterSettings.id, SETTINGS_ID));
    if (!seeded) throw new Error('world encounter settings row could not be created');
    return rowToSettings(seeded);
  }

  function cache(next: WorldEncounterSettings): WorldEncounterSettings {
    cached = next;
    expiresAt = Date.now() + ttl;
    return next;
  }

  async function get(): Promise<WorldEncounterSettings> {
    if (Date.now() < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = load()
      .then(cache)
      .catch((err: unknown) => {
        // A database blip must not stop players hunting. Serve the last known
        // values (or the defaults) and say so once.
        deps.logger.warn(
          { err, tag: 'world-encounter/settings-read-failed' },
          'could not read world encounter settings; using last known values',
        );
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function update(
    patch: WorldEncounterSettingsPatch,
    actor: string | null = null,
  ): Promise<WorldEncounterSettings> {
    const issues = validateSettingsPatch(patch);
    if (issues.length > 0) throw new WorldEncounterSettingsValidationError(issues);

    // Make sure the row exists before updating it, so a first-ever save on a
    // fresh install is a save rather than a silent no-op.
    await get();

    const values: Record<string, unknown> = { updatedAt: sql`now()`, updatedBy: actor };
    if (patch.huntChance !== undefined) values.huntChance = patch.huntChance;
    if (patch.travelChance !== undefined) values.travelChance = patch.travelChance;
    if (patch.defaultExpirySeconds !== undefined) {
      values.defaultExpirySeconds = patch.defaultExpirySeconds;
    }
    if (patch.forceTrigger !== undefined) values.forceTrigger = patch.forceTrigger;

    const [row] = await deps.db
      .update(worldEncounterSettings)
      .set(values)
      .where(eq(worldEncounterSettings.id, SETTINGS_ID))
      .returning();
    if (!row) throw new Error('world encounter settings row missing after update');

    const next = cache(rowToSettings(row));
    deps.logger.info(
      {
        tag: 'world-encounter/settings-updated',
        actor,
        huntChance: next.huntChance,
        travelChance: next.travelChance,
        defaultExpirySeconds: next.defaultExpirySeconds,
        forceTrigger: next.forceTrigger,
      },
      // Force trigger changes how the game behaves for every player, so it is
      // worth being able to grep for when one is left on by accident.
      next.forceTrigger
        ? 'world encounter settings updated — FORCE TRIGGER IS ON'
        : 'world encounter settings updated',
    );
    return next;
  }

  return {
    get,
    getCached: () => cached,
    invalidate: () => {
      expiresAt = 0;
    },
    update,
  };
}
