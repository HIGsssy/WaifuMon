/**
 * Pure helpers for the Boss Management pages: the form an editor holds, the
 * schedule form and the schedule object it produces, the bounds the server
 * enforces (checked here first), and the readable forms of windows, verdicts
 * and audit events.
 */
import {
  BOSS_ID_MAX_LENGTH,
  BOSS_ID_PATTERN,
  BOSS_NAME_MAX_LENGTH,
  BOSS_PROSE_MAX_LENGTH,
  RESERVED_BOSS_IDS,
  WEEKDAYS,
  type BossAvailability,
  type BossAvailabilityWindow,
  type BossDateRange,
  type BossDetail,
  type BossEncounter,
  type BossEvent,
  type BossInput,
  type BossIssue,
  type BossSchedule,
  type BossScheduleMode,
  type BossSchedulerHealth,
  type BossStatus,
  type BossSummary,
  type BossTimeWindow,
  type BossVerdict,
  type Weekday,
} from '@/api/adminBosses';

export const BOSSES_PATH = '/admin/bosses';
export const BOSS_ACTIVITY_PATH = '/admin/bosses/activity';
export const bossPath = (id: string) => `${BOSSES_PATH}/${encodeURIComponent(id)}`;
/** The Reward Tables admin page for one boss reward table. */
export const rewardTablePath = (id: string) =>
  `/admin/reward-tables/boss/${encodeURIComponent(id)}`;

export const STATUS_LABELS: Record<BossStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  disabled: 'Disabled',
};

/** `caregiver` → `Caregiver`; an id the Portal has no label for, in words. */
export const titleCase = (value: string) =>
  value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/** Whether `boss` matches what was typed: its name or its id. */
export function matchesSearch(boss: Pick<BossSummary, 'id' | 'name'>, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') return true;
  return [boss.name, boss.id].some((value) => value.toLowerCase().includes(needle));
}

export function idError(id: string): string | null {
  if (id === '') return 'An id is required.';
  if (id.length > BOSS_ID_MAX_LENGTH)
    return `The id can be at most ${BOSS_ID_MAX_LENGTH} characters.`;
  if (!BOSS_ID_PATTERN.test(id))
    return 'The id must be lowercase snake_case — letters, digits and underscores.';
  return RESERVED_BOSS_IDS.includes(id) ? `“${id}” is reserved — choose another id.` : null;
}

