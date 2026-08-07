/**
 * API wrapper contract (plan §22.8) plus the read-only guarantee (§24.6).
 *
 * The read-only assertions matter more than they look: v1's entire safety story
 * is "the Portal cannot change game state". Enforcing it in the client and
 * testing it here makes that a property of the code, not a code-review habit.
 */
import { describe, expect, it } from 'vitest';

import { server } from '../../../msw/server';
import { apiError, data } from '../../../msw/handlers';
import { http } from 'msw';
import {
  createApiClient,
  getData,
  getLastApiError,
  isPortalApiError,
  PortalApiError,
  ReadOnlyViolationError,
} from '../client';
import { getPlayerProfile } from '../players';

describe('the API client', () => {
  it('attaches the bearer token to every request', async () => {
    let seen: string | null = null;
    server.use(
      http.get('/api/v1/players/:playerId/profile', ({ request }) => {
        seen = request.headers.get('authorization');
        return data({ player: {}, currencies: {} });
      }),
    );

    await getPlayerProfile(1);
    expect(seen).toBe('Bearer test-token');
  });

  it('prefixes requests with the configured base URL and nothing else', async () => {
    let url: string | null = null;
    server.use(
      http.get('/api/v1/players/:playerId', ({ request }) => {
        url = new URL(request.url).pathname;
        return data({});
      }),
    );

    await getData('/v1/players/1');
    expect(url).toBe('/api/v1/players/1');
  });

  it('decodes the API error envelope into a PortalApiError', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    const error = await getData('/v1/players/999').catch((e: unknown) => e);

    expect(isPortalApiError(error)).toBe(true);
    const decoded = error as PortalApiError;
    expect(decoded.status).toBe(404);
    expect(decoded.code).toBe('PLAYER_NOT_FOUND');
    expect(decoded.message).toBe('No player with that id.');
    expect(decoded.requestId).toBe('test-request-id');
    expect(decoded.isNotFound).toBe(true);
  });

  it('remembers the last decoded error for the diagnostics page', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    await getData('/v1/players/1').catch(() => undefined);
    expect(getLastApiError()?.code).toBe('INTERNAL_ERROR');
  });

  it('normalises a transport failure into a network PortalApiError', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => HttpResponseError()));

    const error = (await getData('/v1/players/1').catch((e: unknown) => e)) as PortalApiError;
    expect(error.isNetworkError).toBe(true);
    expect(error.status).toBe(0);
  });

  it.each(['post', 'patch', 'put', 'delete'] as const)(
    'refuses to issue a %s request — the Portal is read-only',
    async (method) => {
      const client = createApiClient();
      await expect(client.request({ url: '/v1/players/1', method })).rejects.toBeInstanceOf(
        ReadOnlyViolationError,
      );
    },
  );

  /**
   * The refusal is unconditional — no path is exempt.
   *
   * Asserted separately against the endpoints most likely to tempt an
   * exception. Appearance selection is the live example: it is genuinely
   * cosmetic (the API writes one column), which is exactly what makes it the
   * plausible first crack in a binary rule. The rule stays binary; the action
   * lives in Discord until the authenticated-Portal milestone.
   */
  it.each([
    ['put', '/v1/players/1/collection/owned/2/appearance'],
    ['post', '/v1/players/1/collection/owned/2/appearance'],
    ['patch', '/v1/players/1/collection/owned/2/favorite'],
    ['post', '/v1/players/1/hunt'],
    ['delete', '/v1/players/1/collection/owned/2'],
  ] as const)('refuses %s %s — no endpoint is exempt', async (method, url) => {
    const client = createApiClient();
    await expect(client.request({ url, method })).rejects.toBeInstanceOf(
      ReadOnlyViolationError,
    );
  });

  it('refuses a write even when the caller prefixes the API base path', async () => {
    // Guards the shape an allowlist would have matched on: a `/api`-prefixed
    // path must not read as a different, permitted route.
    const client = createApiClient();
    await expect(
      client.request({ url: '/api/v1/players/1/collection/owned/2/appearance', method: 'put' }),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });
});

/** MSW's way of simulating a connection failure. */
function HttpResponseError(): Response {
  return Response.error();
}
