/**
 * `/players` — the trainers you share a server with.
 *
 * Scoped, always and only, to the guild the session currently has selected.
 * That scope is enforced by the API (`GET /v1/players` reads the selection off
 * the session cookie and takes no guild parameter); this page does not filter
 * by guild and could not, which is the point — there is no client-side rule
 * here that a crafted request could step around.
 *
 * What the page *does* own is the cache boundary. `usePlayerDirectory` is keyed
 * by `session.guildDbId`, so guild A's roster and guild B's are separate
 * entries, and the page renders its loading state — never the previous
 * server's players — while a switch resolves.
 *
 * Search, Name and Trainer Level are the three controls, and "Recently active"
 * is the fourth only because `lastActiveAt` is a real timestamp the game
 * already keeps. There is deliberately no online/offline indicator: nothing in
 * the system knows that.
 */
import { Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { DIRECTORY_PAGE_SIZE } from '@/api/players';
import { usePlayerDirectory } from '@/api/hooks/usePlayerDirectory';
import type { DirectorySort } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { avatarAsset } from '@/images/assets';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { formatRelative } from '@/lib/format';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import type { Rarity } from '@/api/types';

const SORTS: readonly { value: DirectorySort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'level', label: 'Trainer level' },
  { value: 'recent', label: 'Recently active' },
];

function isSort(value: string | null): value is DirectorySort {
  return SORTS.some((option) => option.value === value);
}

function PlayerRow({
  player,
}: {
  player: {
    id: number;
    displayName: string;
    avatarUrl: string | null;
    level: number;
    lastActiveAt: string;
    buddy: { speciesName: string; rarity: string; assetId: { kind: 'waifumon'; slug: string; variant: string } } | null;
  };
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:gap-4">
      <Artwork
        asset={avatarAsset(player.id, player.avatarUrl)}
        displayWidth={ARTWORK_WIDTH.avatar}
        name={player.displayName}
        aspect="aspect-square"
        className="size-10 shrink-0 rounded-full border border-border"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{player.displayName}</p>
        <p className="tabular text-xs text-ink-subtle">
          Level {player.level} · active {formatRelative(player.lastActiveAt)}
        </p>
      </div>

      {/* The buddy preview rides on the directory response itself — no second
          request per row. A player with no buddy simply has no cell here. */}
      {player.buddy && (
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          {/* `baseArtwork` routes this through the same dex-gated artwork
              endpoint every other species image uses, so another player's
              buddy silhouettes for a viewer who has not discovered her. That
              is the existing reveal rule applied unchanged — the directory
              does not become a way to see art you have not earned. */}
          <Artwork
            asset={{ ...player.buddy.assetId, baseArtwork: true }}
            displayWidth={ARTWORK_WIDTH.strip}
            name={player.buddy.speciesName}
            aspect="aspect-[3/4]"
            className="w-9 shrink-0 overflow-hidden rounded-md border border-border"
          />
          <div className="min-w-0">
            <p className="truncate text-xs text-ink-muted">{player.buddy.speciesName}</p>
            <RarityBadge rarity={player.buddy.rarity as Rarity} />
          </div>
        </div>
      )}

      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link to={`/players/${player.id}`} viewTransition>
          View Profile
        </Link>
      </Button>
    </li>
  );
}

export function PlayersPage() {
  const { session, eligibleGuilds } = useSession();
  const guildDbId = session?.guildDbId;
  const guildName =
    eligibleGuilds?.find((guild) => guild.discordGuildId === session?.discordGuildId)?.name ?? null;

  const [searchParams, setSearchParams] = useSearchParams();
  const sortParam = searchParams.get('sort');
  const sort: DirectorySort = isSort(sortParam) ? sortParam : 'name';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [searchDraft, setSearchDraft] = useState(searchParams.get('search') ?? '');
  const search = useDebouncedValue(searchDraft, 250);

  const directory = usePlayerDirectory({ guildDbId, page, search, sort });

  function patch(key: string, value: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      // Any change to what is being asked for returns to the first page.
      if (key !== 'page') next.delete('page');
      return next;
    });
  }

  const players = directory.data?.items ?? [];
  const total = directory.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Players"
        description={
          guildName
            ? `Waifumon trainers in ${guildName}.`
            : 'Waifumon trainers in your selected server.'
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={searchDraft}
          onChange={(event) => {
            setSearchDraft(event.target.value);
            patch('search', event.target.value);
          }}
          placeholder="Search players..."
          aria-label="Search players"
          className="sm:max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="shrink-0">Sort</span>
          <select
            value={sort}
            onChange={(event) => patch('sort', event.target.value)}
            aria-label="Sort players"
            className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-ink sm:h-9"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {directory.isError ? (
        <ErrorState
          error={directory.error}
          onRetry={() => void directory.refetch()}
          title="Couldn't load the player directory."
        />
      ) : /* Fail closed: no resolved guild, or nothing fetched for this one yet,
            renders skeletons rather than an empty roster or a stale one. */
      guildDbId === undefined || (directory.isPending && !directory.data) ? (
        <Card flush className="overflow-hidden">
          <div className="space-y-px">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-none" />
            ))}
          </div>
        </Card>
      ) : players.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? 'No players match that name.' : 'No players here yet.'}
          description={
            search
              ? 'Try a shorter search, or clear it to see everyone in this server.'
              : 'Nobody in this server has played Waifumon yet.'
          }
          hint={search ? undefined : 'Trainers appear here once they play in Discord.'}
        />
      ) : (
        <>
          <Card flush className="overflow-hidden">
            {/* Labelled so the roster is addressable as its own list — the
                shell's navigation is a list too. */}
            <ul aria-label="Players in this server">
              {players.map((player) => (
                <PlayerRow key={player.id} player={player} />
              ))}
            </ul>
          </Card>

          {lastPage > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => patch('page', String(page - 1))}
              >
                Previous
              </Button>
              <p className="tabular text-xs text-ink-subtle">
                Page {page} of {lastPage} · {total} players
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= lastPage}
                onClick={() => patch('page', String(page + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
