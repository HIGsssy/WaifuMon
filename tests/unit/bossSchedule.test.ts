/**
 * Boss availability schedules: validation, weekly and date-range eligibility,
 * the edges of a window, and what a daylight-saving change does to one.
 *
 * Every instant below is written in UTC with the Toronto wall-clock time
 * beside it, because the whole point of the module is that those two are
 * different things. 2026: EDT (UTC−4) from Mar 8 to Nov 1, EST (UTC−5) outside.
 */
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_AVAILABLE,
  BossScheduleSchema,
  describeBossSchedule,
  evaluateBossSchedule,
  isBossAvailableAt,
  scheduleMode,
  validateBossSchedule,
  zonedDateOf,
  zonedTimeToUtc,
  type BossSchedule,
  type BossScheduleInput,
} from '../../src/modules/bosses/bossSchedule';

const TORONTO = 'America/Toronto';
const schedule = (input: BossScheduleInput): BossSchedule => BossScheduleSchema.parse(input);
const at = (iso: string) => new Date(iso);
const errorsOf = (input: unknown) =>
  validateBossSchedule(input)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.path);

/** The spec's example: Queen of the Rogue Planet. */
const QUEEN = schedule({
  timezone: TORONTO,
  weekly: [
    { day: 'fri', windows: [{ start: '18:00', end: '23:59' }] },
    { day: 'sat', allDay: true },
    { day: 'sun', windows: [{ start: '12:00', end: '22:00' }] },
  ],
});

describe('always available', () => {
  it('is the default, is open at any instant, and has nothing to wait for', () => {
    expect(BossScheduleSchema.parse({})).toEqual(ALWAYS_AVAILABLE);
    expect(ALWAYS_AVAILABLE.timezone).toBe(TORONTO);
    expect(scheduleMode(ALWAYS_AVAILABLE)).toBe('always');
    const now = evaluateBossSchedule(ALWAYS_AVAILABLE, at('2026-10-09T12:00:00Z'));
    expect(now).toMatchObject({ availableNow: true, nextWindow: null, unavailableReason: null });
    expect(describeBossSchedule(ALWAYS_AVAILABLE)).toBe('Always available');
  });
});

describe('validation', () => {
  it('accepts the documented example', () => {
    expect(validateBossSchedule(QUEEN).issues).toEqual([]);
  });

  it('rejects an unknown timezone', () => {
    expect(errorsOf({ timezone: 'Mars/Olympus_Mons' })).toEqual(['timezone']);
  });

  it('rejects a weekly schedule that allows nothing', () => {
    expect(errorsOf({ weekly: [] })).toEqual(['weekly']);
    expect(errorsOf({ weekly: [{ day: 'mon' }] })).toEqual(['weekly[0].windows']);
  });

  it('rejects a day listed twice, a zero-length window, and windows on an all-day rule', () => {
    expect(errorsOf({ weekly: [{ day: 'mon', allDay: true }, { day: 'mon', allDay: true }] })).toEqual(['weekly[1].day']);
    expect(errorsOf({ weekly: [{ day: 'mon', windows: [{ start: '10:00', end: '10:00' }] }] })).toEqual([
      'weekly[0].windows[0]',
    ]);
    expect(errorsOf({ weekly: [{ day: 'mon', allDay: true, windows: [{ start: '10:00', end: '11:00' }] }] })).toEqual([
      'weekly[0].windows',
    ]);
  });

  it('rejects malformed times, and allows 24:00 only as an end', () => {
    expect(errorsOf({ weekly: [{ day: 'mon', windows: [{ start: '25:00', end: '26:00' }] }] })).toEqual([
      'weekly[0].windows[0].start',
      'weekly[0].windows[0].end',
    ]);
    expect(errorsOf({ weekly: [{ day: 'mon', windows: [{ start: '24:00', end: '01:00' }] }] })).toEqual([
      'weekly[0].windows[0].start',
    ]);
    expect(errorsOf({ weekly: [{ day: 'mon', windows: [{ start: '18:00', end: '24:00' }] }] })).toEqual([]);
  });

  it('rejects dates that do not exist and a range that ends before it starts', () => {
    expect(errorsOf({ dateRange: { kind: 'fixed', start: '2026-02-30', end: '2026-03-01' } })).toEqual(['dateRange.start']);
    expect(errorsOf({ dateRange: { kind: 'fixed', start: '2026-10-31', end: '2026-10-25' } })).toEqual(['dateRange.end']);
    expect(errorsOf({ dateRange: { kind: 'fixed' } })).toEqual(['dateRange']);
    expect(errorsOf({ dateRange: { kind: 'yearly', start: '13-01', end: '12-31' } })).toEqual(['dateRange.start']);
    expect(errorsOf({ dateRange: { kind: 'yearly', start: '02-30', end: '03-01' } })).toEqual(['dateRange.start']);
    // Feb 29 is a real yearly date; it simply only happens in leap years.
    expect(errorsOf({ dateRange: { kind: 'yearly', start: '02-29', end: '03-01' } })).toEqual([]);
  });

  it('warns about overlapping windows rather than refusing them', () => {
    const { schedule: parsed, issues } = validateBossSchedule({
      weekly: [{ day: 'mon', windows: [{ start: '10:00', end: '14:00' }, { start: '13:00', end: '16:00' }] }],
    });
    expect(parsed).not.toBeNull();
    expect(issues).toEqual([expect.objectContaining({ path: 'weekly[0].windows', severity: 'warning' })]);
  });

  it('rejects unknown fields', () => {
    expect(errorsOf({ timezone: TORONTO, hourly: true })).not.toEqual([]);
  });
});

