/**
 * The availability schedule editor: each mode produces exactly the schedule
 * object the server stores (weekly rules with several windows and one that
 * runs overnight, fixed and yearly date ranges, both together), and the live
 * preview says what that schedule means — in the schedule's own timezone,
 * including why a schedule that can never open cannot.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { BossIssue, BossSchedule } from '@/api/adminBosses';

import { scheduleFormOf, scheduleOf } from '../bossModel';
import { ScheduleEditor } from '../ScheduleEditor';
import {
  ALWAYS,
  FRIDAY_EVENINGS,
  NEXT_FRIDAY,
  TORONTO,
  installBossApi,
  renderWithSession,
  type BossApi,
  type User,
} from './bossFixtures';

let boss: BossApi;
beforeEach(() => {
  boss = installBossApi([]);
});
afterEach(() => vi.restoreAllMocks());

/** Holds the form as the boss editor does, and shows the schedule it stands for. */
function Harness({
  initial,
  disabled = false,
  issues = [],
}: {
  initial: BossSchedule;
  disabled?: boolean;
  issues?: BossIssue[];
}) {
  const [form, setForm] = useState(() => scheduleFormOf(initial));
  return (
    <>
      <ScheduleEditor value={form} disabled={disabled} issues={issues} onChange={setForm} />
      <pre data-testid="schedule-json">{JSON.stringify(scheduleOf(form))}</pre>
    </>
  );
}

function renderEditor(
  initial: BossSchedule = ALWAYS,
  props: { disabled?: boolean; issues?: BossIssue[] } = {},
) {
  return renderWithSession(<Harness initial={initial} {...props} />, '/');
}

/** The schedule object the editor would save right now. */
const schedule = (): BossSchedule =>
  JSON.parse(screen.getByTestId('schedule-json').textContent ?? 'null');
const retype = async (user: User, label: string, value: string) => {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
};
const day = (id: string) => within(screen.getByTestId(`schedule-day-${id}`));
/** The preview has caught up with the schedule on screen. */
const previewed = () =>
  waitFor(() => expect(boss.preview.mock.calls.at(-1)?.[0]).toEqual(schedule()));