/** The issues at `path` exactly, or beneath it (`schedule` also shows `schedule.weekly[0]`). */
export function issuesAt(issues: readonly BossIssue[], path: string): BossIssue[] {
  return issues.filter(
    (i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`),
  );
}

/** The same issue reported twice (stored and refused, or refused and previewed) is shown once. */
export function uniqueIssues(issues: readonly BossIssue[]): BossIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const id = `${i.path}:${i.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Hands the browser a JSON document to save under `filename`. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── the schedule form ───────────────────────────────────────────────────────

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const SCHEDULE_MODES: readonly BossScheduleMode[] = [
  'always',
  'weekly',
  'date_range',
  'weekly_date_range',
];
export const SCHEDULE_MODE_LABELS: Record<BossScheduleMode, string> = {
  always: 'Always available',
  weekly: 'Weekly schedule',
  date_range: 'Date range',
  weekly_date_range: 'Weekly + date range',
};

export const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface DayForm {
  enabled: boolean;
  allDay: boolean;
  windows: BossTimeWindow[];
}

/**
 * What the schedule editor holds. Richer than the schedule: switching mode or
 * unticking a day keeps what was typed, so switching back does not lose it.
 * {@link scheduleOf} decides what is actually sent.
 */
export interface ScheduleForm {
  mode: BossScheduleMode;
  timezone: string;
  days: Record<Weekday, DayForm>;
  /** The date range repeats every year (`MM-DD`) rather than naming real dates. */
  yearly: boolean;
  /** `YYYY-MM-DD`, or empty for no bound. */
  fixedStart: string;
  fixedEnd: string;
  /** `MM-DD`. */
  yearlyStart: string;
  yearlyEnd: string;
}

/** The window a day is given when "all day" is switched off. */
export const DEFAULT_WINDOW: BossTimeWindow = { start: '18:00', end: '22:00' };

const usesWeekly = (mode: BossScheduleMode) => mode === 'weekly' || mode === 'weekly_date_range';
const usesDateRange = (mode: BossScheduleMode) =>
  mode === 'date_range' || mode === 'weekly_date_range';
export { usesDateRange, usesWeekly };

export function scheduleModeOf(schedule: Pick<BossSchedule, 'weekly' | 'dateRange'>) {
  if (schedule.weekly && schedule.dateRange) return 'weekly_date_range' as const;
  if (schedule.weekly) return 'weekly' as const;
  if (schedule.dateRange) return 'date_range' as const;
  return 'always' as const;
}

export function scheduleFormOf(schedule: BossSchedule): ScheduleForm {
  const days = Object.fromEntries(
    WEEKDAYS.map((day) => {
      const rule = schedule.weekly?.find((r) => r.day === day);
      return [
        day,
        rule
          ? { enabled: true, allDay: rule.allDay, windows: rule.windows.map((w) => ({ ...w })) }
          : { enabled: false, allDay: true, windows: [] },
      ];
    }),
  ) as Record<Weekday, DayForm>;
  const range = schedule.dateRange;
  return {
    mode: scheduleModeOf(schedule),
    timezone: schedule.timezone,
    days,
    yearly: range?.kind === 'yearly',
    fixedStart: range?.kind === 'fixed' ? (range.start ?? '') : '',
    fixedEnd: range?.kind === 'fixed' ? (range.end ?? '') : '',
    yearlyStart: range?.kind === 'yearly' ? range.start : '01-01',
    yearlyEnd: range?.kind === 'yearly' ? range.end : '12-31',
  };
}

export const alwaysAvailable = (timezone: string): BossSchedule => ({
  timezone,
  weekly: null,
  dateRange: null,
});

/** The days a weekly rule is sent for, in the order they are sent (Monday first). */
export const enabledDays = (form: ScheduleForm): Weekday[] =>
  WEEKDAYS.filter((day) => form.days[day].enabled);

/** The schedule object the form stands for — exactly what is saved and previewed. */
export function scheduleOf(form: ScheduleForm): BossSchedule {
  const dateRange: BossDateRange = form.yearly
    ? { kind: 'yearly', start: form.yearlyStart, end: form.yearlyEnd }
    : { kind: 'fixed', start: form.fixedStart || null, end: form.fixedEnd || null };
  return {
    timezone: form.timezone.trim(),
    weekly: usesWeekly(form.mode)
      ? enabledDays(form).map((day) => {
          const rule = form.days[day];
          return {
            day,
            allDay: rule.allDay,
            windows: rule.allDay
              ? []
              : rule.windows.map((w) => ({ start: w.start.trim(), end: w.end.trim() })),
          };
        })
      : null,
    dateRange: usesDateRange(form.mode) ? dateRange : null,
  };
}

const TIME = /^(\d{2}):(\d{2})$/;
const minutesOf = (time: string): number | null => {
  const match = TIME.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** A window whose end is at or before its start runs into the next day. */
export function endsNextDay(window: BossTimeWindow): boolean {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  return start !== null && end !== null && end <= start;
}

/** `MM-DD` ⇄ a month and a day, for the yearly range's two selects. */
export function yearlyParts(value: string): { month: number; day: number } {
  const [month, day] = value.split('-').map(Number);
  return { month: month || 1, day: day || 1 };
}
export const yearlyDate = (month: number, day: number) =>
  `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * Schedule issues for one weekday row. The server names a rule by its index
 * in the `weekly` array that was sent, which is the nth *enabled* day.
 */
export function dayIssues(
  issues: readonly BossIssue[],
  form: ScheduleForm,
  day: Weekday,
): BossIssue[] {
  const index = enabledDays(form).indexOf(day);
  return index === -1 ? [] : issuesAt(issues, `weekly[${index}]`);
}

/** Issues about the weekly rule as a whole (e.g. no weekday chosen). */
export const weeklyIssues = (issues: readonly BossIssue[]) =>
  issues.filter((i) => i.path === 'weekly');

/** `schedule.weekly[0].windows` → `weekly[0].windows`; the bare `schedule` path becomes ``. */
export function scheduleIssuesOf(issues: readonly BossIssue[]): BossIssue[] {
  return issuesAt(issues, 'schedule').map((i) => ({
    ...i,
    path: i.path.replace(/^schedule\.?/, ''),
  }));
}

// ── instants, in words ──────────────────────────────────────────────────────

/**
 * An instant as the wall clock of `timeZone` reads it: `Fri, Oct 30, 2026, 18:00`.
 * A zone the browser does not know falls back to UTC, and says so.
 */
export function formatInZone(iso: string, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  try {
    return format(timeZone);
  } catch {
    return `${format('UTC')} UTC`;
  }
}

/** A window in the schedule's own zone: `Fri, Oct 30, 2026, 18:00 – Fri, Oct 30, 2026, 23:00`. */
export function formatWindow(window: BossAvailabilityWindow, timeZone: string): string {
  if (window.start === null && window.end === null) return 'No limits — always open';
  if (window.start === null) return `Until ${formatInZone(window.end!, timeZone)}`;
  if (window.end === null)
    return `From ${formatInZone(window.start, timeZone)}, with no end in sight`;
  return `${formatInZone(window.start, timeZone)} – ${formatInZone(window.end, timeZone)}`;
}

/** One line on where a schedule stands now, for a list row. */
export function nextWindowLine(availability: BossAvailability, timeZone: string): string {
  if (availability.mode === 'always') return 'No schedule limits';
  if (availability.availableNow) {
    const end = availability.currentWindow?.end ?? null;
    return end
      ? `Open until ${formatInZone(end, timeZone)} (${timeZone})`
      : 'Open, no end in sight';
  }
  const next = availability.nextWindow?.start ?? null;
  if (next) return `Next window ${formatInZone(next, timeZone)} (${timeZone})`;
  return availability.unavailableReason ?? 'No upcoming window';
}

/** An instant in the viewer's own zone, for activity and audit rows. */
export const formatLocal = (iso: string | null) =>
  iso === null
    ? '—'
    : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ── the boss form ───────────────────────────────────────────────────────────

export interface BossForm {
  name: string;
  description: string;
  /** A shipped artwork path, or empty for none. */
  artwork: string;
  status: BossStatus;
  regions: string[];
  affinity: string;
  /** A boss reward table id, or empty for none yet. */
  rewardTable: string;
  scoutingText: string;
  repelledText: string;
  unchallengedText: string;
  schedule: ScheduleForm;
}

export function blankBossForm(reference: {
  defaultTimezone: string;
  affinities: readonly string[];
}): BossForm {
  return {
    name: '',
    description: '',
    artwork: '',
    status: 'draft',
    regions: [],
    affinity: reference.affinities[0] ?? '',
    rewardTable: '',
    scoutingText: '',
    repelledText: '',
    unchallengedText: '',
    schedule: scheduleFormOf(alwaysAvailable(reference.defaultTimezone)),
  };
}

export function formOf(boss: BossDetail): BossForm {
  return {
    name: boss.name,
    description: boss.description,
    artwork: boss.artwork ?? '',
    status: boss.status,
    regions: boss.regions,
    affinity: boss.affinity,
    rewardTable: boss.rewardTable,
    scoutingText: boss.scoutingText,
    repelledText: boss.repelledText,
    unchallengedText: boss.unchallengedText,
    schedule: scheduleFormOf(boss.schedule),
  };
}

/** What Create and Save send. */
export function inputOf(form: BossForm): BossInput {
  return {
    name: form.name.trim(),
    affinity: form.affinity,
    regions: form.regions,
    status: form.status,
    artwork: form.artwork.trim() === '' ? null : form.artwork.trim(),
    rewardTable: form.rewardTable,
    scoutingText: form.scoutingText.trim(),
    repelledText: form.repelledText.trim(),
    unchallengedText: form.unchallengedText.trim(),
    description: form.description.trim(),
    schedule: scheduleOf(form.schedule),
  };
}

export const PROSE_FIELDS = [
  ['scoutingText', 'Scouting text', 'Shown when the boss is announced and players can commit.'],
  ['repelledText', 'Repelled text', 'Shown when the encounter ends with damage dealt.'],
  ['unchallengedText', 'Unchallenged text', 'Shown when the encounter ends and nobody fought.'],
] as const;

/** Problems found before asking the server, keyed like the server's own issue paths. */
export function formErrors(form: BossForm): BossIssue[] {
  const issues: BossIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  if (form.name.trim() === '') add('name', 'A name is required.');
  else if (form.name.trim().length > BOSS_NAME_MAX_LENGTH)
    add('name', `The name can be at most ${BOSS_NAME_MAX_LENGTH} characters.`);
  const prose = [['description', 'Description'], ...PROSE_FIELDS] as const;
  for (const [field, label] of prose) {
    if (form[field].trim().length > BOSS_PROSE_MAX_LENGTH)
      add(
        field,
        `${label} can be at most ${BOSS_PROSE_MAX_LENGTH.toLocaleString('en-US')} characters.`,
      );
  }
  if (form.schedule.timezone.trim() === '') add('schedule.timezone', 'A timezone is required.');
  return issues;
}

// ── activity and diagnostics ────────────────────────────────────────────────

export const ENCOUNTER_STATUS_LABELS: Record<BossEncounter['status'], string> = {
  scheduled: 'Scheduled',
  scouting: 'Open',
  resolving: 'Resolving',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

/** Only an encounter that has not started resolving can be ended by hand. */
export const canEndEncounter = (encounter: BossEncounter) =>
  encounter.status === 'scheduled' || encounter.status === 'scouting';

export const SCHEDULER_HEALTH_LABELS: Record<BossSchedulerHealth, string> = {
  ok: 'Healthy',
  stalled: 'Stalled',
  failing: 'Failing',
  starting: 'Starting',
  stopped: 'Stopped',
};

export const VERDICTS: readonly BossVerdict[] = [
  'eligible',
  'outside_schedule',
  'not_active',
  'other_region',
  'reward_table_unavailable',
];
export const VERDICT_LABELS: Record<BossVerdict, string> = {
  eligible: 'Eligible',
  outside_schedule: 'Outside schedule',
  not_active: 'Draft or disabled',
  other_region: 'Other region',
  reward_table_unavailable: 'Reward table unavailable',
};

// ── the audit trail ─────────────────────────────────────────────────────────

const EVENT_LABELS: Record<BossEvent['action'], string> = {
  bootstrap: 'Added from the shipped content',
  create: 'Created',
  update: 'Edited',
  status: 'Status changed',
  duplicate: 'Duplicated',
  delete: 'Deleted',
  import: 'Imported',
  manual_spawn: 'Spawned manually',
  schedule_override: 'Schedule overridden for a manual spawn',
  manual_end: 'Encounter ended manually',
};

const isStatus = (value: unknown): value is BossStatus =>
  typeof value === 'string' && value in STATUS_LABELS;

/** One audit event in admin words, with whatever its details add. */
export function describeEvent(event: BossEvent): string {
  const label = EVENT_LABELS[event.action] ?? titleCase(event.action);
  const d = event.details;
  const changed = Array.isArray(d.changed) ? d.changed.filter((f) => typeof f === 'string') : [];
  if (event.action === 'status' && isStatus(d.from) && isStatus(d.to))
    return `${label}: ${STATUS_LABELS[d.from]} → ${STATUS_LABELS[d.to]}`;
  if (event.action === 'duplicate' && typeof d.from === 'string') return `${label} from ${d.from}`;
  if (event.action === 'import' && typeof d.result === 'string')
    return `${label} (${d.result}${changed.length > 0 ? `: ${changed.join(', ')}` : ''})`;
  if (event.action === 'update' && changed.length > 0) return `${label}: ${changed.join(', ')}`;
  if (typeof d.encounterId === 'number') return `${label} — encounter #${d.encounterId}`;
  return label;
}

/** A boss id suggested from its name: lowercase snake_case, at most 64 characters. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
}
