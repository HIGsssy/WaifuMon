/**
 * CardViewer — a rendered card, large enough to read.
 *
 * One implementation for both card contexts. A card is a card: the species
 * preview and an owned copy differ only in which `AssetId` they carry, and that
 * difference is already resolved by `speciesCardAsset` / `ownedCardAsset`
 * before it reaches here. Two viewers would be two places to fix a layout bug.
 *
 * **Size.** The 1024 px derivative, never the master. At the viewport heights
 * this dialog actually occupies, 1024 is already more pixels than the card is
 * drawn with on any normal display, and the master is roughly twice the bytes
 * for no visible difference. Export Card is the surface that wants the master,
 * and it still asks for it.
 */
import type { AssetId } from '@/images/types';
import { Artwork } from '@/components/media/Artwork';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** The width the enlarged card is requested at. See the note above. */
export const CARD_VIEWER_WIDTH = 1024;

export interface CardViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetId;
  /** Character or species name — becomes the dialog's accessible title. */
  name: string;
  rarityLabel?: string | undefined;
}

export function CardViewer({ open, onOpenChange, asset, name, rarityLabel }: CardViewerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close card">
        {/* Radix requires a title; the card itself carries the name visually. */}
        <DialogTitle className="sr-only">{`${name} card`}</DialogTitle>
        <DialogDescription className="sr-only">
          Press Escape or click outside the card to close.
        </DialogDescription>

        <Artwork
          asset={asset}
          displayWidth={CARD_VIEWER_WIDTH}
          name={`${name} card`}
          {...(rarityLabel === undefined ? {} : { rarityLabel })}
          priority
          // The card's own 2:3 proportions. `contain` inside a height-bounded
          // box is what keeps a tall card fully visible on a short viewport
          // instead of running off the ends.
          aspect="aspect-[2/3]"
          fit="contain"
          className="max-h-[88vh] w-auto max-w-full rounded-2xl bg-transparent"
          imgClassName="h-full w-full"
        />
      </DialogContent>
    </Dialog>
  );
}
