import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DUNGEONS_QUERY_KEY,
  listDungeons,
  setDungeonEnabled,
  getDungeonSettings,
  updateDungeonSettings,
  listProgressionCurrencies,
  updateProgressionCurrency,
  type DungeonSettings,
  type DungeonSummary,
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
import { DungeonImportPanel } from './DungeonImportPanel';
const formatUpdated = (iso: string) => new Date(iso).toLocaleString();
export function DungeonsListPage() {
  const [importing, setImporting] = useState(false);
  const client = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'definitions'],
    queryFn: ({ signal }) => listDungeons(signal),
  });
  const toggle = useMutation({
    mutationFn: (d: DungeonSummary) => setDungeonEnabled(d.key, !d.enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY }),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeons"
        description="Manage drafts and published revisions. Saving a draft never publishes it."
        actions={
          canWrite && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={importing} onClick={() => setImporting(true)}>
                Import Dungeon
              </Button>
              <Button asChild>
                <Link to="/admin/dungeons/new">Create dungeon</Link>
              </Button>
            </div>
          )
        }
      />
      {importing && <DungeonImportPanel onCancel={() => setImporting(false)} />}
      {query.isPending && <Skeleton className="h-32" />}
      {query.isError && (
        <ErrorState
          title="Could not load dungeons"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {toggle.isError && (
        <ErrorState title="Could not change dungeon availability" error={toggle.error} />
      )}
      {query.data?.dungeons.length === 0 && <Card className="p-6">No dungeons yet.</Card>}
      {query.data?.dungeons.map((d) => (
        <Card key={d.key} className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex-1">
            <Link
              className="font-medium hover:underline"
              to={`/admin/dungeons/definitions/${encodeURIComponent(d.key)}`}
            >
              {d.name}
            </Link>
            <p className="text-sm text-ink-muted">
              {d.key} · Draft {d.draftRevision} ·{' '}
              {d.published ? `Published ${d.published.number}` : 'Unpublished'} · {d.roomCount}{' '}
              rooms
            </p>
            <p className="text-xs text-ink-subtle">Validation available on the management page</p>
          </div>
          <Badge>{d.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Badge variant="outline">
            {d.draftDiffers ? 'Unpublished changes' : 'Draft matches publication'}
          </Badge>
          {canWrite && (
            <Button disabled={toggle.isPending} onClick={() => toggle.mutate(d)}>
              {d.enabled ? 'Disable' : 'Enable'} {d.name}
            </Button>
          )}
        </Card>
      ))}
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
