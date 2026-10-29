import { expect, test } from '@playwright/test';
import type { SharedPool, SharedPoolDefinition } from '@/api/adminDungeonSpeciesPools';
import type { DungeonSpeciesRef } from '@/api/adminDungeons';
import { stubApi } from './stubApi';

test('shared pool creation, persistent multi-add and compact mobile layout', async ({
  page,
}, info) => {
  await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
  const base: DungeonSpeciesRef = {
    slug: 'exclusive',
    name: 'Unassigned Angel',
    rarity: 'N',
    race: 'angel',
    affinity: 'switch',
    regions: [],
    enabled: true,
    dungeonExclusive: true,
    regionExclusive: false,
    permitted: false,
    unavailableReason: 'not_permitted',
    dungeonPolicyAllowed: true,
    dungeonAccess: [],
    perPlayerLimit: null,
    directRescue: { available: false, reason: 'not_permitted' },
  };
  const catalogue = [
    base,
    {
      ...base,
      slug: 'multi',
      name: 'Travelling Angel',
      regions: ['waifu-valley', 'twin-peeks'],
      dungeonExclusive: false,
    },
  ];
  const pools: SharedPool[] = [
    {
      revision: 1,
      definition: {
        key: 'night_angels',
        name: 'Night Angels',
        description: '',
        enabled: true,
        entries: [{ id: 'e', species: base.slug, weight: 1, oncePerRun: true }],
      },
    },
  ];
  let created: SharedPoolDefinition | undefined;
  await page.route('**/api/v1/admin/dungeons/waifumon-pools**', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'POST') {
      created = route.request().postDataJSON() as SharedPoolDefinition;
      const saved = { definition: created, revision: 1 };
      pools.push(saved);
      return route.fulfill({ json: { data: saved } });
    }
    return route.fulfill({
      json: {
        data:
          key === 'waifumon-pools'
            ? pools
            : key === 'references'
              ? []
              : pools.find((p) => p.definition.key === key),
      },
    });
  });
  await page.route('**/api/v1/admin/dungeons/species?*', (route) =>
    route.fulfill({
      json: {
        data: {
          species: catalogue,
          regions: [
            { id: 'waifu-valley', name: 'Waifu Valley' },
            { id: 'twin-peeks', name: 'Twin Peeks' },
          ],
        },
      },
    }),
  );
  await page.route('**/api/v1/admin/dungeons/species/artwork?*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );

  await page.goto('/admin/dungeons/waifumon-pools');
  await expect(page.getByRole('heading', { name: 'Dungeon WaifuMon Pools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export all JSON' })).toBeHidden();
  await page.getByText('Advanced / Import–Export', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review import' })).toBeVisible();
  await page.getByText('Advanced / Import–Export', { exact: true }).click();
  await page.getByRole('button', { name: 'Create pool' }).click();
  await page.getByLabel('Pool name', { exact: true }).fill('Night Angels');
  await expect(page.getByTestId('pool-key-preview')).toHaveText('night_angels_2');
  await page.getByRole('button', { name: 'Add WaifuMon', exact: true }).click();
  await page.getByLabel('Search species').fill('Angel');
  await page.getByLabel('Filter species by region', { exact: true }).selectOption('unassigned');
  await page.getByLabel('Filter species by dungeon exclusivity').selectOption('dungeon');
  await page.getByRole('button', { name: 'Add species Unassigned Angel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Remove species Unassigned Angel', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter species by region', { exact: true }).selectOption('twin-peeks');
  await page.getByLabel('Filter species by dungeon exclusivity').selectOption('other');
  await page.getByRole('button', { name: 'Add species Travelling Angel', exact: true }).click();
  await expect(page.getByLabel('Search species')).toHaveValue('Angel');
  await expect(page.getByLabel('Filter species by region', { exact: true })).toHaveValue(
    'twin-peeks',
  );
  await expect(
    page.getByRole('region', { name: 'Selected WaifuMon and weights' }).getByRole('listitem'),
  ).toHaveCount(2);
  await page.getByLabel('Entry 1 weight', { exact: true }).fill('7');
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.evaluate(() => document.body.clientWidth),
  );
  await page.screenshot({ path: `/tmp/pool-ux-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save pool', exact: true }).click();
  await expect(page).toHaveURL(/waifumon-pools\/night_angels_2$/);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(created).toMatchObject({
    key: 'night_angels_2',
    enabled: false,
    entries: [
      { species: 'exclusive', weight: 7 },
      { species: 'multi', weight: 1 },
    ],
  });
});
