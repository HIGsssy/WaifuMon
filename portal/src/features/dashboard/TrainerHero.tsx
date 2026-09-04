/**
 * The Dashboard hero (plan §8.1): trainer identity beside the active buddy.
 *
 * On mobile the buddy art stacks above the trainer block; on desktop they sit
 * side by side with the art given the larger share. The buddy panel's footprint
 * is identical whether it holds art, a skeleton, or the no-buddy silhouette, so
 * nothing on the page moves as the queries resolve (§14).
 *
 * The trainer side carries the balances rather than the page. Three standalone
 * currency cards spent a full row on three integers; folded in here they cost
 * one line beneath the XP bar, and the hero reads as one object — a trainer and
 * what she is carrying — instead of two unrelated bands.
 */
import { Coins, Heart, Sparkle, Zap } from 'lucide-react';
import { Link } from 'react-router';

import type { CurrencyBalances, OwnedEntry, PlayerProfile } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { XpBar } from '@/components/waifumon/Meters';
import { displayName } from '@/content/species';
import { avatarAsset, speciesAsset } from '@/images/assets';
import { formatDate, formatNumber } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { ARTWORK_WIDTH } from '@/images/sizes';

export interface TrainerHeroProps {
  playerId: number;
  displayName: string;
  avatarUrl: string | null;
  profile: PlayerProfile | undefined;
  buddy: OwnedEntry | null | undefined;
  buddyLoading: boolean;
}

/**
 * One balance, as a chip rather than a card.
 *
 * `detail` is the Energy ceiling and nothing else today — a balance with a
 * maximum is a meter and reads as `18 / 35`; one without is just a number.
 * `whitespace-nowrap` on the figure is what keeps `1,820` from breaking across
 * two lines when three of these share a narrow row on a phone.
 */
function ResourceChip({
  icon: Icon,
  label,
  value,
  detail,
  cssVar,
}: {
  icon: typeof Zap;
  label: string;
  value: number;
  detail?: string | undefined;
  cssVar: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface-raised px-3 py-2">
      <Icon
        className="size-4 shrink-0"
        style={{ color: `var(${cssVar})` }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-[0.65rem] leading-none tracking-wide text-ink-subtle uppercase">
          {label}
        </p>
        {/*
          One text node, not a value plus a styled suffix. A meter is a single
          figure — "34 / 35" — and splitting it made a screen reader announce
          two unrelated runs, which is also why it could not be matched as one
          string in a test.
        */}
        <p className="tabular mt-1 text-sm leading-none font-semibold whitespace-nowrap text-ink">
          {detail === undefined ? formatNumber(value) : `${formatNumber(value)} / ${detail}`}
        </p>
      </div>
    </div>
  );
}

function ResourceRow({ currencies }: { currencies: CurrencyBalances }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <ResourceChip
        icon={Zap}
        label="Energy"
        value={currencies.huntEnergy}
        detail={formatNumber(currencies.maxHuntEnergy)}
        cssVar="--currency-energy"
      />
      <ResourceChip
        icon={Coins}
        label="WaifuBux"
        value={currencies.waifubux}
        cssVar="--currency-waifubux"
      />
      <ResourceChip
        icon={Sparkle}
        label="Essence"
        value={currencies.essence}
        cssVar="--currency-essence"
      />
    </div>
  );
}

function TrainerIdentity({
  playerId,
  name,
  avatarUrl,
  profile,
}: {
  playerId: number;
  name: string;
  avatarUrl: string | null;
  profile: PlayerProfile | undefined;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-4 p-5 sm:p-6">
      <div className="flex items-center gap-3.5">
        <Artwork
          asset={avatarAsset(playerId, avatarUrl)}
          displayWidth={ARTWORK_WIDTH.avatar}
          name={name}
          aspect="aspect-square"
          priority
          className="size-14 shrink-0 rounded-full border border-border"
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs tracking-wide text-ink-muted uppercase">Trainer</p>
          <h2 className="truncate font-display text-2xl leading-tight text-ink" title={name}>
            {name}
          </h2>
        </div>
        {profile && (
          <span className="tabular shrink-0 self-start rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-sm font-medium text-ink">
            Level {profile.player.progress.level}
          </span>
        )}
      </div>

      {profile ? (
        <>
          {/*
            The same bar an owned copy gets, from the same server-resolved
            shape. The Portal has never been allowed to compute a level curve
            (§16); it now no longer has to, because `player.progress` carries
            the identical fields `waifu.progress` does.
          */}
          <XpBar progress={profile.player.progress} label="Trainer experience" />
          <ResourceRow currencies={profile.currencies} />
          <p className="text-xs text-ink-subtle">
            Trainer since {formatDate(profile.player.createdAt)}
          </p>
        </>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-4 w-40" />
        </div>
      )}
    </div>
  );
}

