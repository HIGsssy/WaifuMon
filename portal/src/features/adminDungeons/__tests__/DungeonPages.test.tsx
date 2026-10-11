import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { install, renderAt, fixture, issue, PERMISSIONS } from './dungeonFixtures';
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
});
describe('Phase 1B.1 dungeon management', () => {
  it('loads definitions and preserves editable settings and currency panels', async () => {
    const user = userEvent.setup();
    renderAt('/admin/dungeons');
    expect(await screen.findByText('Tunnels')).toHaveAttribute(
      'href',
      '/admin/dungeons/definitions/tunnels',
    );
    expect(screen.getByText(/Draft 4 · Published 2/)).toBeInTheDocument();
    expect(screen.queryByText('Procedural')).not.toBeInTheDocument();
    const limit = await screen.findByLabelText('Daily run limit');
    await user.clear(limit);
    await user.type(limit, '5');
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(api.updateDungeonSettings).toHaveBeenCalledWith({ dailyRunLimit: 5 });
    const plural = screen.getByLabelText('Plural name');
    await user.clear(plural);
    await user.type(plural, 'Coins');
    await user.click(screen.getByRole('button', { name: 'Save currency' }));
    expect(api.updateProgressionCurrency).toHaveBeenCalledWith(
      'ascension_currency',
      expect.objectContaining({ pluralName: 'Coins' }),
      2,
    );
  });
  it('handles an empty list', async () => {
    vi.mocked(api.listDungeons).mockResolvedValue({ dungeons: [] });
    renderAt('/admin/dungeons');
    expect(await screen.findByText('No dungeons yet.')).toBeInTheDocument();
  });
  it('shows loading and API failure states', async () => {
    vi.mocked(api.getDungeon).mockRejectedValue(
      new PortalApiError({
        status: 403,
        code: 'PORTAL_PERMISSION_DENIED',
        message: 'Access denied',
      }),
    );
    renderAt();
    expect(screen.getByText('Loading dungeon…')).toBeInTheDocument();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });
  it('handles missing definitions', async () => {
    vi.mocked(api.getDungeon).mockRejectedValue(
      new PortalApiError({ status: 404, code: 'DUNGEON_NOT_FOUND', message: 'Missing dungeon' }),
    );
    renderAt();
    expect(await screen.findByText('Dungeon not found')).toBeInTheDocument();
  });
  it('retrieves the draft, saves metadata with its revision, and preserves room/layout data without publishing', async () => {
    const user = userEvent.setup();
    renderAt('/admin/dungeons/zones/tunnels');
    const name = await screen.findByLabelText('Dungeon name');
    await user.clear(name);
    await user.type(name, 'New Tunnels');
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved. Publication is unchanged.')).toBeInTheDocument();
    expect(api.saveDungeonDraft).toHaveBeenCalledWith('tunnels', {
      expectedRevision: 4,
      layout: fixture().layout,
      definition: expect.objectContaining({
        name: 'New Tunnels',
        rooms: fixture().draft.rooms,
        connections: fixture().draft.connections,
      }),
    });
    expect(api.publishDungeon).not.toHaveBeenCalled();
    expect(world.stored.layout).toEqual(fixture().layout);
  });
  it('preserves edits and blocks retry after a stale revision until explicit reload', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveDungeonDraft).mockRejectedValue(
      new PortalApiError({ status: 409, code: 'DUNGEON_DRAFT_STALE', message: 'Draft stale' }),
    );
    renderAt();
    const name = await screen.findByLabelText('Dungeon name');
    await user.clear(name);
    await user.type(name, 'My edits');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/A newer draft exists/)).toBeInTheDocument();
    expect(name).toHaveValue('My edits');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    world.stored = {
      ...fixture(),
      draftRevision: 8,
      draft: { ...fixture().draft, name: 'Other author' },
    };
    await user.click(
      screen.getByRole('button', { name: 'Reload latest draft (discard local edits)' }),
    );
    await waitFor(() => expect(name).toHaveValue('Other author'));
    expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1);
  });
  it('displays severity, location and validation failures and blocks invalid publication', async () => {
    world.stored = { ...fixture(), issues: [issue] };
    renderAt();
    expect(
      (await screen.findAllByText(/error: rooms\[0\].actions\[0\].waves\[0\].enemy/))[0],
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
  });
  it('shows validation returned for local draft edits', async () => {
    const user = userEvent.setup();
    vi.mocked(api.validateDungeon).mockResolvedValue({
      definition: fixture().draft,
      contentHash: 'h',
      issues: [{ ...issue, severity: 'warning' }],
      publishable: true,
    });
    renderAt();
    await screen.findByLabelText('Dungeon name');
    await user.click(screen.getByRole('button', { name: 'Validate draft' }));
    expect((await screen.findAllByText(/warning: rooms/))[0]).toBeInTheDocument();
  });
  it('keeps publication separate from write permission', async () => {
    renderAt(undefined, ['dungeons.read', 'dungeons.write']);
    await screen.findByLabelText('Dungeon name');
    expect(screen.queryByRole('button', { name: 'Publish draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Roll back to revision/ })).not.toBeInTheDocument();
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });
  it('publishes explicitly for a publisher without draft-write permission', async () => {
    const user = userEvent.setup();
    renderAt(undefined, ['dungeons.read', 'dungeons.publish']);
    expect(await screen.findByLabelText('Dungeon name')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    expect(await screen.findByText('Published revision 3.')).toBeInTheDocument();
    expect(api.publishDungeon).toHaveBeenCalledWith('tunnels', 4);
  });
  it('displays server publication validation failures', async () => {
    const user = userEvent.setup();
    vi.mocked(api.publishDungeon).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'DUNGEON_INVALID',
        message: 'Cannot publish',
        details: { issues: [issue] },
      }),
    );
    renderAt();
    await screen.findByLabelText('Dungeon name');
    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    expect(await screen.findByText('Cannot publish')).toBeInTheDocument();
    expect(screen.getByText(/Enemy ghost is missing/)).toBeInTheDocument();
  });
  it('requires confirmation naming the rollback revision and supports cancellation', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'History & export' }));
    await user.click(await screen.findByRole('button', { name: 'Roll back to revision 1' }));
    expect(api.rollbackDungeon).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Roll back Tunnels to revision 1?');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.rollbackDungeon).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Roll back to revision 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback to revision 1' }));
    expect(await screen.findByText('Published pointer moved to revision 1.')).toBeInTheDocument();
    expect(api.rollbackDungeon).toHaveBeenCalledWith('tunnels', 1);
  });
  it('inspects revisions/history and exports a bare dungeon package', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'History & export' }));
    await user.click(await screen.findByRole('button', { name: 'View revision 1' }));
    expect(await screen.findByText('Revision 1 content and layout')).toBeInTheDocument();
    expect(screen.getByText(/draft_saved/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export saved draft' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.exportDungeonPackage).toHaveBeenCalledWith('tunnels', 'draft');
  });
  it('creates only an unpublished starter draft', async () => {
    const user = userEvent.setup();
    renderAt('/admin/dungeons/new', PERMISSIONS);
    await user.type(screen.getByLabelText('Dungeon name'), 'Service Tunnels');
    await user.click(await screen.findByLabelText('Waifu Valley'));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Dungeon settings')).toBeInTheDocument();
    expect(api.createDungeon).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'service_tunnels',
        availableRegions: ['waifu-valley'],
        rooms: [expect.objectContaining({ id: 'entrance', extraction: true, actions: [] })],
      }),
    );
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });
});
