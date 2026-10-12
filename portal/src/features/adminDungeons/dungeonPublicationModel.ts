/**
 * How a dungeon's draft stands against what is published, in words. The
 * definition and the loot it depends on are reported separately by the server:
 * a shared loot table can change while the dungeon itself has not.
 */
import type { DungeonRewardDependencyChange, DungeonSummary } from '@/api/adminDungeons';

export type PublicationKind = 'unpublished' | 'matches' | 'definition' | 'loot' | 'both';

export interface DependencyLine {
  id: string;
  text: string;
  /** Keys and hashes, for a hover title only. */
  detail: string;
  /** Publishing is blocked until this is repaired. */
  broken: boolean;
}

export interface PublicationState {
  kind: PublicationKind;
  /** A loot dependency is missing, archived, unreadable or matches nothing. */
  broken: boolean;
  /** The short overall status. */
  label: string;
  summary: string;
  changes: DependencyLine[];
}

type Source = Pick<
  DungeonSummary,
  'published' | 'draftDiffers' | 'dependenciesDiffer' | 'dependencyChanges'
>;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeDependencyChange(change: DungeonRewardDependencyChange): DependencyLine {
  if (change.kind === 'table') {
    const name = `Loot table “${change.name}”`;
    const text = {
      changed: `${name} gives different rewards now.`,
      missing: `${name} was deleted. Remove it from the dungeon or pick another table.`,
      archived: `${name} is archived. Restore it or pick another table.`,
      invalid: `${name} can no longer be read. Open it under Dungeon Loot Tables and save it again.`,
    }[change.status];
    return {
      id: `table:${change.tableKey}`,
      text,
      detail: `${change.tableKey} · published ${change.publishedHash ?? 'none'} · now ${change.currentHash ?? 'none'}`,
      broken: change.status !== 'changed',
    };
  }
  const detail = [
    change.added.length ? `added: ${change.added.join(', ')}` : '',
    change.removed.length ? `removed: ${change.removed.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (change.status === 'empty')
    return {
      id: `equipment:${change.selectorKey}`,
      text: `${change.description}: no gear matches this choice any more. Loosen the choice or pick other gear.`,
      detail,
      broken: true,
    };
  const parts = [
    change.added.length
      ? `${count(change.added.length, 'more piece', 'more pieces')} can drop now`
      : '',
    change.removed.length
      ? `${count(change.removed.length, 'piece', 'pieces')} can no longer drop`
      : '',
  ].filter(Boolean);
  return {
    id: `equipment:${change.selectorKey}`,
    text: `${change.description}: ${parts.join(' and ') || 'the gear that can drop has changed'}.`,
    detail,
    broken: false,
  };
}

const LABELS: Record<PublicationKind, string> = {
  unpublished: 'Not published yet',
  matches: 'Matches publication',
  definition: 'Dungeon changed',
  loot: 'Loot changed',
  both: 'Dungeon and loot changed',
};

const SUMMARIES: Record<PublicationKind, string> = {
  unpublished: 'Players cannot start runs until this dungeon is published.',
  matches: 'Players get exactly what this draft holds.',
  definition:
    'The dungeon itself has changed since it was published. Players keep the published version until you publish again.',
  loot: 'The dungeon itself is as published, but the loot it uses has changed. Players keep the old loot until you publish again.',
  both: 'Both the dungeon itself and the loot it uses have changed since it was published. Players keep the published version until you publish again.',
};

/**
 * `unsavedDefinition`: the editor holds definition edits the server has not
 * seen, which are a definition change whatever the saved draft says.
 */
export function publicationState(source: Source, unsavedDefinition = false): PublicationState {
  const changes = (source.dependencyChanges ?? []).map(describeDependencyChange);
  const broken = changes.some((c) => c.broken);
  const definition = source.draftDiffers || unsavedDefinition;
  const loot = (source.dependenciesDiffer ?? false) || changes.length > 0;
  const kind: PublicationKind = !source.published
    ? 'unpublished'
    : definition && loot
      ? 'both'
      : definition
        ? 'definition'
        : loot
          ? 'loot'
          : 'matches';
  // The server can report a difference it cannot itemise, such as a changed item.
  if (source.published && (source.dependenciesDiffer ?? false) && changes.length === 0)
    changes.push({
      id: 'unlisted',
      text: 'The rewards this dungeon relies on are not the ones that were published.',
      detail: '',
      broken: false,
    });
  return {
    kind,
    broken,
    label: broken ? 'Loot needs repair' : LABELS[kind],
    summary: broken
      ? 'Some of the loot this dungeon uses is missing or broken. It cannot be published until that is repaired.'
      : SUMMARIES[kind],
    changes,
  };
}

/** What pressing Publish will do, for the confirmation. */
export function publishExplanation(state: PublicationState): string {
  switch (state.kind) {
    case 'unpublished':
      return 'This is the first publication of this dungeon.';
    case 'matches':
      return 'Nothing has changed since the last publication, so no new revision will be made.';
    case 'definition':
      return 'This publishes your changes to the dungeon itself. The shared loot it uses has not changed.';
    case 'loot':
      return 'The dungeon itself has not changed. This publishes changes to the loot it uses:';
    case 'both':
      return 'This publishes your changes to the dungeon itself, and changes to the loot it uses:';
  }
}

export const PUBLISH_FREEZE_NOTE =
  'Publishing checks every reward and freezes it into a new revision that never changes. Editing a loot table afterwards does not affect players until you publish again.';
