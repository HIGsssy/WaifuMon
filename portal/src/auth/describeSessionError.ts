/**
 * Turns a failed session resolution into something a developer can act on.
 *
 * Shared by both screens that can be looking at one: the production env
 * fallback (§8.11) and the dev-only developer-login form. The wording is the
 * same in both because the failure is the same — only the thing to fix differs,
 * and each screen says that part itself.
 */
import { isPortalApiError } from '@/api/client';

export interface DescribedSessionError {
  headline: string;
  detail: string;
}

export function describeSessionError(error: unknown): DescribedSessionError | null {
  if (error === null || error === undefined) return null;

  if (isPortalApiError(error)) {
    if (error.isNetworkError) {
      return {
        headline: "Can't reach the Waifumon server",
        detail:
          'The Platform API did not answer. Check that the bot is running with ' +
          'PLATFORM_API_ENABLED=true and that VITE_PLATFORM_API_PROXY_TARGET points at its port.',
      };
    }
    if (error.isUnauthorized) {
      return {
        headline: 'The Platform API rejected the token',
        detail: 'VITE_PLATFORM_API_TOKEN must match PLATFORM_API_TOKEN in the bot’s .env exactly.',
      };
    }
    if (error.isNotFound) {
      return {
        headline: 'No player with that id',
        detail:
          'The id resolved to nothing. Find a real one with /waifumon in Discord, or query the ' +
          'API’s GET /api/v1/players/lookup with a Discord guild and user id.',
      };
    }
    return { headline: error.message, detail: `${error.code} (HTTP ${error.status})` };
  }

  if (error instanceof Error) {
    return { headline: 'The configured player id is not usable', detail: error.message };
  }
  return { headline: 'Session could not be resolved', detail: String(error) };
}
