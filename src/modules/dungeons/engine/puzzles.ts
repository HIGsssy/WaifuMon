/**
 * Text input puzzles: comparing a typed answer, and what a player may see of
 * the puzzle they are standing at.
 *
 * ## Matching
 *
 * Both sides go through the same normalisation: Unicode NFC, then surrounding
 * whitespace trimmed when `trimWhitespace` is on, then lower-cased when the
 * puzzle is case-insensitive. Nothing inside an answer is touched — inner
 * spaces and punctuation count — and answers are strings throughout, so
 * `"0042"` never matches `"42"`.
 *
 * ## Secrecy
 *
 * `DungeonPuzzleView` is the only thing a player-facing screen gets. It has
 * the prompt and the attempt counts, never the accepted answers.
 */
import { roomOf, type TextPuzzleAction } from '../content/dungeonDefinition';
import type { DungeonEngineContext, DungeonPuzzleInstance, DungeonRunState } from './types';

export interface DungeonPuzzleView {
  prompt: string;
  /** Answers submitted so far, right or wrong. */
  attempts: number;
  /** Null: unlimited. */
  maxAttempts: number | null;
  /** Null when unlimited. */
  attemptsRemaining: number | null;
}

function normalise(action: Pick<TextPuzzleAction, 'caseSensitive' | 'trimWhitespace'>, text: string): string {
  let out = text.normalize('NFC');
  if (action.trimWhitespace) out = out.trim();
  if (!action.caseSensitive) out = out.toLowerCase();
  return out;
}

/** Whether `submitted` is one of the puzzle's accepted answers. An answer that normalises to nothing never matches. */
export function puzzleAnswerMatches(
  action: Pick<TextPuzzleAction, 'answers' | 'caseSensitive' | 'trimWhitespace'>,
  submitted: string,
): boolean {
  const given = normalise(action, submitted);
  if (given === '') return false;
  return action.answers.some((answer) => normalise(action, answer) === given);
}

/** The accepted answers as the matcher sees them, for validation: empty and duplicate entries. */
export function normalisedPuzzleAnswers(action: Pick<TextPuzzleAction, 'answers' | 'caseSensitive' | 'trimWhitespace'>): string[] {
  return action.answers.map((answer) => normalise(action, answer));
}

export function puzzleInstanceOf(state: Pick<DungeonRunState, 'rooms'>, roomId: string, actionId: string): DungeonPuzzleInstance | undefined {
  return state.rooms[roomId]?.puzzles?.[actionId];
}

/** The puzzle the cursor stands on, as a player may see it; null when it is not on one. */
export function describeOfferedPuzzle(state: DungeonRunState, ctx: Pick<DungeonEngineContext, 'definition'>): DungeonPuzzleView | null {
  const room = roomOf(ctx.definition, state.cursor.roomId);
  const action = room?.actions.find((a) => a.id === state.cursor.actionId);
  if (!room || action?.type !== 'text_puzzle') return null;
  const attempts = puzzleInstanceOf(state, room.id, action.id)?.attempts ?? 0;
  return {
    prompt: action.prompt,
    attempts,
    maxAttempts: action.maxAttempts,
    attemptsRemaining: action.maxAttempts === null ? null : Math.max(0, action.maxAttempts - attempts),
  };
}
