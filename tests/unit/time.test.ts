import { describe, expect, it } from 'vitest';
import { claimDateInTimezone, isValidTimezone, nextResetAt } from '../../src/shared/time';

describe('claimDateInTimezone', () => {
  it('formats the UTC calendar date', () => {
    expect(claimDateInTimezone(new Date('2026-07-15T23:59:00Z'), 'UTC')).toBe('2026-07-15');
  });

  it('shifts the calendar day for offset timezones', () => {
    const instant = new Date('2026-07-15T23:30:00Z');
    expect(claimDateInTimezone(instant, 'Asia/Tokyo')).toBe('2026-07-16'); // UTC+9
    expect(claimDateInTimezone(instant, 'America/Los_Angeles')).toBe('2026-07-15'); // UTC-7
  });
});

describe('nextResetAt', () => {
  it('is midnight of the next day in UTC', () => {
    const reset = nextResetAt(new Date('2026-07-15T10:00:00Z'), 'UTC');
    expect(reset.toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });

  it('is midnight of the next day in an offset zone', () => {
    // Tokyo is UTC+9 year-round: next Tokyo midnight after 10:00Z Jul 15
    // (19:00 JST) is Jul 16 00:00 JST = Jul 15 15:00Z.
    const reset = nextResetAt(new Date('2026-07-15T10:00:00Z'), 'Asia/Tokyo');
    expect(reset.toISOString()).toBe('2026-07-15T15:00:00.000Z');
  });

  it('is always strictly in the future and flips the calendar day', () => {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/Berlin']) {
      const now = new Date('2026-07-15T13:37:11Z');
      const reset = nextResetAt(now, tz);
      expect(reset.getTime()).toBeGreaterThan(now.getTime());
      expect(claimDateInTimezone(reset, tz)).not.toBe(claimDateInTimezone(now, tz));
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Not/A_Zone')).toBe(false);
  });
});
