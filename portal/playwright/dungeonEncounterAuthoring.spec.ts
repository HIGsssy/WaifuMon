import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { DungeonSpeciesRef } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { serveDungeon, validate } from './dungeonBackend';
import { stubApi } from './stubApi';
const SANDBOX = '../../src/modules/dungeons/engine/sandbox';
const FACTS = '../../src/modules/dungeons/dungeonEncounterAuthoring';
const PRESENTER = '../../src/discord/dungeonEncounterPreview';
const POOLS = '../../src/modules/dungeons/engine/speciesAuthoring';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=',
  'base64',
);
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
    dungeonAccess: [{ dungeon: 'encounter_halls', perPlayerLimit: 1, directRescue: true }],
    perPlayerLimit: 1,
    directRescue: { available: true, reason: null },
  },
  {
    slug: 'elf',
    name: 'Test Elf',
    rarity: 'R',
    race: 'elf',
    affinity: 'switch',
    enabled: true,
    regionExclusive: false,
    dungeonExclusive: false,
    permitted: true,
    unavailableReason: null,
    dungeonAccess: [],
    perPlayerLimit: null,
    directRescue: { available: false, reason: 'direct_not_permitted' },
  },
  {
    slug: 'restricted',
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
function definition(withEncounter = false) {
  const d = starterDungeon('encounter_halls', 'Encounter Halls', ['waifu-valley']);
  d.flags = [{ key: 'open', scope: 'run', description: 'Companion found' }];
  d.rooms.push({ id: 'exit', name: 'Way Out', kind: 'exit', actions: [] });
  d.connections.push({ id: 'out', from: d.entranceRoomId, to: 'exit', label: 'Way out' });
  d.speciesPools = [
    {
      id: 'pool',
      name: 'Wild',
      entries: [
        { id: 'one', species: 'android', weight: 3 },
        { id: 'two', species: 'elf', weight: 1 },
        { id: 'none', nothing: true, weight: 1 },
      ],
    },
  ];
  if (withEncounter)
    d.rooms[0]!.actions.unshift({
      id: 'encounter',
      type: 'wild_encounter',
      source: { kind: 'species', species: 'android' },
      intro: 'She appears.',
      capture: { maxAttempts: 2, allowGuaranteedItems: false },
      results: {
        captured: { text: 'Together at last.', flags: [{ flag: 'open', value: true }] },
        escaped: { text: 'She is gone.' },
      },
    });
  return d;
}
const live = {
  encounterSource: {
    species: (slug: string) => {
      const s = catalog.find((s) => s.slug === slug);
      return (
        s && {
          enabled: s.enabled,
          restricted: s.regionExclusive || s.dungeonExclusive,
          access: s.dungeonAccess,
        }
      );
    },
    item: (slug: string) => (slug === 'basic_charm' ? { enabled: true, capture: true } : undefined),
    hasUsableCaptureItem: () => true,
  },
};
async function open(page: Page, d = definition()) {
  await stubApi(page, {
    session: { permissions: ['dungeons.read', 'dungeons.write', 'dungeons.publish'] },
  });
  const backend = await serveDungeon(
    page,
    d,
    { rooms: {}, notes: [] },
    { reference: () => ({ lootTables: [], items: [] }), context: async () => live },
  );
  await page.route('**/api/v1/admin/dungeons/species?*', (r) =>
    r.fulfill({ json: { data: { species: catalog } } }),
  );
  await page.route('**/api/v1/admin/dungeons/capture-items', (r) =>
    r.fulfill({
      json: {
        data: {
          items: [
            {
              slug: 'basic_charm',
              name: 'Basic Charm',
              enabled: true,
              guaranteed: false,
              rarities: null,
            },
          ],
        },
      },
    }),
  );
  await page.route('**/api/v1/admin/dungeons/species/artwork?*', (r) =>
    r.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/api/v1/admin/dungeons/scene-preview', (r) =>
    r.fulfill({ contentType: 'image/png', body: png, headers: { 'x-dungeon-scene': 'sprite' } }),
  );
  await page.route('**/api/v1/admin/dungeons/*/species-status', (r) =>
    r.fulfill({ json: { data: { revisions: [] } } }),
  );
  await page.route('**/api/v1/admin/dungeons/validate', async (r) => {
    const body = r.request().postDataJSON();
    const report = await validate(body.definition, live);
    const pools = await import(POOLS);
    await r.fulfill({
      json: {
        data: {
          ...report,
          publishable: !report.issues.some((i) => i.severity === 'error'),
          ...(report.definition
            ? pools.describeSpeciesAuthoring(
                report.definition,
                catalog.map((s) => ({ ...s, archetype: s.race })),
                body.speciesScenario,
              )
            : { speciesPools: [] }),
        },
      },
    });
  });
  const run = async (body: any, preview = false) => {
    const { createDungeonSandbox } = await import(SANDBOX);
    const { createEncounterAuthoringFacts, authoringCaptureRng } = await import(FACTS);
    const report = await validate(body.definition, live);
    const def = structuredClone(report.definition) as any;
    if (preview) {
      const room = def.rooms.find((r: any) => r.id === body.roomId);
      const a = room.actions.find((a: any) => a.id === body.actionId);
      a.source = { kind: 'species', species: body.species };
      delete a.when;
      a.outcomes = {};
      delete a.next;
      room.actions = [
        a,
        { id: 'after', type: 'rest', label: '', healBasisPoints: 0, optional: false, outcomes: {} },
      ];
      def.entranceRoomId = room.id;
    }
    const catalogue = {
      species: catalog.map((s) => ({
        ...s,
        tags: s.regionExclusive
          ? ['region_exclusive']
          : s.dungeonExclusive
            ? ['dungeon_exclusive']
            : [],
        baseCaptureRate: null,
      })),
      items: [
        {
          slug: 'basic_charm',
          name: 'Basic Charm',
          category: 'capture',
          enabled: true,
          isGuaranteedCapture: false,
          captureRarities: null,
          captureModifier: 1,
          captureBonus: 0,
        },
      ],
      speciesAccess: Object.fromEntries(catalog.map((s) => [s.slug, s.dungeonAccess])),
    };
    const inventory = preview ? { basic_charm: 3 } : body.inventory;
    const scenario = preview
      ? {
          captureOutcome:
            body.stage === 'captured' || body.stage === 'rescued'
              ? 'success'
              : body.stage === 'failure' || body.stage === 'escaped'
                ? 'failure'
                : 'normal',
        }
      : body.encounterScenario;
    const content = {
      species: [],
      tables: JSON.parse(fs.readFileSync(path.resolve('../content/tables.json'), 'utf8')),
    };
    const facts = createEncounterAuthoringFacts({
      definition: def,
      catalogue,
      content,
      inventory,
      scenario,
    });
    const sandbox = createDungeonSandbox({
      definition: def,
      fighter: { waifuId: 0, name: 'Simulated Buddy', attack: 60, defense: 30, maxHp: 400 },
      dependencies: { enemies: {}, rewardTables: {} },
      seed: body.seed ?? 1,
      encounterFactsFor: facts.factsFor,
      rng: authoringCaptureRng(body.seed ?? 1, scenario?.captureOutcome),
    });
    for (const input of body.inputs ?? []) await sandbox.input(input);
    if (preview && ['captured', 'rescued', 'failure', 'escaped'].includes(body.stage)) {
      if (sandbox.view.action?.encounter?.mode === 'direct')
        await sandbox.input({ type: 'rescue' });
      else {
        await sandbox.input({ type: 'select_item', item: 'basic_charm' });
        await sandbox.input({ type: 'capture' });
      }
    }
    return { sandbox, def, catalogue, facts };
  };
  await page.route('**/api/v1/admin/dungeons/encounter-preview', async (r) => {
    const b = await run(r.request().postDataJSON(), true);
    const { buildEncounterAuthoringPreview } = await import(PRESENTER);
    await r.fulfill({
      json: {
        data: buildEncounterAuthoringPreview(
          b.def,
          b.sandbox,
          b.catalogue.species,
          b.catalogue.items,
        ),
      },
    });
  });
  await page.route('**/api/v1/admin/dungeons/sandbox', async (r) => {
    const body = r.request().postDataJSON();
    const b = await run(body);
    await r.fulfill({
      json: {
        data: {
          view: b.sandbox.view,
          state: b.sandbox.state,
          effects: b.sandbox.effects,
          eventResults: [],
          encounterDiagnostics: b.facts.diagnostics,
          simulatedGrants: b.facts.grants(b.sandbox.effects),
          steps: body.inputs.length,
          stoppedBy: null,
          refusal: null,
        },
      },
    });
  });
  await page.goto(`/admin/dungeons/definitions/${d.key}`);
  await expect(page.getByRole('heading', { name: d.name, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  return backend;
}
async function expandEncounter(page: Page) {
  const button = page.getByRole('button', { name: /Activity \d+: Wild Encounter/ });
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
}
const editor = (page: Page) => page.getByTestId('encounter-editor');
test('creates wild encounter, rules and placement; saves/reloads on desktop and narrow screens', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add Wild Encounter' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Choose WaifuMon' }).click();
  await expect(
    page.getByRole('button', { name: 'Select species Restricted Angel' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Select species Test Android' }).click();
  await editor(page).getByLabel('Encounter introduction').fill('A companion at the door.');
  await editor(page).getByLabel('Capture attempt limit').fill('1');
  await editor(page).getByLabel('Permitted capture charms').selectOption('subset');
  await editor(page).getByLabel('Permit charm Basic Charm').check();
  await editor(page).getByLabel('Mirror encountered WaifuMon').check();
  await editor(page).getByLabel('Sprite position').selectOption('center');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  await expandEncounter(page);
  await expect(editor(page).getByLabel('Encounter introduction')).toHaveValue(
    'A companion at the door.',
  );
  await expect(editor(page).getByLabel('Mirror encountered WaifuMon')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('pool source switching, species preview, production presenter and pool editor link', async ({
  page,
}) => {
  await open(page, definition(true));
  await expandEncounter(page);
  await editor(page).getByLabel('Encounter source').selectOption('pool');
  await editor(page).getByLabel('WaifuMon pool', { exact: true }).selectOption('pool');
  await expect(
    editor(page).getByRole('region', { name: 'Pool selection probabilities' }),
  ).toContainText('Nothing: 20%');
  await editor(page).getByLabel('Preview pool species').selectOption('elf');
  await expect(editor(page).getByAltText('Encounter scene: Test Elf')).toBeVisible();
  await expect(editor(page).getByTestId('encounter-discord-preview')).toContainText('Test Elf');
  await editor(page).getByRole('button', { name: 'Edit selected pool' }).click();
  await expect(page.getByTestId('species-pool-editor')).toBeVisible();
});
test('direct rescue authorization is explained and Show me repairs invalid publication', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add Rescue', exact: true }).click();
  await editor(page).getByLabel('Rescue mode').selectOption('direct');
  await expect(editor(page).getByLabel('Capture attempt limit')).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'Choose WaifuMon' }).click();
  await page.getByRole('button', { name: 'Select species Test Elf' }).click();
  await expect(editor(page)).toContainText('Direct rescue is not authorized');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const todo = page.getByRole('button', { name: /To do/ });
  if ((await todo.getAttribute('aria-expanded')) === 'false') await todo.click();
  const issue = page.getByRole('button', { name: /Show me:.*rescue/i }).first();
  await expect(issue).toBeVisible();
  await issue.click();
  await expect(editor(page).getByLabel('Rescue mode')).toHaveValue('direct');
});
test('sandbox forces capture success and failure with simulated ownership and consumption', async ({
  page,
}) => {
  await open(page, definition(true));
  await expandEncounter(page);
  await editor(page).getByRole('button', { name: 'Test encounter in dungeon sandbox' }).click();
  const sandbox = page.getByTestId('dungeon-sandbox');
  await sandbox.getByLabel('Simulated charm quantity Basic Charm').fill('2');
  await sandbox.getByLabel('Simulated capture rolls').selectOption('failure');
  await sandbox.getByLabel('Sandbox capture charm').selectOption('basic_charm');
  await sandbox.getByRole('button', { name: 'Simulate capture attempt' }).click();
  await expect(sandbox.getByTestId('sandbox-encounter-result')).toContainText('failure');
  await expect(sandbox.getByTestId('sandbox-simulated-grant')).toContainText('0 ownership grants');
  await sandbox.getByRole('button', { name: 'Start again' }).click();
  await sandbox.getByLabel('Simulated capture rolls').selectOption('success');
  await sandbox.getByLabel('Sandbox capture charm').selectOption('basic_charm');
  await sandbox.getByRole('button', { name: 'Simulate capture attempt' }).click();
  await expect(sandbox.getByTestId('sandbox-encounter-result')).toContainText('captured');
  await expect(sandbox.getByTestId('sandbox-simulated-grant')).toContainText('1 ownership grant');
  await expect(sandbox.getByTestId('sandbox-safe')).toContainText('no run is saved');
});
test('sandbox direct rescue and acquisition-limit scenarios use simulated grants only', async ({
  page,
}) => {
  const d = definition(true);
  const a = d.rooms[0]!.actions[0]!;
  a.type = 'rescue';
  a.mode = 'direct';
  delete a.capture;
  a.results = {
    rescued: { text: 'Safe together.', flags: [{ flag: 'open', value: true }] },
    unavailable: { text: 'Already rescued.' },
  };
  await open(page, d);
  const button = page.getByRole('button', { name: /Activity \d+: Rescue/ });
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  await editor(page).getByRole('button', { name: 'Test encounter in dungeon sandbox' }).click();
  const sandbox = page.getByTestId('dungeon-sandbox');
  await sandbox.getByRole('button', { name: 'Simulate direct rescue' }).click();
  await expect(sandbox.getByTestId('sandbox-simulated-grant')).toContainText('no charm consumed');
  await expect(sandbox.getByTestId('sandbox-encounter-result')).toContainText('rescued');
  await sandbox.getByRole('button', { name: 'Start again' }).click();
  await sandbox.getByLabel('Simulated acquisitions android').fill('1');
  await expect(sandbox.getByTestId('sandbox-encounter-result')).toContainText('unavailable');
  await expect(sandbox.getByTestId('sandbox-simulated-grant')).toHaveCount(0);
});
test('missing pool stays in a repair draft and can be replaced through activity controls', async ({
  page,
}) => {
  const d = definition(true);
  d.rooms[0]!.actions[0]!.source = { kind: 'pool', poolId: 'missing' };
  await open(page, d);
  await expandEncounter(page);
  await expect(editor(page)).toContainText('This pool is missing. Its reference is kept');
  await editor(page).getByLabel('WaifuMon pool', { exact: true }).selectOption('pool');
  await expect(editor(page)).toContainText('Wild · 3 entries');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  await expandEncounter(page);
  await expect(editor(page).getByLabel('WaifuMon pool', { exact: true })).toHaveValue('pool');
});
