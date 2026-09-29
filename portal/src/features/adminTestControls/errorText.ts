import { isPortalApiError } from '@/api/client';

/** Server wording when there is one — the API's `userMessage` is safe to show. */
export function errorText(error: unknown, fallback: string): string {
  if (isPortalApiError(error)) {
    if (error.status === 403) return 'This account may not use Staging Test Controls.';
    if (error.message) return error.message;
  }
  return fallback;
}
