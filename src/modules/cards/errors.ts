/**
 * Card renderer errors. Every failure mode a caller can reasonably branch on
 * is its own class so an HTTP layer (Phase 3) can map artwork-missing to 404
 * and asset-missing to 500 without string-matching messages.
 */
import { AppError } from '../../shared/errors';

/** Base class so callers can `catch`/`instanceof` the whole family at once. */
export class CardRenderError extends AppError {}

/**
 * A required file from `assets/cardart/` is absent. This is a deployment or
 * authoring bug, never player-triggerable — the renderer refuses to silently
 * substitute another asset (notably: `EX` never falls back to `UR`).
 */
export class CardAssetMissingError extends CardRenderError {
  readonly assetPath: string;

  constructor(assetPath: string, what: string) {
    super(
      'CARD_ASSET_MISSING',
      `Required card asset missing (${what}): ${assetPath}`,
      'Card art is being updated, try again shortly~',
    );
    this.assetPath = assetPath;
  }
}

/**
 * The character artwork the caller pointed at does not exist or is not
 * readable. Distinct from {@link CardAssetMissingError} because it is a content
 * problem for one species/appearance, not a broken install — and because the
 * renderer must never substitute unrelated artwork.
 */
export class CardArtworkMissingError extends CardRenderError {
  readonly artworkPath: string;

  constructor(artworkPath: string, speciesSlug: string, appearanceId: string) {
    super(
      'CARD_ARTWORK_MISSING',
      `Artwork for "${speciesSlug}" appearance "${appearanceId}" not readable at ${artworkPath}`,
      "That look doesn't have artwork yet~",
    );
    this.artworkPath = artworkPath;
  }
}

/** The base template is structurally not what the composer expects. */
export class CardTemplateError extends CardRenderError {
  constructor(message: string) {
    super('CARD_TEMPLATE_INVALID', message, 'Card art is being updated, try again shortly~');
  }
}

/** A caller asked for an output width the renderer will not produce. */
export class CardOutputWidthError extends CardRenderError {
  constructor(width: number, min: number, max: number) {
    super(
      'CARD_OUTPUT_WIDTH_INVALID',
      `Requested card width ${width} is outside the supported range ${min}–${max}`,
      'That card size is not available~',
    );
  }
}
