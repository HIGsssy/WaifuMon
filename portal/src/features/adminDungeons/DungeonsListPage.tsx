/**
 * Admin — Dungeons: every dungeon zone, where it stands relative to Git, the
 * Delve-wide settings (the daily run limit every zone shares), and the
 * progression currency dungeons pay.
 *
 * Zones are database rows seeded from `content/dungeons/zones.json`. A zone
 * edited here is never overwritten by a deploy; **Export** writes the file
 * format back so the edit can be committed to Git.
 *
 * There is no delete. A zone is switched off instead — runs already generated
 * keep the zone they started with either way.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  DUNGEONS_QUERY_KEY,
  exportDungeonZones,
  getDungeonReference,
  getDungeonSettings,
  listDungeonZones,
  listProgressionCurrencies,
  setDungeonZoneEnabled,
  updateDungeonSettings,
  updateProgressionCurrency,
  type DungeonSettings,
  type DungeonZoneSummary,
  type ProgressionCurrency,
  type ProgressionCurrencyMetadata,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { cn } from '@/lib/cn';

/** Where a zone stands relative to Git, in one badge. */
export function ZoneOriginBadge({ summary }: { summary: Pick<DungeonZoneSummary, 'origin'> }) {
  if (summary.origin === 'custom') return <Badge variant="outline">Portal only</Badge>;
  if (summary.origin === 'shipped') return <Badge variant="default">Shipped</Badge>;
  return (
    <Badge
      variant="solid"
      title="Edited here; deploys will not overwrite it. Export to commit it to Git."
    >
      Edited — differs from Git
    </Badge>
  );
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const formatUpdated = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function DungeonsListPage() {
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'zones'],
    queryFn: ({ signal }) => listDungeonZones(signal),
  });
  const zones = query.data?.zones ?? [];
  // Region names for the list. Shared with the editor's cache; ids show until it loads.
  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
    staleTime: 60_000,
  }).data;
  const regionNames = new Map((reference?.regions ?? []).map((r) => [r.id, r.name]));
  const exporting = useMutation({
    mutationFn: exportDungeonZones,
    onSuccess: (exported) =>
      downloadJson(exported.file.split('/').pop() ?? 'zones.json', exported.document),
  });
  const toggle = useMutation({
    mutationFn: (zone: DungeonZoneSummary) =>
      setDungeonZoneEnabled(zone.key, !zone.enabled, zone.revision),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY }),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeons"
        description="Zones the dungeon generator builds runs from. Edits reach the next run generated; a run already generated keeps the zone it started with."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/dungeons/preview">Generation preview</Link>
            </Button>
            <Button
              variant="outline"
              disabled={exporting.isPending}
              onClick={() => exporting.mutate()}
            >
              Export zones
            </Button>
            {canWrite && (
              <Button asChild variant="accent">
                <Link to="/admin/dungeons/new">New zone</Link>
              </Button>
            )}
          </div>
        }
      />

      {exporting.isError && (
        <ErrorState variant="inline" title="Could not export" error={exporting.error} />
      )}
      {toggle.isError && (
        <ErrorState
          variant="inline"
          title={
            isPortalApiError(toggle.error) && toggle.error.code === 'DUNGEON_ZONE_STALE'
              ? 'That zone was changed by someone else — the list has been refreshed'
              : 'Could not change the zone'
          }
          error={toggle.error}
        />
      )}
      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load dungeon zones"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && zones.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No dungeon zones yet.</Card>
      )}
      {zones.length > 0 && (
        <Card className="divide-y divide-border">
          {zones.map((z) => (
            <div
              key={z.key}
              className="flex flex-wrap items-start gap-3 px-4 py-3"
              data-testid="dungeon-zone-row"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/dungeons/zones/${encodeURIComponent(z.key)}`}
                    className={cn(
                      'font-medium text-ink hover:underline',
                      !z.enabled && 'text-ink-muted',
                    )}
                  >
                    {z.name}
                  </Link>
                  <span className="font-mono text-xs text-ink-subtle">{z.key}</span>
                  <ZoneOriginBadge summary={z} />
                  {z.enabled ? (
                    <Badge variant="default">Enabled</Badge>
                  ) : (
                    <Badge variant="danger">Disabled</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {z.minNodes}–{z.maxNodes} nodes · {z.poolCount} pool{z.poolCount === 1 ? '' : 's'}{' '}
                  ({z.poolEntryCount} entr{z.poolEntryCount === 1 ? 'y' : 'ies'}) ·{' '}
                  {z.rewardBandCount} depth band
                  {z.rewardBandCount === 1 ? '' : 's'}
                </p>
                <p className="text-xs text-ink-muted" data-testid="zone-regions">
                  {z.availableRegions.length === 0
                    ? 'Available nowhere — choose a region in the editor'
                    : `Available in: ${z.availableRegions.map((id) => regionNames.get(id) ?? id).join(', ')}`}
                </p>
                <p className="text-xs text-ink-subtle">
                  Revision {z.revision} · updated {formatUpdated(z.updatedAt)}
                  {z.updatedBy ? ` by ${z.updatedBy}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                {canWrite && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={toggle.isPending}
                    aria-label={`${z.enabled ? 'Disable' : 'Enable'} ${z.name}`}
                    onClick={() => toggle.mutate(z)}
                  >
                    {z.enabled ? 'Disable' : 'Enable'}
                  </Button>
                )}
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/admin/dungeons/zones/${encodeURIComponent(z.key)}`}>
                    {canWrite ? 'Edit' : 'View'}
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <SettingsPanel canWrite={canWrite} />
      <CurrencyPanel canWrite={canWrite} />
    </div>
  );
}

/** Delve-wide settings: one daily run limit, shared by every zone. */
function SettingsPanel({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'settings'],
    queryFn: ({ signal }) => getDungeonSettings(signal),
  });
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase text-ink-muted">Delve settings</h2>
      <p className="text-xs text-ink-muted">
        How many runs a player may start per game day, counted across every zone. Starting a run
        uses one; resuming, extracting, finishing, dying and abandoning never give one back. It
        resets with the daily claim and is separate from Energy.
      </p>
      {query.isPending && <Skeleton className="h-20 w-full" />}
      {query.isError && (
        <ErrorState
          variant="inline"
          title="Could not load the Delve settings"
          error={query.error}
        />
      )}
      {query.data && (
        <SettingsCard
          key={`${query.data.dailyRunLimit}:${query.data.updatedAt ?? ''}`}
          settings={query.data}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

function SettingsCard({ settings, canWrite }: { settings: DungeonSettings; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(String(settings.dailyRunLimit));
  const value = Number(text);
  // Whole numbers inside the server's bounds only — nothing is rounded or clamped for the admin.
  const valid =
    /^\d+$/.test(text.trim()) &&
    value >= settings.dailyRunLimitMin &&
    value <= settings.dailyRunLimitMax;
  const dirty = valid && value !== settings.dailyRunLimit;
  const save = useMutation({
    mutationFn: () => updateDungeonSettings({ dailyRunLimit: value }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: [...DUNGEONS_QUERY_KEY, 'settings'] }),
  });

  return (
    <Card className="space-y-3 p-4" data-testid="delve-settings-card">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Daily run limit
          <Input
            aria-label="Daily run limit"
            className="w-32"
            inputMode="numeric"
            value={text}
            disabled={!canWrite}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {canWrite && (
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save limit'}
          </Button>
        )}
      </div>
      {!valid && (
        <p className="text-xs text-danger" role="alert">
          Enter a whole number from {settings.dailyRunLimitMin} to {settings.dailyRunLimitMax}.
        </p>
      )}
      <p className="text-xs text-ink-subtle" data-testid="delve-settings-sample">
        {valid && value === 0
          ? 'Delve is closed to new runs. Runs already in progress can still be finished.'
          : `Shown to players as: Daily Runs: ${valid ? value : settings.dailyRunLimit} / ${
              valid ? value : settings.dailyRunLimit
            } remaining`}
      </p>
      {settings.updatedAt && (
        <p className="text-xs text-ink-subtle">
          Updated {formatUpdated(settings.updatedAt)}
          {settings.updatedBy ? ` by ${settings.updatedBy}` : ''}
        </p>
      )}
      {save.isError && (
        <ErrorState variant="inline" title="Could not save the Delve settings" error={save.error} />
      )}
    </Card>
  );
}

/** The progression currencies dungeons pay: a fixed key, editable display names. */
function CurrencyPanel({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'currencies'],
    queryFn: ({ signal }) => listProgressionCurrencies(signal),
  });
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase text-ink-muted">Progression currency</h2>
      <p className="text-xs text-ink-muted">
        What dungeons pay toward Ascension. Rename it freely — zones and balances reference the key,
        which never changes.
      </p>
      {query.isPending && <Skeleton className="h-24 w-full" />}
      {query.isError && (
        <ErrorState variant="inline" title="Could not load the currency" error={query.error} />
      )}
      {query.data?.currencies.map((currency) => (
        <CurrencyCard
          key={`${currency.key}:${currency.revision}`}
          currency={currency}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}

function CurrencyCard({
  currency,
  canWrite,
}: {
  currency: ProgressionCurrency;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProgressionCurrencyMetadata>({
    singularName: currency.singularName,
    pluralName: currency.pluralName,
    description: currency.description,
    icon: currency.icon,
    enabled: currency.enabled,
  });
  const save = useMutation({
    mutationFn: () => updateProgressionCurrency(currency.key, form, currency.revision),
    // Success or stale, the list is the source of truth for the next edit.
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: [...DUNGEONS_QUERY_KEY, 'currencies'] }),
  });
  const set = (patch: Partial<ProgressionCurrencyMetadata>) => setForm({ ...form, ...patch });
  const dirty =
    form.singularName !== currency.singularName ||
    form.pluralName !== currency.pluralName ||
    form.description !== currency.description ||
    (form.icon ?? '') !== (currency.icon ?? '') ||
    form.enabled !== currency.enabled;
  const incomplete = form.singularName.trim() === '' || form.pluralName.trim() === '';
  const stale = isPortalApiError(save.error) && save.error.code === 'PROGRESSION_CURRENCY_STALE';
  const sample = (n: number) =>
    `${form.icon ? `${form.icon} ` : ''}${n} ${n === 1 ? form.singularName : form.pluralName}`;

  return (
    <Card className="space-y-3 p-4" data-testid="currency-card">
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-xs text-ink-muted">
          Key
          <span className="block h-9 pt-2 font-mono text-sm text-ink" data-testid="currency-key">
            {currency.key}
          </span>
        </div>
        <label className="text-xs text-ink-muted">
          Singular name
          <Input
            aria-label="Singular name"
            className="w-48"
            value={form.singularName}
            disabled={!canWrite}
            onChange={(e) => set({ singularName: e.target.value })}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Plural name
          <Input
            aria-label="Plural name"
            className="w-48"
            value={form.pluralName}
            disabled={!canWrite}
            onChange={(e) => set({ pluralName: e.target.value })}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Icon or emoji
          <Input
            aria-label="Icon or emoji"
            className="w-28"
            value={form.icon ?? ''}
            disabled={!canWrite}
            onChange={(e) => set({ icon: e.target.value === '' ? null : e.target.value })}
          />
        </label>
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            aria-label="Currency enabled"
            checked={form.enabled}
            disabled={!canWrite}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>
      <label className="block text-xs text-ink-muted">
        Description
        <Input
          aria-label="Currency description"
          value={form.description}
          disabled={!canWrite}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <p className="text-xs text-ink-subtle" data-testid="currency-sample">
        Shown to players as: {sample(1)} · {sample(12)}
      </p>
      {stale ? (
        <p className="text-xs text-danger" role="alert">
          Someone else changed this currency since you opened it. Their version has been loaded —
          make your change again.
        </p>
      ) : (
        save.isError && (
          <ErrorState variant="inline" title="Could not save the currency" error={save.error} />
        )
      )}
      {canWrite && (
        <Button
          type="button"
          variant="accent"
          size="sm"
          disabled={!dirty || incomplete || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save currency'}
        </Button>
      )}
    </Card>
  );
}
