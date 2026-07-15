/**
 * Calendar-day math in a configurable timezone. Daily claims key on the
 * calendar date (YYYY-MM-DD) in the configured zone, backed by a unique
 * constraint in the database.
 */

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns the calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function claimDateInTimezone(instant: Date, timeZone: string): string {
  // en-CA locale formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** UTC offset of `timeZone` at `instant`, in milliseconds. */
function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // hour '24' can appear for midnight in some ICU versions.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - instant.getTime();
}

/** The instant at which the calendar day in `timeZone` next rolls over. */
export function nextResetAt(instant: Date, timeZone: string): Date {
  const today = claimDateInTimezone(instant, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  // Midnight (start of tomorrow) as if the zone were UTC, then correct by the
  // zone's actual offset at that moment (handles DST transitions closely enough
  // for a daily-reset boundary).
  const naiveMidnightUtc = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  const offset = timezoneOffsetMs(new Date(naiveMidnightUtc), timeZone);
  return new Date(naiveMidnightUtc - offset);
}
