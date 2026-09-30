/**
 * Friendly durations for the repeat-cooldown control.
 *
 * Storage stays in whole seconds (`cooldownSeconds`); these helpers only
 * translate between that and "15 minutes" / "6 hours" / "1 day" so an author
 * never has to type 21600.
 */

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const UNIT_SECONDS: Record<DurationUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

/** The server's ceiling for `cooldownSeconds` (30 days). */
export const MAX_COOLDOWN_SECONDS = 30 * 24 * 60 * 60;

/**
 * Seconds → the largest unit that represents them exactly. A value that is not
 * a whole number of minutes (legacy content can hold any integer) is shown in
 * fractional minutes rather than rounded, so opening and saving an encounter
 * never changes its cooldown.
 */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  if (seconds > 0 && seconds % UNIT_SECONDS.days === 0) {
    return { value: seconds / UNIT_SECONDS.days, unit: 'days' };
  }
  if (seconds > 0 && seconds % UNIT_SECONDS.hours === 0) {
    return { value: seconds / UNIT_SECONDS.hours, unit: 'hours' };
  }
  return { value: seconds / UNIT_SECONDS.minutes, unit: 'minutes' };
}

/** A value in `unit` → whole seconds, never negative. */
export function toSeconds(value: number, unit: DurationUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * UNIT_SECONDS[unit]);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * "15 minutes", "6 hours", "1 day 6 hours", "45 seconds". At most the two
 * largest non-zero parts — a cooldown is read at a glance, not to the second.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 minutes';
  const parts: string[] = [];
  let rest = Math.round(seconds);
  const days = Math.floor(rest / UNIT_SECONDS.days);
  rest -= days * UNIT_SECONDS.days;
  const hours = Math.floor(rest / UNIT_SECONDS.hours);
  rest -= hours * UNIT_SECONDS.hours;
  const minutes = Math.floor(rest / UNIT_SECONDS.minutes);
  const secs = rest - minutes * UNIT_SECONDS.minutes;
  if (days) parts.push(plural(days, 'day'));
  if (hours) parts.push(plural(hours, 'hour'));
  if (minutes) parts.push(plural(minutes, 'minute'));
  if (secs) parts.push(plural(secs, 'second'));
  return parts.slice(0, 2).join(' ');
}

/** Compact form for list badges: "15M", "6H", "1D 6H", "45S". */
export function formatDurationShort(seconds: number): string {
  return formatDuration(seconds)
    .split(' ')
    .reduce<string[]>((out, token, i, all) => {
      if (i % 2 === 0) out.push(`${token}${all[i + 1]![0]!.toUpperCase()}`);
      return out;
    }, [])
    .join(' ');
}
