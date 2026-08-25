/**
 * The Art ↔ Card switch.
 *
 * Shared by the owned-copy hero and the species detail page so the two read as
 * the same control rather than two that happen to look alike. It was local to
 * the collection hero until the encyclopedia needed it too.
 *
 * `aria-pressed` on two buttons rather than a radio group: that is the shape
 * the rest of the Portal uses for a two-state view switch.
 */
import { Image as ImageIcon, Sparkles } from 'lucide-react';

export type CardView = 'art' | 'card';

export interface CardViewToggleProps {
  value: CardView;
  onChange: (view: CardView) => void;
  /** Labels the group for assistive tech, e.g. "Hero image view". */
  label?: string;
}

export function CardViewToggle({ value, onChange, label = 'Image view' }: CardViewToggleProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1"
    >
      <ViewButton
        active={value === 'art'}
        onClick={() => onChange('art')}
        icon={<ImageIcon className="size-4" aria-hidden="true" />}
        label="Art"
      />
      <ViewButton
        active={value === 'card'}
        onClick={() => onChange('card')}
        icon={<Sparkles className="size-4" aria-hidden="true" />}
        label="Card"
      />
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-surface-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
