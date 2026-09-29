/**
 * `/admin/test-controls` — find a test account and open its controls.
 *
 * Search reuses the Players directory endpoint, so it is scoped to the guild
 * the session has selected by the server, never by this page. A tester who
 * already knows the internal player id can jump straight to it.
 *
 * Gated on `players.testcontrols` by the route and, for real, by the API,
 * which registers these endpoints only on a non-production deployment with
 * `ENABLE_TEST_ADMIN_CONTROLS=true`. Anywhere else the info call 404s and the
 * page says the tools are not available here.
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { getTestControlsInfo } from '@/api/adminTestControls';
import { isPortalApiError } from '@/api/client';
import { usePlayerDirectory } from '@/api/hooks/usePlayerDirectory';
import { queryKeys } from '@/api/queryKeys';
import { useSession } from '@/auth/useSession';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import { errorText } from './errorText';
import { DisabledNotice, StagingBanner } from './shared';

export function TestControlsPickerPage() {
  const info = useQuery({
    queryKey: queryKeys.adminTestControls(),
    queryFn: ({ signal }) => getTestControlsInfo(signal),
    retry: false,
  });
  const disabled = isPortalApiError(info.error) && info.error.status === 404;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staging Test Controls"
        description="Prepare test accounts for level- and progression-gated content without grinding."
      />
      <StagingBanner deploymentEnv={info.data?.deploymentEnv} />

      {info.isPending && <Skeleton className="h-40 rounded-2xl" />}
      {disabled && <DisabledNotice />}
      {info.isError && !disabled && (
        <div
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm"
        >
          {errorText(info.error, 'Test controls could not be loaded.')}
        </div>
      )}
      {info.data && <PlayerPicker />}
    </div>
  );
}

function PlayerPicker() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [idInput, setIdInput] = useState('');
  const debounced = useDebouncedValue(search.trim(), 250);
  const directory = usePlayerDirectory({
    guildDbId: session?.guildDbId,
    page: 1,
    search: debounced,
    sort: 'name',
  });

  const openById = (e: React.FormEvent) => {
    e.preventDefault();
    const id = Number(idInput.trim());
    if (Number.isInteger(id) && id > 0) void navigate(`/admin/test-controls/${id}`);
  };

  const players = directory.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a test player</CardTitle>
      </CardHeader>
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search players by name</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            placeholder="Search by display name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <form onSubmit={openById} className="flex gap-2">
          <label className="sr-only" htmlFor="test-controls-player-id">
            Player id
          </label>
          <Input
            id="test-controls-player-id"
            className="w-32"
            inputMode="numeric"
            placeholder="Player id"
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline">
            Open
          </Button>
        </form>
      </div>

      <div className="mt-4">
        {directory.isPending && !directory.data ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : directory.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorText(directory.error, 'Players could not be loaded.')}
          </p>
        ) : players.length === 0 ? (
          <p className="text-sm text-ink-muted">No players match.</p>
        ) : (
          <ul
            className="divide-y divide-border rounded-xl border border-border"
            aria-label="Players"
          >
            {players.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/admin/test-controls/${p.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-surface-raised"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink">{p.displayName}</span>
                    <span className="ml-2 text-ink-subtle">#{p.id}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-ink-muted">
                    Lv {p.level}
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
