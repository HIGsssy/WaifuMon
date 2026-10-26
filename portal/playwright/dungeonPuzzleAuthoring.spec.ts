/**
 * Authoring a Text Input Puzzle in the real Dungeon Editor, built for
 * production: add it, write a prompt and an author-only answer, remember a
 * flag on a solve, route it, save, reload, check, play it in the sandbox (the
 * real engine), then duplicate, reorder and remove it. Drafts are checked by
 * the server's own validator (`dungeonBackend.ts`). Runs at desktop and at the
 * mobile baseline.
 */
import { expect, test, type Page } from '@playwright/test';
import { serveDungeon, validate } from './dungeonBackend';
import { stubApi } from './stubApi';

type DungeonDefinition = Parameters<typeof serveDungeon>[1];
type DungeonAction = DungeonDefinition['rooms'][number]['actions'][number];

/** A brand-new dungeon as the Portal's New dungeon creates it: one start room players can leave from. */
const KEYPAD: DungeonDefinition = {
  key: 'keypad', name: 'Keypad Vault', description: '', availableRegions: ['waifu-valley'],
  entranceRoomId: 'entrance', artwork: null, background: null,
  settings: { progressionCurrency: null, defeatCurrencyRetentionBasisPoints: 5000, abandonCurrencyRetentionBasisPoints: 0 },
  flags: [], rooms: [{ id: 'entrance', name: 'Entrance', extraction: true, actions: [] }], connections: [],
};

