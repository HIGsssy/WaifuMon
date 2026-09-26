/**
 * `/api/v1/players/{id}/expeditions` — open missions and regional boards.
 *
 * Read-only in every sense: the endpoint never resolves a due mission, and
 * there is no Portal endpoint that starts, claims or cancels one.
 */
import { getData } from './client';
import type { ExpeditionOverview } from './types';

export function getExpeditions(
  playerId: number,
  signal?: AbortSignal,
): Promise<ExpeditionOverview> {
  return getData<ExpeditionOverview>(
    `/v1/players/${playerId}/expeditions`,
    signal ? { signal } : {},
  );
}
