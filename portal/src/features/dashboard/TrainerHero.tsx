/**
 * The Dashboard hero (plan §8.1): trainer identity beside the active buddy.
 *
 * On mobile the buddy art stacks above the trainer block; on desktop they sit
 * side by side with the art given the larger share. The buddy panel's footprint
 * is identical whether it holds art, a skeleton, or the no-buddy silhouette, so
 * nothing on the page moves as the queries resolve (§14).
 */
import { Heart } from 'lucide-react';
import { Link } from 'react-router';

import type { OwnedEntry, PlayerProfile } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { XpBar } from '@/components/waifumon/Meters';
import { displayName } from '@/content/species';
import { avatarAsset, speciesAsset } from '@/images/assets';
import { formatDate, formatNumber } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';

export interface TrainerHeroProps {
  playerId: number;
  displayName: string;
  avatarUrl: string | null;
  profile: PlayerProfile | undefined;
  buddy: OwnedEntry | null | undefined;
  buddyLoading: boolean;
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
    <div className="flex flex-col justify-center gap-5 p-6 sm:p-8">
      <div className="flex items-center gap-4">
        <Artwork
          asset={avatarAsset(playerId, avatarUrl)}
          name={name}
          aspect="aspect-square"
          priority
          className="size-16 shrink-0 rounded-full border border-border sm:size-20"
        />
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-ink-muted uppercase">Trainer</p>
          <h2 className="truncate font-display text-2xl text-ink sm:text-3xl" title={name}>
            {name}
          </h2>
        </div>
      </div>

      {profile ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="tabular rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-sm font-medium text-ink">
              Level {profile.player.level}
            </span>
            <span className="tabular text-sm text-ink-muted">
              {formatNumber(profile.player.xp)} XP
            </span>
          </div>
          {/*
            The API exposes total XP but no per-level progression for the
            *player* (owned copies get `progress`, trainers do not), so there is
            no honest "XP to next level" bar to draw here. Filed as API
            feedback — the Portal shows the total rather than inventing a curve.
          */}
          <p className="text-xs text-ink-subtle">
            Trainer since {formatDate(profile.player.createdAt)}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
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
    <Link to={`/collection/${buddy.waifu.id}`} className="lift block rounded-2xl">
      <RarityGlowRing rarity={buddy.species.rarity} glow>
        <div className="relative">
          <Artwork
            asset={speciesAsset(buddy.species, buddy.waifu)}
            name={buddy.species.name}
            rarityLabel={rarity.label}
            priority
            aspect="aspect-[4/5] sm:aspect-[3/4]"
          />
          {/* A gradient scrim rather than a solid bar — the art keeps breathing. */}
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
            </div>
            <div className="mt-3">
              <XpBar progress={buddy.progress} compact />
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
