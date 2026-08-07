/**
 * Care Mode state, read-only (plan §8.4).
 *
 * Every value here is rendered exactly as `GET /players/{id}/care` returned it.
 * In particular:
 *
 *   - `pendingTicks` is the API's own forecast — reading it does not bank the
 *     ticks, and the Portal does not recompute it from elapsed time.
 *   - `nextTickAt` is an instant the API supplies; the Portal formats it. It
 *     does not derive one from `lastTickAt + intervalMinutes`, which would be
 *     the same arithmetic the care service owns (§16).
 *
 * There are no Enter / Exit / Change Target controls. Care Mode is driven from
 * Discord (§4).
 */
import { HeartHandshake, Pause, Play } from 'lucide-react';

import type { CareState } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatNumber, formatRelative } from '@/lib/format';

export function CareCard({ care, targetName }: { care: CareState; targetName: string | null }) {
  if (!care.enabled) {
    return (
      <Card className="border-dashed bg-surface/40">
        <CardTitle>Care Mode</CardTitle>
        <p className="mt-3 text-sm text-ink-muted">
          Care Mode is switched off by server configuration.
        </p>
      </Card>
    );
  }

  const energyPercent =
    care.effectiveEnergyCap > 0 ? (care.currentEnergy / care.effectiveEnergyCap) * 100 : 0;

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <CardTitle>Care Mode</CardTitle>
        <Badge variant={care.active ? 'solid' : 'outline'} className="gap-1.5">
          {care.active ? (
            <Play className="size-3 fill-current" aria-hidden="true" />
          ) : (
            <Pause className="size-3" aria-hidden="true" />
          )}
          {care.active ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      {care.active ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-sunken p-3">
            <HeartHandshake className="size-4 shrink-0 text-accent" aria-hidden="true" />
            <p className="min-w-0 text-sm text-ink">
              Caring for <span className="font-medium">{targetName ?? 'a Waifumon'}</span>
              {care.startedAt && (
                <span className="text-ink-subtle"> · started {formatRelative(care.startedAt)}</span>
              )}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-ink-muted">Next tick</dt>
            <dd className="text-right text-ink">
              {care.nextTickAt ? formatRelative(care.nextTickAt) : '—'}
            </dd>

            <dt className="text-ink-muted">Pending ticks</dt>
            <dd className="tabular text-right text-ink">{formatNumber(care.pendingTicks)}</dd>

            <dt className="text-ink-muted">Interval</dt>
            <dd className="tabular text-right text-ink">{care.intervalMinutes} min</dd>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          Care Mode is not running. Start it from Discord to earn affection and XP over time.
        </p>
      )}

      <div className="mt-5 space-y-2 border-t border-border pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-ink-muted">Energy</span>
          <span className="tabular text-xs text-ink">
            {formatNumber(care.currentEnergy)} / {formatNumber(care.effectiveEnergyCap)}
          </span>
        </div>
        <Progress
          value={energyPercent}
          indicatorClassName="bg-[var(--currency-energy)]"
          aria-label={`Energy: ${care.currentEnergy} of ${care.effectiveEnergyCap}`}
        />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4 text-center">
        <div>
          <dt className="text-xs text-ink-muted">Energy / tick</dt>
          <dd className="tabular text-sm text-ink">{care.energyPerTick}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">XP / tick</dt>
          <dd className="tabular text-sm text-ink">{care.waifuXpPerTick}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Affection / tick</dt>
          <dd className="tabular text-sm text-ink">{care.affectionPerTick}</dd>
        </div>
      </dl>
    </Card>
  );
}
