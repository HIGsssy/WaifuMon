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
  await page.getByLabel('Dungeon package file').setInputFiles({
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
  // The editor header states each of these as its own badge.
  for (const badge of ['Disabled', 'Draft 1', 'Unpublished'])
    await expect(page.getByText(badge, { exact: true })).toBeVisible();
});

for (const version of [2, 3] as const)
  for (const action of ['copy', 'use_existing'] as const) {
    test(`v${version} import reviews ${action} loot choices and confirms a stale plan again`, async ({
      page,
    }) => {
      await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
      const sourceHash = `sha256:${'a'.repeat(64)}`;
      const reviewedHash = `sha256:${'b'.repeat(64)}`;
      const body = (amount: number) => ({
        guaranteed: [
          {
            id: 'coins',
            grant: {
              type: 'currency' as const,
              currency: 'waifubux' as const,
              amount: { min: amount, max: amount },
            },
          },
        ],
        chances: [],
        pools: [],
      });
      const draft = starterDungeon('v2_imported', 'Imported reward dungeon', []);
      const pkg = { format: 'waifumon-dungeon-package', schemaVersion: version, dungeon: draft };
      let plans = 0;
      let applies = 0;
      let reviewedChoice: { action: 'copy'; key: string } | { action: 'use_existing' } | null =
        null;
      await page.route('**/api/v1/admin/dungeons/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        let data: unknown = {};
        if (path.endsWith('/import/plan')) {
          plans++;
          const request = route.request().postDataJSON();
          expect(request.package).toEqual(pkg);
          reviewedChoice = request.lootTables?.coin_hoard ?? null;
          if (reviewedChoice)
            expect(reviewedChoice).toEqual(
              action === 'copy' ? { action, key: 'my_coin_copy' } : { action },
            );
          const plan: DungeonImportPlan = {
            validPackage: true,
            packageId: 'source-package',
            packageHash: sourceHash,
            sourceEnvironment: 'staging',
            dungeonKey: draft.key,
            contentHash: sourceHash,
            planHash: reviewedChoice ? reviewedHash : sourceHash,
            target: {
              status: 'new',
              expectedRevision: null,
              currentContentHash: null,
              changedFields: [],
            },
            enemies: [],
            lootTables: [
              {
                key: 'coin_hoard',
                name: 'Coin hoard',
                status: 'different',
                currentRevision: plans > 2 ? 3 : 2,
                currentHash: 'destination',
                incomingHash: 'source',
                currentName: 'Local coins',
                archived: false,
                incomingBody: body(7),
                currentBody: body(99),
                decision: reviewedChoice,
                targetKey: reviewedChoice?.action === 'copy' ? reviewedChoice.key : 'coin_hoard',
                suggestedCopyKey: 'coin_hoard_imported',
              },
            ],
            equipmentChanges: [],
            ...(version === 3
              ? {
                  eventDependencies: {
                    eventCount: 3,
                    poolCount: 1,
                    requiredItems: [
                      { key: 'vault_key', name: 'Vault Key', status: 'available' as const },
                      { key: 'absent_key', name: 'Ancient Key', status: 'missing' as const },
                      { key: 'disabled_key', name: 'Rusty Key', status: 'disabled' as const },
                    ],
                  },
                }
              : {}),
            resultingContentHash: action === 'copy' && reviewedChoice ? reviewedHash : sourceHash,
            issues: !reviewedChoice
              ? [
                  {
                    code: 'loot_table_decision_required',
                    severity: 'error',
                    path: 'lootTables.coin_hoard',
                    message: 'Choose a loot decision.',
                  },
                ]
              : action === 'use_existing'
                ? [
                    {
                      code: 'loot_table_rewards_differ',
                      severity: 'warning',
                      path: 'lootTables.coin_hoard',
                      message: 'Destination rewards differ.',
                    },
                  ]
                : [],
            publishable: reviewedChoice !== null && version !== 3,
          };
          if (version === 3)
            plan.issues.push(
              {
                code: 'event_item_missing',
                severity: 'error',
                path: 'dependencies.requiredItems.absent_key',
                message: 'Ancient Key is missing here.',
              },
              {
                code: 'event_item_disabled',
                severity: 'error',
                path: 'dependencies.requiredItems.disabled_key',
                message: 'Rusty Key is disabled here.',
              },
            );
          data = plan;
        } else if (path.endsWith('/import/apply')) {
          applies++;
          const input = route.request().postDataJSON();
          expect(input).toMatchObject({
            package: pkg,
            expectedPlanHash: reviewedHash,
            decisions: { lootTables: { coin_hoard: reviewedChoice } },
          });
          if (applies === 1) {
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'DUNGEON_IMPORT_STALE',
                  message: 'Loot table changed during review.',
                },
              },
            });
            return;
          }
          data = {
            importId: 1,
            dungeonKey: draft.key,
            result: 'created',
            draftRevision: 1,
            createdEnemies: [],
            createdLootTables: action === 'copy' ? ['my_coin_copy'] : [],
            reusedLootTables: action === 'use_existing' ? ['coin_hoard'] : [],
            contentHash: action === 'copy' ? reviewedHash : sourceHash,
            issues: [],
            publishable: true,
            replayed: false,
          };
        } else if (path.endsWith('/definitions')) data = { dungeons: [] };
        else if (path.endsWith('/reward-health')) data = { dungeons: [] };
        else if (path.endsWith('/currencies')) data = { currencies: [] };
        else if (path.endsWith('/settings'))
          data = {
            dailyRunLimit: 3,
            dailyRunLimitMin: 0,
            dailyRunLimitMax: 50,
            updatedAt: null,
            updatedBy: null,
          };
        await route.fulfill({ json: { data, meta: { requestId: 'import-v2-e2e' } } });
      });
      await page.goto('/admin/dungeons');
      await page.getByRole('button', { name: 'Import Dungeon', exact: true }).click();
      await page.getByLabel('Dungeon package file').setInputFiles({
        name: `v${version}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(pkg)),
      });
      if (version === 3) {
        await expect(page.getByText('3 events · 1 event pool')).toBeVisible();
        await expect(page.getByText('Vault Key: Available here')).toBeVisible();
        await expect(
          page.getByText('Ancient Key: Missing here — repair before publication'),
        ).toBeVisible();
        await expect(
          page.getByText('Rusty Key: Disabled here — enable before publication'),
        ).toBeVisible();
      }
      await expect(page.getByText('Guaranteed: 7 WaifuBux')).toBeVisible();
      await expect(page.getByText('Guaranteed: 99 WaifuBux')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Apply import as draft' })).toBeDisabled();
      await page.getByLabel('Decision for loot table Coin hoard').selectOption(action);
      if (action === 'copy') await page.getByLabel('New key for Coin hoard').fill('my_coin_copy');
      else
        await expect(
          page.getByText(/Using destination rewards can give different amounts/),
        ).toBeVisible();
      await page.getByRole('button', { name: 'Preview loot choices' }).click();
      await expect(page.getByText(/Loot choices need/)).toHaveCount(0);
      await page.getByLabel('Approve create dungeon draft').check();
      if (version === 3) {
        const acceptance = page.getByLabel(/Accept permitted missing dependencies/);
        if (!(await acceptance.isChecked())) {
          await expect(page.getByRole('button', { name: 'Apply import as draft' })).toBeDisabled();
          await acceptance.check();
        }
      }
      if (action === 'use_existing')
        await page.getByLabel(/Acknowledge all reported warnings/).check();
      await page.getByRole('button', { name: 'Apply import as draft' }).click();
      await expect(page.getByText('Import conflict — review again')).toBeVisible();
      await page.getByRole('button', { name: 'Review a new plan' }).click();
      await expect(page.getByRole('button', { name: 'Apply import as draft' })).toBeDisabled();
      if (action === 'copy')
        await expect(page.getByLabel('New key for Coin hoard')).toHaveValue('my_coin_copy');
      else
        await expect(page.getByLabel('Decision for loot table Coin hoard')).toHaveValue(
          'use_existing',
        );
      await page.getByLabel('Approve create dungeon draft').check();
      if (version === 3) {
        const acceptance = page.getByLabel(/Accept permitted missing dependencies/);
        if (!(await acceptance.isChecked())) {
          await expect(page.getByRole('button', { name: 'Apply import as draft' })).toBeDisabled();
          await acceptance.check();
        }
      }
      if (action === 'use_existing')
        await page.getByLabel(/Acknowledge all reported warnings/).check();
      await page.getByRole('button', { name: 'Apply import as draft' }).click();
      await expect(page.getByText(/Import successful/)).toBeVisible();
      expect(plans).toBe(3);
      expect(applies).toBe(2);
    });
  }