describe('schedule modes', () => {
  it('starts always available, with no weekday or date controls', async () => {
    renderEditor();
    expect(screen.getByLabelText('Always available')).toBeChecked();
    expect(schedule()).toEqual({ timezone: TORONTO, weekly: null, dateRange: null });
    expect(screen.getByTestId('schedule-always')).toHaveTextContent('No schedule limits');
    expect(screen.queryByTestId('schedule-weekly')).not.toBeInTheDocument();
    expect(screen.queryByTestId('schedule-date-range')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Timezone')).not.toBeInTheDocument();
  });

  it('derives the mode from which of the weekly rule and the date range are set', () => {
    const weekly = FRIDAY_EVENINGS.weekly;
    const dateRange = { kind: 'yearly', start: '10-25', end: '10-31' } as const;
    expect(scheduleFormOf(ALWAYS).mode).toBe('always');
    expect(scheduleFormOf({ ...ALWAYS, weekly }).mode).toBe('weekly');
    expect(scheduleFormOf({ ...ALWAYS, dateRange }).mode).toBe('date_range');
    expect(scheduleFormOf({ ...ALWAYS, weekly, dateRange }).mode).toBe('weekly_date_range');
  });

  it('round-trips a stored schedule unchanged', () => {
    const stored: BossSchedule = {
      timezone: 'Europe/Berlin',
      weekly: [
        { day: 'mon', allDay: true, windows: [] },
        {
          day: 'fri',
          allDay: false,
          windows: [
            { start: '18:00', end: '24:00' },
            { start: '02:00', end: '04:00' },
          ],
        },
      ],
      dateRange: { kind: 'fixed', start: null, end: '2026-12-31' },
    };
    expect(scheduleOf(scheduleFormOf(stored))).toEqual(stored);
    expect(scheduleOf(scheduleFormOf(ALWAYS))).toEqual(ALWAYS);
  });

  it('keeps what was typed when the mode is switched away and back', async () => {
    const user = renderEditor(FRIDAY_EVENINGS);
    await user.click(screen.getByLabelText('Always available'));
    expect(schedule()).toEqual(ALWAYS);
    await user.click(screen.getByLabelText('Weekly schedule'));
    expect(schedule()).toEqual(FRIDAY_EVENINGS);
  });
});

describe('weekly schedule', () => {
  it('builds weekday rules: all day, several windows, and one that runs overnight', async () => {
    const user = renderEditor();
    await user.click(screen.getByLabelText('Weekly schedule'));
    // Seven rows, Monday first, none chosen yet.
    expect(
      screen
        .getAllByTestId(/^schedule-day-[a-z]{3}$/)
        .map((r) => r.getAttribute('data-testid')!.slice(-3)),
    ).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(schedule().weekly).toEqual([]);

    // A newly chosen day is the whole day.
    await user.click(screen.getByLabelText('Saturday'));
    expect(schedule().weekly).toEqual([{ day: 'sat', allDay: true, windows: [] }]);

    // Friday: hours instead. Switching off "all day" starts with one window.
    await user.click(screen.getByLabelText('Friday'));
    await user.click(screen.getByLabelText('Friday all day'));
    expect(screen.getByLabelText('Friday window 1 start')).toHaveValue('18:00');
    await retype(user, 'Friday window 1 start', '12:00');
    await retype(user, 'Friday window 1 end', '14:30');
    await user.click(screen.getByRole('button', { name: 'Add Friday window' }));
    await retype(user, 'Friday window 2 start', '22:00');
    await retype(user, 'Friday window 2 end', '02:00');

    expect(schedule()).toEqual({
      timezone: TORONTO,
      // Sent Monday-first, whatever order they were ticked in.
      weekly: [
        {
          day: 'fri',
          allDay: false,
          windows: [
            { start: '12:00', end: '14:30' },
            { start: '22:00', end: '02:00' },
          ],
        },
        { day: 'sat', allDay: true, windows: [] },
      ],
      dateRange: null,
    });
    // Only the window that ends at or before its start is marked as running overnight.
    expect(day('fri').getAllByTestId('schedule-ends-next-day')).toHaveLength(1);
    expect(day('fri').getByTestId('schedule-ends-next-day')).toHaveTextContent('ends next day');
  });

  it('accepts 24:00 as the end of the day, which is not the next day', async () => {
    const user = renderEditor(FRIDAY_EVENINGS);
    await retype(user, 'Friday window 1 end', '24:00');
    expect(schedule().weekly).toEqual([
      { day: 'fri', allDay: false, windows: [{ start: '18:00', end: '24:00' }] },
    ]);
    expect(day('fri').queryByTestId('schedule-ends-next-day')).not.toBeInTheDocument();

    // Ending exactly when it starts wraps a full day round.
    await retype(user, 'Friday window 1 end', '18:00');
    expect(day('fri').getByTestId('schedule-ends-next-day')).toBeInTheDocument();
  });

  it('removes a window, drops a day that is unticked, and sends no windows for an all-day rule', async () => {
    const user = renderEditor({
      timezone: TORONTO,
      weekly: [
        {
          day: 'fri',
          allDay: false,
          windows: [
            { start: '08:00', end: '10:00' },
            { start: '18:00', end: '23:00' },
          ],
        },
        { day: 'sun', allDay: true, windows: [] },
      ],
      dateRange: null,
    });
    await user.click(screen.getByRole('button', { name: 'Remove Friday window 1' }));
    expect(schedule().weekly![0]).toEqual({
      day: 'fri',
      allDay: false,
      windows: [{ start: '18:00', end: '23:00' }],
    });

    await user.click(screen.getByLabelText('Friday all day'));
    expect(schedule().weekly![0]).toEqual({ day: 'fri', allDay: true, windows: [] });
    expect(screen.queryByLabelText('Friday window 1 start')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Sunday'));
    expect(schedule().weekly).toEqual([{ day: 'fri', allDay: true, windows: [] }]);
  });

  it('reads times in the timezone the admin names', async () => {
    const user = renderEditor(FRIDAY_EVENINGS);
    expect(screen.getByLabelText('Timezone')).toHaveValue(TORONTO);
    await retype(user, 'Timezone', 'Europe/Berlin');
    expect(schedule().timezone).toBe('Europe/Berlin');
  });
});

describe('date range', () => {
  it('builds a fixed range of real dates, either end optional', async () => {
    const user = renderEditor();
    await user.click(screen.getByLabelText('Date range'));
    expect(screen.getByLabelText('Repeats every year')).not.toBeChecked();
    expect(schedule().dateRange).toEqual({ kind: 'fixed', start: null, end: null });

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-25' } });
    expect(schedule()).toEqual({
      timezone: TORONTO,
      weekly: null,
      dateRange: { kind: 'fixed', start: '2026-10-25', end: null },
    });

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-02' } });
    expect(schedule().dateRange).toEqual({ kind: 'fixed', start: '2026-10-25', end: '2026-11-02' });

    // Clearing the start leaves a range with only an end.
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '' } });
    expect(schedule().dateRange).toEqual({ kind: 'fixed', start: null, end: '2026-11-02' });
  });

  it('builds a yearly range of month and day, and says when it crosses New Year', async () => {
    const user = renderEditor();
    await user.click(screen.getByLabelText('Date range'));
    await user.click(screen.getByLabelText('Repeats every year'));
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
    expect(schedule().dateRange).toEqual({ kind: 'yearly', start: '01-01', end: '12-31' });

    await user.selectOptions(screen.getByLabelText('Start month'), 'October');
    await user.selectOptions(screen.getByLabelText('Start day'), '25');
    await user.selectOptions(screen.getByLabelText('End month'), 'October');
    await user.selectOptions(screen.getByLabelText('End day'), '31');
    expect(schedule()).toEqual({
      timezone: TORONTO,
      weekly: null,
      dateRange: { kind: 'yearly', start: '10-25', end: '10-31' },
    });
    expect(screen.queryByText(/crosses New Year/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('End month'), 'January');
    await user.selectOptions(screen.getByLabelText('End day'), '5');
    expect(schedule().dateRange).toEqual({ kind: 'yearly', start: '10-25', end: '01-05' });
    expect(screen.getByText(/crosses New Year/)).toBeInTheDocument();
  });

  it('loads a stored yearly range into its selects, and switches it to fixed dates', async () => {
    const user = renderEditor({
      ...ALWAYS,
      dateRange: { kind: 'yearly', start: '12-20', end: '01-02' },
    });
    expect(screen.getByLabelText('Date range')).toBeChecked();
    expect(screen.getByLabelText('Repeats every year')).toBeChecked();
    expect(screen.getByLabelText('Start month')).toHaveDisplayValue('December');
    expect(screen.getByLabelText('Start day')).toHaveDisplayValue('20');
    expect(screen.getByLabelText('End month')).toHaveDisplayValue('January');
    expect(screen.getByLabelText('End day')).toHaveDisplayValue('2');

    await user.click(screen.getByLabelText('Repeats every year'));
    expect(schedule().dateRange).toEqual({ kind: 'fixed', start: null, end: null });
  });

  it('combines a weekly rule with a date range', async () => {
    const user = renderEditor(FRIDAY_EVENINGS);
    await user.click(screen.getByLabelText('Weekly + date range'));
    await user.click(screen.getByLabelText('Repeats every year'));
    await user.selectOptions(screen.getByLabelText('Start month'), 'October');
    await user.selectOptions(screen.getByLabelText('End month'), 'October');
    await user.selectOptions(screen.getByLabelText('End day'), '31');
    expect(schedule()).toEqual({
      timezone: TORONTO,
      weekly: [{ day: 'fri', allDay: false, windows: [{ start: '18:00', end: '23:00' }] }],
      dateRange: { kind: 'yearly', start: '10-01', end: '10-31' },
    });
  });
});

