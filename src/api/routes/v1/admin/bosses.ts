/**
 * Portal admin — Boss Management.
 *
 * Boss definitions are database rows (`boss_definitions`); this is where they
 * are authored, scheduled and watched.
 *
 *   - `bosses.read`  — list, get, the editor's reference data, validate and
 *     schedule preview (dry runs), export, import plan, the audit trail, and
 *     the Activity and Diagnostics views.
 *   - `bosses.write` — create, update, lifecycle, duplicate, delete, apply an
 *     import. Reaches future encounters only.
 *   - `bosses.operate` — **Spawn Now** and **End Encounter**, which act on a
 *     server's players at once. Separate from `write`: neither implies the other.
 *
 * Every definition write names the revision it edited; a stale one is refused
 * with `409 BOSS_DEFINITION_STALE` rather than overwriting. Validation
 * failures are `400 BOSS_DEFINITION_INVALID` with per-field `details.issues`.
 *
 * Activity, Diagnostics, Spawn Now and End Encounter act on **one guild** —
 * the Portal session's selected server (a bearer caller names it with
 * `?guildId=`). They go through the same `BossEncounterService` the scheduler
 * and `/waifumon-admin boss` use: a manual spawn is an ordinary encounter,
 * paid from its reward table like any other, and ending one pays everyone who
 * committed.
 *
 * There is deliberately no route that edits a live encounter's numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../../../context';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import { commonErrorResponses, errorSchema, notFoundResponse } from '../../../schemas/common';
import { requirePortalPermission } from '../../../plugins/portalPermissions';
import { resolveGuildScope } from '../../../plugins/guildScope';
import { ApiErrorWithDetails } from '../../../errors';
import {
  AppError,
  BossChannelNotConfiguredError,
  BossDefinitionInUseError,
  BossDefinitionInvalidError,
  BossDefinitionStaleError,
  BossEncounterNotFoundError,
  BossEncounterNotOpenError,
  BossSpawnRefusedError,
} from '../../../../shared/errors';
import {
  AFFINITIES,
  BOSS_DEFINITION_EVENT_ACTIONS,
  BOSS_DEFINITION_SOURCES,
  BOSS_DEFINITION_STATUSES,
  BOSS_ENCOUNTER_STATUSES,
  type BossEncounterRow,
} from '../../../../db/schema';
import { resolveExistingAssetFile } from '../../../../modules/assets/assetContainment';
import { BOSS_KEY_MAX_LENGTH, BOSS_KEY_PATTERN } from '../../../../modules/bosses/bossDefinitions';
import type {
  BossDefinitionDetail,
  BossDefinitionService,
  BossDefinitionSummary,
} from '../../../../modules/bosses/bossDefinitionService';
import type { BossEncounterService } from '../../../../modules/bosses/bossEncounterService';
import {
  DEFAULT_BOSS_SCHEDULE_TIMEZONE,
  WEEKDAYS,
  type BossAvailability,
} from '../../../../modules/bosses/bossSchedule';
import type { BossSchedulerStatus } from '../../../../modules/bosses/bossScheduler';
import { parseShuffleBagState } from '../../../../modules/bosses/bossShuffleBag';
import { REGIONS, regionLabel } from '../../../../modules/bosses/regions';

const idSchema = z.string().min(1).max(BOSS_KEY_MAX_LENGTH).regex(BOSS_KEY_PATTERN);
/** The service validates the boss itself, so a bad field is an issue at that field, not a schema 400. */
const bossBody = z.record(z.string(), z.unknown());
const revisionSchema = z.number().int().positive();

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});

const scheduleSchema = z.object({
  timezone: z.string(),
  weekly: z
    .array(
      z.object({
        day: z.enum(WEEKDAYS),
        allDay: z.boolean(),
        windows: z.array(z.object({ start: z.string(), end: z.string() })),
      }),
    )
    .nullable(),
  dateRange: z
    .union([
      z.object({ kind: z.literal('fixed'), start: z.string().nullable(), end: z.string().nullable() }),
      z.object({ kind: z.literal('yearly'), start: z.string(), end: z.string() }),
    ])
    .nullable(),
});

const windowSchema = z.object({ start: z.string().nullable(), end: z.string().nullable() });

