/**
 * The fixed wording and text lengths of the Discord event screen, repeated
 * for the editor's preview and the sandbox. Which choices are available and
 * what their chances are is never decided here: that is the server's answer.
 */
import type { DungeonEventChoiceView } from '@/api/adminDungeons';
import { percentOfBasisPoints } from './dungeonEventModel';

/** The lengths the Discord event screen truncates at (`dungeonPresenter.ts`), and its one row of buttons. */
export const DISCORD_EVENT_LIMITS = {
  title: 80,
  text: 1500,
  choiceLabel: 60,
  description: 200,
  unavailableText: 120,
  outcomeText: 800,
  button: 80,
  fieldValue: 1024,
  choices: 5,
} as const;
const L = DISCORD_EVENT_LIMITS;
export const CONSUMED_WHEN_SELECTED = 'Consumed when selected.';
export const CONSUMED_EVEN_IF_CHECK_FAILS = 'Consumed when selected, even if the check fails.';

export const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function unavailableLine(choice: DungeonEventChoiceView): string {
  if (choice.unavailableText) return truncate(choice.unavailableText, L.unavailableText);
  if (choice.unavailableReason === 'items') return 'You don’t have what this needs.';
  if (choice.unavailableReason === 'no_way_back') return 'There is nowhere to go back to.';
  return 'Not available right now.';
}

/** The lines under a choice's name, in the order the Discord screen writes them. */
export function choiceNotes(
  choice: DungeonEventChoiceView,
  itemName: (slug: string) => string,
): Array<{ text: string; strong?: boolean; muted?: boolean }> {
  const notes: Array<{ text: string; strong?: boolean; muted?: boolean }> = [];
  if (choice.description) notes.push({ text: truncate(choice.description, L.description) });
  for (const item of choice.items)
    notes.push({
      text: `Needs ${item.quantity}× ${itemName(item.item)} (you have ${item.owned}).`,
    });
  if (choice.consumesOnSelect)
    notes.push({
      text: choice.check ? CONSUMED_EVEN_IF_CHECK_FAILS : CONSUMED_WHEN_SELECTED,
      strong: true,
    });
  if (choice.check)
    notes.push({
      text: `Success chance: ${percentOfBasisPoints(choice.check.chanceBasisPoints)}`,
    });
  if (!choice.available) notes.push({ text: unavailableLine(choice), muted: true });
  if (notes.length === 0)
    notes.push({ text: choice.walksAway ? 'Step back for now.' : 'No requirements.' });
  return notes;
}
