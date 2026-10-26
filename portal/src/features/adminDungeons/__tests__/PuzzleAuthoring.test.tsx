import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonAction, DungeonDefinition } from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { RoomInspector } from '../RoomInspector';
import { ACTION_OUTCOMES, createAction, duplicateAction } from '../dungeonActionModel';
import { activitySummary, friendlyIssue } from '../dungeonText';
import { fixture, install, reference, renderWith } from './dungeonFixtures';

beforeEach(() => {
  install();
  stubObjectUrls();
});

function Harness({ initial }: { initial: DungeonDefinition }) {
  const [d, setD] = useState(initial);
  return (
    <>
      <RoomInspector
        room={d.rooms[0]!}
        definition={d}
        reference={reference}
        issues={[]}
        disabled={false}
        onChange={setD}
        onSelect={() => {}}
        onAddNext={() => {}}
        onDelete={() => {}}
      />
      <output data-testid="definition">{JSON.stringify(d)}</output>
    </>
  );
}
const definition = () => JSON.parse(screen.getByTestId('definition').textContent!) as DungeonDefinition;
const puzzle = () => definition().rooms[0]!.actions.find((a) => a.type === 'text_puzzle')!;

describe('the Text Input Puzzle model', () => {
  it('creates a puzzle with an empty answer to fill in and unlimited attempts', () => {
    const created = createAction('text_puzzle', []);
    expect(created).toMatchObject({
      type: 'text_puzzle', prompt: '', answers: [''], caseSensitive: false, trimWhitespace: true,
      maxAttempts: null, outcomes: {}, optional: false,
    });
    expect(ACTION_OUTCOMES.text_puzzle).toEqual(['solved', 'exhausted']);
  });

  it('duplicates a puzzle with every setting and a new id', () => {
    const original: DungeonAction = { ...createAction('text_puzzle', []), answers: ['0042'], maxAttempts: 3, solvedFlag: 'f_x' };
    const [, copy] = duplicateAction([original], original.id);
    expect(copy!.id).not.toBe(original.id);
    expect({ ...copy, id: original.id }).toEqual(original);
    copy!.answers!.push('more');
    expect(original.answers).toEqual(['0042']);
  });

  it('never puts the answers in the collapsed summary', () => {
    const action = { ...createAction('text_puzzle', []), prompt: 'Four digits.', answers: ['0042', 'secret'], maxAttempts: 3 };
    const summary = activitySummary(action, fixture().draft, reference);
    expect(summary).toBe('“Four digits.” — 2 accepted answers, 3 attempts');
    expect(summary).not.toContain('0042');
  });

  it('explains puzzle validation issues in plain words', () => {
    const d: DungeonDefinition = { ...fixture().draft };
    d.rooms = [{ ...d.rooms[0]!, actions: [createAction('text_puzzle', [])] }, ...d.rooms.slice(1)];
    const said = (code: string) =>
      friendlyIssue({ code, severity: 'error', path: 'rooms[0].actions[0].answers', message: 'x' }, d, reference);
    expect(said('puzzle_no_answers').title).toMatch(/no accepted answer, so it can never be solved/);
    expect(said('puzzle_prompt_empty').help).toBe('Write the question or instruction players answer.');
    expect(said('puzzle_answer_empty').actionId).toBe(d.rooms[0]!.actions[0]!.id);
  });
});

describe('authoring a puzzle in the room inspector', () => {
  it('adds a puzzle and edits what players read apart from the author-only answers', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={fixture().draft} />);
    await user.click(screen.getByRole('button', { name: /More/ }));
    await user.click(screen.getByRole('button', { name: 'Add Text Input Puzzle' }));

    await user.type(screen.getByLabelText('Puzzle title'), 'Security Door');
    await user.type(screen.getByLabelText('Puzzle prompt'), 'Enter the code.');
    const answers = screen.getByRole('region', { name: 'Accepted answers (authors only)' });
    expect(within(answers).getByText(/Only authors see these/)).toBeInTheDocument();
    await user.type(within(answers).getByLabelText('Accepted answer 1'), '0042');
    await user.click(within(answers).getByRole('button', { name: /Add another accepted answer/ }));
    await user.type(within(answers).getByLabelText('Accepted answer 2'), 'forty two');
    await user.click(within(answers).getByLabelText('Answers are case-sensitive'));
    await user.type(screen.getByLabelText('Maximum attempts'), '3');
    await user.type(screen.getByLabelText('Message for a wrong answer'), 'Buzz.');
    // Declared and chosen in one go, ready for a locked path to read.
    await user.click(screen.getByRole('button', { name: 'New…' }));
    const flag = definition().flags.find((f) => f.key === puzzle().solvedFlag);
    expect(flag).toMatchObject({ scope: 'run', description: 'Puzzle solved' });
    expect(screen.getByLabelText('Remember when solved')).toHaveValue(flag!.key);

    expect(puzzle()).toMatchObject({
      label: 'Security Door', prompt: 'Enter the code.', answers: ['0042', 'forty two'],
      caseSensitive: true, trimWhitespace: true, maxAttempts: 3, incorrectText: 'Buzz.',
    });
    // The prompt is not shown with the answers, and the answers are not in the card's heading.
    expect(within(answers).queryByText('Enter the code.')).toBeNull();
    expect(screen.getByRole('button', { name: /^Activity \d+: Text Input Puzzle\./ }).textContent).not.toContain('0042');

    await user.clear(screen.getByLabelText('Maximum attempts'));
    expect(puzzle().maxAttempts).toBeNull();
    await user.click(within(answers).getByRole('button', { name: 'Remove accepted answer 1' }));
    expect(puzzle().answers).toEqual(['forty two']);
  });

  it('routes the solved and exhausted outcomes with the usual controls', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={fixture().draft} />);
    await user.click(screen.getByRole('button', { name: /More/ }));
    await user.click(screen.getByRole('button', { name: 'Add Text Input Puzzle' }));
    await user.click(screen.getByRole('button', { name: 'Advanced options' }));
    // The title is edited with the puzzle, not as button text.
    expect(screen.queryByLabelText('Button text')).toBeNull();
    const exhausted = screen.getByLabelText('After the last attempt is used up');
    expect(within(exhausted).getByRole('option', { name: /Usual: continue with the next activity, unsolved/ })).toBeInTheDocument();
    await user.selectOptions(exhausted, 'end_run:defeated');
    await user.selectOptions(screen.getByLabelText('After the correct answer'), 'room_complete');
    expect(puzzle().outcomes).toEqual({ exhausted: { type: 'end_run', outcome: 'defeated' }, solved: { type: 'room_complete' } });
  });
});