async function open(page: Page) {
  await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write', 'dungeons.publish'] } });
  const backend = await serveDungeon(page, structuredClone(KEYPAD));
  await page.goto('/admin/dungeons/definitions/keypad');
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  return backend;
}
const puzzleOf = (d: DungeonDefinition) => d.rooms[0]!.actions.filter((a) => a.type === 'text_puzzle');
const card = (page: Page, n: number) => page.getByRole('button', { name: new RegExp(`^Activity ${n}: `) });
async function addPuzzle(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Add Text Input Puzzle' }).click();
}
async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('an author builds, saves, reloads, checks, plays, duplicates, reorders and removes a keypad puzzle', async ({ page }) => {
  const backend = await open(page);
  // Something already in the room, to prove reordering and removal leave it alone.
  await page.getByRole('button', { name: 'Add Rest', exact: true }).click();
  await addPuzzle(page);

  await page.getByLabel('Puzzle title', { exact: true }).fill('Security Terminal');
  await page.getByLabel('Puzzle prompt', { exact: true }).fill('ENTER ACCESS CODE');
  const answers = page.getByRole('region', { name: 'Accepted answers (authors only)' });
  await expect(answers).toContainText('Only authors see these');
  await answers.getByLabel('Accepted answer 1', { exact: true }).fill('0042');
  await expect(page.getByLabel('Maximum attempts', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Maximum attempts', { exact: true })).toHaveAttribute('placeholder', 'Unlimited');
  await page.getByLabel('Message for a correct answer', { exact: true }).fill('ACCESS GRANTED');
  await page.getByLabel('Message for a wrong answer', { exact: true }).fill('ACCESS DENIED');
  await page.getByRole('button', { name: 'New…' }).click();
  await expect(page.getByLabel('Remember when solved', { exact: true })).toHaveValue(/^f_/);
  await page.getByRole('button', { name: 'Advanced options' }).last().click();
  await page.getByLabel('After the correct answer', { exact: true }).selectOption('next');
  // The collapsed card never repeats the answer.
  await expect(card(page, 2)).toContainText('1 accepted answer, unlimited attempts');
  await expect(card(page, 2)).not.toContainText('0042');
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(1);
  const saved = backend.detail.draft;
  const flag = saved.flags.find((f) => f.scope === 'run')!;
  expect(puzzleOf(saved)).toEqual([expect.objectContaining({
    type: 'text_puzzle', label: 'Security Terminal', prompt: 'ENTER ACCESS CODE', answers: ['0042'],
    caseSensitive: false, trimWhitespace: true, maxAttempts: null, solvedText: 'ACCESS GRANTED',
    incorrectText: 'ACCESS DENIED', solvedFlag: flag.key, outcomes: { solved: { type: 'next' } },
  })]);
  expect((await validate(saved)).issues.filter((i) => i.severity === 'error')).toEqual([]);

  // Reopened from what was stored, every value is where the author left it.
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();
  await card(page, 2).click();
  await expect(page.getByLabel('Puzzle title', { exact: true })).toHaveValue('Security Terminal');
  await expect(page.getByLabel('Puzzle prompt', { exact: true })).toHaveValue('ENTER ACCESS CODE');
  await expect(page.getByLabel('Accepted answer 1', { exact: true })).toHaveValue('0042');
  await expect(page.getByLabel('Remember when solved', { exact: true })).toHaveValue(flag.key);
  await expect(page.getByLabel('After the correct answer', { exact: true })).toHaveValue('next');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('button', { name: /^Checklist: / })).toHaveText('Nothing to fix');

  // Played by the real engine: a wrong code, then the right one.
  await playDungeon(page);
  const play = page.getByTestId('dungeon-sandbox');
  await play.getByRole('button', { name: 'Rest' }).click();
  await expect(play).toContainText('ENTER ACCESS CODE');
  await play.getByLabel('Sandbox puzzle answer', { exact: true }).fill('42');
  await play.getByRole('button', { name: 'Enter answer' }).click();
  await expect(play).toContainText('❌ Incorrect — ACCESS DENIED');
  await play.getByLabel('Sandbox puzzle answer', { exact: true }).fill('0042');
  await play.getByRole('button', { name: 'Enter answer' }).click();
  await expect(play).toContainText('✅ Solved — ACCESS GRANTED');
  await expect(play).toContainText(`Remembers: ${flag.description}`);
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Close test play' }).click();
  await page.getByRole('button', { name: 'Select room Entrance' }).click();

  // Duplicate, move the copy up, then remove it: the original and the rest are untouched.
  await card(page, 2).click();
  await page.getByRole('button', { name: 'Duplicate activity 2' }).click();
  let draft = (await pending(page, backend)).rooms[0]!.actions;
  expect(draft.map((a) => a.type)).toEqual(['rest', 'text_puzzle', 'text_puzzle']);
  const [original, copy] = draft.filter((a) => a.type === 'text_puzzle') as [DungeonAction, DungeonAction];
  expect(copy.id).not.toBe(original.id);
  expect({ ...copy, id: original.id }).toEqual(original);
  // The copy opens on its own, below the original.
  await expect(page.getByRole('button', { name: 'Move activity 3 up' })).toBeVisible();
  await page.getByRole('button', { name: 'Move activity 3 up' }).click();
  await page.getByRole('button', { name: 'Move activity 2 up' }).click();
  draft = (await pending(page, backend)).rooms[0]!.actions;
  expect(draft.map((a) => a.id)).toEqual([copy.id, draft[1]!.id, original.id]);
  expect(draft[1]!.type).toBe('rest');
  await page.getByRole('button', { name: 'Remove activity 1' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove text input puzzle?' });
  await confirm.getByRole('button', { name: 'Remove activity', exact: true }).click();
  draft = (await pending(page, backend)).rooms[0]!.actions;
  expect(draft.map((a) => a.type)).toEqual(['rest', 'text_puzzle']);
  expect(draft[1]).toEqual(original);
});

test('an optional three-attempt puzzle is skippable, counts down and follows its exhausted route', async ({ page }) => {
  const backend = await open(page);
  await addPuzzle(page);
  await page.getByLabel('Puzzle prompt', { exact: true }).fill('Four digits.');
  await page.getByLabel('Accepted answer 1', { exact: true }).fill('0042');
  await page.getByLabel('Maximum attempts', { exact: true }).fill('3');
  await page.getByLabel('Message when attempts run out', { exact: true }).fill('LOCKOUT');
  await page.getByRole('button', { name: 'Advanced options' }).click();
  await page.getByLabel('Player can skip this', { exact: true }).check();
  const exhausted = page.getByLabel('After the last attempt is used up', { exact: true });
  await expect(exhausted.locator('option', { hasText: 'Usual: continue with the next activity, unsolved' })).toHaveCount(1);
  await exhausted.selectOption('room_complete');
  await expect(page.getByLabel('If the player skips it', { exact: true })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(1);
  expect(puzzleOf(backend.detail.draft)[0]).toMatchObject({ optional: true, maxAttempts: 3, exhaustedText: 'LOCKOUT', outcomes: { exhausted: { type: 'room_complete' } } });

  await playDungeon(page);
  const play = page.getByTestId('dungeon-sandbox');
  await expect(play.getByRole('button', { name: 'Skip it' })).toBeVisible();
  await expect(play).toContainText('3 attempts left');
  for (const guess of ['1', '2']) {
    await play.getByLabel('Sandbox puzzle answer', { exact: true }).fill(guess);
    await play.getByRole('button', { name: 'Enter answer' }).click();
    await expect(play).toContainText('❌ Incorrect');
  }
  await expect(play).toContainText('1 attempt left');
  await play.getByLabel('Sandbox puzzle answer', { exact: true }).fill('3');
  await play.getByRole('button', { name: 'Enter answer' }).click();
  await expect(play).toContainText('🔒 Out of attempts — LOCKOUT');
  await expect(play).not.toContainText('Remembers');
});

/** The sandbox opens from the dungeon's settings, which a selected room replaces. */
async function playDungeon(page: Page) {
  await page.getByRole('button', { name: 'Show dungeon settings' }).click();
  await page.getByTestId('dungeon-events').getByRole('button', { name: 'Play the dungeon' }).click();
}
/** The editor's unsaved draft, read through a save. */
async function pending(page: Page, backend: Awaited<ReturnType<typeof serveDungeon>>) {
  const before = backend.saves;
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect.poll(() => backend.saves).toBe(before + 1);
  return backend.detail.draft;
}