describe('weekly schedule', () => {
  it('is open exactly inside the windows of the selected days', () => {
    // Friday Oct 9 2026 (EDT, UTC−4).
    expect(isBossAvailableAt(QUEEN, at('2026-10-09T21:59:59Z'))).toBe(false); // Fri 17:59:59
    expect(isBossAvailableAt(QUEEN, at('2026-10-09T22:00:00Z'))).toBe(true); // Fri 18:00:00 — start is inclusive
    expect(isBossAvailableAt(QUEEN, at('2026-10-10T03:58:59Z'))).toBe(true); // Fri 23:58:59
    expect(isBossAvailableAt(QUEEN, at('2026-10-10T03:59:00Z'))).toBe(false); // Fri 23:59:00 — end is exclusive
    expect(isBossAvailableAt(QUEEN, at('2026-10-10T04:00:00Z'))).toBe(true); // Sat 00:00 — all day
    expect(isBossAvailableAt(QUEEN, at('2026-10-11T03:59:59Z'))).toBe(true); // Sat 23:59:59
    expect(isBossAvailableAt(QUEEN, at('2026-10-11T04:00:00Z'))).toBe(false); // Sun 00:00
    expect(isBossAvailableAt(QUEEN, at('2026-10-11T16:00:00Z'))).toBe(true); // Sun 12:00
    expect(isBossAvailableAt(QUEEN, at('2026-10-12T02:00:00Z'))).toBe(false); // Sun 22:00
    expect(isBossAvailableAt(QUEEN, at('2026-10-14T16:00:00Z'))).toBe(false); // Wed noon
  });

  it('reports the window it is in and the next one to open', () => {
    const closed = evaluateBossSchedule(QUEEN, at('2026-10-07T16:00:00Z')); // Wed noon
    expect(closed.availableNow).toBe(false);
    expect(closed.currentWindow).toBeNull();
    expect(closed.nextWindow).toEqual({ start: at('2026-10-09T22:00:00Z'), end: at('2026-10-10T03:59:00Z') });

    const open = evaluateBossSchedule(QUEEN, at('2026-10-09T23:00:00Z')); // Fri 19:00
    expect(open.availableNow).toBe(true);
    expect(open.currentWindow).toEqual({ start: at('2026-10-09T22:00:00Z'), end: at('2026-10-10T03:59:00Z') });
    // Saturday, all day.
    expect(open.nextWindow).toEqual({ start: at('2026-10-10T04:00:00Z'), end: at('2026-10-11T04:00:00Z') });
  });

  it('supports several windows in one day', () => {
    const lunchAndEvening = schedule({
      timezone: TORONTO,
      weekly: [{ day: 'wed', windows: [{ start: '12:00', end: '13:00' }, { start: '19:00', end: '21:00' }] }],
    });
    // Wednesday Oct 7 2026.
    expect(isBossAvailableAt(lunchAndEvening, at('2026-10-07T16:30:00Z'))).toBe(true); // 12:30
    expect(isBossAvailableAt(lunchAndEvening, at('2026-10-07T18:00:00Z'))).toBe(false); // 14:00
    expect(isBossAvailableAt(lunchAndEvening, at('2026-10-07T23:30:00Z'))).toBe(true); // 19:30
    const between = evaluateBossSchedule(lunchAndEvening, at('2026-10-07T18:00:00Z'));
    expect(between.nextWindow).toEqual({ start: at('2026-10-07T23:00:00Z'), end: at('2026-10-08T01:00:00Z') });
  });

  it('treats overlapping and back-to-back windows as one', () => {
    const merged = schedule({
      timezone: TORONTO,
      weekly: [
        { day: 'wed', windows: [{ start: '10:00', end: '14:00' }, { start: '13:00', end: '16:00' }, { start: '16:00', end: '17:00' }] },
      ],
    });
    const now = evaluateBossSchedule(merged, at('2026-10-07T15:00:00Z')); // Wed 11:00
    expect(now.currentWindow).toEqual({ start: at('2026-10-07T14:00:00Z'), end: at('2026-10-07T21:00:00Z') });
  });

  it('carries a window that crosses midnight into the next day, as part of the day it started on', () => {
    const lateNight = schedule({
      timezone: TORONTO,
      weekly: [{ day: 'fri', windows: [{ start: '22:00', end: '02:00' }] }],
    });
    expect(isBossAvailableAt(lateNight, at('2026-10-10T01:59:00Z'))).toBe(false); // Fri 21:59
    expect(isBossAvailableAt(lateNight, at('2026-10-10T02:00:00Z'))).toBe(true); // Fri 22:00
    expect(isBossAvailableAt(lateNight, at('2026-10-10T05:59:00Z'))).toBe(true); // Sat 01:59 — Friday's window
    expect(isBossAvailableAt(lateNight, at('2026-10-10T06:00:00Z'))).toBe(false); // Sat 02:00
    // Saturday is not a selected day: nothing opens at Sat 22:00.
    expect(isBossAvailableAt(lateNight, at('2026-10-11T02:30:00Z'))).toBe(false);
    expect(evaluateBossSchedule(lateNight, at('2026-10-10T05:00:00Z')).currentWindow).toEqual({
      start: at('2026-10-10T02:00:00Z'),
      end: at('2026-10-10T06:00:00Z'),
    });
  });

  it('reads the wall clock in the schedule timezone, not UTC and not the server zone', () => {
    const noon = (timezone: string) =>
      schedule({ timezone, weekly: WEEK.map((day) => ({ day, windows: [{ start: '12:00', end: '13:00' }] })) });
    const instant = at('2026-10-09T03:30:00Z'); // 12:30 in Tokyo, 23:30 the day before in Toronto
    expect(isBossAvailableAt(noon('Asia/Tokyo'), instant)).toBe(true);
    expect(isBossAvailableAt(noon(TORONTO), instant)).toBe(false);
    expect(isBossAvailableAt(noon('UTC'), instant)).toBe(false);
  });
});

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

