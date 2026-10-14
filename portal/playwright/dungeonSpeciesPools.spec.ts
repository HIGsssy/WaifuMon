/** Browser fixture uses the production validator and species analysis, loaded only at test runtime. */
import { expect, test, type Page } from '@playwright/test';
import type {
  DungeonDefinition,
  DungeonSpeciesRef,
  DungeonSpeciesScenario,
} from '@/api/adminDungeons';
import { starterDungeon } from '@/features/adminDungeons/dungeonModel';
import { serveDungeon, validate } from './dungeonBackend';
import { stubApi } from './stubApi';
const AUTHORING = '../../src/modules/dungeons/engine/speciesAuthoring';
const catalog: DungeonSpeciesRef[] = [
  {
    slug: 'android',
    name: 'Test Android',
    rarity: 'SR',
    race: 'android',
    affinity: 'switch',
    enabled: true,
    regionExclusive: false,
    dungeonExclusive: true,
    permitted: true,
    unavailableReason: null,
    dungeonAccess: [{ dungeon: 'species_halls', perPlayerLimit: 2, directRescue: true }],
    perPlayerLimit: 2,
    directRescue: { available: true, reason: null },
  },
  {
    slug: 'angel',
    name: 'Restricted Angel',
    rarity: 'UR',
    race: 'angel',
    affinity: 'caregiver',
    enabled: true,
    regionExclusive: true,
    dungeonExclusive: false,
    permitted: false,
    unavailableReason: 'not_permitted',
    dungeonAccess: [],
    perPlayerLimit: null,
    directRescue: { available: false, reason: 'direct_not_permitted' },
  },
];
function dungeon(withPool = false): DungeonDefinition {
  const d = starterDungeon('species_halls', 'Species Halls', ['waifu-valley']);
  d.rooms.push({ id: 'exit', name: 'Way Out', kind: 'exit', actions: [] });
  d.connections.push({ id: 'way_out', from: d.entranceRoomId, to: 'exit', label: 'Way out' });
  d.flags = [{ key: 'open', scope: 'run', description: 'Vault opened' }];
  if (withPool)
    d.speciesPools = [
      {
        id: 'pool',
        name: 'Wild',
        entries: [
          { id: 'one', species: 'android', weight: 3, oncePerRun: true },
          { id: 'none', nothing: true, weight: 1 },
        ],
      },
    ];
  return d;
}
async function open(
  page: Page,
  d = dungeon(),
  permissions = ['dungeons.read', 'dungeons.write', 'dungeons.publish'],
) {
  await stubApi(page, { session: { permissions } });
  const backend = await serveDungeon(page, d);
  const scenarios: DungeonSpeciesScenario[] = [];
  await page.route('**/api/v1/admin/dungeons/species?*', (route) =>
    route.fulfill({ json: { data: { species: catalog } } }),
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
  await page.route('**/api/v1/admin/dungeons/validate', async (route) => {
    const body = route.request().postDataJSON();
    const report = await validate(body.definition);
    const { describeSpeciesAuthoring } = await import(AUTHORING);
    if (body.speciesScenario) scenarios.push(body.speciesScenario);
    await route.fulfill({
      json: {
        data: {
          ...report,
          contentHash: 'hash',
          publishable: !report.issues.some((i) => i.severity === 'error'),
          ...(report.definition
            ? describeSpeciesAuthoring(
                report.definition,
                catalog.map((s) => ({ ...s, archetype: s.race })),
                body.speciesScenario,
              )
            : { speciesPools: [] }),
        },
      },
    });
  });
  await page.goto(`/admin/dungeons/definitions/${d.key}`);
  await expect(page.getByRole('heading', { level: 1, name: d.name })).toBeVisible();
  return { backend, scenarios };
}
const panel = (page: Page) => page.getByTestId('dungeon-species-pools');
const sheet = (page: Page) => page.getByTestId('species-pool-editor');

test('pool creation, picker restrictions, weights, conditions, Nothing and stable save/reload', async ({
  page,
}) => {
  const { backend } = await open(page);
  await panel(page).getByRole('button', { name: '+ New WaifuMon pool' }).click();
  await sheet(page).getByLabel('WaifuMon pool name').fill('Wild androids');
  await sheet(page).getByRole('button', { name: '+ Add species' }).click();
  await expect(
    sheet(page).getByRole('button', { name: 'Add species Restricted Angel' }),
  ).toBeDisabled();
  await expect(sheet(page).getByTestId('species-option-angel')).toContainText('Region-exclusive');
  await expect(sheet(page).getByTestId('species-android-thumbnail').getByRole('img')).toBeVisible();
  await sheet(page).getByLabel('Search species').fill('Android');
  await expect(
    sheet(page).getByRole('button', { name: 'Add species Restricted Angel' }),
  ).toHaveCount(0);
  await sheet(page).getByLabel('Filter species by rarity').selectOption('SR');
  await sheet(page).getByLabel('Filter species by race').selectOption('android');
  await sheet(page).getByRole('button', { name: 'Add species Test Android' }).click();
  await sheet(page).getByLabel('Entry 1 weight').fill('3');
  await sheet(page).getByLabel('Entry 1: once per run').uncheck();
  await sheet(page).getByLabel('Entry 1 is in the draw type').selectOption('flag');
  await sheet(page).getByRole('button', { name: '+ Add Nothing' }).click();
  await sheet(page).getByLabel('Entry 2 nothing text').fill('Quiet.');
  await sheet(page).getByLabel('Assume flag Vault opened').check();
  await expect(sheet(page).getByRole('region', { name: 'In this simulated run' })).toContainText(
    'Nothing: 25%',
  );
  await page.getByRole('button', { name: 'Close WaifuMon pool' }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => backend.saves).toBe(1);
  const saved = structuredClone(backend.detail.draft.speciesPools);
  expect(saved?.[0]?.id).toMatch(/^sp_[a-f0-9]{32}$/);
  expect(saved?.[0]?.entries[0]).toMatchObject({
    weight: 3,
    oncePerRun: false,
    when: { type: 'flag', flag: 'open' },
  });
  await page.reload();
  await panel(page).getByRole('button', { name: 'Edit WaifuMon pool Wild androids' }).click();
  await expect(sheet(page).getByLabel('Entry 1 weight')).toHaveValue('3');
  expect(backend.detail.draft.speciesPools).toEqual(saved);
  expect(backend.detail.draft).not.toHaveProperty('eventPools');
  const overflow = await sheet(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('duplicates independently, lists encounter usage and blocks deletion while referenced', async ({
  page,
}) => {
  const d = dungeon(true);
  d.rooms[0]!.actions.push({
    id: 'wild',
    type: 'wild_encounter',
    source: { kind: 'pool', poolId: 'pool' },
    intro: '',
    capture: { maxAttempts: 3, allowGuaranteedItems: true },
  });
  const { backend } = await open(page, d);
  await expect(panel(page)).toContainText('Entrance — Wild Encounter');
  await panel(page).getByRole('button', { name: 'Delete WaifuMon pool Wild', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Can’t delete');
  await expect(page.getByRole('button', { name: 'Delete WaifuMon pool', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await panel(page)
    .getByRole('button', { name: 'Duplicate WaifuMon pool Wild', exact: true })
    .click();
  await panel(page).getByRole('button', { name: 'Edit WaifuMon pool Wild (copy)' }).click();
  await sheet(page).getByLabel('Entry 1 weight').fill('9');
  await page.getByRole('button', { name: 'Close WaifuMon pool' }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => backend.saves).toBe(1);
  expect(backend.detail.draft.speciesPools!.map((p) => p.entries[0]!.weight)).toEqual([3, 9]);
  await panel(page).getByRole('button', { name: 'Delete WaifuMon pool Wild (copy)' }).click();
  await page.getByRole('button', { name: 'Delete WaifuMon pool', exact: true }).click();
  await expect(panel(page).getByTestId('species-pool-row')).toHaveCount(1);
});

test('server scenario changes preserve limited weights, then exclude species already encountered', async ({
  page,
}) => {
  const { backend, scenarios } = await open(page, dungeon(true));
  await panel(page).getByRole('button', { name: 'Edit WaifuMon pool Wild' }).click();
  const odds = sheet(page).getByRole('region', { name: 'In this simulated run' });
  await expect(odds).toContainText('Test Android: 75%');
  await sheet(page).getByLabel('Assumed acquisitions for Test Android').fill('2');
  await expect(odds).toContainText('Unavailable outcome: 75%');
  await expect(odds).toContainText('Test Android: 75%');
  await sheet(page).getByLabel('Assume encountered Test Android').check();
  await expect(odds).toContainText('Nothing: 100%');
  await expect(odds).toContainText('Excluded: already encountered');
  expect(scenarios.at(-1)).toMatchObject({
    seenSpecies: ['android'],
    acquisitions: { android: 2 },
  });
  expect(backend.saves).toBe(0);
});

test('unfinished drafts have friendly checklist focus and duplicate publishing errors', async ({
  page,
}) => {
  const d = dungeon(true);
  d.speciesPools![0]!.entries.push({ id: 'dupe', species: 'android', weight: 1 });
  await open(page, d);
  await expect(page.getByRole('button', { name: 'Publish draft', exact: true })).toBeDisabled();
  await expect(page.getByText(/Duplicate species pool identity/).first()).toBeVisible();
  await panel(page).getByRole('button', { name: 'Edit WaifuMon pool Wild' }).click();
  await sheet(page).getByRole('button', { name: 'Remove species pool entry 3' }).click();
  await sheet(page).getByLabel('Entry 1 weight').fill('');
  await expect(sheet(page)).toContainText('Finish this field before saving');
  await page.getByRole('button', { name: 'Close WaifuMon pool' }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Show me: WaifuMon pool .*Weight must/ }).click();
  await expect(sheet(page).getByLabel('Entry 1 weight')).toBeFocused();
});

test('read-only pool inspection is usable on narrow screens', async ({ page }) => {
  await open(page, dungeon(true), ['dungeons.read']);
  await panel(page).getByRole('button', { name: 'View WaifuMon pool Wild' }).click();
  await expect(sheet(page).getByLabel('WaifuMon pool name')).toBeDisabled();
  await expect(sheet(page).getByRole('button', { name: '+ Add species' })).toHaveCount(0);
  await expect(sheet(page).getByRole('region', { name: 'In this simulated run' })).toContainText(
    'Nothing: 25%',
  );
  await sheet(page).getByLabel('Assume encountered Test Android').check();
  await expect(sheet(page).getByRole('region', { name: 'In this simulated run' })).toContainText(
    'Nothing: 100%',
  );
  expect(await sheet(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
    1,
  );
});