describe('schedule preview', () => {
  it('asks the server about exactly the schedule on screen, once typing pauses', async () => {
    const user = renderEditor(FRIDAY_EVENINGS);
    await previewed();
    const before = boss.preview.mock.calls.length;
    await retype(user, 'Friday window 1 end', '23:30');
    await previewed();
    expect(boss.preview.mock.calls.at(-1)![0]).toEqual({
      timezone: TORONTO,
      weekly: [{ day: 'fri', allDay: false, windows: [{ start: '18:00', end: '23:30' }] }],
      dateRange: null,
    });
    // Debounced: six keystrokes did not mean six requests.
    expect(boss.preview.mock.calls.length - before).toBeLessThan(6);
  });

  it('says an always-available schedule is open, with no window to wait for', async () => {
    renderEditor();
    const preview = within(screen.getByTestId('schedule-preview'));
    expect(await preview.findByTestId('schedule-summary')).toHaveTextContent('Always available');
    expect(preview.getByTestId('schedule-available-now')).toHaveTextContent('Yes');
    expect(preview.getByTestId('schedule-current-window')).toHaveTextContent(
      'No limits — always open',
    );
    expect(preview.getByTestId('schedule-next-window')).toHaveTextContent('Not needed');
    expect(preview.queryByTestId('schedule-unavailable')).not.toBeInTheDocument();
  });

  it('shows the summary, that it is closed now, and the next window in the schedule’s own zone', async () => {
    boss.preview.mockResolvedValue({
      issues: [],
      summary: 'Fri 18:00–23:00 (America/Toronto)',
      availability: NEXT_FRIDAY,
    });
    renderEditor(FRIDAY_EVENINGS);
    const preview = within(screen.getByTestId('schedule-preview'));
    expect(await preview.findByTestId('schedule-summary')).toHaveTextContent(
      'Fri 18:00–23:00 (America/Toronto)',
    );
    expect(preview.getByTestId('schedule-available-now')).toHaveTextContent('No');
    expect(preview.getByTestId('schedule-current-window')).toHaveTextContent('None — closed now');
    // 22:00Z–03:00Z is 18:00–23:00 on Friday in Toronto, whatever zone the browser is in.
    expect(preview.getByTestId('schedule-next-window')).toHaveTextContent(
      'Fri, Oct 30, 2026, 18:00 – Fri, Oct 30, 2026, 23:00',
    );
    expect(preview.getByTestId('schedule-zone-note')).toHaveTextContent(
      'Times are shown in America/Toronto.',
    );
  });

  it('formats the same instants differently for a schedule in another zone', async () => {
    boss.preview.mockResolvedValue({
      issues: [],
      summary: 'Fri 18:00–23:00 (Asia/Tokyo)',
      availability: {
        ...NEXT_FRIDAY,
        availableNow: true,
        currentWindow: { start: '2026-10-30T09:00:00.000Z', end: '2026-10-30T14:00:00.000Z' },
        nextWindow: { start: '2026-11-06T09:00:00.000Z', end: null },
      },
    });
    renderEditor({ ...FRIDAY_EVENINGS, timezone: 'Asia/Tokyo' });
    const preview = within(screen.getByTestId('schedule-preview'));
    expect(await preview.findByTestId('schedule-available-now')).toHaveTextContent('Yes');
    expect(preview.getByTestId('schedule-current-window')).toHaveTextContent(
      'Fri, Oct 30, 2026, 18:00 – Fri, Oct 30, 2026, 23:00',
    );
    expect(preview.getByTestId('schedule-next-window')).toHaveTextContent(
      'From Fri, Nov 6, 2026, 18:00, with no end in sight',
    );
    expect(preview.getByTestId('schedule-zone-note')).toHaveTextContent('Asia/Tokyo');
  });

  it('explains a schedule that has no future window', async () => {
    boss.preview.mockResolvedValue({
      issues: [],
      summary: 'until Jan 1, 2020 (America/Toronto)',
      availability: {
        mode: 'date_range',
        availableNow: false,
        currentWindow: null,
        nextWindow: null,
        unavailableReason:
          'The date range ended on 2020-01-01, so this boss will not become available again.',
      },
    });
    renderEditor({ ...ALWAYS, dateRange: { kind: 'fixed', start: null, end: '2020-01-01' } });
    const preview = within(screen.getByTestId('schedule-preview'));
    expect(await preview.findByTestId('schedule-unavailable')).toHaveTextContent(
      'The date range ended on 2020-01-01, so this boss will not become available again.',
    );
    expect(preview.getByTestId('schedule-available-now')).toHaveTextContent('No');
    expect(preview.getByTestId('schedule-next-window')).toHaveTextContent('None in the next year');
  });

  it('shows validation issues in the preview and beside the row they name', async () => {
    boss.preview.mockResolvedValue({
      issues: [
        {
          path: 'timezone',
          message: '"Mars/Olympus" is not a known IANA timezone (for example America/Toronto)',
          severity: 'error',
        },
        {
          path: 'weekly[1].windows',
          message: 'Sat has overlapping windows; they are treated as one',
          severity: 'warning',
        },
        {
          path: 'dateRange.end',
          message: 'the end date is before the start date',
          severity: 'error',
        },
      ],
      summary: null,
      availability: null,
    });
    renderEditor({
      timezone: 'Mars/Olympus',
      weekly: [
        { day: 'wed', allDay: true, windows: [] },
        {
          day: 'sat',
          allDay: false,
          windows: [
            { start: '10:00', end: '14:00' },
            { start: '12:00', end: '16:00' },
          ],
        },
      ],
      dateRange: { kind: 'fixed', start: '2026-12-01', end: '2026-11-01' },
    });
    const preview = within(screen.getByTestId('schedule-preview'));
    // Errors are alerts and the warning is not, so the rows are counted, not the list items.
    expect((await preview.findByTestId('schedule-preview-issues')).children).toHaveLength(3);
    expect(preview.getByTestId('schedule-summary')).toHaveTextContent(
      'This schedule cannot be read yet',
    );
    expect(preview.queryByTestId('schedule-available-now')).not.toBeInTheDocument();

    expect(screen.getByTestId('schedule-timezone-issues')).toHaveTextContent(
      '"Mars/Olympus" is not a known IANA timezone',
    );
    // `weekly[1]` is the second enabled weekday — Saturday — not the second row.
    expect(screen.getByTestId('schedule-day-sat-issues')).toHaveTextContent(
      '⚠ Sat has overlapping windows',
    );
    expect(screen.queryByTestId('schedule-day-tue-issues')).not.toBeInTheDocument();
    expect(screen.getByTestId('schedule-range-issues')).toHaveTextContent(
      'the end date is before the start date',
    );
  });

  it('shows issues the page already knows of before any preview answers', async () => {
    boss.preview.mockImplementation(() => new Promise(() => {}));
    renderEditor(
      { ...FRIDAY_EVENINGS, weekly: [] },
      {
        issues: [
          {
            path: 'weekly',
            message: 'choose at least one weekday, or switch the schedule to always available',
            severity: 'error',
          },
        ],
      },
    );
    expect(screen.getByTestId('schedule-weekly-issues')).toHaveTextContent(
      'choose at least one weekday',
    );
  });

  it('says so when the preview cannot be fetched', async () => {
    boss.preview.mockRejectedValue(new Error('offline'));
    renderEditor(FRIDAY_EVENINGS);
    expect(await screen.findByText('Could not preview the schedule')).toBeInTheDocument();
  });

  it('is fully disabled when read-only, and still previews', async () => {
    renderEditor(FRIDAY_EVENINGS, { disabled: true });
    expect(screen.getByLabelText('Weekly schedule')).toBeDisabled();
    expect(screen.getByLabelText('Timezone')).toBeDisabled();
    expect(screen.getByLabelText('Friday')).toBeDisabled();
    expect(screen.getByLabelText('Friday all day')).toBeDisabled();
    expect(screen.getByLabelText('Friday window 1 end')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /window/ })).not.toBeInTheDocument();
    expect(await screen.findByTestId('schedule-summary')).toBeInTheDocument();
  });
});
