/**
 * Pure formatting and form logic for the Load Testing page — kept out of the
 * components so it is testable without rendering.
 */
import type { LoadTestLimits, LoadTestProfile, RunState } from '@/api/adminLoadTesting';

export const PROFILE_INFO: Record<LoadTestProfile, { label: string; description: string }> = {
  normal: {
    label: 'Normal Gameplay',
    description:
      'Discord-command-shaped reads: hunt checks, collection, inspect with card, profile, inventory, buddy, daily, expeditions.',
  },
  portal: {
    label: 'Portal / API',
    description:
      'Portal page views — each fires its queries together: dashboard, collection pages and filters, encyclopedia, shop, players, leaderboards.',
  },
  cards: {
    label: 'Card Rendering',
    description:
      'Card images through the real renderer. Warm: cached cards and 304 revalidations. Cold: never-drawn cards, removed again afterwards.',
  },
  mixed: {
    label: 'Mixed Players',
    description:
      'The capacity test: 55% Discord players, 35% Portal users (some browsing cards), 10% card-heavy, with occasional new cards.',
  },
};

export const STATE_LABEL: Record<RunState, string> = {
  preparing: 'Preparing',
  priming: 'Priming',
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
};

export const ACTIVE_STATES: ReadonlySet<RunState> = new Set([
  'preparing',
  'priming',
  'running',
  'stopping',
]);

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSeconds(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function formatRate(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}

export interface FormValues {
  profile: LoadTestProfile;
  cardMode: 'warm' | 'cold';
  concurrency: string;
  durationMinutes: string;
  label: string;
  resetMetricsWindow: boolean;
}

export type FormErrors = Partial<Record<'concurrency' | 'durationMinutes' | 'profile', string>>;

/**
 * Client-side validation mirroring the server's schema, so a bad value is
 * caught before a round trip. The server re-validates regardless.
 */
export function validateForm(
  values: FormValues,
  limits: LoadTestLimits,
  cardsAvailable: boolean,
): FormErrors {
  const errors: FormErrors = {};
  const c = Number(values.concurrency);
  if (!Number.isInteger(c) || c < 1 || c > limits.maxConcurrency) {
    errors.concurrency = `Enter a whole number from 1 to ${limits.maxConcurrency}.`;
  }
  const minutes = Number(values.durationMinutes);
  const seconds = Math.round(minutes * 60);
  if (
    !Number.isFinite(minutes) ||
    seconds < limits.minDurationSeconds ||
    seconds > limits.maxDurationSeconds
  ) {
    errors.durationMinutes = `Enter between ${limits.minDurationSeconds / 60} and ${limits.maxDurationSeconds / 60} minutes.`;
  }
  if (values.profile === 'cards' && !cardsAvailable) {
    errors.profile = 'Card rendering is switched off on this server.';
  }
  return errors;
}
