/**
 * "May this caller see this species' artwork?" — the server half of the dex
 * spoiler rule.
 *
 * The Portal silhouettes an undiscovered species, but a silhouette drawn in a
 * browser is a presentation choice, not a control: the artwork routes are
 * addressed by slug, every slug is public through `/content/species`, and the
 * whole encyclopedia is therefore one hand-typed URL away from any player who
 * opens devtools. This is the check that makes the silhouette mean something.
 *
 * ### Who it applies to
 *
 * Only **player-scoped** callers — a Portal browser session, authenticated by
 * the session cookie. The shared bearer token is the bot, the admin panel, the
 * card-warming tools and the operator: they render every species by design, and
 * gating them on a player's dex would be meaningless (there is no player in
 * scope) as well as wrong. In development the Vite proxy attaches that same
 * bearer token, so a developer's Portal is unaffected — which is why the client
 * gate in `SpeciesArtwork` is a peer of this check rather than a duplicate of
 * it, and why both exist.
 *
 * ### Fail-closed
 *
 * A portal session with no resolved player (mid guild-selection, or a Discord
 * account with no profile in the selected guild) has no dex to check against,
 * so it sees no artwork. Unknown is refused, never allowed.
 */
import type { ApiContext } from '../context';
import { ApiSpeciesNotDiscoveredError } from '../errors';

/** The slice of the request this check reads — kept structural for testability. */
export interface SpeciesVisibilityRequest {
  apiAuth?: 'bearer' | 'portal' | undefined;
  portalSession?: { playerId: number | null } | undefined;
}

/**
 * Throws `ApiSpeciesNotDiscoveredError` (403) when a player's browser asks for
 * artwork of a species they have not caught. Resolves silently for every
 * trusted caller.
 */
export async function assertSpeciesVisible(
  ctx: ApiContext,
  req: SpeciesVisibilityRequest,
  slug: string,
): Promise<void> {
  // Anything that is not a positively-identified trusted caller falls through
  // to the dex check below, so a future auth mode cannot open this by omission.
  if (req.apiAuth === 'bearer') return;

  const playerId = req.portalSession?.playerId;
  if (playerId === undefined || playerId === null) {
    throw new ApiSpeciesNotDiscoveredError(slug);
  }

  const discovered = await ctx.services.collection.hasDiscoveredSpeciesSlug(playerId, slug);
  if (!discovered) throw new ApiSpeciesNotDiscoveredError(slug);
}
