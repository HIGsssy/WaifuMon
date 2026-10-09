/**
 * Portal admin API client for Boss Management.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/bosses.ts`. Boss definitions are
 * database rows; every write names the `revision` it edited, and a save that
 * lost a race comes back as a 409 `BOSS_DEFINITION_STALE` rather than
 * overwriting.
 *
 * A boss is disabled, not deleted: Delete exists for a boss that has never had
 * an encounter and that Git does not ship, and is refused
 * (`BOSS_DEFINITION_IN_USE`) otherwise.
 *
 * Activity, Diagnostics, Spawn Now and End Encounter act on the Portal
 * session's selected server.
 */
import type { QueryClient } from '@tanstack/react-query';

import { apiClient, deleteData, getData, postData, putData } from './client';

/** The server's bounds, so a typo is caught before the round trip. */
export const BOSS_ID_PATTERN = /^[a-z0-9_]+$/;
export const BOSS_ID_MAX_LENGTH = 64;
export const BOSS_NAME_MAX_LENGTH = 100;
export const BOSS_PROSE_MAX_LENGTH = 2000;
/** Ids that are path segments of the admin routes and of these pages. */
export const RESERVED_BOSS_IDS: readonly string[] = [
  'new',
  'export',
  'import',
  'validate',
  'reference',
  'activity',
  'diagnostics',
  'events',
  'schedule',
  'encounters',
  'artwork',
];

