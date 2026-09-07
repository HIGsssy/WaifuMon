/**
 * A single achievement tile.
 *
 * The card renders exactly what the backend resolved (plan §6). It never
 * evaluates criteria, and for a hidden, still-locked badge there is nothing to
 * evaluate — the API sends `"???"`, `"Hidden Achievement"` and `progress: null`,
 * so the concealed presentation is not a decision made here but the only data
 * that arrived.
 */
import { Check, Lock } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/cn';
import { formatDate, formatNumber, titleCase } from '@/lib/format';
import type { Achievement } from '@/api/types';

function progressPercent(progress: Achievement['progress']): number {
  if (!progress || progress.target === 0) return 0;
  return Math.round((progress.current / progress.target) * 100);
}

export function AchievementCard({ achievement }: { achievement: Achievement }) {
  const { unlocked, hidden, progress } = achievement;
  const concealed = hidden && !unlocked;

  return (
    <Card
      className={cn(
        'flex h-full gap-4',
        unlocked ? 'border-accent/40' : 'opacity-90',
      )}
      data-testid="achievement-card"
      data-unlocked={unlocked}
      data-hidden={hidden}
    >
      <div
        aria-hidden="true"
        className={cn(
          'flex size-12 shrink-0 items-center justify-center rounded-xl border text-2xl',
          unlocked
            ? 'border-accent/40 bg-accent-soft'
            : 'border-border bg-surface-sunken grayscale',
        )}
      >
        {concealed ? '❓' : (achievement.icon ?? '🏅')}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate font-medium text-ink">{achievement.name}</h3>
          {unlocked ? (
            <Check className="size-4 shrink-0 text-accent" aria-label="Unlocked" />
          ) : (
            <Lock className="size-3.5 shrink-0 text-ink-subtle" aria-label="Locked" />
          )}
        </div>

        <p className="mt-1 text-sm text-ink-muted">{achievement.description}</p>

        {!concealed && progress && !unlocked && (
          <div className="mt-3">
            <Progress value={progressPercent(progress)} aria-label={`${achievement.name} progress`} />
            <p className="tabular mt-1 text-xs text-ink-subtle">
              {formatNumber(progress.current)} / {formatNumber(progress.target)}
            </p>
          </div>
        )}

        <div className="mt-2 flex items-center gap-2 text-xs text-ink-subtle">
          {!concealed && <span>{titleCase(achievement.category)}</span>}
          {unlocked && achievement.unlockedAt && (
            <span>· Earned {formatDate(achievement.unlockedAt)}</span>
          )}
        </div>
      </div>
    </Card>
  );
}
