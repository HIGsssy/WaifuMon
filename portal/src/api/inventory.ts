/**
 * `/api/v1/players/{id}/inventory` — held items and quantities.
 *
 * Not paginated: an inventory is bounded by the item catalog, and the service
 * omits zero-quantity rows.
 */
import { getData } from './client';
import type { InventoryEntry } from './types';

export function getInventory(playerId: number, signal?: AbortSignal): Promise<InventoryEntry[]> {
  return getData<InventoryEntry[]>(`/v1/players/${playerId}/inventory`, signal ? { signal } : {});
}
