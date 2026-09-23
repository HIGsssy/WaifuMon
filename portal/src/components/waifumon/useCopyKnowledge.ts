/**
 * "May *this viewer* see this species?" — asked about a copy somebody owns.
 *
 * ### The two ownerships a collection view has to keep apart
 *
 * A Waifumon tile carries two different ownership facts, and the public
 * Collection is where conflating them leaks:
 *
 *   - **The owner's.** It decides which copies appear at all. On
 *     `/players/:id/collection` that is the profile owner, and the API has
 *     already authorized it by guild.
 *   - **The viewer's.** It decides which *species knowledge* — artwork, name,
 *     archetype, affinity, content rating, lore, Buddy Bonus — may be drawn.
 *     That is the viewer's dex and nothing else.
 *
 * In `self` mode the two coincide: the copy is in the viewer's own collection,
 * so the species is discovered by construction and no overlay is needed. In
 * `public` mode they are unrelated, and the premise the self-mode components
 * were written against ("the copy is here, therefore it is unlocked") is simply
 * false — Alice owning a Void Empress is not a reason for Bob to learn what one
 * looks like.
 *
 * So this returns the **same tri-state** `discovered` value the Encyclopedia
 * gates on, resolved from the **same** `useSpeciesDiscovery` overlay, so a
 * guild-mate's copy and an encyclopedia entry cannot disagree about what the
 * viewer has unlocked. `undefined` means "not established yet" and locks, as
 * everywhere else.
 *
 * The underlying walk is disabled in `self` mode: the answer is a constant
 * there, and firing it would put the viewer's own collection page through a
 * pagination walk it has no use for.
 */
import { useSpeciesDiscovery } from '@/api/hooks/useSpeciesDiscovery';
import { useSession } from '@/auth/useSession';
import type { CollectionMode } from '@/components/waifumon/WaifumonCard';

/**
 * `true` when the viewer may see this species' protected information,
 * `false` when they positively may not, `undefined` while unknown.
 */
export function useCopyKnowledge(mode: CollectionMode, slug: string): boolean | undefined {
  // `useSession`, not `useCurrentSession`: the session resolves asynchronously,
  // and a component that throws while it is still in flight would turn a
  // privacy gate into a crash. No session means no dex, which means nothing is
  // established — `undefined`, which locks.
  const { session } = useSession();
  const isPublic = mode === 'public';
  const discovery = useSpeciesDiscovery(session?.playerId ?? 0, {
    enabled: isPublic && session !== null,
  });
  // Not `discovery.isDiscovered(slug)` in self mode: the copy being in the
  // viewer's own collection is a stronger and cheaper proof than an overlay
  // that is still walking, and it never flickers.
  return isPublic ? discovery.isDiscovered(slug) : true;
}