const availabilitySchema = z.object({
  mode: z.enum(['always', 'weekly', 'date_range', 'weekly_date_range']),
  availableNow: z.boolean(),
  currentWindow: windowSchema.nullable(),
  nextWindow: windowSchema.nullable(),
  unavailableReason: z.string().nullable(),
});

const definitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  affinity: z.enum(AFFINITIES),
  regions: z.array(z.string()),
  status: z.enum(BOSS_DEFINITION_STATUSES),
  artwork: z.string().nullable(),
  rewardTable: z.string(),
  scoutingText: z.string(),
  repelledText: z.string(),
  unchallengedText: z.string(),
  description: z.string(),
  schedule: scheduleSchema,
});

const summarySchema = definitionSchema.extend({
  revision: z.number().int(),
  source: z.enum(BOSS_DEFINITION_SOURCES),
  shipped: z.boolean(),
  encounterCount: z.number().int(),
  lastEncounterAt: z.string().nullable(),
  scheduleSummary: z.string(),
  availability: availabilitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const detailSchema = summarySchema.extend({ issues: z.array(issueSchema) });

const eventSchema = z.object({
  id: z.number().int(),
  bossKey: z.string(),
  action: z.enum(BOSS_DEFINITION_EVENT_ACTIONS),
  actor: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const encounterSchema = z.object({
  id: z.number().int(),
  bossId: z.string(),
  bossName: z.string(),
  region: z.string(),
  status: z.enum(BOSS_ENCOUNTER_STATUSES),
  /** True for a manual spawn (Portal or `/waifumon-admin boss spawn`). */
  forced: z.boolean(),
  /** When the boss was drawn. */
  scheduledAt: z.string(),
  /** When the announcement went up and the window opened; null until then. */
  startedAt: z.string().nullable(),
  /** The participation deadline; null until the window opens. */
  expiresAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  participantCount: z.number().int(),
  /** Combined damage, recorded at resolution. Bosses have no HP pool. */
  totalDamage: z.number(),
  resolutionReason: z.string().nullable(),
  rewardTable: z.string(),
});

const importPlanSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      action: z.enum(['create', 'conflict', 'unchanged', 'invalid']),
      currentRevision: z.number().int().nullable(),
      changedFields: z.array(z.string()),
      issues: z.array(issueSchema),
    }),
  ),
  issues: z.array(issueSchema),
  canApply: z.boolean(),
});

const schedulerSchema = z.object({
  /**
   * `ok` — a pass completed recently. `stalled` — armed, but no pass has
   * completed for several intervals. `failing` — the last pass threw.
   * `starting` — armed, no pass finished yet. `stopped` — not armed.
   */
  health: z.enum(['ok', 'stalled', 'failing', 'starting', 'stopped']),
  explanation: z.string(),
  running: z.boolean(),
  intervalMs: z.number().int(),
  passes: z.number().int(),
  lastPassStartedAt: z.string().nullable(),
  lastPassCompletedAt: z.string().nullable(),
  lastPassDurationMs: z.number().nullable(),
  lastPassGuilds: z.number().int().nullable(),
  lastPassUsableGuilds: z.number().int().nullable(),
  lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
});