describe('date-range availability', () => {
  const halloween = schedule({ timezone: TORONTO, dateRange: { kind: 'fixed', start: '2026-10-25', end: '2026-10-31' } });

  it('is open from the start of the first day to the end of the last, in the schedule timezone', () => {
    expect(scheduleMode(halloween)).toBe('date_range');
    expect(isBossAvailableAt(halloween, at('2026-10-25T03:59:59Z'))).toBe(false); // Oct 24 23:59:59
    expect(isBossAvailableAt(halloween, at('2026-10-25T04:00:00Z'))).toBe(true); // Oct 25 00:00
    expect(isBossAvailableAt(halloween, at('2026-11-01T03:59:59Z'))).toBe(true); // Oct 31 23:59:59
    expect(isBossAvailableAt(halloween, at('2026-11-01T04:00:00Z'))).toBe(false); // Nov 1 00:00
  });

  it('reports the whole range as one window', () => {
    const before = evaluateBossSchedule(halloween, at('2026-10-09T12:00:00Z'));
    expect(before.availableNow).toBe(false);
    expect(before.nextWindow).toEqual({ start: at('2026-10-25T04:00:00Z'), end: at('2026-11-01T04:00:00Z') });
  });

  it('does not recur: a year-specific range that has ended can never open again, and says so', () => {
    const after = evaluateBossSchedule(halloween, at('2027-10-28T12:00:00Z'));
    expect(after).toMatchObject({ availableNow: false, currentWindow: null, nextWindow: null });
    expect(after.unavailableReason).toContain('ended on 2026-10-31');
  });

  it('recurs every year only when asked to', () => {
    const yearly = schedule({ timezone: TORONTO, dateRange: { kind: 'yearly', start: '10-25', end: '10-31' } });
    expect(isBossAvailableAt(yearly, at('2026-10-28T12:00:00Z'))).toBe(true);
    expect(isBossAvailableAt(yearly, at('2027-10-28T12:00:00Z'))).toBe(true);
    expect(isBossAvailableAt(yearly, at('2027-06-01T12:00:00Z'))).toBe(false);
    const next = evaluateBossSchedule(yearly, at('2026-11-15T12:00:00Z')).nextWindow;
    expect(next).toEqual({ start: at('2027-10-25T04:00:00Z'), end: at('2027-11-01T04:00:00Z') });
  });

  it('lets a yearly range cross New Year', () => {
    const winter = schedule({ timezone: TORONTO, dateRange: { kind: 'yearly', start: '12-20', end: '01-05' } });
    expect(isBossAvailableAt(winter, at('2026-12-25T12:00:00Z'))).toBe(true);
    expect(isBossAvailableAt(winter, at('2027-01-03T12:00:00Z'))).toBe(true);
    expect(isBossAvailableAt(winter, at('2027-01-06T12:00:00Z'))).toBe(false);
  });

  it('supports a range with only a start or only an end', () => {
    const fromLaunch = schedule({ timezone: TORONTO, dateRange: { kind: 'fixed', start: '2026-11-01' } });
    expect(isBossAvailableAt(fromLaunch, at('2026-10-31T12:00:00Z'))).toBe(false);
    const launched = evaluateBossSchedule(fromLaunch, at('2026-12-01T12:00:00Z'));
    expect(launched.availableNow).toBe(true);
    // Open-ended: there is no end to report.
    expect(launched.currentWindow?.end).toBeNull();

    const untilRetired = schedule({ timezone: TORONTO, dateRange: { kind: 'fixed', end: '2026-11-01' } });
    expect(isBossAvailableAt(untilRetired, at('2026-10-31T12:00:00Z'))).toBe(true);
    expect(isBossAvailableAt(untilRetired, at('2026-11-03T12:00:00Z'))).toBe(false);
  });
});

