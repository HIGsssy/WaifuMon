/**
 * The detail page's hero image, and the Art ↔ Card switch over it.
 *
 * Two things are being shown here, and they are genuinely different assets:
 * the raw character artwork, and the server-rendered *card* — frame, rarity
 * overlay, race and affinity icons, her level and card text. Artwork stays the
 * default; the card is opt-in.
 *
 * The card is addressed by the owned-copy route, not the species preview,
 * because a card carries her level and the appearance she is wearing and the
 * API already knows both. Passing the Portal's copy of those as query
 * parameters would be gameplay state reconstructed on the client — stale the
 * moment she levels up in another tab.
 *
 * Both views go through `<Artwork>` and the image resolver. Nothing here builds
 * a URL: that is the `cardApi` provider's job, and keeping it there is what
 * lets the card move to a CDN later without this file changing.
 */
import { useState } from 'react';
import { Download, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';

import type { OwnedEntry } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { heroTransitionName } from '@/components/waifumon/WaifumonCard';
import { appearanceAsset, ownedCardAsset } from '@/images/assets';
import { cardUrlFor } from '@/images/providers/cardApi';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { cardFilename, downloadAuthenticatedFile } from '@/lib/download';
import { rarityStyle } from '@/lib/rarity';

type HeroView = 'art' | 'card';

export interface WaifumonHeroProps {
  entry: OwnedEntry;
  /** False when the backend has card rendering switched off. */
  cardsAvailable: boolean;
}

export function WaifumonHero({ entry, cardsAvailable }: WaifumonHeroProps) {
  const { waifu, species } = entry;
  const [view, setView] = useState<HeroView>('art');
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  // A card the renderer cannot serve is not a view to offer. If the flag is
  // switched off between renders the toggle disappears and this falls back to
  // artwork rather than leaving a broken image on screen.
  const showingCard = cardsAvailable && view === 'card';
  const cardAsset = ownedCardAsset(waifu.playerId, entry);
  const rarity = rarityStyle(species.rarity);

  async function handleExport(): Promise<void> {
    // The full-resolution master, never the 512 px derivative on screen.
    const url = cardUrlFor(cardAsset, null);
    if (url === null) return;

    setExporting(true);
    setExportFailed(false);
    try {
      await downloadAuthenticatedFile(
        url,
        cardFilename(species.slug, waifu.selectedAppearance?.assetId.variant),
      );
    } catch {
      // No backend detail on screen: the user can retry, and the request id is
      // already in the console via the API client's own logging.
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-3">
      <RarityGlowRing rarity={species.rarity} glow>
        {showingCard ? (
          <Artwork
            asset={cardAsset}
            displayWidth={ARTWORK_WIDTH.hero}
            name={`${species.name} card`}
            rarityLabel={rarity.label}
            priority
            // The card's own ~13:19 proportions, not the artwork tile's 3:4.
            aspect="aspect-[5/7]"
            fit="contain"
          />
        ) : (
          <Artwork
            asset={appearanceAsset(waifu.selectedAppearance)}
            displayWidth={ARTWORK_WIDTH.hero}
            name={species.name}
            rarityLabel={rarity.label}
            priority
            aspect="aspect-[3/4]"
            viewTransitionName={heroTransitionName(waifu.id)}
          />
        )}
      </RarityGlowRing>

      {cardsAvailable && (
        <div className="space-y-2">
          <div
            role="group"
            aria-label="Hero image view"
            className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1"
          >
            <ViewButton
              active={!showingCard}
              onClick={() => setView('art')}
              icon={<ImageIcon className="size-4" aria-hidden="true" />}
              label="Art"
            />
            <ViewButton
              active={showingCard}
              onClick={() => setView('card')}
              icon={<Sparkles className="size-4" aria-hidden="true" />}
              label="Card"
            />
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {exporting ? 'Preparing card…' : 'Export card'}
          </Button>

          {exportFailed && (
            <p role="status" className="text-center text-xs text-ink-muted">
              Couldn’t save that card. Try again in a moment.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // `aria-pressed` rather than a radio group: two toggle buttons is what
      // the rest of the Portal uses for this shape of control.
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-surface-raised text-ink shadow-sm'
          : 'text-ink-muted hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