const diagnosticsSchema = z.object({
  generatedAt: z.string(),
  /** False when `bossEncounters.enabled` is off — nothing is scheduled anywhere. */
  featureEnabled: z.boolean(),
  /** Null when this API process runs no boss scheduler; nothing is assumed about another process. */
  scheduler: schedulerSchema.nullable(),
  /**
   * Whether the shipped roster reached the database. `missingShipped` is read
   * from the database on every request, so it is true whichever process ran
   * the bootstrap; `lastRun` is what *this* process's startup reported.
   */
  bootstrap: z.object({
    definitions: z.number().int(),
    missingShipped: z.array(z.string()),
    lastRun: z
      .object({
        at: z.string(),
        error: z.string().nullable(),
        created: z.array(z.string()),
        heldBack: z.array(z.string()),
      })
      .nullable(),
  }),
  guild: z.object({
    region: z.string(),
    channelConfigured: z.boolean(),
    paused: z.boolean(),
    suspendedReason: z.string().nullable(),
    suspendedAt: z.string().nullable(),
    /** When the respawn cooldown ends; null means a spawn is due as soon as a boss is eligible. */
    nextSpawnAt: z.string().nullable(),
    cooldownActive: z.boolean(),
    /** Bosses still owed by the current shuffle bag. */
    bagRemaining: z.number().int(),
  }),
  active: encounterSchema.nullable(),
  /** One entry per definition, each with exactly one verdict. */
  bosses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(BOSS_DEFINITION_STATUSES),
      verdict: z.enum(['eligible', 'not_active', 'other_region', 'outside_schedule', 'reward_table_unavailable']),
      detail: z.string().nullable(),
      /** True for an eligible boss that is only waiting on the guild's respawn cooldown. */
      heldByCooldown: z.boolean(),
      scheduleSummary: z.string(),
      /** The schedule's IANA timezone, for showing its windows in that zone. */
      timezone: z.string(),
      availability: availabilitySchema,
    }),
  ),
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toAvailability(a: BossAvailability): z.infer<typeof availabilitySchema> {
  const window = (w: BossAvailability['currentWindow']) => (w ? { start: iso(w.start), end: iso(w.end) } : null);
  return {
    mode: a.mode,
    availableNow: a.availableNow,
    currentWindow: window(a.currentWindow),
    nextWindow: window(a.nextWindow),
    unavailableReason: a.unavailableReason,
  };
}

