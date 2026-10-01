/**
 * The vendor editor's form state and checks — pure, no React.
 *
 * Mirrors the server's rules (`VendorStockEntrySchema`, `vendorStockIssues`)
 * so a bad line is caught next to the field; the server still re-validates.
 */
import {
  VENDOR_PRICE_MAX,
  VENDOR_QUANTITY_MAX,
  VENDOR_STOCK_MAX_LINES,
  type AdminVendor,
  type VendorInput,
  type VendorStockLine,
} from '@/api/adminVendors';
import { isValidSlug } from './slugs';

export interface VendorFormState {
  vendorKey: string;
  /** False once the author edits the key by hand, so the name stops driving it. */
  keyFromName: boolean;
  name: string;
  description: string;
  stock: VendorStockLine[];
}

export const EMPTY_VENDOR_FORM: VendorFormState = {
  vendorKey: '',
  keyFromName: true,
  name: '',
  description: '',
  stock: [],
};

export function vendorFormFrom(v: AdminVendor): VendorFormState {
  return {
    vendorKey: v.vendorKey,
    keyFromName: false,
    name: v.name,
    description: v.description,
    stock: v.stock.map((s) => ({ ...s })),
  };
}

export function vendorInputOf(f: VendorFormState): VendorInput {
  return { name: f.name.trim(), description: f.description, stock: f.stock };
}

export function vendorFormErrors(
  f: VendorFormState,
  opts: { isNew: boolean; takenKeys: ReadonlySet<string>; itemSlugs?: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];
  if (!f.name.trim()) errors.push('Give the vendor a name.');
  if (opts.isNew) {
    if (!isValidSlug(f.vendorKey)) {
      errors.push('The key must be 1–64 lowercase letters, numbers or underscores.');
    } else if (opts.takenKeys.has(f.vendorKey)) {
      errors.push(`Another vendor already uses the key “${f.vendorKey}”.`);
    }
  }
  if (f.stock.length > VENDOR_STOCK_MAX_LINES) {
    errors.push(`A vendor can stock at most ${VENDOR_STOCK_MAX_LINES} items.`);
  }
  const seen = new Set<string>();
  f.stock.forEach((line, i) => {
    const where = `Line ${i + 1}`;
    if (!line.itemSlug) errors.push(`${where}: pick an item.`);
    else if (seen.has(line.itemSlug)) errors.push(`${where}: this item is already stocked.`);
    else if (opts.itemSlugs && !opts.itemSlugs.has(line.itemSlug)) {
      errors.push(`${where}: “${line.itemSlug}” is not a known item.`);
    }
    seen.add(line.itemSlug);
    if (!Number.isInteger(line.price) || line.price < 1 || line.price > VENDOR_PRICE_MAX) {
      errors.push(
        `${where}: price must be a whole number from 1 to ${VENDOR_PRICE_MAX.toLocaleString('en-US')}.`,
      );
    }
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > VENDOR_QUANTITY_MAX
    ) {
      errors.push(
        `${where}: stock per visit must be a whole number from 1 to ${VENDOR_QUANTITY_MAX}.`,
      );
    }
  });
  return errors;
}

export function vendorFormWarnings(f: VendorFormState): string[] {
  return f.stock.length === 0
    ? ['This vendor has no inventory — players will find nothing to buy.']
    : [];
}
