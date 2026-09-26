/**
 * `useNow` — the current time, re-read on an interval.
 *
 * For countdowns rendered from a server timestamp ("Returns in 2h 14m"). The
 * timestamp is the authority; this only moves the clock the text is measured
 * against, so a ticking countdown costs no network request.
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