function toSummary(s: BossDefinitionSummary): z.infer<typeof summarySchema> {
  return {
    ...s,
    lastEncounterAt: iso(s.lastEncounterAt),
    availability: toAvailability(s.availability),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toDetail(d: BossDefinitionDetail): z.infer<typeof detailSchema> {
  return { ...toSummary(d), issues: d.issues };
}

function toEncounter(e: BossEncounterRow): z.infer<typeof encounterSchema> {
  return {
    id: e.id,
    bossId: e.bossId,
    bossName: e.bossName,
    region: e.region,
    status: e.status as z.infer<typeof encounterSchema>['status'],
    forced: e.forced,
    scheduledAt: e.scheduledAt.toISOString(),
    startedAt: iso(e.scoutingStartedAt),
    expiresAt: iso(e.deadlineAt),
    resolvedAt: iso(e.resolvedAt),
    participantCount: e.participantCount,
    totalDamage: e.totalDamage,
    resolutionReason: e.resolutionReason,
    rewardTable: e.rewardTable,
  };
}

/** How many intervals may pass without a completed pass before the scheduler reads as stalled. */
const STALLED_AFTER_INTERVALS = 3;

/** Turn what the scheduler recorded about itself into a verdict. Nothing here is assumed. */
export function describeSchedulerStatus(status: BossSchedulerStatus, now: Date): z.infer<typeof schedulerSchema> {
  const facts = {
    running: status.running,
    intervalMs: status.intervalMs,
    passes: status.passes,
    lastPassStartedAt: iso(status.lastPassStartedAt),
    lastPassCompletedAt: iso(status.lastPassCompletedAt),
    lastPassDurationMs: status.lastPassDurationMs,
    lastPassGuilds: status.lastPassGuilds,
    lastPassUsableGuilds: status.lastPassUsableGuilds,
    lastError: status.lastError ? { at: status.lastError.at.toISOString(), message: status.lastError.message } : null,
  };
  if (!status.running) {
    return { ...facts, health: 'stopped', explanation: 'The boss scheduler is not running in this process.' };
  }
  if (status.lastError) {
    return { ...facts, health: 'failing', explanation: `The last scheduler pass failed: ${status.lastError.message}` };
  }
  if (!status.lastPassCompletedAt) {
    return { ...facts, health: 'starting', explanation: 'The scheduler is running but has not completed a pass yet.' };
  }
  const sinceMs = now.getTime() - status.lastPassCompletedAt.getTime();
  if (sinceMs > status.intervalMs * STALLED_AFTER_INTERVALS) {
    return {
      ...facts,
      health: 'stalled',
      explanation: `No scheduler pass has completed for ${Math.round(sinceMs / 1000)} seconds (one is expected every ${Math.round(status.intervalMs / 1000)}).`,
    };
  }
  return { ...facts, health: 'ok', explanation: 'The last scheduler pass completed on time.' };
}

/** Service errors that carry structure the editor needs, re-raised with it as `details`. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof BossDefinitionInvalidError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { issues: err.issues });
    }
    if (err instanceof BossDefinitionStaleError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
        updatedBy: err.updatedBy,
        updatedAt: err.updatedAt.toISOString(),
      });
    }
    if (err instanceof BossDefinitionInUseError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, {
        encounterCount: err.encounterCount,
        shipped: err.shipped,
      });
    }
    if (err instanceof BossSpawnRefusedError) {
      throw new ApiErrorWithDetails(err.code, err.message, err.userMessage, { reason: err.reason });
    }
    throw err;
  }
}

const conflictResponse = {
  409: errorSchema.describe(
    'BOSS_DEFINITION_STALE — someone saved first (details: expectedRevision, currentRevision). ' +
      'BOSS_DEFINITION_KEY_TAKEN — the id is in use. BOSS_DEFINITION_IN_USE — has encounter history or is shipped. ' +
      'BOSS_SPAWN_REFUSED — the spawner refused (details.reason).',
  ),
};

/** A reply that sends bytes; the route's typed responses only describe its JSON errors. */
interface BinaryReply {
  header(name: string, value: string): BinaryReply;
  send(payload: Buffer): unknown;
}

const IMAGE_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** Shipped boss artwork an admin can pick: image files directly under `assets/bosses/`. */
function listBossArtwork(assetsDir: string | undefined): string[] {
  if (!assetsDir) return [];
  try {
    return fs
      .readdirSync(path.join(assetsDir, 'bosses'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() in IMAGE_TYPES)
      .map((entry) => `bosses/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

export const adminBossRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const service = ctx.services.bossDefinitions;
    const authorization = ctx.portalAuthorization;
    if (!service) return;
    const definitions: BossDefinitionService = service;
    /** Absent when `bossEncounters.enabled` is off: definitions stay editable, nothing can be spawned. */
    const encounters: BossEncounterService | undefined = ctx.services.bosses;

    const gate =
      (permission: 'bosses.read' | 'bosses.write' | 'bosses.operate') =>
      async (req: FastifyRequest): Promise<void> => {
        if (!authorization) {
          throw new AppError(
            'PORTAL_PERMISSION_DENIED',
            'Portal authorization service is not configured',
            'Admin features are unavailable.',
          );
        }
        await requirePortalPermission(req, authorization, permission, {
          allowBearer: ctx.adminBearerAllowed === true,
        });
      };

    const notFound = (id: string) => new AppError('NOT_FOUND', `Boss "${id}" not found`, 'Not found.');
    /** The actor comes from the authenticated session, never the body. */
    const actorOf = (req: FastifyRequest) => req.portalSession?.discordUserId ?? null;
    const tags = ['Admin — Bosses'];
    const idParams = z.object({ id: idSchema });
    const guildQuery = z.object({ guildId: z.string().max(32).optional() });

    function requireEncounters(): BossEncounterService {
      if (!encounters) {
        throw new BossSpawnRefusedError('feature_disabled', 'Boss encounters are switched off on this server.');
      }
      return encounters;
    }

    /** Ask the scheduler for a pass now, so a manual action reaches Discord without waiting a minute. */
    function requestPass(): 'requested' | 'no_scheduler' {
      const scheduler = ctx.bossRuntime?.scheduler;
      if (!scheduler?.running) return 'no_scheduler';
      void scheduler.tick();
      return 'requested';
    }

    app.get(
      '/admin/bosses',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'List every boss definition: identity, regions, lifecycle status, schedule summary, whether it is inside ' +
            'its availability window now, the next window, and how many encounters it has had',
          response: { 200: dataSchema(z.object({ bosses: z.array(summarySchema) })), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, { bosses: (await definitions.list()).map(toSummary) }),
    );

    app.get(
      '/admin/bosses/reference',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'What the boss editor offers: regions, affinities, boss reward tables, shipped artwork files, and the ' +
            'global encounter tuning (window length, respawn cooldown) shown read-only',
          response: {
            200: dataSchema(
              z.object({
                regions: z.array(z.object({ id: z.string(), label: z.string(), enabled: z.boolean() })),
                affinities: z.array(z.string()),
                rewardTables: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
                artwork: z.array(z.string()),
                defaultTimezone: z.string(),
                /** `tables.json` → `bossEncounters`. Shared by every boss; not editable here. */
                tuning: z.object({
                  enabled: z.boolean(),
                  scoutingMinutes: z.number(),
                  downtimeMinutesMin: z.number(),
                  downtimeMinutesMax: z.number(),
                  attacksPerParticipation: z.number(),
                }),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const config = ctx.getContent().tables.bossEncounters;
        const tables = await definitions.rewardTableOptions();
        return ok(req, {
          regions: REGIONS.map((id) => ({
            id,
            label: regionLabel(id),
            enabled: (config.regions as readonly string[]).includes(id),
          })),
          affinities: [...AFFINITIES],
          rewardTables: tables,
          artwork: listBossArtwork(ctx.assetsDir),
          defaultTimezone: DEFAULT_BOSS_SCHEDULE_TIMEZONE,
          tuning: {
            enabled: config.enabled,
            scoutingMinutes: config.scoutingMinutes,
            downtimeMinutesMin: config.downtimeMinutesMin,
            downtimeMinutesMax: config.downtimeMinutesMax,
            attacksPerParticipation: config.attacksPerParticipation,
          },
        });
      },
    );

    app.get(
      '/admin/bosses/artwork',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary: 'The bytes of a shipped boss artwork file, by its path relative to the assets directory',
          querystring: z.object({ path: z.string().min(1).max(300) }),
          response: { ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req, reply) => {
        const type = IMAGE_TYPES[path.extname(req.query.path).toLowerCase()];
        const found = ctx.assetsDir && type ? resolveExistingAssetFile(ctx.assetsDir, req.query.path) : null;
        if (!found || found.status !== 'available') throw notFound(req.query.path);
        // Data, never a document — the same headers managed artwork is served with.
        (reply as unknown as BinaryReply)
          .header('content-type', type!)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cross-origin-resource-policy', 'same-origin')
          .header('cache-control', 'private, max-age=300')
          .send(await fs.promises.readFile(found.absolutePath));
        return reply;
      },
    );

    app.get(
      '/admin/bosses/export',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary: 'Every boss definition, schedules included, as a `waifumon-boss-definitions` document',
          response: {
            200: dataSchema(
              z.object({
                file: z.string(),
                document: z.object({ format: z.string(), version: z.number().int(), bosses: z.array(definitionSchema) }),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await definitions.export()),
    );

    app.post(
      '/admin/bosses/import/plan',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'Dry run of an import: per boss, whether it would be created, conflicts with an existing boss (and in ' +
            'which fields), is unchanged, or is invalid. Writes nothing',
          body: z.object({ document: z.unknown() }),
          response: { 200: dataSchema(importPlanSchema), ...commonErrorResponses },
        },
      },
      async (req) => ok(req, await definitions.planImport(req.body.document)),
    );

    app.post(
      '/admin/bosses/import/apply',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary:
            'Apply an import. New ids are inserted. An existing boss is replaced only with `conflicts: "overwrite"` ' +
            'and only at the revision named in `expectedRevisions`; with `"skip"` it is left untouched',
          body: z.object({
            document: z.unknown(),
            conflicts: z.enum(['skip', 'overwrite']),
            expectedRevisions: z.record(z.string(), z.number().int()).optional(),
          }),
          response: {
            200: dataSchema(
              z.object({
                created: z.array(z.string()),
                overwritten: z.array(z.string()),
                skipped: z.array(z.string()),
                unchanged: z.array(z.string()),
              }),
            ),
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) =>
        ok(
          req,
          await translate(() =>
            definitions.applyImport(
              req.body.document,
              { conflicts: req.body.conflicts, expectedRevisions: req.body.expectedRevisions },
              actorOf(req),
            ),
          ),
        ),
    );

    app.post(
      '/admin/bosses/validate',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary: 'Dry run: every issue creating or saving this boss would raise, without writing',
          body: z.object({ id: z.string().max(200), boss: z.unknown(), creating: z.boolean().default(false) }),
          response: { 200: dataSchema(z.object({ issues: z.array(issueSchema) })), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, {
          issues: await definitions.validate({ id: req.body.id, boss: req.body.boss, creating: req.body.creating }),
        }),
    );

    app.post(
      '/admin/bosses/schedule/preview',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'Check an availability schedule and describe it: a summary in words, whether it is open now, the ' +
            'current and next window, and why if it can never open. Writes nothing',
          body: z.object({ schedule: z.unknown() }),
          response: {
            200: dataSchema(
              z.object({
                issues: z.array(issueSchema),
                summary: z.string().nullable(),
                availability: availabilitySchema.nullable(),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const preview = definitions.previewSchedule(req.body.schedule);
        return ok(req, {
          issues: preview.issues,
          summary: preview.summary,
          availability: preview.availability ? toAvailability(preview.availability) : null,
        });
      },
    );

    app.get(
      '/admin/bosses/events',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'The Boss Management audit trail, newest first: definition changes, lifecycle changes, imports, manual ' +
            'spawns, schedule overrides and manual encounter ends',
          querystring: z.object({ bossId: idSchema.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
          response: { 200: dataSchema(z.object({ events: z.array(eventSchema) })), ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, {
          events: (await definitions.events({ bossKey: req.query.bossId, limit: req.query.limit })).map((e) => ({
            ...e,
            createdAt: e.createdAt.toISOString(),
          })),
        }),
    );

    app.get(
      '/admin/bosses/activity',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'This server\'s active boss encounter (if any) and its recent encounter history, from `boss_encounters`',
          querystring: guildQuery.extend({ limit: z.coerce.number().int().min(1).max(100).optional() }),
          response: {
            200: dataSchema(
              z.object({
                featureEnabled: z.boolean(),
                active: z.array(encounterSchema),
                recent: z.array(encounterSchema),
              }),
            ),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const scope = await resolveGuildScope(req, ctx, req.query.guildId);
        if (!encounters) return ok(req, { featureEnabled: false, active: [], recent: [] });
        return ok(req, {
          featureEnabled: true,
          active: (await encounters.listActive(scope.guildDbId)).map(toEncounter),
          recent: (await encounters.listRecent(scope.guildDbId, req.query.limit ?? 25)).map(toEncounter),
        });
      },
    );

    app.get(
      '/admin/bosses/diagnostics',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary:
            'Why this server\'s next boss will or will not spawn: what this process has observed of its scheduler, ' +
            'the guild\'s cooldown and pause state, the active encounter, and one verdict per definition (eligible, ' +
            'not active, other region, outside schedule, reward table unavailable)',
          querystring: guildQuery,
          response: { 200: dataSchema(diagnosticsSchema), ...commonErrorResponses },
        },
      },
      async (req) => {
        const scope = await resolveGuildScope(req, ctx, req.query.guildId);
        const now = new Date();
        const status = ctx.bossRuntime?.scheduler?.status();
        const summaries = new Map((await definitions.list(now)).map((s) => [s.id, s]));
        const spawn = encounters ? await encounters.explainSpawn(scope.guildDbId, now) : null;
        const bootstrap = await definitions.bootstrapState();
        return ok(req, {
          generatedAt: now.toISOString(),
          featureEnabled: spawn?.enabled ?? false,
          scheduler: status ? describeSchedulerStatus(status, now) : null,
          bootstrap: {
            definitions: bootstrap.definitions,
            missingShipped: bootstrap.missingShipped,
            lastRun: bootstrap.lastRun ? { ...bootstrap.lastRun, at: bootstrap.lastRun.at.toISOString() } : null,
          },
          guild: {
            region: spawn?.region ?? REGIONS[0],
            channelConfigured: spawn?.channelConfigured ?? false,
            paused: spawn?.state?.paused ?? false,
            suspendedReason: spawn?.state?.suspendedReason ?? null,
            suspendedAt: iso(spawn?.state?.suspendedAt ?? null),
            nextSpawnAt: iso(spawn?.state?.nextSpawnAt ?? null),
            cooldownActive: spawn?.cooldownActive ?? false,
            bagRemaining: parseShuffleBagState(spawn?.state?.bagState).remaining.length,
          },
          active: spawn?.active ? toEncounter(spawn.active) : null,
          bosses: spawn
            ? spawn.bosses.map((b) => ({
                id: b.definition.id,
                name: b.definition.name,
                status: b.definition.status,
                verdict: b.verdict,
                detail: b.detail,
                heldByCooldown: b.verdict === 'eligible' && spawn.cooldownActive,
                scheduleSummary: summaries.get(b.definition.id)?.scheduleSummary ?? '',
                timezone: b.definition.schedule.timezone,
                availability: toAvailability(b.availability),
              }))
            : [],
        });
      },
    );

    app.post(
      '/admin/bosses',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary: 'Create a boss (409 when the id is taken). The id cannot be changed afterwards',
          body: z.object({ id: z.string().max(200), boss: bossBody }),
          response: { 200: dataSchema(detailSchema), ...conflictResponse, ...commonErrorResponses },
        },
      },
      async (req) =>
        ok(req, toDetail(await translate(() => definitions.create(req.body.id, req.body.boss, actorOf(req))))),
    );

    app.get(
      '/admin/bosses/:id',
      {
        preValidation: gate('bosses.read'),
        schema: {
          tags,
          summary: 'Get one boss, with its revision, schedule state and current problems',
          params: idParams,
          response: { 200: dataSchema(detailSchema), ...notFoundResponse, ...commonErrorResponses },
        },
      },
      async (req) => {
        const boss = await definitions.get(req.params.id);
        if (!boss) throw notFound(req.params.id);
        return ok(req, toDetail(boss));
      },
    );

    app.put(
      '/admin/bosses/:id',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary:
            'Save a boss. `expectedRevision` must be the revision you loaded; a stale save is refused with ' +
            '409 BOSS_DEFINITION_STALE rather than overwriting. An encounter already drawn keeps the boss it froze',
          params: idParams,
          body: z.object({ boss: bossBody, expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const saved = await translate(() => definitions.update(req.params.id, req.body, actorOf(req)));
        if (!saved) throw notFound(req.params.id);
        return ok(req, toDetail(saved));
      },
    );

    app.put(
      '/admin/bosses/:id/status',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary:
            'Move a boss between Draft, Active and Disabled. Activating validates the whole boss; disabling always ' +
            'works. A live encounter of that boss is not affected',
          params: idParams,
          body: z.object({ status: z.enum(BOSS_DEFINITION_STATUSES), expectedRevision: revisionSchema }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const saved = await translate(() => definitions.setStatus(req.params.id, req.body, actorOf(req)));
        if (!saved) throw notFound(req.params.id);
        return ok(req, toDetail(saved));
      },
    );

    app.post(
      '/admin/bosses/:id/duplicate',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary: 'Copy a boss under a new id. The copy starts as a Draft',
          params: idParams,
          body: z.object({ id: z.string().max(200), name: z.string().max(200).optional() }),
          response: {
            200: dataSchema(detailSchema),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const copy = await translate(() => definitions.duplicate(req.params.id, req.body, actorOf(req)));
        if (!copy) throw notFound(req.params.id);
        return ok(req, toDetail(copy));
      },
    );

    app.delete(
      '/admin/bosses/:id',
      {
        preValidation: gate('bosses.write'),
        schema: {
          tags,
          summary:
            'Delete a boss that has never had an encounter and that Git does not ship (409 BOSS_DEFINITION_IN_USE ' +
            'otherwise — disable it instead)',
          params: idParams,
          querystring: z.object({ expectedRevision: z.coerce.number().int().positive() }),
          response: {
            200: dataSchema(z.object({ ok: z.boolean() })),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const deleted = await translate(() =>
          definitions.delete(req.params.id, { expectedRevision: req.query.expectedRevision }, actorOf(req)),
        );
        if (!deleted) throw notFound(req.params.id);
        return ok(req, { ok: true });
      },
    );

    app.post(
      '/admin/bosses/:id/spawn',
      {
        preValidation: gate('bosses.operate'),
        schema: {
          tags,
          summary:
            'Spawn Now: manually spawn an Active boss on this server through the normal spawn service (its ' +
            'reward table, one active encounter per server). Refused with 409 BOSS_SPAWN_REFUSED and a `details.reason`; ' +
            '`outside_schedule` may be deliberately overridden with `overrideSchedule: true`, which is audited. ' +
            'The shuffle bag and the respawn cooldown are left untouched',
          params: idParams,
          querystring: guildQuery,
          body: z.object({ overrideSchedule: z.boolean().default(false) }),
          response: {
            200: dataSchema(
              z.object({
                encounter: encounterSchema,
                scheduleOverridden: z.boolean(),
                /** `requested`: this process's scheduler was asked to announce it now. `no_scheduler`: it will be announced by whichever process runs the scheduler, on its next pass. */
                announcement: z.enum(['requested', 'no_scheduler']),
              }),
            ),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const scope = await resolveGuildScope(req, ctx, req.query.guildId);
        const svc = requireEncounters();
        const now = new Date();
        const result = await translate(async () => {
          const spawn = await svc.explainSpawn(scope.guildDbId, now);
          if (!spawn.channelConfigured) throw new BossChannelNotConfiguredError();
          const target = spawn.bosses.find((b) => b.definition.id === req.params.id);
          if (!target) throw notFound(req.params.id);
          if (spawn.active) {
            throw new BossSpawnRefusedError(
              'encounter_active',
              `This server already has an active boss encounter (${spawn.active.bossName}). End it first.`,
            );
          }
          if (target.verdict === 'not_active') {
            throw new BossSpawnRefusedError('not_active', 'Only an Active boss can be spawned. Activate it first.');
          }
          if (target.verdict === 'other_region') {
            throw new BossSpawnRefusedError(
              'other_region',
              `${target.definition.name} is not assigned to this server's region (${regionLabel(spawn.region as (typeof REGIONS)[number])}).`,
            );
          }
          try {
            return await svc.forceSpawn(scope.guildDbId, req.params.id, now, {
              ignoreSchedule: req.body.overrideSchedule,
            });
          } catch (err) {
            // Lost a race with the scheduler or another admin for the one active slot.
            if (err instanceof BossEncounterNotOpenError) {
              throw new BossSpawnRefusedError('encounter_active', 'This server already has an active boss encounter.');
            }
            throw err;
          }
        });
        const scheduleOverridden = result.scheduleOverridden === true;
        const details = {
          guildDbId: scope.guildDbId,
          discordGuildId: scope.discordGuildId,
          encounterId: result.encounter.id,
          scheduleOverridden,
        };
        await definitions.recordOperatorAction({
          bossKey: req.params.id,
          action: 'manual_spawn',
          actor: actorOf(req),
          details,
        });
        if (scheduleOverridden) {
          await definitions.recordOperatorAction({
            bossKey: req.params.id,
            action: 'schedule_override',
            actor: actorOf(req),
            details,
          });
        }
        return ok(req, {
          encounter: toEncounter(result.encounter),
          scheduleOverridden,
          announcement: requestPass(),
        });
      },
    );

    app.post(
      '/admin/bosses/encounters/:encounterId/end',
      {
        preValidation: gate('bosses.operate'),
        schema: {
          tags,
          summary:
            'End Encounter: close this server\'s active encounter now, exactly as `/waifumon-admin boss end` does. ' +
            'Everyone who committed is paid in full from the encounter\'s reward table; an encounter nobody ' +
            'joined is cancelled. 409 when it is already resolving or finished',
          params: z.object({ encounterId: z.coerce.number().int().positive() }),
          querystring: guildQuery,
          response: {
            200: dataSchema(z.object({ encounter: encounterSchema, announcement: z.enum(['requested', 'no_scheduler']) })),
            ...notFoundResponse,
            ...conflictResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const scope = await resolveGuildScope(req, ctx, req.query.guildId);
        const svc = requireEncounters();
        const encounter = await svc.getEncounter(req.params.encounterId);
        // An encounter of another server is not found, not forbidden.
        if (!encounter || encounter.guildId !== scope.guildDbId) throw new BossEncounterNotFoundError();
        const result = await svc.cancel(encounter.id, 'cancelled_admin');
        if (!result) {
          throw new ApiErrorWithDetails(
            'BOSS_SPAWN_REFUSED',
            `Boss encounter ${encounter.id} is ${encounter.status}; it cannot be ended`,
            'That encounter is already resolving or finished.',
            { reason: 'not_active' },
          );
        }
        await definitions.recordOperatorAction({
          bossKey: encounter.bossId,
          action: 'manual_end',
          actor: actorOf(req),
          details: {
            guildDbId: scope.guildDbId,
            discordGuildId: scope.discordGuildId,
            encounterId: encounter.id,
            participantCount: result.participants.length,
            outcome: result.encounter.status,
          },
        });
        return ok(req, { encounter: toEncounter(result.encounter), announcement: requestPass() });
      },
    );
  };
