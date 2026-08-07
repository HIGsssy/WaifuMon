/**
 * ComingSoonTile — the reserved slot for a feature that does not exist yet.
 *
 * Used both as a page body (Achievements / Events / Friends, §8.10) and as a
 * placeholder card inside a built page (the Profile's achievements and seasons
 * slots, §8.8). Rendering the slot now is what stops the layout from shifting
 * when the feature lands (§25.12).
 *
 * Never interactive: there is nothing behind it yet, and a clickable tile that
 * does nothing is worse than an honest one that says so.
 */
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export interface ComingSoonTileProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

export function ComingSoonTile({ icon: Icon, title, description, className }: ComingSoonTileProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border bg-surface/30 p-5',
        className,
      )}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <Badge variant="outline">Coming Soon</Badge>
      </div>
      <div>
        <h3 className="font-medium text-ink">{title}</h3>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      </div>
    </div>
  );
}
