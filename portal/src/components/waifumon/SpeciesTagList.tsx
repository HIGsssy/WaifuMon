/**
 * A species' player-facing tags, as quiet chips.
 *
 * Shared by the Waifumon detail and the encyclopedia entry so the two can
 * never disagree about what a player is shown. Which tags qualify, and their
 * wording, is decided in `@/lib/speciesTags` — never here. Renders nothing when
 * no tag qualifies.
 */
import { cn } from '@/lib/cn';
import { playerFacingTags } from '@/lib/speciesTags';

export function SpeciesTagList({
  species,
  className,
}: {
  species: { tags?: readonly unknown[] | null | undefined };
  className?: string;
}) {
  const tags = playerFacingTags(species);
  if (tags.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {tags.map(({ tag, label }) => (
        <span
          key={tag}
          className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-subtle"
        >
          {label}
        </span>
      ))}
    </div>
  );
}
