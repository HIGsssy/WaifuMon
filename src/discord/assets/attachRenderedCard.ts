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
import { ownedCardRequest } from '../../modules/appearance/cardPresentation';
import type { OwnedCardSubject } from '../../modules/appearance/cardPresentation';
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
