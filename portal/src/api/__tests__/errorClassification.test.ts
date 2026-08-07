/**
 * How a failed request is classified.
 *
 * This exists because of a specific bug: every rejection with no response —
 * a dead server, a slow server, and a request React Query itself aborted — was
 * decoded as `NETWORK_ERROR` and rendered as "Can't reach the Waifumon server".
 * Under `<StrictMode>` the Portal aborts every query once per mount by design,
 * so the dashboard produced that banner intermittently against a perfectly
 * healthy API. Two of the three are not faults at all.
 */
import { describe, expect, it } from 'vitest';
import { http } from 'msw';
import axios from 'axios';

import { server } from '../../../msw/server';
import { apiError } from '../../../msw/handlers';
import {
  getData,
  getLastApiError,
  isCanceledRequest,
  isPortalApiError,
  PortalApiError,
  requestTimeoutMs,
} from '../client';

async function failureFrom(request: Promise<unknown>): Promise<PortalApiError> {
  const error = await request.catch((e: unknown) => e);
  expect(isPortalApiError(error)).toBe(true);
  return error as PortalApiError;
}

describe('failure classification', () => {
  it('marks an unreachable API as a network failure, not a timeout', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => Response.error()));

    const error = await failureFrom(getData('/v1/players/1'));

    expect(error.kind).toBe('network');
    expect(error.isNetworkError).toBe(true);
    expect(error.isTimeout).toBe(false);
    expect(error.isTransportError).toBe(true);
  });

  it('marks an aborted request as cancelled rather than a network failure', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => new Promise(() => undefined)));

    const controller = new AbortController();
    const pending = getData('/v1/players/1', { signal: controller.signal });
    controller.abort();

    const error = await failureFrom(pending);

    expect(error.kind).toBe('canceled');
    // The distinction the UI actually depends on: a cancellation must never
    // read as "the server is down".
    expect(error.isNetworkError).toBe(false);
    expect(isCanceledRequest(error)).toBe(true);
  });

  it('never lets a cancellation become the diagnostics page’s last error', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () =>
        apiError(500, 'INTERNAL_ERROR', 'Something broke.'),
      ),
    );
    await getData('/v1/players/1').catch(() => undefined);
    expect(getLastApiError()?.code).toBe('INTERNAL_ERROR');

    server.use(http.get('/api/v1/shop/catalog', () => new Promise(() => undefined)));
    const controller = new AbortController();
    const pending = getData('/v1/shop/catalog', { signal: controller.signal });
    controller.abort();
    await pending.catch(() => undefined);

    // Still the real failure — the abort did not overwrite it.
    expect(getLastApiError()?.code).toBe('INTERNAL_ERROR');
  });

  it('classifies an HTTP error envelope as http, not transport', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    const error = await failureFrom(getData('/v1/players/999'));

    expect(error.kind).toBe('http');
    expect(error.isTransportError).toBe(false);
    expect(error.isNotFound).toBe(true);
  });

  it('recognises a raw axios cancellation, not only a decoded one', () => {
    expect(isCanceledRequest(new axios.CanceledError('canceled'))).toBe(true);
    expect(isCanceledRequest(new Error('nope'))).toBe(false);
    expect(isCanceledRequest(null)).toBe(false);
  });

  it('waits long enough for a link with real latency', () => {
    // Tailscale-class latency plus artwork contending for the same origin is
    // seconds, not milliseconds. A timeout under ~20s manufactures failures.
    expect(requestTimeoutMs()).toBeGreaterThanOrEqual(20_000);
  });
});