export const BOSS_STATUSES = ['draft', 'active', 'disabled'] as const;
export type BossStatus = (typeof BOSS_STATUSES)[number];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface BossIssue {
  /** `name`, `regions`, `rewardTable`, `schedule.weekly[1].windows`, `id`… */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface BossTimeWindow {
  /** `HH:MM`. */
  start: string;
  /** `HH:MM`, or `24:00` for the end of the day. At or before `start` means it ends the next day. */
  end: string;
}

export interface BossWeeklyDay {
  day: Weekday;
  /** True: the whole day; `windows` must then be empty. */
  allDay: boolean;
  windows: BossTimeWindow[];
}

export type BossDateRange =
  /** Real dates (`YYYY-MM-DD`), either end optional. */
  | { kind: 'fixed'; start: string | null; end: string | null }
  /** `MM-DD`, every year. An end before the start crosses New Year. */
  | { kind: 'yearly'; start: string; end: string };

/** Both `weekly` and `dateRange` null means always available. */
export interface BossSchedule {
  /** IANA timezone every wall-clock value is read in. */
  timezone: string;
  weekly: BossWeeklyDay[] | null;
  dateRange: BossDateRange | null;
}

export type BossScheduleMode = 'always' | 'weekly' | 'date_range' | 'weekly_date_range';

/** A half-open interval of instants (ISO). A null bound is unbounded. */
export interface BossAvailabilityWindow {
  start: string | null;
  end: string | null;
}

export interface BossAvailability {
  mode: BossScheduleMode;
  availableNow: boolean;
  currentWindow: BossAvailabilityWindow | null;
  nextWindow: BossAvailabilityWindow | null;
  /** Why there is no window now or ahead; null whenever there is one. */
  unavailableReason: string | null;
}

/** What an admin may set. The id is fixed at creation and travels beside it. */
export interface BossInput {
  name: string;
  affinity: string;
  regions: string[];
  status: BossStatus;
  artwork: string | null;
  rewardTable: string;
  scoutingText: string;
  repelledText: string;
  unchallengedText: string;
  description: string;
  schedule: BossSchedule;
}

/** A boss as an export document holds it. */
export interface BossDefinition extends BossInput {
  id: string;
}

export interface BossSummary extends BossDefinition {
  revision: number;
  /** How the row came to exist. */
  source: 'bootstrap' | 'portal' | 'import';
  /** Whether this build's `bosses.json` ships a boss of this id. */
  shipped: boolean;
  /** Encounters ever recorded for this boss, in every server. */
  encounterCount: number;
  lastEncounterAt: string | null;
  /** The schedule in words. */
  scheduleSummary: string;
  /** Where the schedule stands now. Status and cooldown are separate questions. */
  availability: BossAvailability;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface BossDetail extends BossSummary {
  /** Problems with the stored boss on this server now. */
  issues: BossIssue[];
}

export interface BossReference {
  regions: Array<{ id: string; label: string; enabled: boolean }>;
  affinities: string[];
  rewardTables: Array<{ id: string; enabled: boolean }>;
  /** Shipped artwork paths, e.g. `bosses/x.webp`. */
  artwork: string[];
  defaultTimezone: string;
  /** `tables.json` → `bossEncounters`. Shared by every boss; not editable here. */
  tuning: {
    enabled: boolean;
    scoutingMinutes: number;
    downtimeMinutesMin: number;
    downtimeMinutesMax: number;
    attacksPerParticipation: number;
  };
}

export interface BossExport {
  /** A suggested file name for the download. */
  file: string;
  document: { format: string; version: number; bosses: BossDefinition[] };
}

export type BossImportAction = 'create' | 'conflict' | 'unchanged' | 'invalid';

export interface BossImportPlanEntry {
  id: string;
  name: string | null;
  action: BossImportAction;
  /** The existing boss's revision; null when there is none. */
  currentRevision: number | null;
  /** Which fields differ from the existing boss, for a conflict. */
  changedFields: string[];
  issues: BossIssue[];
}

export interface BossImportPlan {
  entries: BossImportPlanEntry[];
  /** Problems with the package as a whole. */
  issues: BossIssue[];
  /** False while the package or any boss in it has an error. */
  canApply: boolean;
}

export type BossImportConflictMode = 'skip' | 'overwrite';

export interface BossImportResult {
  created: string[];
  overwritten: string[];
  skipped: string[];
  unchanged: string[];
}

export interface BossSchedulePreview {
  issues: BossIssue[];
  /** Null while the schedule has an error. */
  summary: string | null;
  availability: BossAvailability | null;
}

export type BossEventAction =
  | 'bootstrap'
  | 'create'
  | 'update'
  | 'status'
  | 'duplicate'
  | 'delete'
  | 'import'
  | 'manual_spawn'
  | 'schedule_override'
  | 'manual_end';

export interface BossEvent {
  id: number;
  bossKey: string;
  action: BossEventAction;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export type BossEncounterStatus = 'scheduled' | 'scouting' | 'resolving' | 'resolved' | 'cancelled';

/** One encounter of this server. Bosses have no HP pool; `totalDamage` is recorded at resolution. */
export interface BossEncounter {
  id: number;
  bossId: string;
  bossName: string;
  region: string;
  status: BossEncounterStatus;
  /** True for a manual spawn (Portal or `/waifumon-admin boss spawn`). */
  forced: boolean;
  /** When the boss was drawn. */
  scheduledAt: string;
  /** When the announcement went up and the window opened; null until then. */
  startedAt: string | null;
  /** The participation deadline; null until the window opens. */
  expiresAt: string | null;
  resolvedAt: string | null;
  participantCount: number;
  totalDamage: number;
  resolutionReason: string | null;
  rewardTable: string;
}

export interface BossActivity {
  /** False when boss encounters are switched off: nothing is scheduled anywhere. */
  featureEnabled: boolean;
  active: BossEncounter[];
  recent: BossEncounter[];
}

export type BossSchedulerHealth = 'ok' | 'stalled' | 'failing' | 'starting' | 'stopped';

export interface BossSchedulerStatus {
  health: BossSchedulerHealth;
  explanation: string;
  running: boolean;
  intervalMs: number;
  passes: number;
  lastPassStartedAt: string | null;
  lastPassCompletedAt: string | null;
  lastPassDurationMs: number | null;
  lastPassGuilds: number | null;
  lastPassUsableGuilds: number | null;
  lastError: { at: string; message: string } | null;
}

export type BossVerdict =
  'eligible' | 'not_active' | 'other_region' | 'outside_schedule' | 'reward_table_unavailable';

export interface BossDiagnosticsEntry {
  id: string;
  name: string;
  status: BossStatus;
  verdict: BossVerdict;
  detail: string | null;
  /** True for an eligible boss that is only waiting on the server's respawn cooldown. */
  heldByCooldown: boolean;
  scheduleSummary: string;
  /** The schedule's IANA timezone. */
  timezone: string;
  availability: BossAvailability;
}

export interface BossDiagnostics {
  generatedAt: string;
  featureEnabled: boolean;
  /** Null when this API process runs no boss scheduler; nothing is known about another process. */
  scheduler: BossSchedulerStatus | null;
  /** Whether the shipped roster reached the database, and what this process's last startup import reported. */
  bootstrap: {
    definitions: number;
    missingShipped: string[];
    lastRun: { at: string; error: string | null; created: string[]; heldBack: string[] } | null;
  };
  guild: {
    region: string;
    channelConfigured: boolean;
    paused: boolean;
    suspendedReason: string | null;
    suspendedAt: string | null;
    /** When the respawn cooldown ends; null means a spawn is due as soon as a boss is eligible. */
    nextSpawnAt: string | null;
    cooldownActive: boolean;
    /** Bosses still owed by the current shuffle bag. */
    bagRemaining: number;
  };
  active: BossEncounter | null;
  /** One entry per definition, each with exactly one verdict. */
  bosses: BossDiagnosticsEntry[];
}

/** `requested`: this process's scheduler announces it now. `no_scheduler`: another process will, on its next pass. */
export type BossAnnouncement = 'requested' | 'no_scheduler';

export interface BossSpawnResult {
  encounter: BossEncounter;
  scheduleOverridden: boolean;
  announcement: BossAnnouncement;
}

/** `details.reason` of a 409 `BOSS_SPAWN_REFUSED`. Only `outside_schedule` may be overridden. */
export type BossSpawnRefusal =
  | 'outside_schedule'
  | 'encounter_active'
  | 'not_active'
  | 'other_region'
  | 'reward_table_unavailable'
  | 'feature_disabled';

/** `details` of a 409 `BOSS_DEFINITION_STALE`. */
export interface BossStaleDetails {
  expectedRevision?: number;
  currentRevision?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

/** `details` of a 409 `BOSS_DEFINITION_IN_USE`. */
export interface BossInUseDetails {
  encounterCount?: number;
  shipped?: boolean;
}

export const BOSSES_QUERY_KEY = ['admin', 'bosses'] as const;

const base = '/v1/admin/bosses';
const bossUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

/** Call after any boss write, spawn or end: every boss view is refreshed. */
export function invalidateBossQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: BOSSES_QUERY_KEY });
}

export function listBosses(signal?: AbortSignal): Promise<{ bosses: BossSummary[] }> {
  return getData(base, opts(signal));
}

export function getBossReference(signal?: AbortSignal): Promise<BossReference> {
  return getData(`${base}/reference`, opts(signal));
}

/** Bytes of one shipped boss artwork file, for a thumbnail or preview. 404 when no file is there. */
export async function bossArtworkBlob(path: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/artwork`, {
    params: { path },
    responseType: 'blob',
  });
  return response.data;
}

export function exportBosses(): Promise<BossExport> {
  return getData(`${base}/export`);
}

/** Dry run of an import. Writes nothing. */
export function planBossImport(document: unknown): Promise<BossImportPlan> {
  return postData(`${base}/import/plan`, { document });
}

/**
 * Apply an import. An existing boss is replaced only with `overwrite`, and
 * only at the revision named in `expectedRevisions` (409 otherwise).
 */
export function applyBossImport(
  document: unknown,
  conflicts: BossImportConflictMode,
  expectedRevisions?: Record<string, number>,
): Promise<BossImportResult> {
  return postData(`${base}/import/apply`, {
    document,
    conflicts,
    ...(expectedRevisions ? { expectedRevisions } : {}),
  });
}

/** Dry run: every issue creating (`creating`) or saving this boss would raise. Writes nothing. */
export function validateBoss(
  id: string,
  boss: BossInput,
  creating: boolean,
  signal?: AbortSignal,
): Promise<{ issues: BossIssue[] }> {
  return postData(`${base}/validate`, { id, boss, creating }, opts(signal));
}

/** Check a schedule and describe it. Writes nothing. */
export function previewBossSchedule(
  schedule: BossSchedule,
  signal?: AbortSignal,
): Promise<BossSchedulePreview> {
  return postData(`${base}/schedule/preview`, { schedule }, opts(signal));
}

/** The audit trail, newest first; for one boss when `bossId` is given. */
export function listBossEvents(
  query: { bossId?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ events: BossEvent[] }> {
  return getData(`${base}/events`, { params: query, ...opts(signal) });
}

export function getBossActivity(signal?: AbortSignal): Promise<BossActivity> {
  return getData(`${base}/activity`, opts(signal));
}

export function getBossDiagnostics(signal?: AbortSignal): Promise<BossDiagnostics> {
  return getData(`${base}/diagnostics`, opts(signal));
}

/** Refused with 400 `BOSS_DEFINITION_INVALID` (details.issues) or 409 `BOSS_DEFINITION_KEY_TAKEN`. */
export function createBoss(id: string, boss: BossInput): Promise<BossDetail> {
  return postData(base, { id, boss });
}

export function getBoss(id: string, signal?: AbortSignal): Promise<BossDetail> {
  return getData(bossUrl(id), opts(signal));
}

export function updateBoss(
  id: string,
  boss: BossInput,
  expectedRevision: number,
): Promise<BossDetail> {
  return putData(bossUrl(id), { boss, expectedRevision });
}

/** Activating validates the whole boss (400 `BOSS_DEFINITION_INVALID`); disabling always works. */
export function setBossStatus(
  id: string,
  status: BossStatus,
  expectedRevision: number,
): Promise<BossDetail> {
  return putData(`${bossUrl(id)}/status`, { status, expectedRevision });
}

/** A copy under a new id. It starts as a Draft. */
export function duplicateBoss(
  sourceId: string,
  input: { id: string; name?: string },
): Promise<BossDetail> {
  return postData(`${bossUrl(sourceId)}/duplicate`, input);
}

/** Refused with 409 `BOSS_DEFINITION_IN_USE` (details.encounterCount, details.shipped). */
export function deleteBoss(id: string, expectedRevision: number): Promise<{ ok: boolean }> {
  return deleteData(bossUrl(id), { params: { expectedRevision } });
}

/**
 * Spawn Now. Refused with 409 `BOSS_SPAWN_REFUSED` and a `details.reason`;
 * `outside_schedule` may be retried with `overrideSchedule: true`, which is
 * audited. 404 `BOSS_CHANNEL_NOT_CONFIGURED` when the server has no boss channel.
 */
export function spawnBoss(id: string, overrideSchedule: boolean): Promise<BossSpawnResult> {
  return postData(`${bossUrl(id)}/spawn`, { overrideSchedule });
}

/** End Encounter. Everyone who committed is paid in full; an encounter nobody joined is cancelled. */
export function endBossEncounter(
  encounterId: number,
): Promise<{ encounter: BossEncounter; announcement: BossAnnouncement }> {
  return postData(`${base}/encounters/${encounterId}/end`, {});
}
