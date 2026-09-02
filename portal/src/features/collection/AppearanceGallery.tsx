/**
 * The appearance gallery — a **progression journal**, not an image picker.
 *
 * Three rules shape everything below:
 *
 *   1. **Every tile states its requirement**, earned or not. "Owned", "Reach
 *      Level 20", "Winter Festival 2027" — the label is the point, so a player
 *      opening a species they just caught can already read what is ahead.
 *      Hiding locked entries would turn a journal back into a picker.
 *   2. **Locked artwork is never shown, and there is no way to ask for it.**
 *      The picture *is* the reward for reaching the level, so a locked tile is
 *      a named slot with its requirement and nothing else. This used to be a
 *      silhouette with a "Reveal artwork" button, which was a client-side
 *      curtain over art the API had already sent — the reward was one click
 *      away for anyone who wanted it, and zero clicks away for anyone reading
 *      the network tab. The API now withholds `assetId` for locked entries, so
 *      the curtain is gone along with the thing it was hiding.
 *   3. **Cosmetic rarity is styled unlike species rarity.** A dotted chip in
 *      the accent colour, never the rarity palette, so a Rare species wearing a
 *      Seasonal look reads as two independent facts.
 *
 * Unlock state is never computed here. `isUnlocked` comes from the Platform
 * API, so this component needs no change when a new unlock source ships — and
 * it is a *rendering* hint, not the fence: the fence is the missing `assetId`.
 *
 * The gallery is **read-only**. Each unlocked tile shows that appearance's own
 * artwork, fetched through the authenticated owned-artwork endpoint keyed by the
 * tile's appearance id; there is no "wear this look" control and no mutation.
 * Changing the equipped appearance is a game action that lives in Discord.
 */
import { Check, Lock, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { useWaifuAppearances } from '@/api/hooks/useCollection';
import type { Appearance, CosmeticRarity } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { appearanceArtworkAsset } from '@/images/assets';
import { cn } from '@/lib/cn';
import { ARTWORK_WIDTH } from '@/images/sizes';

const COSMETIC_RARITY_LABELS: Record<CosmeticRarity, string> = {
  standard: 'Standard',
  common: 'Common',
  rare: 'Rare',
  seasonal: 'Seasonal',
  limited: 'Limited',
  exclusive: 'Exclusive',
};

/** Unknown future values render as "Common" rather than as a raw string. */
function cosmeticRarityLabel(rarity: string): string {
  return COSMETIC_RARITY_LABELS[rarity as CosmeticRarity] ?? 'Common';
}

/**
 * Cosmetic-rarity chip.
 *
 * Dotted border + accent colour, deliberately nothing like `RarityBadge`'s
 * solid rarity-palette pill. The visual difference *is* the design: the two
 * rarities must never be mistaken for one another.
 */
function CosmeticRarityChip({ rarity }: { rarity: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong bg-surface-sunken px-1.5 py-0.5 text-[0.65rem] font-medium tracking-wide text-ink-subtle uppercase">
      <Sparkles className="size-2.5" aria-hidden="true" />
      {cosmeticRarityLabel(rarity)}
    </span>
  );
}

/**
 * The stand-in for a locked tile's artwork.
 *
 * Deliberately not a silhouette of the real thing and not a blur of it — both
 * would need the artwork in the browser to produce. It is drawn from nothing
 * but a lock glyph and the requirement text, which is all the client has for a
 * locked entry and all it should have.
 */
function LockedArtworkSlot({ unlockLabel, aspect }: { unlockLabel: string; aspect: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-b border-border border-dashed bg-surface-sunken px-3 text-center',
        aspect,
      )}
      // Decorative: the tile's own `aria-label` already announces the name,
      // the locked state and the requirement, and repeating them here would
      // make a screen reader read the tile twice.
      aria-hidden="true"
    >
      <Lock className="size-5 text-ink-subtle" />
      <span className="text-[0.7rem] leading-tight font-medium text-ink-subtle">{unlockLabel}</span>
    </div>
  );
}

interface AppearanceTileProps {
  appearance: Appearance;
  playerId: number;
  waifuId: number;
  isActive: boolean;
  onSelect: () => void;
}

