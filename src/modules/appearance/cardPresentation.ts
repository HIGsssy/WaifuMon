/**
 * "Which card should this surface draw?" — answered once, for every surface.
 *
 * Turning a slug or an owned copy into a {@link CardRenderInput} is a chain of
 * small decisions: find the species in the content snapshot, pick the
 * appearance (requested, or the one she is wearing), resolve that appearance to
 * a file on disk with its fallbacks, choose the level, and set the ownership
 * flag. None of it is hard. All of it is easy to get subtly wrong in a second
 * place — and a card keyed by the appearance that was *requested* rather than
 * the one that actually resolved silently doubles the render cache.
 *
 * It lived inside the HTTP card route, which was fine while HTTP was the only
 * consumer. It is not: Discord renders the same cards in-process, and copying
 * this chain into the bot is exactly how the two would drift.
 *
 * The split, deliberately:
 *
 *   - **Here:** every content, appearance and ownership decision, ending at a
 *     `CardRenderInput`. No Fastify, no discord.js, no rasterizing.
 *   - **Callers:** what to do with the bytes. The route streams WebP; Discord
 *     wraps it in an attachment. Both call `renderCard()` themselves, through
 *     the cards module's public API.
 *
 * Failures are the existing typed errors, unchanged, so the HTTP layer keeps
 * mapping them to the same status codes it always did.
 */
