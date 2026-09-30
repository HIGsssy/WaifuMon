/**
 * Portal admin API client for World Encounter vendors.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/vendors.ts`. A vendor's stock lines
 * carry this vendor's own price and currency, and `quantity` is how many a
 * single visit offers — each encounter visit gets a fresh copy of the stock.
 */
import { deleteData, getData, postData, putData } from './client';

export type VendorCurrency = 'waifubux' | 'essence';

export interface VendorStockLine {
  itemSlug: string;
  /** How many one visit offers (1–999). There is no "unlimited". */
  quantity: number;
  price: number;
  currency: VendorCurrency;
}

export interface AdminVendor {
  vendorKey: string;
  name: string;
  description: string;
  stock: VendorStockLine[];
  updatedAt: string;
  usedBy: Array<{ id: number; slug: string; name: string; lifecycle: string }>;
}

export interface VendorInput {
  name: string;
  description: string;
  stock: VendorStockLine[];
}

/** Server limits, mirrored for the editor (`VendorStockEntrySchema`). */
export const VENDOR_STOCK_MAX_LINES = 20;
export const VENDOR_QUANTITY_MAX = 999;
export const VENDOR_PRICE_MAX = 1_000_000;

export const VENDORS_QUERY_KEY = ['admin', 'vendors'] as const;

export function listAdminVendors(signal?: AbortSignal): Promise<{ vendors: AdminVendor[] }> {
  return getData<{ vendors: AdminVendor[] }>('/v1/admin/vendors', signal ? { signal } : {});
}

export function getAdminVendor(vendorKey: string, signal?: AbortSignal): Promise<AdminVendor> {
  return getData<AdminVendor>(
    `/v1/admin/vendors/${encodeURIComponent(vendorKey)}`,
    signal ? { signal } : {},
  );
}

export function createAdminVendor(
  input: VendorInput & { vendorKey: string },
): Promise<AdminVendor> {
  return postData<AdminVendor>('/v1/admin/vendors', input);
}

export function updateAdminVendor(vendorKey: string, input: VendorInput): Promise<AdminVendor> {
  return putData<AdminVendor>(`/v1/admin/vendors/${encodeURIComponent(vendorKey)}`, input);
}

export function deleteAdminVendor(vendorKey: string): Promise<{ ok: boolean }> {
  return deleteData<{ ok: boolean }>(`/v1/admin/vendors/${encodeURIComponent(vendorKey)}`);
}