describe('weekly schedule combined with a date range', () => {
  const christmasWeekends = schedule({
    timezone: TORONTO,
    weekly: [{ day: 'sat', allDay: true }, { day: 'sun', allDay: true }],
    dateRange: { kind: 'yearly', start: '12-01', end: '12-31' },
  });

  it('needs both: a selected weekday that falls inside the range', () => {
    expect(scheduleMode(christmasWeekends)).toBe('weekly_date_range');
    expect(isBossAvailableAt(christmasWeekends, at('2026-12-05T17:00:00Z'))).toBe(true); // Sat Dec 5
    expect(isBossAvailableAt(christmasWeekends, at('2026-12-09T17:00:00Z'))).toBe(false); // Wed Dec 9
    expect(isBossAvailableAt(christmasWeekends, at('2026-11-28T17:00:00Z'))).toBe(false); // Sat Nov 28
    expect(isBossAvailableAt(christmasWeekends, at('2027-01-02T17:00:00Z'))).toBe(false); // Sat Jan 2
  });

  it('finds the first matching day when asked from outside the range', () => {
    const next = evaluateBossSchedule(christmasWeekends, at('2026-10-09T12:00:00Z')).nextWindow;
    // Sat Dec 5 and Sun Dec 6 run together into one window (EST, UTC−5).
    expect(next).toEqual({ start: at('2026-12-05T05:00:00Z'), end: at('2026-12-07T05:00:00Z') });
  });

  it('lets a window that starts on the last day of the range finish after midnight', () => {
    const halloweenNight = schedule({
      timezone: TORONTO,
      weekly: WEEK.map((day) => ({ day, windows: [{ start: '22:00', end: '02:00' }] })),
      dateRange: { kind: 'fixed', start: '2026-10-31', end: '2026-10-31' },
    });
    // Sat Oct 31 22:00 EDT → Sun Nov 1 02:00 EST. The clocks go back at 02:00
    // EDT that night, so this window is five hours long, not four.
    const open = evaluateBossSchedule(halloweenNight, at('2026-11-01T04:30:00Z'));
    expect(open.currentWindow).toEqual({ start: at('2026-11-01T02:00:00Z'), end: at('2026-11-01T07:00:00Z') });
    // And nothing opens on Nov 1 itself.
    expect(evaluateBossSchedule(halloweenNight, at('2026-11-01T12:00:00Z'))).toMatchObject({
      availableNow: false,
      nextWindow: null,
    });
  });

  it('explains a combination that can never match', () => {
    // Oct 26–29 2026 is Monday to Thursday.
    const never = schedule({
      timezone: TORONTO,
      weekly: [{ day: 'sat', allDay: true }],
      dateRange: { kind: 'fixed', start: '2026-10-26', end: '2026-10-29' },
    });
    const verdict = evaluateBossSchedule(never, at('2026-10-09T12:00:00Z'));
    expect(verdict).toMatchObject({ availableNow: false, nextWindow: null });
    expect(verdict.unavailableReason).toBe('No selected weekday falls inside the date range.');
  });

  it('finds the window of an event announced years ahead', () => {
    const farOff = schedule({
      timezone: TORONTO,
      weekly: [{ day: 'sat', allDay: true }],
      dateRange: { kind: 'fixed', start: '2029-10-25', end: '2029-10-31' },
    });
    // Sat Oct 27 2029 (EDT).
    expect(evaluateBossSchedule(farOff, at('2026-10-09T12:00:00Z'))).toMatchObject({
      availableNow: false,
      nextWindow: { start: at('2029-10-27T04:00:00Z'), end: at('2029-10-28T04:00:00Z') },
      unavailableReason: null,
    });
  });
});