function BuddyPanel({
  buddy,
  loading,
}: {
  buddy: OwnedEntry | null | undefined;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton className="aspect-[4/5] w-full rounded-2xl sm:aspect-[3/4]" />;
  }

  if (!buddy) {
    return (
      <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-surface/40 p-6 text-center sm:aspect-[3/4]">
        <div className="rounded-2xl border border-border bg-surface-raised p-3.5 text-ink-subtle">
          <Heart className="size-6" aria-hidden="true" />
        </div>
        <p className="font-display text-lg text-ink">No buddy set</p>
        <p className="max-w-[15rem] text-sm text-ink-muted">
          Choose a companion from Discord and they will appear here.
        </p>
      </div>
    );
  }

  const rarity = rarityStyle(buddy.species.rarity);
  const name = displayName(buddy);

  return (
    <Link
      to={`/collection/${buddy.waifu.id}`}
      className="lift block rounded-2xl"
      aria-label={`View ${name}`}
      viewTransition
    >
      <RarityGlowRing rarity={buddy.species.rarity} glow>
        <div className="relative">
          <Artwork
            asset={speciesAsset(buddy.species, buddy.waifu)}
            displayWidth={ARTWORK_WIDTH.hero}
            name={buddy.species.name}
            rarityLabel={rarity.label}
            priority
            aspect="aspect-[4/5] sm:aspect-[3/4]"
          />
          {/*
            A gradient scrim rather than a solid bar — the art keeps breathing.
            Affection joins the level as a chip rather than as a second meter:
            the XP bar is the one progression the panel draws, and stacking a
            second one here would start burying the artwork the panel exists
            for. Seductive Power is deliberately left off — it is a per-copy
            comparison figure that means something on the detail page and
            nothing next to a level.
          */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-4 pt-12">
            <div className="flex items-center gap-2">
              <Heart className="size-3.5 shrink-0 fill-current text-rose-300" aria-hidden="true" />
              <span className="text-xs tracking-wide text-white/80 uppercase">Active buddy</span>
            </div>
            <p className="mt-1 truncate font-display text-xl text-white" title={name}>
              {name}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <RarityBadge rarity={buddy.species.rarity} />
              <span className="tabular rounded-full bg-white/15 px-2 py-0.5 text-xs font-medium text-white">
                Lv {buddy.waifu.level}
              </span>
              <span className="tabular inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-xs font-medium text-white">
                <Heart className="size-3 fill-current text-rose-300" aria-hidden="true" />
                {buddy.waifu.affection}
              </span>
            </div>
            <div className="mt-3">
              <XpBar progress={buddy.progress} compact label="Buddy experience" />
            </div>
          </div>
        </div>
      </RarityGlowRing>
    </Link>
  );
}

export function TrainerHero({
  playerId,
  displayName: name,
  avatarUrl,
  profile,
  buddy,
  buddyLoading,
}: TrainerHeroProps) {
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_26rem]">
      {/* Order flips on mobile: the artwork leads, per §8.1. */}
      <div className="order-2 rounded-2xl border border-border bg-surface lg:order-1">
        <TrainerIdentity playerId={playerId} name={name} avatarUrl={avatarUrl} profile={profile} />
      </div>
      <div className="order-1 lg:order-2">
        <BuddyPanel buddy={buddy} loading={buddyLoading} />
      </div>
    </section>
  );
}
