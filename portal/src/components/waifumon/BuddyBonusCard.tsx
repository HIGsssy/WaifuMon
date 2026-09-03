/**
 * The Buddy Bonus panel — one species' passive effect, on the encyclopedia
 * entry and on an owned copy's detail page.
 *
 * **This component phrases nothing.** `effectSummary` and `targetLabel` arrive
 * from the Platform API already resolved by the bot's own effect registry, so
 * the Portal, a Discord embed and a hunt result line all say the same thing
 * about the same bonus, and a new effect id needs no change here. Writing a
 * `switch (effectId)` in this file would be the mistake it exists to prevent.
 *
 * `status` is the only thing the two call sites disagree about, and it is the
 * question a player is actually asking: the bonus applies **only while a copy
 * of her is the active Buddy**, so the encyclopedia says what equipping her
 * would do, and a copy's page says whether it is doing it right now.
 */
import { Sparkles } from 'lucide-react';

import type { BuddyBonus } from '@/api/types';
import { Card, CardTitle } from '@/components/ui/card';

/** How this bonus relates to the player, at this call site. */
export type BuddyBonusStatus =
  /** This copy is the active Buddy — the effect is live. */
  | 'active'
  /** An owned copy that is not equipped. */
  | 'inactive'
  /** No copy in scope: the encyclopedia's "here is what she grants" reading. */
  | 'species';

const STATUS_NOTE: Record<BuddyBonusStatus, string> = {
  active: 'Active — she is your Buddy, so this is applying now.',
  inactive: 'Set her as your Buddy in Discord to apply this.',
  species: 'Applies while she is your active Buddy.',
};

export interface BuddyBonusCardProps {
  bonus: BuddyBonus;
  status?: BuddyBonusStatus;
}

export function BuddyBonusCard({ bonus, status = 'species' }: BuddyBonusCardProps) {
  return (
    <Card>
      <CardTitle>Buddy Bonus</CardTitle>

      <div className="mt-4 flex items-start gap-3">
        <div
          className={
            status === 'active'
              ? 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300'
              : 'rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle'
          }
        >
          <Sparkles className="size-4" aria-hidden="true" />
        </div>

        <div className="min-w-0">
          <h3 className="font-medium text-ink">{bonus.name}</h3>
          <p className="tabular mt-1 text-sm text-ink">{bonus.effectSummary}</p>
          {/* Authored prose, and only when there is some — never an empty quote. */}
          {bonus.flavorText && (
            <p className="mt-2 text-sm text-ink-muted italic">“{bonus.flavorText}”</p>
          )}
        </div>
      </div>

      <p className="mt-4 border-t border-border pt-3 text-xs text-ink-subtle">
        {STATUS_NOTE[status]}
      </p>
    </Card>
  );
}
