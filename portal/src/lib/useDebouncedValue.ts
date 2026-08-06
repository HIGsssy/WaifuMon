/**
 * Debounces a rapidly-changing value (plan §15).
 *
 * The Collection's search box writes to the URL, which re-renders the grid.
 * Without this, every keystroke would push a history entry and re-filter 25
 * cards. The input stays fully controlled and responsive; only the commit is
 * delayed.
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