describe('daylight saving', () => {
  it('converts local times on either side of the offset change', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 15 }, 12 * 60, TORONTO)).toEqual(at('2026-01-15T17:00:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 15 }, 12 * 60, TORONTO)).toEqual(at('2026-07-15T16:00:00Z'));
    expect(zonedDateOf(at('2026-07-15T03:30:00Z'), TORONTO)).toEqual({ year: 2026, month: 7, day: 14, minuteOfDay: 23 * 60 + 30 });
  });

  it('spring forward: a 23-hour day is a 23-hour all-day window', () => {
    const sundays = schedule({ timezone: TORONTO, weekly: [{ day: 'sun', allDay: true }] });
    // Sunday Mar 8 2026: 00:00 EST → 24:00 EDT.
    const day = evaluateBossSchedule(sundays, at('2026-03-08T12:00:00Z')).currentWindow!;
    expect(day).toEqual({ start: at('2026-03-08T05:00:00Z'), end: at('2026-03-09T04:00:00Z') });
    expect((day.end!.getTime() - day.start!.getTime()) / 3_600_000).toBe(23);
  });

  it('spring forward: a start time inside the missing hour opens when the clocks land', () => {
    const early = schedule({ timezone: TORONTO, weekly: [{ day: 'sun', windows: [{ start: '02:30', end: '04:00' }] }] });
    // 02:30 does not exist on Mar 8; the clocks jump 02:00 → 03:00. The window
    // opens at 03:30 EDT (the requested time pushed past the gap).
    const window = evaluateBossSchedule(early, at('2026-03-08T05:30:00Z')).nextWindow!;
    expect(window).toEqual({ start: at('2026-03-08T07:30:00Z'), end: at('2026-03-08T08:00:00Z') });
    expect(isBossAvailableAt(early, at('2026-03-08T06:59:00Z'))).toBe(false); // 01:59 EST
  });

  it('fall back: a 25-hour day is a 25-hour all-day window', () => {
    const sundays = schedule({ timezone: TORONTO, weekly: [{ day: 'sun', allDay: true }] });
    // Sunday Nov 1 2026: 00:00 EDT → 24:00 EST.
    const day = evaluateBossSchedule(sundays, at('2026-11-01T12:00:00Z')).currentWindow!;
    expect(day).toEqual({ start: at('2026-11-01T04:00:00Z'), end: at('2026-11-02T05:00:00Z') });
    expect((day.end!.getTime() - day.start!.getTime()) / 3_600_000).toBe(25);
  });

  it('fall back: a time that happens twice means its first occurrence', () => {
    const repeated = schedule({ timezone: TORONTO, weekly: [{ day: 'sun', windows: [{ start: '01:30', end: '03:00' }] }] });
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST). 03:00 EST is 08:00Z.
    const window = evaluateBossSchedule(repeated, at('2026-11-01T04:30:00Z')).nextWindow!;
    expect(window).toEqual({ start: at('2026-11-01T05:30:00Z'), end: at('2026-11-01T08:00:00Z') });
    expect(isBossAvailableAt(repeated, at('2026-11-01T06:45:00Z'))).toBe(true); // the second 01:45
  });

  it('keeps a weekly window at the same wall-clock time across the change', () => {
    const fridays = schedule({ timezone: TORONTO, weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '20:00' }] }] });
    // Fri Oct 30 (EDT) opens 22:00Z; Fri Nov 6 (EST) opens 23:00Z.
    expect(evaluateBossSchedule(fridays, at('2026-10-29T12:00:00Z')).nextWindow?.start).toEqual(at('2026-10-30T22:00:00Z'));
    expect(evaluateBossSchedule(fridays, at('2026-11-02T12:00:00Z')).nextWindow?.start).toEqual(at('2026-11-06T23:00:00Z'));
  });
});

