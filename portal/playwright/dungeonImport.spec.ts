import { expect, test } from '@playwright/test';
import type { DungeonDetail, DungeonImportPlan } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { stubApi } from './stubApi';

test('upload, review an enemy conflict, import a draft and open it', async ({ page }) => {
  await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
  const hash = `sha256:${'a'.repeat(64)}`;
  const draft = starterDungeon('imported', 'Imported dungeon', []);
  const pkg = {
    format: 'waifumon-dungeon-package',
    schemaVersion: 1,
    dungeon: draft,
    packageId: 'source-package',
  };
  const plan: DungeonImportPlan = {
    validPackage: true,
    packageId: 'source-package',
    sourceEnvironment: 'staging',
    dungeonKey: draft.key,
    packageHash: hash,
    contentHash: hash,
    planHash: hash,
    target: { status: 'new', expectedRevision: null, currentContentHash: null, changedFields: [] },
    enemies: [
      {
        key: 'slime',
        status: 'different',
        currentRevision: 3,
        currentHash: 'other',
        incomingHash: hash,
        changedFields: ['hp'],
      },
    ],
    issues: [
      {
        code: 'enemy_conflict',
        severity: 'warning',
        path: 'dependencies.enemies.slime',
        message: 'Slime differs from source; keep target.',
      },
    ],
    publishable: true,
  };
  const detail: DungeonDetail = {
    key: draft.key,
    name: draft.name,
    enabled: false,
    position: 0,
    roomCount: 1,
    draftRevision: 1,
    draftHash: hash,
    published: null,
    draftDiffers: true,
    open: false,
    updatedAt: '2026-10-10T00:00:00Z',
    updatedBy: 'author',
    draft,
    layout: {},
    issues: [],
  };
  let applyCount = 0;
  await page.route('**/api/v1/admin/dungeons/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = detail;
    if (path.endsWith('/import/plan')) {
      expect(route.request().postDataJSON()).toEqual({ package: pkg });
      data = plan;
    } else if (path.endsWith('/import/apply')) {
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({
        package: pkg,
        expectedPlanHash: hash,
        expectedRevision: null,
        decisions: {
          dungeon: 'create',
          enemies: { slime: 'use_existing' },
          allowMissingDependencies: false,
        },
      });
      expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
      applyCount++;
      data = {
        importId: 1,
        dungeonKey: draft.key,
        result: 'created',
        draftRevision: 1,
        createdEnemies: [],
        issues: [],
        publishable: true,
        replayed: false,
      };
    } else if (path.endsWith('/import-history')) data = { imports: [] };
    else if (path.endsWith('/definitions')) data = { dungeons: [] };
    else if (path.endsWith('/revisions')) data = { revisions: [] };
    else if (path.endsWith('/history')) data = { events: [] };
    else if (path.endsWith('/reference'))
      data = {
        regions: [],
        currencies: [],
        enemies: [],
        rewardTables: [],
        actionTypes: [],
        reservedActionTypes: {},
      };
    else if (path.endsWith('/currencies')) data = { currencies: [] };
    else if (path.endsWith('/settings'))
      data = {
        dailyRunLimit: 3,
        dailyRunLimitMin: 0,
        dailyRunLimitMax: 50,
        updatedAt: null,
        updatedBy: null,
      };
    await route.fulfill({ json: { data, meta: { requestId: 'import-e2e' } } });
  });
  await page.goto('/admin/dungeons');
  await page.getByRole('button', { name: 'Import Dungeon', exact: true }).click();
  await page
    .getByLabel('Dungeon package file')
    .setInputFiles({
      name: 'dungeon.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(pkg)),
    });
  await expect(page.getByText('Source environment: staging')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply import as draft' })).toBeDisabled();
  await page.getByLabel('Approve create dungeon draft').check();
  await page.getByLabel('Decision for enemy slime').selectOption('use_existing');
  await page.getByLabel(/Acknowledge all reported warnings/).check();
  await page.getByRole('button', { name: 'Apply import as draft' }).click();
  await expect(page.getByText(/Import successful/)).toBeVisible();
  expect(applyCount).toBe(1);
  await page.getByRole('link', { name: 'Open imported dungeon draft' }).click();
  await expect(page).toHaveURL(/\/definitions\/imported$/);
  await expect(page.getByRole('heading', { name: 'Imported dungeon' })).toBeVisible();
  await expect(page.getByText('Disabled · Draft 1 · Unpublished')).toBeVisible();
});
