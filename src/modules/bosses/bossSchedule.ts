/**
 * Boss availability schedules — pure, timezone-aware, and the only place that
 * turns "Friday 18:00 in Toronto" into an instant.
 *
 * A schedule answers one question for the spawner: *may this boss be drawn
 * right now?* It never spawns anything, never ends an encounter and never
 * touches a cooldown. An encounter that is already live runs to its own
 * deadline whether or not the window that allowed it has since closed.
 *
 * Three shapes, all of one object:
 *
 *   - **always** — `weekly` and `dateRange` both null;
 *   - **weekly** — some weekdays, each all day or one or more `HH:MM` windows;
 *   - **date range** — a span of calendar dates, either `fixed` (real dates,
 *     one year only, either end optional) or `yearly` (`MM-DD`, every year).
 *
 * The two combine: with both set, a moment must fall on a date inside the
 * range *and* inside that day's weekly rule. A window belongs to the day it
 * **starts** on, so "Oct 31, 22:00–02:00" runs until 02:00 on Nov 1 even
 * though Nov 1 is outside the range.
 *
 * Every wall-clock value is read in the schedule's own IANA `timezone`. The
 * server's local zone is never consulted. Windows are computed by converting
 * their local endpoints to instants one at a time, so a 23- or 25-hour day is
 * simply a shorter or longer interval:
 *
 *   - a local time that does not exist (spring forward) is moved later by the
 *     size of the gap;
 *   - a local time that happens twice (fall back) means its first occurrence.
 *
 * Window starts are inclusive and ends exclusive. `24:00` is a legal end and
 * means the end of that day.
 */
import { z } from 'zod';
import { isValidTimezone } from '../../shared/time';

export const DEFAULT_BOSS_SCHEDULE_TIMEZONE = 'America/Toronto';

/** Monday first, the order the editor lists them in. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const startTime = z.string().regex(TIME_PATTERN, 'must be a 24-hour time, HH:MM');
const endTime = z
  .string()
  .refine((v) => TIME_PATTERN.test(v) || v === '24:00', 'must be a 24-hour time, HH:MM (24:00 for the end of the day)');

const TimeWindowSchema = z.object({ start: startTime, end: endTime }).strict();

const WeeklyDaySchema = z
  .object({
    day: z.enum(WEEKDAYS),
    /** True: the whole day. `windows` is then ignored and must be empty. */
    allDay: z.boolean().default(false),
    windows: z.array(TimeWindowSchema).max(12).default([]),
  })
  .strict();

const FIXED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEARLY_DATE = /^\d{2}-\d{2}$/;

const DateRangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fixed'),
      /** First day, inclusive (`YYYY-MM-DD`). Null: no start. */
      start: z.string().regex(FIXED_DATE, 'must be a date, YYYY-MM-DD').nullable().default(null),
      /** Last day, inclusive. Null: no end. */
      end: z.string().regex(FIXED_DATE, 'must be a date, YYYY-MM-DD').nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal('yearly'),
      /** First day, inclusive (`MM-DD`), every year. */
      start: z.string().regex(YEARLY_DATE, 'must be a month and day, MM-DD'),
      /** Last day, inclusive. Earlier than `start` means the range crosses New Year. */
      end: z.string().regex(YEARLY_DATE, 'must be a month and day, MM-DD'),
    })
    .strict(),
]);

export const BossScheduleSchema = z
  .object({
    timezone: z.string().min(1).default(DEFAULT_BOSS_SCHEDULE_TIMEZONE),
    weekly: z.array(WeeklyDaySchema).nullable().default(null),
    dateRange: DateRangeSchema.nullable().default(null),
  })
  .strict();

export type BossSchedule = z.infer<typeof BossScheduleSchema>;
export type BossScheduleInput = z.input<typeof BossScheduleSchema>;
export type BossScheduleDateRange = NonNullable<BossSchedule['dateRange']>;
export type BossScheduleMode = 'always' | 'weekly' | 'date_range' | 'weekly_date_range';

export const ALWAYS_AVAILABLE: BossSchedule = {
  timezone: DEFAULT_BOSS_SCHEDULE_TIMEZONE,
  weekly: null,
  dateRange: null,
};

export function scheduleMode(schedule: BossSchedule): BossScheduleMode {
  if (schedule.weekly && schedule.dateRange) return 'weekly_date_range';
  if (schedule.weekly) return 'weekly';
  if (schedule.dateRange) return 'date_range';
  return 'always';
}

// ── calendar arithmetic (no timezone involved) ──────────────────────────────