function AppearanceTile({ appearance, playerId, waifuId, isActive, onSelect }: AppearanceTileProps) {
  const locked = !appearance.isUnlocked;
  // The tile's own appearance drives its artwork — never the copy's worn look.
  // `null` exactly when the API withheld the asset for a locked entry, so the
  // placeholder is driven by what we actually have rather than by `locked`.
  const asset = appearanceArtworkAsset(playerId, waifuId, appearance);
  const stateLabel = appearance.isSelected
    ? 'currently worn'
    : locked
      ? `locked — ${appearance.unlockLabel}`
      : 'unlocked';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isActive}
      // The name alone is not enough for a screen reader: locked/worn state and
      // the requirement carry the meaning, and neither is available from the
      // artwork or the colour ring.
      aria-label={`${appearance.name} — ${stateLabel}`}
      className={cn(
        'lift group block overflow-hidden rounded-2xl border text-left transition',
        'focus-visible:ring-accent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        appearance.isSelected
          ? 'border-accent ring-accent/40 ring-2'
          : isActive
            ? 'border-border-strong'
            : 'border-border',
      )}
    >
      <div className="relative">
        {/* `asset` is null exactly when the API withheld the artwork. Testing
            it rather than `locked` means the placeholder is driven by what we
            actually have, so no future prop can put a picture here. */}
        {asset === null ? (
          <LockedArtworkSlot unlockLabel={appearance.unlockLabel} aspect="aspect-[3/4]" />
        ) : (
          <Artwork
            asset={asset}
            displayWidth={ARTWORK_WIDTH.strip}
            name={appearance.name}
            aspect="aspect-[3/4]"
          />
        )}
        {appearance.isSelected && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-semibold text-white shadow">
            <Check className="size-3" aria-hidden="true" />
            Worn
          </span>
        )}
        {locked && (
          <span className="absolute top-2 right-2 inline-flex items-center rounded-full bg-surface/90 p-1 text-ink-subtle shadow">
            <Lock className="size-3" aria-hidden="true" />
          </span>
        )}
      </div>

      <div className="space-y-1.5 p-2.5">
        <p className="truncate text-sm font-medium text-ink">{appearance.name}</p>
        {/* Rule 1: the requirement is permanent, on every tile, in both states. */}
        <p className={cn('truncate text-xs', locked ? 'text-ink-subtle' : 'text-ink-muted')}>
          {appearance.unlockLabel}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <CosmeticRarityChip rarity={appearance.cosmeticRarity} />
          {appearance.introducedVersion && (
            <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[0.65rem] text-ink-subtle">
              {appearance.introducedVersion}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

interface AppearanceDetailProps {
  appearance: Appearance;
}

/**
 * The read-only detail panel for the highlighted tile.
 *
 * Informational only: it states the look, its requirement and rarity, and
 * whether she is wearing it. There is **no** control to equip an appearance —
 * the Portal never mutates the equipped look. Locked entries still withhold
 * their flavour text and description, because describing a surprise is a smaller
 * version of spoiling it.
 */
function AppearanceDetail({ appearance }: AppearanceDetailProps) {
  const locked = !appearance.isUnlocked;

  return (
    <div className="mt-4 rounded-2xl border border-border bg-surface-sunken/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-ink">{appearance.name}</h3>
        <CosmeticRarityChip rarity={appearance.cosmeticRarity} />
      </div>

      {/* Flavour text and description are held back with the artwork. They
          describe the look, and describing a surprise is a smaller version of
          spoiling it — the unlock label is what a locked entry is *for*. */}
      {!locked && appearance.flavorText && (
        <p className="mt-2 text-sm text-ink-muted italic">“{appearance.flavorText}”</p>
      )}
      {!locked && appearance.description && (
        <p className="mt-2 text-sm text-ink-muted">{appearance.description}</p>
      )}

      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-muted">Unlock</dt>
          <dd className="text-ink">{appearance.unlockLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-muted">Cosmetic rarity</dt>
          <dd className="text-ink">{cosmeticRarityLabel(appearance.cosmeticRarity)}</dd>
        </div>
        {appearance.introducedVersion && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">Introduced</dt>
            <dd className="text-ink">{appearance.introducedVersion}</dd>
          </div>
        )}
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {locked ? (
          // No reveal control, because there is nothing to reveal — the API
          // sent no artwork for this entry. The requirement is the panel.
          <p className="self-center text-sm text-ink-subtle">
            <Lock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            Locked — {appearance.unlockLabel}. The artwork stays hidden until you earn it.
          </p>
        ) : appearance.isSelected ? (
          <p className="text-sm text-ink-muted">
            <Check className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            She’s wearing this one.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">Unlocked. Equip it from the Discord bot.</p>
        )}
      </div>
    </div>
  );
}

export interface AppearanceGalleryProps {
  playerId: number;
  waifuId: number;
  /** Display name, used in the section's screen-reader label. */
  waifuName: string;
}

export function AppearanceGallery({ playerId, waifuId, waifuName }: AppearanceGalleryProps) {
  const gallery = useWaifuAppearances(playerId, waifuId);

  const [activeId, setActiveId] = useState<string | null>(null);

  if (gallery.isError) {
    return (
      <Card>
        <CardTitle>Appearances</CardTitle>
        <p className="mt-3 text-sm text-ink-muted">Couldn’t load {waifuName}’s appearances.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void gallery.refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  if (!gallery.data) {
    return (
      <Card>
        <CardTitle>Appearances</CardTitle>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true">
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
        </div>
      </Card>
    );
  }

  const { appearances } = gallery.data;
  const unlockedCount = appearances.filter((a) => a.isUnlocked).length;
  const active =
    appearances.find((a) => a.id === activeId) ??
    appearances.find((a) => a.isSelected) ??
    appearances[0];

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Appearances</CardTitle>
        <span className="tabular text-sm text-ink-muted">
          {unlockedCount} / {appearances.length} unlocked
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-subtle">
        Purely cosmetic — an appearance never changes her stats, XP, affection, or capture odds.
      </p>

      <div
        className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3"
        role="group"
        aria-label={`Appearances for ${waifuName}`}
      >
        {appearances.map((appearance) => (
          <AppearanceTile
            key={appearance.id}
            appearance={appearance}
            playerId={playerId}
            waifuId={waifuId}
            isActive={appearance.id === active?.id}
            onSelect={() => setActiveId(appearance.id)}
          />
        ))}
      </div>

      {active && <AppearanceDetail appearance={active} />}
    </Card>
  );
}
