/**
 * The Discord process's `owned copy → rendered card attachment` adapter.
 *
 * Discord and the Platform API run in one process, so a card here is a direct
 * call into the cards module — not a request to our own HTTP route. The route
 * exists for the Portal, which is a different process; going through localhost
 * from inside the same one would add a socket, a serializer and a bearer token
 * to a function call.
 *
 * What this file is allowed to know is deliberately narrow:
 *
 *   - **Which** card to draw comes from `modules/appearance/cardPresentation`,
 *     the same resolver the HTTP route uses. Appearance selection, artwork
 *     fallback, level and the ownership flag are decided there, once.
 *   - **How** to draw it is `renderCard()` from the cards module's public API.
 *     Nothing here touches the composer, the rasterizer or the cache.
 *   - The only genuinely Discord-shaped part is the last two lines: wrap bytes
 *     in an `AttachmentBuilder` under a readable filename.
 *
 * **Every failure degrades to `null`.** A card is an enhancement on surfaces
 * that already worked with raw artwork, so a missing asset, a frameless rarity
 * or a disabled renderer must cost the player their card and nothing else — the
 * capture still happened, and the embed still sends.
 */
import { AttachmentBuilder } from 'discord.js';
import { renderCard } from '../../modules/cards';
import { ownedCardRequest, speciesCardRequest } from '../../modules/appearance/cardPresentation';
import type { OwnedCardSubject } from '../../modules/appearance/cardPresentation';
import { CARD_FILENAME, resolveAppearanceAssetOrPath } from './resolveAppearanceAsset';
import type { PlayerWaifuRow, SpeciesRow } from '../../db/schema';
import type { AppContext } from '../types';

/**
 * Display width for a Discord card.
 *
 * 1024 is the largest bucket the renderer derives, and at ~350 KB it sits well
 * inside every upload limit. The 1500 px master is ~640 KB for no visible gain:
 * Discord scales the image down in the client either way, and each message gets
 * a fresh attachment URL, so the extra bytes buy no caching either.
 */
export const DISCORD_CARD_WIDTH = 1024;

/** Attachment filename every rendered-card embed references. */
export function renderedCardFilename(slug: string, ownedId?: number): string {
  const name = slug.replace(/_/g, '-');
  return ownedId === undefined
    ? `waifumon-${name}.webp`
    : `waifumon-${name}-${ownedId}.webp`;
}

export interface RenderedCardAttachment {
  file: AttachmentBuilder;
  /** What `embed.setImage()` should point at. */
  url: string;
}

/**
 * True when this deployment has card rendering switched on.
 *
 * The flag is `platformApi.cardRendererEnabled` because it was introduced to
 * gate the HTTP routes, but it means "this process can render cards" — so
 * Discord reads the same one rather than growing a second switch that could
 * disagree with the Portal about whether cards exist.
 */
export function cardsEnabled(ctx: AppContext): boolean {
  // Optional-chained on purpose. This is the gate for an *optional* feature, so
  // it has to answer "no" for any context that does not describe one — including
  // a partially-assembled config — rather than throwing and taking the whole
  // command down with it. A player must never lose a capture result because a
  // card could not be drawn.
  return ctx.config.platformApi?.cardRendererEnabled === true;
}

/**
 * The rendered card for one owned copy, or `null` to fall back to raw artwork.
 *
 * `null` is returned — never thrown — when cards are switched off, when the
 * species has no frame yet (`EX`), or when anything else goes wrong. A player
 * who just captured a Waifumon must not see a renderer configuration error
 * because an optional feature is disabled.
 */
export async function renderOwnedCardAttachment(
  ctx: AppContext,
  subject: OwnedCardSubject & { waifu: { id: number } },
): Promise<RenderedCardAttachment | null> {
  if (!cardsEnabled(ctx)) return null;

  try {
    const { input } = ownedCardRequest(
      { appearance: ctx.services.appearance, assetsDir: ctx.config.assetsDir, logger: ctx.logger },
      subject,
      { width: DISCORD_CARD_WIDTH },
    );
    const card = await renderCard(input);
    const name = renderedCardFilename(subject.species.slug, subject.waifu.id);

    /**
     * The grid derivatives, for free, right after the expensive part.
     *
     * The render above was at 1024, which means the master now exists on disk.
     * Producing the @256 and @512 the Portal's collection tiles ask for is
     * therefore two Sharp resizes off a file already in the cache — no resvg,
     * no worker thread — and it is the difference between a freshly-captured
     * Waifumon appearing instantly in the grid and appearing after a cold
     * render.
     *
     * Scheduled, never awaited: the player is waiting on this reply, and a
     * capture must not spend a millisecond of it on an optimisation for a page
     * they may not open. `scheduleCopyWarm` dedupes by copy, so the ephemeral
     * reply and the public announcement — which both render this same card —
     * produce one warm between them.
     */
    ctx.cardWarmer?.scheduleCopyWarm(subject);

    return {
      file: new AttachmentBuilder(card.bytes, { name }),
      url: `attachment://${name}`,
    };
  } catch (err) {
    ctx.logger.warn(
      { err, tag: 'discord/card-render', slug: subject.species.slug, waifuId: subject.waifu.id },
      'card render failed; falling back to raw artwork',
    );
    return null;
  }
}

