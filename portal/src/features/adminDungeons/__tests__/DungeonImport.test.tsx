import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { install, renderAt, fixture } from './dungeonFixtures';
import { IMPORT_BODY_LIMIT, requestBytes } from '../dungeonImportModel';

const hash = `sha256:${'a'.repeat(64)}`;
const pkg = {
  format: 'waifumon-dungeon-package',
  schemaVersion: 1,
  packageId: 'source-package',
  dungeon: fixture().draft,
};
const planOf = (patch: Partial<api.DungeonImportPlan> = {}): api.DungeonImportPlan => ({
  validPackage: true,
  packageId: 'source-package',
  packageHash: hash,
  sourceEnvironment: 'staging',
  dungeonKey: 'tunnels',
  contentHash: hash,
  planHash: hash,
  target: { status: 'new', expectedRevision: null, currentContentHash: null, changedFields: [] },
  enemies: [],
  issues: [],
  publishable: true,
  ...patch,
});
const receipt: api.DungeonImportResult = {
  importId: 1,
  dungeonKey: 'tunnels',
  result: 'created',
  draftRevision: 1,
  createdEnemies: [],
  issues: [],
  publishable: true,
  replayed: false,
};
beforeEach(() => {
  install();
  vi.spyOn(api, 'planDungeonImport').mockResolvedValue(planOf());
  vi.spyOn(api, 'applyDungeonImport').mockResolvedValue(receipt);
});
async function open() {
  const user = userEvent.setup();
  renderAt('/admin/dungeons');
  await user.click(screen.getByRole('button', { name: 'Import Dungeon' }));
  return user;
}
async function upload(user: ReturnType<typeof userEvent.setup>, contents = JSON.stringify(pkg)) {
  await user.upload(
    screen.getByLabelText('Dungeon package file'),
    new File([contents], 'package.json', { type: 'application/json' }),
  );
  await screen.findByText('Source environment: staging');
}
const applyButton = () => screen.getByRole('button', { name: 'Apply import as draft' });
describe('Dungeon package import core workflow', () => {
  it('plans the untouched package, displays identity, and requires explicit draft approval', async () => {
    const user = await open();
    expect(screen.getByText(/No file selected/)).toBeInTheDocument();
    await upload(user);
    expect(api.planDungeonImport).toHaveBeenCalledWith(pkg);
    expect(screen.getByText('Selected file: package.json')).toBeInTheDocument();
    expect(screen.getByText(/Schema version: 1/)).toBeInTheDocument();
    expect(screen.getByText('Package identity: source-package')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByRole('link', { name: 'Open imported dungeon draft' });
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        package: pkg,
        expectedRevision: null,
        expectedPlanHash: hash,
        requestId: expect.any(String),
        decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false },
      }),
    );
    expect(api.publishDungeon).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: 'Open imported dungeon draft' }));
    await screen.findByRole('button', { name: 'Save draft' });
  });
  it('rejects invalid JSON without planning', async () => {
    const user = await open();
    await user.upload(
      screen.getByLabelText('Dungeon package file'),
      new File(['{bad'], 'broken.json'),
    );
    await screen.findByText(/Invalid JSON/);
    expect(api.planDungeonImport).not.toHaveBeenCalled();
  });
  it('rejects oversized files and non-JSON filenames locally', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Dungeon package file'), {
      target: { files: [new File(['x'.repeat(IMPORT_BODY_LIMIT + 1)], 'big.json')] },
    });
    await screen.findByText('The selected file exceeds 2 MiB.');
    fireEvent.change(screen.getByLabelText('Dungeon package file'), {
      target: { files: [new File(['{}'], 'bundle.zip')] },
    });
    await screen.findByText('Select a .json Dungeon Content Package.');
    expect(api.planDungeonImport).not.toHaveBeenCalled();
  });
  it('accounts for UTF-8 and JSON wrapping before planning', async () => {
    const user = await open();
    const text = JSON.stringify('é'.repeat((IMPORT_BODY_LIMIT - 2) / 2));
    expect(new Blob([text]).size).toBe(IMPORT_BODY_LIMIT);
    await user.upload(screen.getByLabelText('Dungeon package file'), new File([text], 'big.json'));
    await screen.findByText(/wrapped planning request exceeds/);
    expect(api.planDungeonImport).not.toHaveBeenCalled();
  });
  it('checks the exact apply body as well as the plan body', async () => {
    const user = await open();
    const nearLimit = { padding: 'x'.repeat(IMPORT_BODY_LIMIT - 100) };
    expect(requestBytes({ package: nearLimit })).toBeLessThan(IMPORT_BODY_LIMIT);
    await user.upload(
      screen.getByLabelText('Dungeon package file'),
      new File([JSON.stringify(nearLimit)], 'big.json'),
    );
    await screen.findByText('Source environment: staging');
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText(/wrapped apply request exceeds/);
    expect(api.applyDungeonImport).not.toHaveBeenCalled();
  });
  it('requires supported bundled enemy creation, conflict use-existing and warning acknowledgement', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf({
        publishable: false,
        enemies: [
          {
            key: 'slime',
            status: 'missing_bundled',
            currentRevision: null,
            currentHash: null,
            incomingHash: hash,
            changedFields: [],
          },
          {
            key: 'dragon',
            status: 'different',
            currentRevision: 3,
            currentHash: 'other',
            incomingHash: hash,
            changedFields: ['hp'],
          },
        ],
        issues: [
          {
            code: 'enemy_missing',
            severity: 'error',
            path: 'dungeon.rooms[0].actions[0].waves[0].enemy',
            message: 'Slime is missing',
          },
          {
            code: 'enemy_conflict',
            severity: 'warning',
            path: 'dependencies.enemies.dragon',
            message: 'Dragon differs from source',
          },
          {
            code: 'artwork_missing',
            severity: 'warning',
            path: 'dungeon.artwork',
            message: 'Artwork must be deployed separately',
          },
        ],
      }),
    );
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(applyButton()).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Decision for enemy slime'), 'create');
    await user.selectOptions(screen.getByLabelText('Decision for enemy dragon'), 'use_existing');
    expect(applyButton()).toBeDisabled();
    await user.click(screen.getByLabelText(/Acknowledge all reported warnings/));
    expect(applyButton()).toBeEnabled();
    await user.click(applyButton());
    await waitFor(() =>
      expect(api.applyDungeonImport).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: {
            dungeon: 'create',
            enemies: { slime: 'create', dragon: 'use_existing' },
            allowMissingDependencies: false,
          },
        }),
      ),
    );
  });
  it('accepts permitted missing dependencies only by explicit incomplete-draft choice', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf({
        publishable: false,
        enemies: [
          {
            key: 'ghost',
            status: 'missing',
            currentRevision: null,
            currentHash: null,
            incomingHash: null,
            changedFields: [],
          },
        ],
        issues: [
          {
            code: 'enemy_missing',
            severity: 'error',
            path: 'dungeon.rooms',
            message: 'Ghost missing',
          },
          {
            code: 'reward_table_missing',
            severity: 'error',
            path: 'dungeon.rooms',
            message: 'Table missing',
          },
        ],
      }),
    );
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.selectOptions(screen.getByLabelText('Decision for enemy ghost'), 'leave_missing');
    expect(applyButton()).toBeDisabled();
    await user.click(screen.getByLabelText(/Accept permitted missing dependencies/));
    expect(applyButton()).toBeEnabled();
  });
  it.each(['room_unreachable', 'item_missing', 'package_dependencies_mismatch'])(
    'never waives blocking %s errors',
    async (code) => {
      vi.mocked(api.planDungeonImport).mockResolvedValue(
        planOf({
          issues: [{ code, severity: 'error', path: 'dungeon.rooms', message: 'Blocking defect' }],
        }),
      );
      const user = await open();
      await upload(user);
      await user.click(screen.getByLabelText('Approve create dungeon draft'));
      expect(screen.getByText(/Blocking error: Blocking defect/)).toBeInTheDocument();
      expect(applyButton()).toBeDisabled();
    },
  );
  it('blocks structurally invalid packages even if a code is normally waivable', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf({
        validPackage: false,
        issues: [
          {
            code: 'region_missing',
            severity: 'error',
            path: 'dungeon',
            message: 'Invalid manifest',
          },
        ],
      }),
    );
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(screen.getByLabelText(/Accept permitted missing dependencies/));
    expect(applyButton()).toBeDisabled();
  });
  it('warns explicitly before replacing a draft and sends the reviewed revision', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf({
        target: {
          status: 'different',
          expectedRevision: 4,
          currentContentHash: 'old',
          changedFields: ['rooms'],
        },
      }),
    );
    const user = await open();
    await upload(user);
    expect(screen.getByText(/Replacement overwrites existing draft changes/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Approve replace dungeon draft'));
    await user.click(applyButton());
    await waitFor(() =>
      expect(api.applyDungeonImport).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          decisions: expect.objectContaining({ dungeon: 'replace' }),
        }),
      ),
    );
  });
  it('handles unchanged results without publication', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf({
        target: {
          status: 'identical',
          expectedRevision: 4,
          currentContentHash: hash,
          changedFields: [],
        },
      }),
    );
    vi.mocked(api.applyDungeonImport).mockResolvedValue({
      ...receipt,
      result: 'unchanged',
      draftRevision: 4,
    });
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve unchanged dungeon draft'));
    await user.click(applyButton());
    await screen.findByText(/Import unchanged/);
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });
  it('preserves package after stale conflicts and requires explicit replan and new decisions', async () => {
    vi.mocked(api.applyDungeonImport).mockRejectedValueOnce(
      new PortalApiError({ status: 409, code: 'DUNGEON_IMPORT_STALE', message: 'Draft changed' }),
    );
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText('Import conflict — review again');
    expect(api.planDungeonImport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Apply import as draft' })).not.toBeInTheDocument();
    const first = vi.mocked(api.applyDungeonImport).mock.calls[0]![0];
    await user.click(screen.getByRole('button', { name: 'Review a new plan' }));
    await waitFor(() => expect(api.planDungeonImport).toHaveBeenCalledTimes(2));
    expect(applyButton()).toBeDisabled();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText(/Import successful/);
    expect(vi.mocked(api.applyDungeonImport).mock.calls[1]![0].requestId).not.toBe(first.requestId);
  });
  it.each([0, 503])(
    'retries ambiguous status %s with the same ID and exact payload',
    async (status) => {
      vi.mocked(api.applyDungeonImport)
        .mockRejectedValueOnce(
          new PortalApiError({ status, code: 'UNKNOWN', message: 'No confirmed result' }),
        )
        .mockResolvedValueOnce({ ...receipt, replayed: true });
      const user = await open();
      await upload(user);
      await user.click(screen.getByLabelText('Approve create dungeon draft'));
      await user.click(applyButton());
      await screen.findByText('Import outcome uncertain');
      expect(screen.getByLabelText('Dungeon package file')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel import' })).toBeDisabled();
      expect(screen.getByLabelText('Approve create dungeon draft')).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Retry same import' }));
      await screen.findByText(/Original receipt confirmed by retry/);
      const calls = vi.mocked(api.applyDungeonImport).mock.calls;
      expect(calls[1]![0]).toBe(calls[0]![0]);
      expect(JSON.stringify(calls[1]![0])).toBe(JSON.stringify(calls[0]![0]));
      expect(api.planDungeonImport).toHaveBeenCalledTimes(1);
    },
  );
  it('shows planning permission errors and allows cancellation', async () => {
    vi.mocked(api.planDungeonImport).mockRejectedValue(
      new PortalApiError({ status: 403, code: 'FORBIDDEN', message: 'Write permission denied' }),
    );
    const user = await open();
    await user.upload(
      screen.getByLabelText('Dungeon package file'),
      new File([JSON.stringify(pkg)], 'pkg.json'),
    );
    await screen.findByText('Write permission denied');
    expect(api.applyDungeonImport).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(screen.queryByLabelText('Dungeon package file')).not.toBeInTheDocument();
  });
  it('retains an uncertain request through a permission refusal on retry', async () => {
    vi.mocked(api.applyDungeonImport)
      .mockRejectedValueOnce(
        new PortalApiError({ status: 0, code: 'TIMEOUT', message: 'Timed out', kind: 'timeout' }),
      )
      .mockRejectedValueOnce(
        new PortalApiError({ status: 403, code: 'FORBIDDEN', message: 'Restore write permission' }),
      )
      .mockResolvedValueOnce({ ...receipt, replayed: true });
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText('Import outcome uncertain');
    await user.click(screen.getByRole('link', { name: 'Create dungeon' }));
    expect(screen.getByLabelText('Dungeon package file')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry same import' }));
    await screen.findByText('Restore write permission');
    expect(screen.getByRole('button', { name: 'Cancel import' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry same import' }));
    await screen.findByText(/Original receipt confirmed by retry/);
    const inputs = vi.mocked(api.applyDungeonImport).mock.calls.map((c) => c[0]);
    expect(inputs[1]).toBe(inputs[0]);
    expect(inputs[2]).toBe(inputs[0]);
  });
  it('treats unconfirmed success responses as uncertain and retries unchanged', async () => {
    vi.mocked(api.applyDungeonImport)
      .mockResolvedValueOnce({
        importId: 1,
        dungeonKey: 'tunnels',
        result: 'created',
      } as api.DungeonImportResult)
      .mockResolvedValueOnce(receipt);
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText('Import outcome uncertain');
    await user.click(screen.getByRole('button', { name: 'Retry same import' }));
    await screen.findByText(/Import successful/);
    const calls = vi.mocked(api.applyDungeonImport).mock.calls;
    expect(calls[1]![0]).toBe(calls[0]![0]);
  });
  it('allows a different file to be reviewed without retaining old decisions', async () => {
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await upload(user, JSON.stringify({ ...pkg, packageId: 'another' }));
    await waitFor(() => expect(api.planDungeonImport).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Approve create dungeon draft')).not.toBeChecked();
    expect(applyButton()).toBeDisabled();
  });
  it('hides import for read-only administrators', async () => {
    renderAt('/admin/dungeons', ['dungeons.read']);
    await screen.findByText('Tunnels');
    expect(screen.queryByRole('button', { name: 'Import Dungeon' })).not.toBeInTheDocument();
  });
  it('displays backend rejection issues and requires a new review after refusal', async () => {
    vi.mocked(api.applyDungeonImport).mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'DUNGEON_IMPORT_INVALID',
        message: 'Import refused',
        details: {
          issues: [{ path: 'dungeon.rooms', message: 'Install target reward dependencies first' }],
        },
      }),
    );
    const user = await open();
    await upload(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(applyButton());
    await screen.findByText('Import refused');
    expect(
      screen.getByText('Install target reward dependencies first (dungeon.rooms)'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review a new plan' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry same import' })).not.toBeInTheDocument();
    expect(api.planDungeonImport).toHaveBeenCalledTimes(1);
  });
});
