import { createContext } from 'react';

export type Theme = 'dark' | 'light';

export interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeState | null>(null);

/** Shared with the pre-paint script in index.html — keep the two in step. */
export const THEME_STORAGE_KEY = 'waifumon-portal:theme';
