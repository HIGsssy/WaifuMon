/**
 * A vendor's inventory as a table: item, price (this vendor's own, in
 * Waifubux or Essence), and how many one visit offers.
 *
 * Order is meaningful — it is the order the shop lists its wares in — so rows
 * can be moved. There is no "unlimited" stock: the engine gives every visit a
 * fresh copy of these quantities and counts them down as the player buys.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import {
  VENDOR_PRICE_MAX,
  VENDOR_QUANTITY_MAX,
  VENDOR_STOCK_MAX_LINES,
  type VendorStockLine,
} from '@/api/adminVendors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { EntitySelect, selectClass } from './EntitySelect';

interface Props {
  stock: VendorStockLine[];
  items: AdminEncounterReference['items'];
  onChange: (stock: VendorStockLine[]) => void;
  disabled?: boolean | undefined;
}

export function VendorInventoryEditor({ stock, items, onChange, disabled }: Props) {
  const [adding, setAdding] = useState('');
  const itemName = (slug: string) => items.find((i) => i.slug === slug)?.name ?? slug;
  const stocked = new Set(stock.map((s) => s.itemSlug));
  const addable = items
    .filter((i) => !stocked.has(i.slug))
    .map((i) => ({ value: i.slug, label: i.name, hint: i.category }));

  const set = (i: number, changes: Partial<VendorStockLine>) =>
    onChange(stock.map((line, k) => (k === i ? { ...line, ...changes } : line)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...stock];
    const [line] = next.splice(i, 1);
    next.splice(i + by, 0, line!);
    onChange(next);
  };
  const full = stock.length >= VENDOR_STOCK_MAX_LINES;

  return (
    <div className="space-y-3" data-testid="vendor-inventory">
      {stock.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-ink-muted">
          No items yet. Add what this vendor sells below.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-1 pr-2">Item</th>
                <th className="py-1 pr-2">Price</th>
                <th className="py-1 pr-2">Stock per visit</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {stock.map((line, i) => (
                <tr
                  key={line.itemSlug || i}
                  className="border-t border-border"
                  data-testid="vendor-stock-row"
                >
                  <td className="py-2 pr-2 font-medium">{itemName(line.itemSlug)}</td>
                  <td className="py-2 pr-2">
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        min="1"
                        max={VENDOR_PRICE_MAX}
                        step="1"
                        aria-label={`Price of ${itemName(line.itemSlug)}`}
                        value={Number.isFinite(line.price) ? line.price : ''}
                        disabled={disabled}
                        onChange={(e) => set(i, { price: Number(e.target.value) })}
                        className="w-24"
                      />
                      <select
                        aria-label={`Currency for ${itemName(line.itemSlug)}`}
                        value={line.currency}
                        disabled={disabled}
                        onChange={(e) =>
                          set(i, { currency: e.target.value as VendorStockLine['currency'] })
                        }
                        className={cn(selectClass, 'w-28')}
                      >
                        <option value="waifubux">Waifubux</option>
                        <option value="essence">Essence</option>
                      </select>
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <Input
                      type="number"
                      min="1"
                      max={VENDOR_QUANTITY_MAX}
                      step="1"
                      aria-label={`Stock per visit of ${itemName(line.itemSlug)}`}
                      value={Number.isFinite(line.quantity) ? line.quantity : ''}
                      disabled={disabled}
                      onChange={(e) => set(i, { quantity: Number(e.target.value) })}
                      className="w-20"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${itemName(line.itemSlug)} up`}
                      disabled={disabled || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${itemName(line.itemSlug)} down`}
                      disabled={disabled || i === stock.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${itemName(line.itemSlug)}`}
                      disabled={disabled}
                      onClick={() => onChange(stock.filter((_, k) => k !== i))}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!disabled && (
        <div className="flex flex-wrap items-end gap-2">
          <EntitySelect
            label="Add item"
            value={adding}
            options={addable}
            onChange={setAdding}
            placeholder={full ? 'Inventory is full' : '— pick an item —'}
            searchLabel="Search items to add"
            className="min-w-56 flex-1"
            disabled={full}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!adding || full}
            onClick={() => {
              onChange([
                ...stock,
                { itemSlug: adding, quantity: 1, price: 100, currency: 'waifubux' },
              ]);
              setAdding('');
            }}
          >
            Add to inventory
          </Button>
        </div>
      )}
      <p className="text-[11px] text-ink-muted">
        Prices are this vendor’s own. Each visit starts with the stock shown here, and the counts go
        down as the player buys; up to {VENDOR_STOCK_MAX_LINES} items.
      </p>
    </div>
  );
}