import { resolveAppearanceAssetOrLegacyPath } from './assetResolver';
import type { ResolvedAppearanceAsset } from './assetResolver';
import type { ResolvedAppearance } from './appearanceContent';
import type { AppearanceService } from './appearanceService';
import { CardArtworkMissingError, type CardRenderInput } from '../cards';
import type { SpeciesContent } from '../content/schemas';
import { toCardRenderInput } from '../content/speciesCardInput';
import { AppearanceNotFoundError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';

/** Everything a card request needs from the application around it. */
export interface CardPresentationDeps {
  appearance: Pick<AppearanceService, 'speciesContent' | 'catalogFor' | 'currentAppearance'>;
  /** Absolute path to the assets root — `config.assetsDir`. */
  assetsDir: string;
  logger?: Logger | undefined;
}

/**
 * A resolved card request: what to render, plus what it resolved *from*.
 *
 * `artwork` is returned alongside the input rather than folded away because
 * callers legitimately want it — the HTTP route logs which appearance actually
 * supplied the pixels when a fallback fired, and that is a real diagnostic.
 */
export interface CardRequest {
  input: CardRenderInput;
  species: SpeciesContent;
  /** The appearance asked for. May differ from what resolved. */
  requestedAppearanceId: string;
  artwork: ResolvedAppearanceAsset;
}

export interface SpeciesCardOptions {
  /** Appearance id. Omitted means the species' current default. */
  appearanceId?: string | undefined;
  /** Level printed on the card. Defaults to 1 — a preview, not a copy. */
  level?: number | undefined;
  /** Requested display width; omitted means the full-size master. */
  width?: number | undefined;
  /**
   * Composite the CAUGHT emblem — the pre-catch duplicate-warning signal.
   *
   * Opt-in, off by default. Currently set only by the hunt encounter reveal
   * when the player already owns ≥1 active copy of the species.
   */
  showCaughtBadge?: boolean | undefined;
}

export interface OwnedCardOptions {
  width?: number | undefined;
  /**
   * Composite the CAUGHT emblem. Off by default even for owned copies: the
   * badge is a pre-catch warning, not a general ownership marker, so inspect,
   * capture-success and the Portal owned card all decline it.
   */
  showCaughtBadge?: boolean | undefined;
}

/** The slice of an owned copy a card needs. Satisfied by `OwnedEntry`. */
export interface OwnedCardSubject {
  waifu: { level: number; variant: string | null };
  species: { slug: string };
}

/**
 * A **species preview** card — the card as a definition, at level 1 by
 * default, wearing whichever appearance was asked for.
 *
 * The CAUGHT badge stays off unless the caller explicitly asks for it via
 * {@link SpeciesCardOptions.showCaughtBadge} — the hunt encounter turns it on
 * for the duplicate-warning path; every other preview surface leaves it off.
 */
export function speciesCardRequest(
  deps: CardPresentationDeps,
  species: SpeciesContent,
  options: SpeciesCardOptions = {},
): CardRequest {
  const chosen = pickAppearance(deps, species, options.appearanceId);
  const artwork = resolveArtwork(deps, species, chosen);

  const input = toCardRenderInput(species, {
    artwork,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.showCaughtBadge === undefined
      ? {}
      : { showCaughtBadge: options.showCaughtBadge }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  return { input, species, requestedAppearanceId: chosen.id, artwork };
}

/**
 * A card for one **owned copy** — her real level, the look she is actually
 * wearing.
 *
 * The level and the appearance come off the row, never from the caller. A
 * surface that passed its own copy of either would be reconstructing gameplay
 * state it does not own, and would be wrong the moment she levels up somewhere
 * else.
 *
 * The CAUGHT badge is **not** implied by ownership. It is a pre-catch duplicate
 * warning; on an already-owned copy it would be redundant, and on an inspect
 * or portal surface it would be a lie about *when* the warning was earned.
 * Callers turn it on explicitly via {@link OwnedCardOptions.showCaughtBadge},
 * which no owned surface does today.
 */
export function ownedCardRequest(
  deps: CardPresentationDeps,
  subject: OwnedCardSubject,
  options: OwnedCardOptions = {},
): CardRequest {
  const species = deps.appearance.speciesContent(subject.species.slug);
  if (!species) {
    // An owned copy of a species the content snapshot no longer has. Reported
    // as missing artwork rather than a missing species: the copy is real, the
    // thing we cannot draw is her picture.
    throw new CardArtworkMissingError('', subject.species.slug, 'standard');
  }

  const worn = deps.appearance.currentAppearance(species, subject.waifu.variant);
  const artwork = resolveArtwork(deps, species, worn);

  const input = toCardRenderInput(species, {
    artwork,
    level: subject.waifu.level,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.showCaughtBadge === undefined
      ? {}
      : { showCaughtBadge: options.showCaughtBadge }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  return { input, species, requestedAppearanceId: worn.id, artwork };
}

/**
 * The appearance a species-preview card should wear.
 *
 * An unknown id is a malformed request, not a missing asset — the API answers
 * it with 400 via `APPEARANCE_NOT_FOUND`, and that distinction is preserved by
 * throwing the same error here.
 */
function pickAppearance(
  deps: CardPresentationDeps,
  species: SpeciesContent,
  appearanceId: string | undefined,
): ResolvedAppearance {
  if (appearanceId === undefined) {
    return deps.appearance.currentAppearance(species, null);
  }
  const chosen = deps.appearance
    .catalogFor(species)
    .find((entry) => entry.id === appearanceId);
  if (!chosen) throw new AppearanceNotFoundError(appearanceId, species.slug);
  return chosen;
}

/**
 * Appearance → bytes on disk, degrading appearance → species default → the
 * species' legacy `imagePath`.
 *
 * Only the *result* travels onward, which is the point: after a fallback the
 * path and the id describe the same asset, so a card can never be keyed by an
 * appearance it did not actually draw.
 */
function resolveArtwork(
  deps: CardPresentationDeps,
  species: SpeciesContent,
  appearance: ResolvedAppearance,
): ResolvedAppearanceAsset {
  const resolved = resolveAppearanceAssetOrLegacyPath(
    { assetsDir: deps.assetsDir, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
    // The appearance's own `assetId`, never one rebuilt from its id — the
    // catalog is what says where a look's artwork lives.
    appearance.assetId,
    species.imagePath,
  );
  if (!resolved) throw new CardArtworkMissingError('', species.slug, appearance.id);
  return resolved;
}