/** A calendar date with no zone. `month` is 1–12. */
interface Ymd {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;
const ymdKey = (d: Ymd): number => d.year * 10_000 + d.month * 100 + d.day;
const mdKey = (d: { month: number; day: number }): number => d.month * 100 + d.day;

function addDays(d: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function weekdayOf(d: Ymd): Weekday {
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7]!;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseFixedDate(value: string): Ymd | null {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function parseYearlyDate(value: string): { month: number; day: number } | null {
  const [month, day] = value.split('-').map(Number) as [number, number];
  // 2000 is a leap year: Feb 29 is a legal yearly date (it only happens in leap years).
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) return null;
  return { month, day };
}

const minutesOf = (time: string): number => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

// ── timezone conversion ─────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock reading of `instantMs` in `timeZone`, as if it were UTC. */
function wallClockAsUtc(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
}

const offsetAt = (instantMs: number, timeZone: string): number =>
  wallClockAsUtc(instantMs, timeZone) - Math.floor(instantMs / 1000) * 1000;

/** The calendar date and minute-of-day of `instant` in `timeZone`. */
export function zonedDateOf(instant: Date, timeZone: string): Ymd & { minuteOfDay: number } {
  const wall = new Date(wallClockAsUtc(instant.getTime(), timeZone));
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    minuteOfDay: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

/**
 * The instant at which `timeZone` reads `date` + `minuteOfDay` (which may be
 * 1440, the end of the day).
 *
 * The zone's offset is sampled either side of the target. Where both give the
 * same answer there is no transition nearby. Where the local time happens
 * twice the earlier instant is returned; where it never happens the later
 * candidate is, which is the requested time pushed past the gap.
 */
export function zonedTimeToUtc(date: Ymd, minuteOfDay: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const before = naive - offsetAt(naive - DAY_MS / 2, timeZone);
  const after = naive - offsetAt(naive + DAY_MS / 2, timeZone);
  if (before === after) return new Date(before);
  const valid = [before, after].filter((t) => wallClockAsUtc(t, timeZone) === naive);
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(before, after));
}

// ── validation ──────────────────────────────────────────────────────────────

export interface BossScheduleIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

const zodPath = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');

/**
 * Parse and check a schedule. Shape problems, an unknown timezone, dates that
 * do not exist and a weekly rule that allows nothing are errors; overlapping
 * windows are only a warning, because they are merged when read.
 */
export function validateBossSchedule(input: unknown): { schedule: BossSchedule | null; issues: BossScheduleIssue[] } {
  const parsed = BossScheduleSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      schedule: null,
      issues: parsed.error.issues.map((i) => ({ path: zodPath(i.path), message: i.message, severity: 'error' })),
    };
  }
  const schedule = parsed.data;
  const issues: BossScheduleIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, message, severity: 'error' });

  if (!isValidTimezone(schedule.timezone)) {
    error('timezone', `"${schedule.timezone}" is not a known IANA timezone (for example America/Toronto)`);
  }

  if (schedule.weekly) {
    if (schedule.weekly.length === 0) {
      error('weekly', 'choose at least one weekday, or switch the schedule to always available');
    }
    const seen = new Set<Weekday>();
    for (const [index, rule] of schedule.weekly.entries()) {
      const at = `weekly[${index}]`;
      if (seen.has(rule.day)) error(`${at}.day`, `${WEEKDAY_LABELS[rule.day]} is listed twice`);
      seen.add(rule.day);
      if (rule.allDay) {
        if (rule.windows.length > 0) error(`${at}.windows`, 'an all-day rule cannot also list time windows');
        continue;
      }
      if (rule.windows.length === 0) {
        error(`${at}.windows`, `${WEEKDAY_LABELS[rule.day]} needs at least one time window, or all day`);
      }
      const spans: [number, number][] = [];
      for (const [w, window] of rule.windows.entries()) {
        const start = minutesOf(window.start);
        const end = minutesOf(window.end);
        if (start === end) {
          error(`${at}.windows[${w}]`, 'a window cannot start and end at the same time — use all day for 24 hours');
          continue;
        }
        // A window that ends at or before its start runs into the next day.
        spans.push([start, end > start ? end : end + 1440]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      if (spans.some((span, i) => i > 0 && span[0] < spans[i - 1]![1])) {
        issues.push({
          path: `${at}.windows`,
          message: `${WEEKDAY_LABELS[rule.day]} has overlapping windows; they are treated as one`,
          severity: 'warning',
        });
      }
    }
  }

  const range = schedule.dateRange;
  if (range?.kind === 'fixed') {
    const start = range.start ? parseFixedDate(range.start) : null;
    const end = range.end ? parseFixedDate(range.end) : null;
    if (range.start && !start) error('dateRange.start', `${range.start} is not a real date`);
    if (range.end && !end) error('dateRange.end', `${range.end} is not a real date`);
    if (!range.start && !range.end) error('dateRange', 'set a start date, an end date, or both');
    if (start && end && ymdKey(start) > ymdKey(end)) {
      error('dateRange.end', 'the end date is before the start date');
    }
  } else if (range?.kind === 'yearly') {
    if (!parseYearlyDate(range.start)) error('dateRange.start', `${range.start} is not a real month and day`);
    if (!parseYearlyDate(range.end)) error('dateRange.end', `${range.end} is not a real month and day`);
  }

  return { schedule: issues.some((i) => i.severity === 'error') ? null : schedule, issues };
}

// ── evaluation ──────────────────────────────────────────────────────────────

/** A half-open interval `[start, end)`. A null bound is unbounded. */
export interface AvailabilityWindow {
  start: Date | null;
  end: Date | null;
}

export interface BossAvailability {
  mode: BossScheduleMode;
  /** Whether the boss may be drawn at `now`, as far as the schedule goes. */
  availableNow: boolean;
  /** The window `now` falls in. Null when closed. */
  currentWindow: AvailabilityWindow | null;
  /** The next window that opens after `now`. Null when there is none in sight. */
  nextWindow: AvailabilityWindow | null;
  /** Why there is no window now or ahead; null whenever there is one. */
  unavailableReason: string | null;
}

/**
 * How many days of windows are searched: over a year, so a yearly range is
 * always found. The search starts today — or at the first day of a fixed date
 * range that has not begun, however far off that is, so an event announced
 * two years ahead still has a next window.
 */
const HORIZON_DAYS = 400;

function dateInRange(date: Ymd, range: BossScheduleDateRange | null): boolean {
  if (!range) return true;
  if (range.kind === 'fixed') {
    const start = range.start ? parseFixedDate(range.start) : null;
    const end = range.end ? parseFixedDate(range.end) : null;
    return (!start || ymdKey(date) >= ymdKey(start)) && (!end || ymdKey(date) <= ymdKey(end));
  }
  const start = parseYearlyDate(range.start);
  const end = parseYearlyDate(range.end);
  if (!start || !end) return false;
  const key = mdKey(date);
  return mdKey(start) <= mdKey(end)
    ? key >= mdKey(start) && key <= mdKey(end)
    : key >= mdKey(start) || key <= mdKey(end);
}

/** The minute spans (from that day's midnight; may exceed 1440) a date allows. */
function spansFor(date: Ymd, schedule: BossSchedule): [number, number][] {
  if (!dateInRange(date, schedule.dateRange)) return [];
  if (!schedule.weekly) return [[0, 1440]];
  const rule = schedule.weekly.find((r) => r.day === weekdayOf(date));
  if (!rule) return [];
  if (rule.allDay) return [[0, 1440]];
  return rule.windows
    .map((w): [number, number] => {
      const start = minutesOf(w.start);
      const end = minutesOf(w.end);
      return [start, end > start ? end : end + 1440];
    })
    .filter(([start, end]) => end > start);
}

/**
 * Every window in the search span, merged and in order, plus the instant the
 * span ends (a window reaching it has no end in sight).
 */
function windowsFrom(
  schedule: BossSchedule,
  now: Date,
): { windows: { start: number; end: number }[]; searchedUntil: number } {
  const today = zonedDateOf(now, schedule.timezone);
  const range = schedule.dateRange;
  const rangeStart = range?.kind === 'fixed' && range.start ? parseFixedDate(range.start) : null;
  const origin = rangeStart && ymdKey(rangeStart) > ymdKey(today) ? rangeStart : today;
  const raw: { start: number; end: number }[] = [];
  // The day before is included for a window that started then and is still open.
  for (let offset = -1; offset <= HORIZON_DAYS; offset += 1) {
    const date = addDays(origin, offset);
    for (const [from, to] of spansFor(date, schedule)) {
      const start = zonedTimeToUtc(date, from, schedule.timezone).getTime();
      const end =
        to <= 1440
          ? zonedTimeToUtc(to === 1440 ? addDays(date, 1) : date, to === 1440 ? 0 : to, schedule.timezone).getTime()
          : zonedTimeToUtc(addDays(date, 1), to - 1440, schedule.timezone).getTime();
      if (end > start) raw.push({ start, end });
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of raw) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return {
    windows: merged,
    searchedUntil: zonedTimeToUtc(addDays(origin, HORIZON_DAYS - 1), 0, schedule.timezone).getTime(),
  };
}

function noWindowReason(schedule: BossSchedule, now: Date): string {
  const range = schedule.dateRange;
  if (range?.kind === 'fixed' && range.end) {
    const end = parseFixedDate(range.end);
    const today = zonedDateOf(now, schedule.timezone);
    if (end && ymdKey(end) < ymdKey(today)) {
      return `The date range ended on ${range.end}, so this boss will not become available again.`;
    }
  }
  if (schedule.weekly && range) {
    return range.kind === 'fixed'
      ? 'No selected weekday falls inside the date range.'
      : 'No selected weekday falls inside the date range in the next year.';
  }
  return 'This schedule has no availability window in the next year.';
}

/**
 * Where `now` stands against a schedule: open or closed, the window it is in,
 * and the next one to open.
 *
 * An invalid schedule is treated as closed with the reason given — a boss
 * whose stored schedule cannot be read must not spawn on a guess.
 */
export function evaluateBossSchedule(schedule: BossSchedule, now: Date): BossAvailability {
  const mode = scheduleMode(schedule);
  if (mode === 'always') {
    return {
      mode,
      availableNow: true,
      currentWindow: { start: null, end: null },
      nextWindow: null,
      unavailableReason: null,
    };
  }
  if (validateBossSchedule(schedule).schedule === null) {
    return {
      mode,
      availableNow: false,
      currentWindow: null,
      nextWindow: null,
      unavailableReason: 'The schedule is not valid, so this boss is treated as unavailable.',
    };
  }

  const at = now.getTime();
  const searched = windowsFrom(schedule, now);
  const windows = searched.windows.filter((w) => w.end > at);
  const view = (w: { start: number; end: number }): AvailabilityWindow => ({
    start: new Date(w.start),
    // A window still open at the edge of the search has no end in sight.
    end: w.end >= searched.searchedUntil ? null : new Date(w.end),
  });

  const current = windows[0] && windows[0].start <= at ? windows[0] : null;
  const next = windows.find((w) => w.start > at) ?? null;
  return {
    mode,
    availableNow: current !== null,
    currentWindow: current ? view(current) : null,
    nextWindow: next ? view(next) : null,
    unavailableReason: current || next ? null : noWindowReason(schedule, now),
  };
}

/** Whether the schedule allows a spawn at `now`. Cooldowns and status are separate questions. */
export function isBossAvailableAt(schedule: BossSchedule, now: Date): boolean {
  return evaluateBossSchedule(schedule, now).availableNow;
}

// ── description ─────────────────────────────────────────────────────────────

function describeYearly(value: string): string {
  const parsed = parseYearlyDate(value);
  return parsed ? `${MONTH_LABELS[parsed.month - 1]} ${parsed.day}` : value;
}

function describeFixed(value: string): string {
  const parsed = parseFixedDate(value);
  return parsed ? `${MONTH_LABELS[parsed.month - 1]} ${parsed.day}, ${parsed.year}` : value;
}

/** The schedule in admin words: `Fri 18:00–23:59, Sat all day · Oct 25 – Oct 31, every year (America/Toronto)`. */
export function describeBossSchedule(schedule: BossSchedule): string {
  const parts: string[] = [];
  if (schedule.weekly) {
    const rules = [...schedule.weekly].sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
    parts.push(
      rules.length === 0
        ? 'No weekdays selected'
        : rules
            .map((rule) => {
              const label = WEEKDAY_LABELS[rule.day];
              if (rule.allDay) return `${label} all day`;
              return `${label} ${rule.windows.map((w) => `${w.start}–${w.end}`).join(' & ') || '(no windows)'}`;
            })
            .join(', '),
    );
  }
  const range = schedule.dateRange;
  if (range?.kind === 'yearly') {
    parts.push(`${describeYearly(range.start)} – ${describeYearly(range.end)}, every year`);
  } else if (range?.kind === 'fixed') {
    if (range.start && range.end) parts.push(`${describeFixed(range.start)} – ${describeFixed(range.end)}`);
    else if (range.start) parts.push(`from ${describeFixed(range.start)}`);
    else if (range.end) parts.push(`until ${describeFixed(range.end)}`);
  }
  if (parts.length === 0) return 'Always available';
  return `${parts.join(' · ')} (${schedule.timezone})`;
}
