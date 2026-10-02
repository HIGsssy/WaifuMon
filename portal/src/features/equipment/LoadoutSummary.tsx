/**
 * The top of `/equipment`: the active Buddy, ATK / DEF / HP, and the three
 * active-loadout slots.
 *
 * Every number is the overview response's, which the API reads from the
 * combat-stat service — the same Buddy and the same arithmetic Discord shows.
 * A null stat is "unavailable" (no Buddy, or an empty slot), never zero.
 *
 * The artwork comes from the Buddy endpoint and is drawn only when it names
 * the same copy the overview calculated for, so a Buddy changed in between
 * can never pair one Waifumon's picture with another's numbers.
 */
import { Heart, PackageOpen } from 'lucide-react';

import { useBuddy } from '@/api/hooks/useCollection';
import type { EquipmentItem, EquipmentOverview, EquipmentSlot } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { speciesAsset } from '@/images/assets';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { rarityStyle } from '@/lib/rarity';
import { EquipmentItemCard } from './EquipmentItemCard';
import { SLOTS, SLOT_ICON, SLOT_LABEL, SLOT_STAT, STAT_LABEL, formatStat } from './format';

type Unlocked = Extract<EquipmentOverview, { unlocked: true }>;

function BuddyCard({ playerId, overview }: { playerId: number; overview: Unlocked }) {
  const buddy = overview.buddy;
  const buddyEntry = useBuddy(playerId, { enabled: buddy != null });
  const art =
    buddy && buddyEntry.data && buddyEntry.data.waifu.id === buddy.waifuId ? buddyEntry.data : null;

  if (!buddy) {
    return (
      <Card className="flex items-start gap-3">
        <Heart className="mt-0.5 size-5 shrink-0 text-ink-subtle" aria-hidden="true" />
        <div>
          <CardTitle>No active Buddy</CardTitle>
          <p className="mt-1 text-sm text-ink-muted">
            Combat stats are calculated from your Buddy's Current SP, so ATK, DEF and HP are
            unavailable until you set one in Discord. You can still manage your gear.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex items-center gap-4">
      <div className="w-20 shrink-0 sm:w-24">
        {art ? (
          <Artwork
            asset={speciesAsset(art.species, art.waifu)}
            displayWidth={ARTWORK_WIDTH.strip}
            name={art.species.name}
            rarityLabel={rarityStyle(art.species.rarity).label}
            aspect="aspect-[3/4]"
          />
        ) : (
          <div className="aspect-[3/4] w-full rounded-xl bg-surface-sunken" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0">
        <p className="text-xs tracking-wide text-ink-subtle uppercase">Active Buddy</p>
        <h2 className="font-display text-xl leading-tight break-words text-ink">{buddy.name}</h2>
        <p className="tabular mt-1 text-sm text-ink-muted">
          Level {buddy.level} · {buddy.currentSp.toLocaleString()} SP
        </p>
      </div>
    </Card>
  );
}

function StatTiles({ overview }: { overview: Unlocked }) {
  return (
    <Card>
      <CardTitle>Combat stats</CardTitle>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {SLOTS.map((slot) => {
          const stat = SLOT_STAT[slot];
          return (
            <div key={slot} className="rounded-xl bg-surface-sunken px-3 py-2 text-center">
              <dt className="text-xs tracking-wide text-ink-subtle uppercase">
                {STAT_LABEL[stat]}
              </dt>
              <dd className="tabular font-display text-2xl text-ink" data-testid={`stat-${stat}`}>
                {formatStat(overview.stats[stat])}
              </dd>
            </div>
          );
        })}
      </dl>
      {overview.unavailableReason === 'incomplete_loadout' && (
        <p className="mt-2 text-xs text-ink-subtle">An empty slot leaves its stat unavailable.</p>
      )}
    </Card>
  );
}

function EmptySlot({
  slot,
  onBrowse,
}: {
  slot: EquipmentSlot;
  onBrowse: (slot: EquipmentSlot) => void;
}) {
  const Icon = SLOT_ICON[slot];
  return (
    <div className="flex h-full flex-col items-start gap-2 rounded-2xl border border-dashed border-border-strong p-4">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted">
        <Icon className="size-4" aria-hidden="true" />
        {SLOT_LABEL[slot]} — Empty
      </span>
      <p className="text-xs text-ink-subtle">
        {STAT_LABEL[SLOT_STAT[slot]]} is unavailable while this slot is empty.
      </p>
      <Button variant="ghost" size="sm" onClick={() => onBrowse(slot)}>
        <PackageOpen aria-hidden="true" />
        Browse {SLOT_LABEL[slot]} gear
      </Button>
    </div>
  );
}

export function LoadoutSummary({
  playerId,
  overview,
  onOpen,
  onBrowseSlot,
}: {
  playerId: number;
  overview: Unlocked;
  onOpen: (item: EquipmentItem) => void;
  onBrowseSlot: (slot: EquipmentSlot) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <BuddyCard playerId={playerId} overview={overview} />
        <StatTiles overview={overview} />
      </div>
      <section aria-labelledby="loadout-heading">
        <h2 id="loadout-heading" className="mb-2 font-display text-lg text-ink">
          Current loadout
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {SLOTS.map((slot) => {
            const item = overview.slots[slot];
            return (
              <li key={slot} aria-label={`${SLOT_LABEL[slot]} slot`}>
                {item ? (
                  <EquipmentItemCard item={item} onOpen={onOpen} className="h-full" />
                ) : (
                  <EmptySlot slot={slot} onBrowse={onBrowseSlot} />
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