describe('an unreadable schedule', () => {
  it('is treated as closed rather than guessed at', () => {
    const broken = { timezone: 'Not/AZone', weekly: [{ day: 'mon', allDay: true, windows: [] }], dateRange: null } as BossSchedule;
    const verdict = evaluateBossSchedule(broken, at('2026-10-12T16:00:00Z'));
    expect(verdict.availableNow).toBe(false);
    expect(verdict.unavailableReason).toContain('not valid');
  });
});

describe('description', () => {
  it('reads the way an admin would say it', () => {
    expect(describeBossSchedule(QUEEN)).toBe('Fri 18:00–23:59, Sat all day, Sun 12:00–22:00 (America/Toronto)');
    expect(
      describeBossSchedule(schedule({ timezone: TORONTO, dateRange: { kind: 'fixed', start: '2026-10-25', end: '2026-10-31' } })),
    ).toBe('Oct 25, 2026 – Oct 31, 2026 (America/Toronto)');
    expect(
      describeBossSchedule(
        schedule({
          timezone: TORONTO,
          weekly: [{ day: 'sun', allDay: true }, { day: 'sat', allDay: true }],
          dateRange: { kind: 'yearly', start: '12-01', end: '12-31' },
        }),
      ),
    ).toBe('Sat all day, Sun all day · Dec 1 – Dec 31, every year (America/Toronto)');
    expect(describeBossSchedule(schedule({ timezone: 'UTC', dateRange: { kind: 'fixed', start: '2026-11-01' } }))).toBe(
      'from Nov 1, 2026 (UTC)',
    );
  });
});
