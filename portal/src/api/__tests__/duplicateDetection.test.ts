/**
 * The duplicate-request warning, and what it must not cry wolf about.
 *
 * It used to count request *starts*, which made it fire constantly in
 * development for a reason that was not a bug: `<StrictMode>` mounts every
 * component twice, React Query aborts the first fetch on the intervening
 * unmount, and refetches on the second mount. Two starts microseconds apart,
 * one query key, entirely by design — and the warning told developers to go
 * hunting for a second hook that did not exist.
 *
 * Counting completions instead draws the line in the right place: an aborted
 * request never completes, so the StrictMode pattern is silent, while two
 * fetches that both cost a round trip still get reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http } from 'msw';

import { data } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import { getData } from '../client';
import { resetDuplicateTracking } from '../telemetry';

function duplicateWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('[portal duplicate]'));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetDuplicateTracking();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  resetDuplicateTracking();
});

describe('duplicate request detection', () => {
  it('reports two completed fetches of one path in the same tick', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => data({ id: 1 })));

    await Promise.all([getData('/v1/players/1'), getData('/v1/players/1')]);

    expect(duplicateWarnings(warn)).toHaveLength(1);
    expect(duplicateWarnings(warn)[0]).toContain('/api/v1/players/1');
  });

  it('stays silent when a request is aborted before it completes', async () => {
    // The StrictMode shape: start, abort on unmount, start again on remount.
    // Only the second one finishes, so only one round trip was actually spent.
    server.use(http.get('/api/v1/players/:playerId', () => data({ id: 1 })));

    const controller = new AbortController();
    const aborted = getData('/v1/players/1', { signal: controller.signal });
    controller.abort();
    await aborted.catch(() => undefined);

    await getData('/v1/players/1');

    expect(duplicateWarnings(warn)).toEqual([]);
  });

  it('does not blame the developer for React’s double invoke in its wording', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => data({ id: 1 })));
    await Promise.all([getData('/v1/players/1'), getData('/v1/players/1')]);

    const [message] = duplicateWarnings(warn);
    // The old text asserted a cause it could not know. The new one describes
    // what was observed and says what it has already ruled out.
    expect(message).not.toContain('probably');
    expect(message).toContain('StrictMode remounts are already excluded');
  });

  it('counts a settled failure, which still cost a round trip', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => Response.error()));

    await Promise.all([
      getData('/v1/players/1').catch(() => undefined),
      getData('/v1/players/1').catch(() => undefined),
    ]);

    expect(duplicateWarnings(warn)).toHaveLength(1);
  });

  it('warns once per path, not once per offending request', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => data({ id: 1 })));

    await Promise.all([
      getData('/v1/players/1'),
      getData('/v1/players/1'),
      getData('/v1/players/1'),
      getData('/v1/players/1'),
    ]);

    expect(duplicateWarnings(warn)).toHaveLength(1);
  });

  it('does not warn about different paths', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () => data({ id: 1 })),
      http.get('/api/v1/shop/catalog', () => data([])),
    );

    await Promise.all([getData('/v1/players/1'), getData('/v1/shop/catalog')]);

    expect(duplicateWarnings(warn)).toEqual([]);
  });
});
