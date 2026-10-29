import { expect, test } from '@playwright/test';
import type { DungeonImportPlan } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { stubApi } from './stubApi';
for (const incomplete of [false, true])
  test(`v4 imports ${incomplete ? 'repair' : 'complete'} drafts after dependency review`, async ({
    page,
  }) => {
    await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
    const hash = `sha256:${'a'.repeat(64)}`;
    const pkg = {
      format: 'waifumon-dungeon-package',
      schemaVersion: 4,
      dungeon: starterDungeon('v4_import', 'V4 import', []),
    };
    let applies = 0;
    await page.route('**/api/v1/admin/dungeons/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path.endsWith('/import/plan')) {
        const plan: DungeonImportPlan = {
          validPackage: true,
          packageId: 'source',
          packageHash: hash,
          sourceEnvironment: 'staging',
          dungeonKey: 'v4_import',
          contentHash: hash,
          planHash: hash,
          target: {
            status: 'new',
            expectedRevision: null,
            currentContentHash: null,
            changedFields: [],
            enabled: null,
            publishedRevision: null,
          },
          enemies: [],
          lootTables: [],
          equipmentChanges: [],
          encounterDependencies: {
            encounterCount: 1,
            poolCount: 1,
            requiredSpecies: [
              {
                slug: 'dungeon_waifu',
                name: 'Dungeon Waifu',
                status: incomplete ? 'restricted' : 'available',
                modes: ['direct'],
                sourceRarity: 'R',
                targetRarity: 'N',
                changes: ['Rarity: R → N'],
                directRescue: !incomplete,
                perPlayerLimit: incomplete ? null : 2,
              },
            ],
            captureItems: [
              {
                key: 'basic_charm',
                name: 'Basic Charm',
                status: incomplete ? 'missing' : 'available',
                rarities: ['N'],
                guaranteed: false,
              },
            ],
          },
          issues: [
            {
              code: 'package_species_rarity_changed',
              severity: 'warning',
              path: 'dependencies.requiredSpecies',
              message: 'Rarity differs here.',
            },
            ...(incomplete
              ? [
                  {
                    code: 'species_not_permitted',
                    severity: 'error' as const,
                    path: 'dependencies.requiredSpecies',
                    message: 'Destination authorization required.',
                  },
                  {
                    code: 'capture_item_missing',
                    severity: 'error' as const,
                    path: 'dependencies.captureItems',
                    message: 'Capture item missing.',
                  },
                ]
              : []),
          ],
          publishable: !incomplete,
        };
        data = plan;
      } else if (path.endsWith('/import/apply')) {
        applies++;
        expect(route.request().postDataJSON()).toMatchObject({
          package: pkg,
          expectedPlanHash: hash,
          decisions: { dungeon: 'create', allowMissingDependencies: incomplete },
        });
        data = {
          importId: 1,
          dungeonKey: 'v4_import',
          result: 'created',
          draftRevision: 1,
          createdEnemies: [],
          createdLootTables: [],
          reusedLootTables: [],
          sourceSchemaVersion: 4,
          issues: [],
          publishable: !incomplete,
          replayed: false,
        };
      } else if (path.endsWith('/definitions') || path.endsWith('/reward-health'))
        data = { dungeons: [] };
      else if (path.endsWith('/currencies')) data = { currencies: [] };
      else if (path.endsWith('/settings'))
        data = {
          dailyRunLimit: 3,
          dailyRunLimitMin: 0,
          dailyRunLimitMax: 50,
          updatedAt: null,
          updatedBy: null,
        };
      await route.fulfill({ json: { data, meta: { requestId: 'v4-browser' } } });
    });
    await page.goto('/admin/dungeons');
    await page.getByRole('button', { name: 'Import Dungeon', exact: true }).click();
    await page
      .getByLabel('Dungeon package file')
      .setInputFiles({
        name: 'v4.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(pkg)),
      });
    await expect(page.getByText(/Dungeon Waifu \(dungeon_waifu\)/)).toBeVisible();
    await expect(page.getByText('Rarity: R → N')).toBeVisible();
    await expect(page.getByText(/Basic Charm \(basic_charm\)/)).toBeVisible();
    await expect(
      page.getByText(/Species, capture items and central access policies are never imported/),
    ).toBeVisible();
    const apply = page.getByRole('button', { name: 'Apply import as draft' });
    await page.getByLabel('Approve create dungeon draft').check();
    await expect(apply).toBeDisabled();
    await page.getByLabel(/Acknowledge all reported warnings/).check();
    if (incomplete) {
      await expect(apply).toBeDisabled();
      await page.getByLabel(/Accept permitted missing dependencies/).check();
    }
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByText(/Import successful/)).toBeVisible();
    expect(applies).toBe(1);
  });
