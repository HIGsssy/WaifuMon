/**
 * The recent-catches strip (plan §8.1).
 *
 * Artwork-led on purpose: this is the second-largest picture on the page after
 * the buddy, and it sits directly beneath the hero so the Dashboard opens on
 * what the player has been *doing* rather than on three summary figures.
 *
 * **One request, one short page.** `useRecentCatches` asks the API for five
 * copies in `newest` order; nothing here sorts, slices or walks. Before the API
 * grew that sort, page 1 of the collection was the *rarest* twenty-five, so a
 * strip like this would have cost one request per twenty-five copies owned.
 */
import { Clock } from 'lucide-react';
import { Link } from 'react-router';

import type { OwnedEntry } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { displayName } from '@/content/species';
import { speciesAsset } from '@/images/assets';
import { rarityStyle } from '@/lib/rarity';
import { ARTWORK_WIDTH } from '@/images/sizes';

export interface RecentCatchesProps {
  entries: OwnedEntry[] | undefined;
  loading: boolean;
  /** How many skeleton tiles to hold the row open with. */
  placeholders?: number;
}

/**
 * The strip scrolls horizontally below `sm` rather than wrapping to a second
 * row. Five tiles at two-per-row would be two and a half rows of artwork on a
 * phone, pushing the summary cards off a second screen — and a snap-scrolled
 * strip is the convention the appearance gallery already uses for artwork that
 * outgrows its width.
 */
const TRACK =
  'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-5';
const TILE = 'w-36 shrink-0 snap-start sm:w-auto';

function CatchTile({ entry }: { entry: OwnedEntry }) {
  const name = displayName(entry);
  const rarity = rarityStyle(entry.species.rarity);

  return (
    <Link
      to={`/collection/${entry.waifu.id}`}
      className={`lift block rounded-2xl ${TILE}`}
      viewTransition
    >
      <RarityGlowRing rarity={entry.species.rarity}>
        <Artwork
          asset={speciesAsset(entry.species, entry.waifu)}
          displayWidth={ARTWORK_WIDTH.strip}
          name={entry.species.name}
          rarityLabel={rarity.label}
          aspect="aspect-[3/4]"
        />
        <div className="space-y-1.5 p-2.5">
          {/* Truncated, never clipped: a long nickname shortens, it does not overflow. */}
          <p className="truncate text-xs font-medium text-ink" title={name}>
            {name}
          </p>
          <div className="flex items-center gap-1.5">
            <RarityBadge rarity={entry.species.rarity} />
            <span className="tabular text-[0.68rem] text-ink-subtle">Lv {entry.waifu.level}</span>
          </div>
        </div>
      </RarityGlowRing>
    </Link>
  );
}

export function RecentCatches({ entries, loading, placeholders = 5 }: RecentCatchesProps) {
  // Nothing caught yet is not an error and not a gap to apologise for — a new
  // trainer simply has an empty shelf, and the strip says so in one line.
  const empty = !loading && entries?.length === 0;

  return (
    <section aria-labelledby="recent-catches-heading">
      <h2
        id="recent-catches-heading"
        className="mb-3 flex items-center gap-2 text-sm font-medium tracking-wide text-ink-muted uppercase"
      >
        <Clock className="size-3.5" aria-hidden="true" />
        Recent catches
      </h2>

      {empty ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-5 text-sm text-ink-muted">
          Nothing caught yet — your most recent Waifumon will appear here.
        </p>
      ) : (
        <div className={TRACK}>
          {entries
            ? entries.map((entry) => <CatchTile key={entry.waifu.id} entry={entry} />)
            : Array.from({ length: placeholders }, (_, i) => (
                <Skeleton key={i} className={`aspect-[3/4] rounded-2xl ${TILE}`} />
              ))}
        </div>
      )}
    </section>
  );
}
