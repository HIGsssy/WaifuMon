/**
 * The quick-launch strip (plan §8.1).
 *
 * Curated, not utilitarian: each tile carries a one-line description so the
 * strip reads as a summary of the account rather than a second navigation bar.
 *
 * The collection figures used to be captions here as well as on the progress
 * card, which meant `owned`, `distinctSpecies` and `totalSpecies` each rendered
 * twice on one screen. They now appear once, on the card that exists to state
 * them. The Buddy tile keeps its caption because it names something no other
 * tile does — and it is a name, not a figure repeated from elsewhere.
 */
import type { LucideIcon } from 'lucide-react';
import { Backpack, BookOpen, Compass, Heart, LibraryBig, Store, User } from 'lucide-react';
import { Link } from 'react-router';

import { cn } from '@/lib/cn';

export interface QuickLaunchProps {
  /** `undefined` while loading, `null` when no buddy is set. */
  buddyName: string | null | undefined;
}

interface Tile {
  to: string;
  label: string;
  icon: LucideIcon;
  stat: string | undefined;
}

export function QuickLaunch({ buddyName }: QuickLaunchProps) {
  const tiles: Tile[] = [
    { to: '/collection', label: 'Collection', icon: LibraryBig, stat: 'Everything you own' },
    {
      to: '/buddy',
      label: 'Buddy',
      icon: Heart,
      stat: buddyName === undefined ? undefined : (buddyName ?? 'None set'),
    },
    { to: '/inventory', label: 'Inventory', icon: Backpack, stat: 'Items and charms' },
    { to: '/shop', label: 'Shop', icon: Store, stat: "Today's catalogue" },
    { to: '/encyclopedia', label: 'Encyclopedia', icon: BookOpen, stat: 'Every species' },
    { to: '/guide', label: 'Guide', icon: Compass, stat: 'How the game works' },
    { to: '/profile', label: 'Profile', icon: User, stat: 'Lifetime statistics' },
  ];

  return (
    <section aria-labelledby="quick-launch-heading">
      <h2
        id="quick-launch-heading"
        className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
      >
        Explore
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {tiles.map((tile) => (
          <Link
            key={tile.to}
            to={tile.to}
            className={cn(
              'lift group flex flex-col gap-2.5 rounded-2xl border border-border bg-surface p-4',
            )}
          >
            <tile.icon
              className="size-5 text-ink-subtle transition-colors group-hover:text-accent"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{tile.label}</p>
              {/* Reserve the caption line either way so the row never jumps. */}
              <p className="truncate text-xs text-ink-subtle">{tile.stat ?? ' '}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