/** The slice of an owned copy an image needs. Satisfied by `OwnedEntry`. */
export interface OwnedCardImageSubject {
  waifu: Pick<PlayerWaifuRow, 'id' | 'level' | 'variant'>;
  species: SpeciesRow;
}

/**
 * The picture of one owned copy, however good a one this deployment can make.
 *
 * Three tiers, in descending order of fidelity:
 *
 *   1. the rendered card — frame, level, the works;
 *   2. the raw artwork for the appearance **she is actually wearing**, when the
 *      renderer is switched off or could not draw her;
 *   3. `null`, meaning the surface renders text-only.
 *
 * Tier 2 goes through `currentAppearance(species, variant)` rather than
 * `species.imagePath`, so a copy wearing an unlocked look never silently
 * reverts to the species default just because card rendering is unavailable.
 * `imagePath` is passed only as the resolver's private last resort, for a
 * species whose appearance artwork is missing from disk entirely.
 *
 * Never throws. Every surface that shows a copy — inspect, and the Care Mode
 * Trainer Profile — already worked without a picture, so a failure here costs
 * the image and nothing else.
 */
export async function ownedCardImage(
  ctx: AppContext,
  subject: OwnedCardImageSubject,
): Promise<RenderedCardAttachment | null> {
  try {
    const rendered = await renderOwnedCardAttachment(ctx, subject);
    if (rendered) return rendered;

    // Her level rides along so a `variant` she has stopped qualifying for
    // degrades to the default. Tier 2 is the *fallback* path — the one that
    // runs when card rendering is off — and it must not be the one surface
    // that still paints locked artwork.
    const worn = ctx.services.appearance.currentAppearance(
      subject.species,
      subject.waifu.variant,
      { level: subject.waifu.level },
    );
    const file = resolveAppearanceAssetOrPath(ctx, worn.assetId, subject.species.imagePath);
    return file === null ? null : { file, url: `attachment://${CARD_FILENAME}` };
  } catch (err) {
    ctx.logger.warn(
      { err, tag: 'discord/owned-card-image', slug: subject.species.slug, waifuId: subject.waifu.id },
      'owned card image unavailable; falling back to a text-only embed',
    );
    return null;
  }
}

/**
 * A **species-preview** card with the CAUGHT duplicate-warning badge, for the
 * hunt encounter reveal when the player already owns ≥1 active copy.
 *
 * Never invoked for a first encounter of a species: the badge is a warning
 * only, and painting it on a species the player has not caught would be
 * meaningless. The caller checks ownership.
 *
 * `null` on any failure — renderer off, missing frame, missing content — so
 * the encounter falls back to raw artwork rather than refusing to reveal.
 */
export async function renderEncounterDuplicateCardAttachment(
  ctx: AppContext,
  species: { slug: string },
): Promise<RenderedCardAttachment | null> {
  if (!cardsEnabled(ctx)) return null;

  const content = ctx.services.appearance.speciesContent(species.slug);
  if (!content) return null;

  try {
    const { input } = speciesCardRequest(
      { appearance: ctx.services.appearance, assetsDir: ctx.config.assetsDir, logger: ctx.logger },
      content,
      { width: DISCORD_CARD_WIDTH, showCaughtBadge: true },
    );
    const card = await renderCard(input);
    const name = renderedCardFilename(species.slug);
    return {
      file: new AttachmentBuilder(card.bytes, { name }),
      url: `attachment://${name}`,
    };
  } catch (err) {
    ctx.logger.warn(
      { err, tag: 'discord/encounter-card-render', slug: species.slug },
      'encounter duplicate-warning render failed; falling back to raw artwork',
    );
    return null;
  }
}
