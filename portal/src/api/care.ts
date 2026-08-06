/**
 * `/api/v1/players/{id}/care` — Care Mode state.
 *
 * Read-only in every sense: the API documents `careService.getState` as
 * non-mutating, and `pendingTicks` is a forecast that reading never banks.
 */
import { getData } from './client';
import type { CareState } from './types';

export function getCareState(playerId: number, signal?: AbortSignal): Promise<CareState> {
  return getData<CareState>(`/v1/players/${playerId}/care`, signal ? { signal } : {});
}
