/**
 * `/api/v1/shop/catalog` — the shop listing.
 *
 * Player-independent: `available` and `availabilityNote` come from the service
 * and the Portal renders them verbatim. Affordability is deliberately not
 * evaluated here or anywhere else in the client (plan §16).
 */
import { getData } from './client';
import type { ShopCatalogEntry } from './types';

export function getShopCatalog(signal?: AbortSignal): Promise<ShopCatalogEntry[]> {
  return getData<ShopCatalogEntry[]>('/v1/shop/catalog', signal ? { signal } : {});
}
