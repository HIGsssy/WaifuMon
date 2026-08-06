/**
 * Theme state (plan §18): dark by default, light available from Settings.
 *
 * The class on `<html>` is the source of truth for Tailwind's `dark:` variant.
 * `index.html` applies it before first paint so a dark-mode user never sees a
 * white flash; this provider owns it from hydration onward.
 *
 * First visit with no stored choice follows `prefers-color-scheme`, defaulting
 * to dark — the palette in §17 is designed dark-first and the artwork reads
 * best against it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { THEME_STORAGE_KEY, ThemeContext, type Theme, type ThemeState } from './ThemeContext';

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

function preferredTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? preferredTheme());

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* nothing to persist to — the in-memory theme still applies */
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((current) => (current === 'dark' ? 'light' : 'dark')),
    [],
  );

  const value = useMemo<ThemeState>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
