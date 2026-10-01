/**
 * Vendor authoring: the list, creating a vendor with inventory and prices,
 * editing an existing one, and the guards around empty and in-use vendors.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as adminEncounters from '@/api/adminEncounters';
import * as adminVendors from '@/api/adminVendors';
import type { AdminVendor } from '@/api/adminVendors';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { VendorEditorPage } from '../VendorEditorPage';
import { VendorsListPage } from '../VendorsListPage';
import { EMPTY_SHOP, MERCHANT, REFERENCE } from './authoringFixtures';

let createSpy: MockInstance<typeof adminVendors.createAdminVendor>;
let updateSpy: MockInstance<typeof adminVendors.updateAdminVendor>;
let deleteSpy: MockInstance<typeof adminVendors.deleteAdminVendor>;

beforeEach(() => {
  const vendors = new Map<string, AdminVendor>([
    [MERCHANT.vendorKey, MERCHANT],
    [EMPTY_SHOP.vendorKey, EMPTY_SHOP],
  ]);
  vi.spyOn(adminEncounters, 'getAdminEncounterReference').mockResolvedValue(REFERENCE);
  vi.spyOn(adminVendors, 'listAdminVendors').mockImplementation(async () => ({
    vendors: [...vendors.values()],
  }));
  vi.spyOn(adminVendors, 'getAdminVendor').mockImplementation(async (key) => {
    const v = vendors.get(key);
    if (!v) throw new Error('not found');
    return v;
  });
  createSpy = vi.spyOn(adminVendors, 'createAdminVendor').mockImplementation(async (input) => {
    const v = { ...input, updatedAt: 'now', usedBy: [] };
    vendors.set(v.vendorKey, v);
    return v;
  });
  updateSpy = vi.spyOn(adminVendors, 'updateAdminVendor').mockImplementation(async (key, input) => {
    const v = { ...vendors.get(key)!, ...input };
    vendors.set(key, v);
    return v;
  });
  deleteSpy = vi.spyOn(adminVendors, 'deleteAdminVendor').mockResolvedValue({ ok: true });
});
afterEach(() => vi.restoreAllMocks());

function renderAt(
  path: string,
  permissions = ['admin.access', 'encounters.read', 'encounters.write'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(
    <Routes>
      <Route path="/admin/encounters/vendors" element={<VendorsListPage />} />
      <Route path="/admin/encounters/vendors/new" element={<VendorEditorPage />} />
      <Route path="/admin/encounters/vendors/:vendorKey" element={<VendorEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

describe('vendor list', () => {
  it('shows each vendor with its wares, prices and the encounters that open it', async () => {
    renderAt('/admin/encounters/vendors');
    const rows = await screen.findAllByTestId('vendor-row');
    expect(rows).toHaveLength(2);
    const merchant = rows.find((r) => r.textContent?.includes('The Wandering Merchant'))!;
    expect(merchant).toHaveTextContent('Basic Charm 75 WB · Energy Drink 125 WB');
    expect(merchant).toHaveTextContent('Opened by Market Stall');
    const empty = rows.find((r) => r.textContent?.includes('Empty Shop'))!;
    expect(within(empty).getByText('No inventory')).toBeInTheDocument();
  });
});

describe('creating a vendor', () => {
  it('generates the key from the name, and saves inventory with per-vendor prices', async () => {
    const user = renderAt('/admin/encounters/vendors/new');
    await user.type(await screen.findByLabelText('Name'), 'Night Market');
    expect(screen.getByText('night_market')).toBeInTheDocument();
    // Empty inventory is allowed but called out.
    expect(screen.getByTestId('vendor-warning')).toHaveTextContent('no inventory');

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Basic Charm — charm' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText('Add item'), 'basic_charm');
    await user.click(screen.getByRole('button', { name: 'Add to inventory' }));
    const price = screen.getByLabelText('Price of Basic Charm');
    await user.clear(price);
    await user.type(price, '75');
    await user.selectOptions(screen.getByLabelText('Currency for Basic Charm'), 'essence');
    const qty = screen.getByLabelText('Stock per visit of Basic Charm');
    await user.clear(qty);
    await user.type(qty, '3');
    expect(screen.queryByTestId('vendor-warning')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0]![0]).toEqual({
      vendorKey: 'night_market',
      name: 'Night Market',
      description: '',
      stock: [{ itemSlug: 'basic_charm', quantity: 3, price: 75, currency: 'essence' }],
    });
    // Lands on the saved vendor's own page.
    expect(await screen.findByText('Edit vendor — Night Market')).toBeInTheDocument();
  });

  it('refuses a price of zero before sending anything', async () => {
    const user = renderAt('/admin/encounters/vendors/new');
    await user.type(await screen.findByLabelText('Name'), 'Cheap');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Basic Charm — charm' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText('Add item'), 'basic_charm');
    await user.click(screen.getByRole('button', { name: 'Add to inventory' }));
    await user.clear(screen.getByLabelText('Price of Basic Charm'));
    expect(screen.getByTestId('vendor-issues')).toHaveTextContent(
      'Line 1: price must be a whole number',
    );
    expect(screen.getByRole('button', { name: 'Create vendor' })).toBeDisabled();
  });
});

describe('editing a vendor', () => {
  it('changes prices, removes and reorders items; the key stays fixed', async () => {
    const user = renderAt('/admin/encounters/vendors/wandering_merchant');
    await screen.findByText('Edit vendor — The Wandering Merchant');
    expect(screen.getByText(/fixed, because encounters refer to it/)).toBeInTheDocument();

    const price = screen.getByLabelText('Price of Energy Drink');
    await user.clear(price);
    await user.type(price, '99');
    await user.click(screen.getByRole('button', { name: 'Move Energy Drink up' }));
    await user.click(screen.getByRole('button', { name: 'Remove Basic Charm' }));
    await user.click(screen.getByRole('button', { name: 'Save vendor' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy.mock.calls[0]![0]).toBe('wandering_merchant');
    expect(updateSpy.mock.calls[0]![1].stock).toEqual([
      { itemSlug: 'energy_drink', quantity: 1, price: 99, currency: 'waifubux' },
    ]);
  });

  it('lists the encounters that open it and will not delete it while they do', async () => {
    renderAt('/admin/encounters/vendors/wandering_merchant');
    const usedBy = await screen.findByTestId('vendor-used-by');
    expect(within(usedBy).getByRole('link', { name: 'Market Stall' })).toHaveAttribute(
      'href',
      '/admin/encounters/6',
    );
    expect(screen.getByRole('button', { name: 'Delete vendor' })).toBeDisabled();
  });

  it('deletes an unused vendor', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = renderAt('/admin/encounters/vendors/empty_shop');
    await screen.findByText('Edit vendor — Empty Shop');
    await user.click(screen.getByRole('button', { name: 'Delete vendor' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('empty_shop'));
  });

  it('is read-only without write permission', async () => {
    renderAt('/admin/encounters/vendors/wandering_merchant', ['admin.access', 'encounters.read']);
    await screen.findByText('Edit vendor — The Wandering Merchant');
    expect(screen.getByRole('button', { name: 'Save vendor' })).toBeDisabled();
    expect(screen.getByLabelText('Price of Basic Charm')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete vendor' })).toBeNull();
  });
});
