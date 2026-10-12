import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as loot from '@/api/adminDungeonLootTables';
import { PortalApiError } from '@/api/client';
import { READ, install, renderLoot } from './lootFixtures';

let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
});
const row = async (name: string) =>
  (await screen.findByRole('link', { name })).closest(
    '[data-testid="loot-table-row"]',
  ) as HTMLElement;

describe('Dungeon Loot Tables catalogue', () => {
  it('lists active tables with tier, usage and last update, and hides archived ones', async () => {
    renderLoot();
    const hoard = await row('Scrapheap Boss Hoard');
    expect(within(hoard).getByText('Boss')).toBeInTheDocument();
    expect(
      await within(hoard).findByText(/Used by 2 dungeons: Old Mine, Service Tunnels/),
    ).toHaveTextContent(/Updated .* by Whistler/);
    expect(
      await within(await row('Tunnel Cache')).findByText(/Not used by any dungeon/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Old Stash')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New loot table' })).toHaveAttribute(
      'href',
      '/admin/dungeons/loot/new',
    );
  });

  it('searches by name, filters by tier and can show archived tables', async () => {
    const user = userEvent.setup();
    renderLoot();
    await row('Tunnel Cache');
    await user.type(screen.getByLabelText('Search loot tables'), 'hoard');
    await waitFor(() => expect(screen.queryByText('Tunnel Cache')).not.toBeInTheDocument());
    expect(loot.listDungeonLootTables).toHaveBeenLastCalledWith(
      { includeArchived: false, search: 'hoard' },
      expect.anything(),
    );
    await user.clear(screen.getByLabelText('Search loot tables'));
    await user.click(screen.getByRole('button', { name: 'Common' }));
    await waitFor(() => expect(screen.queryByText('Scrapheap Boss Hoard')).not.toBeInTheDocument());
    expect(await row('Tunnel Cache')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByLabelText('Show archived'));
    expect(within(await row('Old Stash')).getByText('Archived')).toBeInTheDocument();
    expect(loot.listDungeonLootTables).toHaveBeenLastCalledWith(
      { includeArchived: true },
      expect.anything(),
    );
    await user.type(screen.getByLabelText('Search loot tables'), 'zzz');
    expect(
      await screen.findByText('No loot tables match. Try another name or tier.'),
    ).toBeVisible();
  });

  it('opens a table in the editor', async () => {
    const user = userEvent.setup();
    renderLoot();
    await user.click(await screen.findByRole('link', { name: 'Tunnel Cache' }));
    expect(await screen.findByRole('heading', { name: 'Loot table — Tunnel Cache' })).toBeVisible();
    expect(screen.getByLabelText('Table name')).toHaveValue('Tunnel Cache');
  });

  it('duplicates a table under a name, with a key the author never types', async () => {
    const user = userEvent.setup();
    world.tables.push({ ...world.tables[1]!, key: 'tunnel_cache_copy', name: 'Taken' });
    renderLoot();
    await user.click(await screen.findByRole('button', { name: 'Duplicate Tunnel Cache' }));
    const name = await screen.findByLabelText('Name of the copy');
    expect(name).toHaveValue('Tunnel Cache copy');
    expect(screen.getByText(/changing it never affects the original/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Duplicate table' }));
    await waitFor(() =>
      expect(loot.duplicateDungeonLootTable).toHaveBeenCalledWith('tunnel_cache', {
        key: 'tunnel_cache_copy_2',
        name: 'Tunnel Cache copy',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Loot table — Tunnel Cache copy' }),
    ).toBeVisible();
    expect(await screen.findAllByTestId('guaranteed-row')).toHaveLength(2);
  });

  it('archives with an explanation and restores', async () => {
    const user = userEvent.setup();
    renderLoot();
    await within(await row('Scrapheap Boss Hoard')).findByText(/Used by 2/);
    await user.click(screen.getByRole('button', { name: 'Archive Scrapheap Boss Hoard' }));
    expect(await screen.findByText(/keep paying the loot they were published with/)).toBeVisible();
    expect(screen.getByTestId('archive-warning')).toHaveTextContent(
      'Service Tunnels still uses it in its draft',
    );
    await user.click(screen.getByRole('button', { name: 'Archive table' }));
    await waitFor(() =>
      expect(loot.archiveDungeonLootTable).toHaveBeenCalledWith('scrapheap_boss_hoard', 3),
    );
    await waitFor(() => expect(screen.queryByText('Scrapheap Boss Hoard')).not.toBeInTheDocument());
    await user.click(screen.getByLabelText('Show archived'));
    await user.click(await screen.findByRole('button', { name: 'Restore Scrapheap Boss Hoard' }));
    await user.click(await screen.findByRole('button', { name: 'Restore table' }));
    await waitFor(() =>
      expect(loot.restoreDungeonLootTable).toHaveBeenCalledWith('scrapheap_boss_hoard', 4),
    );
  });

  it('offers delete only for archived tables and refuses while a dungeon needs the table', async () => {
    const user = userEvent.setup();
    renderLoot();
    await row('Tunnel Cache');
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show archived'));
    await within(await row('Pinned Stash')).findByText(/Used by 1 dungeon: Old Mine/);
    await user.click(screen.getByRole('button', { name: 'Delete Pinned Stash' }));
    expect(await screen.findByTestId('delete-blocked')).toHaveTextContent(
      'cannot be deleted while Old Mine still needs it',
    );
    expect(screen.getByRole('button', { name: 'Delete table' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Keep the table' }));
    expect(loot.deleteDungeonLootTable).not.toHaveBeenCalled();

    await within(await row('Old Stash')).findByText(/Not used/);
    await user.click(screen.getByRole('button', { name: 'Delete Old Stash' }));
    expect(await screen.findByText(/This cannot be undone/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete table' }));
    await waitFor(() => expect(loot.deleteDungeonLootTable).toHaveBeenCalledWith('old_stash', 2));
    await waitFor(() => expect(screen.queryByText('Old Stash')).not.toBeInTheDocument());
  });

  it('shows the server’s reason when a delete is refused after all', async () => {
    const user = userEvent.setup();
    renderLoot();
    await user.click(screen.getByLabelText('Show archived'));
    await within(await row('Old Stash')).findByText(/Not used/);
    world.usage.old_stash = {
      drafts: [
        { kind: 'draft', dungeonKey: 'new', name: 'New Depths', enabled: true, draftRevision: 1 },
      ],
      published: [],
    };
    await user.click(screen.getByRole('button', { name: 'Delete Old Stash' }));
    await user.click(await screen.findByRole('button', { name: 'Delete table' }));
    expect(await screen.findByTestId('delete-blocked')).toHaveTextContent('New Depths');
  });

  it('is view-only without dungeon write access', async () => {
    renderLoot('/admin/dungeons/loot', READ);
    await row('Tunnel Cache');
    expect(screen.getByTestId('loot-read-only')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Tunnel Cache' })).toHaveTextContent('View');
    for (const name of [/New loot table/, /^Duplicate/, /^Archive/, /^Delete/])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New loot table' })).not.toBeInTheDocument();
  });

  it('shows loading failures with a retry', async () => {
    vi.mocked(loot.listDungeonLootTables).mockRejectedValue(
      new PortalApiError({
        status: 403,
        code: 'PORTAL_PERMISSION_DENIED',
        message: 'Access denied',
      }),
    );
    renderLoot();
    expect(await screen.findByText('Could not load loot tables')).toBeVisible();
  });
});
