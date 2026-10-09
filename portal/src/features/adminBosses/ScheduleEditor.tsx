/**
 * The availability schedule of one boss, and a live preview of what it means.
 *
 * A schedule answers one question for the spawner — may this boss be drawn
 * right now? — and nothing else: it never ends an encounter and never touches
 * the respawn cooldown. Four modes, which are just which of the weekly rule and
 * the date range are set. Every time is read in the schedule's own timezone.
 *
 * The preview is the server's reading of exactly the object that would be
 * saved (`POST /admin/bosses/schedule/preview`), so what it says is what the
 * spawner will do.
 */
import { useId, useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import {
  BOSSES_QUERY_KEY,
  WEEKDAYS,
  previewBossSchedule,
  type BossIssue,
  type BossSchedule,
  type BossSchedulePreview,
  type BossTimeWindow,
  type Weekday,
} from '@/api/adminBosses';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import {
  DEFAULT_WINDOW,
  MONTH_LABELS,
  SCHEDULE_MODES,
  SCHEDULE_MODE_LABELS,
  WEEKDAY_LABELS,
  dayIssues,
  endsNextDay,
  formatWindow,
  issuesAt,
  scheduleOf,
  uniqueIssues,
  usesDateRange,
  usesWeekly,
  weeklyIssues,
  yearlyDate,
  yearlyParts,
  type DayForm,
  type ScheduleForm,
} from './bossModel';
import { BossIssues } from './bossParts';

/** How long typing must pause before the preview is asked for again. */
export const SCHEDULE_PREVIEW_DELAY_MS = 300;

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

function timezoneNames(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

export function ScheduleEditor({
  value,
  disabled,
  issues,
  onChange,
}: {
  value: ScheduleForm;
  disabled: boolean;
  /** Schedule issues the page already knows of (stored or refused), with schedule-relative paths. */
  issues: BossIssue[];
  onChange: (next: ScheduleForm) => void;
}) {
  const id = useId();
  const zones = useMemo(timezoneNames, []);
  const schedule = scheduleOf(value);
  const serialized = JSON.stringify(schedule);
  const settled = useDebouncedValue(serialized, SCHEDULE_PREVIEW_DELAY_MS);
  const preview = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'schedule-preview', settled],
    queryFn: async ({ signal }) => {
      const asked = JSON.parse(settled) as BossSchedule;
      // The zone travels with the answer, so instants are never shown in a zone still being typed.
      return { ...(await previewBossSchedule(asked, signal)), timeZone: asked.timezone };
    },
    placeholderData: keepPreviousData,
  });
  /** The preview on screen is for the schedule on screen. */
  const current = settled === serialized && !preview.isPlaceholderData && preview.data;
  const known = uniqueIssues([...issues, ...(current ? current.issues : [])]);

  const set = (patch: Partial<ScheduleForm>) => onChange({ ...value, ...patch });
  const setDay = (day: Weekday, patch: Partial<DayForm>) =>
    set({ days: { ...value.days, [day]: { ...value.days[day], ...patch } } });
  const setWindow = (day: Weekday, index: number, patch: Partial<BossTimeWindow>) =>
    setDay(day, {
      windows: value.days[day].windows.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    });

  const start = yearlyParts(value.yearlyStart);
  const end = yearlyParts(value.yearlyEnd);
  const crossesNewYear = value.yearlyEnd < value.yearlyStart;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="schedule-editor">
      <div className="space-y-4">
        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="text-xs text-ink-muted">When can this boss be drawn?</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {SCHEDULE_MODES.map((mode) => (
              <label key={mode} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={value.mode === mode}
                  onChange={() => set({ mode })}
                />
                {SCHEDULE_MODE_LABELS[mode]}
              </label>
            ))}
          </div>
        </fieldset>

        {value.mode === 'always' ? (
          <p className="text-xs text-ink-muted" data-testid="schedule-always">
            No schedule limits. The boss can be drawn at any time; its status and the server’s
            respawn cooldown still apply.
          </p>
        ) : (
          <div>
            <label className="block text-xs text-ink-muted">
              Timezone (IANA name, e.g. America/Toronto)
              <Input
                aria-label="Timezone"
                className="mt-1 w-72 font-mono"
                list={`${id}-zones`}
                value={value.timezone}
                disabled={disabled}
                onChange={(e) => set({ timezone: e.target.value })}
              />
            </label>
            <datalist id={`${id}-zones`}>
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-ink-subtle">
              Every time and date below is read in this zone, daylight saving included.
            </p>
          </div>
        )}
        <BossIssues issues={issuesAt(known, 'timezone')} testId="schedule-timezone-issues" />

        {usesWeekly(value.mode) && (
          <div className="space-y-2" data-testid="schedule-weekly">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">Weekdays</h3>
            {WEEKDAYS.map((day) => {
              const rule = value.days[day];
              const label = WEEKDAY_LABELS[day];
              return (
                <div
                  key={day}
                  className="space-y-1 rounded-lg border border-border px-3 py-2"
                  data-testid={`schedule-day-${day}`}
                >
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <label className="flex w-32 items-center gap-1.5 text-sm text-ink">
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={rule.enabled}
                        disabled={disabled}
                        onChange={(e) => setDay(day, { enabled: e.target.checked })}
                      />
                      {label}
                    </label>
                    {rule.enabled && (
                      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                        <input
                          type="checkbox"
                          aria-label={`${label} all day`}
                          checked={rule.allDay}
                          disabled={disabled}
                          onChange={(e) =>
                            setDay(day, {
                              allDay: e.target.checked,
                              // A day with hours needs at least one window to hold them.
                              windows:
                                !e.target.checked && rule.windows.length === 0
                                  ? [{ ...DEFAULT_WINDOW }]
                                  : rule.windows,
                            })
                          }
                        />
                        All day
                      </label>
                    )}
                  </div>
                  {rule.enabled && !rule.allDay && (
                    <div className="space-y-1 pl-6">
                      {rule.windows.map((window, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                          <Input
                            aria-label={`${label} window ${index + 1} start`}
                            className="w-20 font-mono"
                            placeholder="HH:MM"
                            value={window.start}
                            disabled={disabled}
                            onChange={(e) => setWindow(day, index, { start: e.target.value })}
                          />
                          <span className="text-xs text-ink-muted">to</span>
                          <Input
                            aria-label={`${label} window ${index + 1} end`}
                            className="w-20 font-mono"
                            placeholder="HH:MM"
                            value={window.end}
                            disabled={disabled}
                            onChange={(e) => setWindow(day, index, { end: e.target.value })}
                          />
                          {endsNextDay(window) && (
                            <Badge variant="outline" data-testid="schedule-ends-next-day">
                              ends next day
                            </Badge>
                          )}
                          {!disabled && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Remove ${label} window ${index + 1}`}
                              onClick={() =>
                                setDay(day, { windows: rule.windows.filter((_, i) => i !== index) })
                              }
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      ))}
                      {!disabled && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Add ${label} window`}
                          onClick={() =>
                            setDay(day, { windows: [...rule.windows, { ...DEFAULT_WINDOW }] })
                          }
                        >
                          Add window
                        </Button>
                      )}
                    </div>
                  )}
                  <BossIssues
                    issues={dayIssues(known, value, day)}
                    testId={`schedule-day-${day}-issues`}
                  />
                </div>
              );
            })}
            <p className="text-xs text-ink-subtle">
              Times are 24-hour HH:MM; 24:00 is the end of the day. A window that ends at or before
              its start runs into the next day, and belongs to the day it starts on.
            </p>
            <BossIssues issues={weeklyIssues(known)} testId="schedule-weekly-issues" />
          </div>
        )}

        {usesDateRange(value.mode) && (
          <div className="space-y-2" data-testid="schedule-date-range">
            <h3 className="text-xs font-semibold uppercase text-ink-muted">Date range</h3>
            <label className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                aria-label="Repeats every year"
                checked={value.yearly}
                disabled={disabled}
                onChange={(e) => set({ yearly: e.target.checked })}
              />
              Repeats every year
            </label>
            {value.yearly ? (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  {(
                    [
                      ['Start', start, 'yearlyStart'],
                      ['End', end, 'yearlyEnd'],
                    ] as const
                  ).map(([edge, parts, field]) => (
                    <div key={field} className="flex items-end gap-1 text-xs text-ink-muted">
                      <label>
                        {edge === 'Start' ? 'First day' : 'Last day'}
                        <select
                          aria-label={`${edge} month`}
                          className={selectClass}
                          value={parts.month}
                          disabled={disabled}
                          onChange={(e) =>
                            set({ [field]: yearlyDate(Number(e.target.value), parts.day) })
                          }
                        >
                          {MONTH_LABELS.map((month, i) => (
                            <option key={month} value={i + 1}>
                              {month}
                            </option>
                          ))}
                        </select>
                      </label>
                      <select
                        aria-label={`${edge} day`}
                        className={selectClass}
                        value={parts.day}
                        disabled={disabled}
                        onChange={(e) =>
                          set({ [field]: yearlyDate(parts.month, Number(e.target.value)) })
                        }
                      >
                        {DAYS_OF_MONTH.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-ink-subtle">
                  Both days are included, every year.
                  {crossesNewYear &&
                    ' The last day is earlier in the year, so the range crosses New Year.'}
                </p>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs text-ink-muted">
                    First day
                    <Input
                      type="date"
                      aria-label="Start date"
                      className="w-44"
                      value={value.fixedStart}
                      disabled={disabled}
                      onChange={(e) => set({ fixedStart: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-ink-muted">
                    Last day
                    <Input
                      type="date"
                      aria-label="End date"
                      className="w-44"
                      value={value.fixedEnd}
                      disabled={disabled}
                      onChange={(e) => set({ fixedEnd: e.target.value })}
                    />
                  </label>
                </div>
                <p className="text-xs text-ink-subtle">
                  Both days are included. Leave one empty for no start or no end.
                </p>
              </>
            )}
            <BossIssues issues={issuesAt(known, 'dateRange')} testId="schedule-range-issues" />
          </div>
        )}
        {/* Issues about the schedule as a whole, e.g. one that can never open. */}
        <BossIssues issues={known.filter((i) => i.path === '')} testId="schedule-issues" />
      </div>

      <aside
        className="space-y-2 self-start rounded-lg border border-border bg-surface-sunken p-3 text-sm"
        aria-label="Schedule preview"
        data-testid="schedule-preview"
      >
        <h3 className="flex items-center justify-between text-xs font-semibold uppercase text-ink-muted">
          Preview
          {(settled !== serialized || preview.isFetching) && (
            <span className="font-normal normal-case text-ink-subtle">Updating…</span>
          )}
        </h3>
        {preview.isError && (
          <ErrorState
            variant="inline"
            title="Could not preview the schedule"
            error={preview.error}
          />
        )}
        {preview.data && <SchedulePreview preview={preview.data} />}
      </aside>
    </div>
  );
}

function SchedulePreview({ preview }: { preview: BossSchedulePreview & { timeZone: string } }) {
  const { availability, timeZone } = preview;
  const limited = availability !== null && availability.mode !== 'always';
  return (
    <>
      <p className="text-ink" data-testid="schedule-summary">
        {preview.summary ?? 'This schedule cannot be read yet — fix the problems below.'}
      </p>
      {availability && (
        <dl className="space-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-ink-muted">Available now</dt>
            <dd className="text-ink" data-testid="schedule-available-now">
              {availability.availableNow ? 'Yes' : 'No'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-ink-muted">Current window</dt>
            <dd className="text-ink" data-testid="schedule-current-window">
              {availability.currentWindow
                ? formatWindow(availability.currentWindow, timeZone)
                : 'None — closed now'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-ink-muted">Next window</dt>
            <dd className="text-ink" data-testid="schedule-next-window">
              {availability.nextWindow
                ? formatWindow(availability.nextWindow, timeZone)
                : limited
                  ? 'None in the next year'
                  : 'Not needed — always open'}
            </dd>
          </div>
        </dl>
      )}
      {limited && (
        <p className="text-xs text-ink-subtle" data-testid="schedule-zone-note">
          Times are shown in {timeZone}.
        </p>
      )}
      {availability?.unavailableReason && (
        <p
          className="text-xs font-medium text-danger"
          role="alert"
          data-testid="schedule-unavailable"
        >
          {availability.unavailableReason}
        </p>
      )}
      <BossIssues issues={preview.issues} testId="schedule-preview-issues" />
    </>
  );
}
