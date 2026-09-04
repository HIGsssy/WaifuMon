/**
 * Global Encounter Settings — the four runtime values the engine reads on
 * every roll.
 *
 * Scope is deliberately narrow: these are World Encounter tuning knobs and
 * nothing else. Unrelated configuration stays where it lives.
 *
 * Two things this screen owes an operator:
 *
 *   - **The effective values**, not just the contents of the inputs. A form
 *     that shows what you typed cannot tell you what the server is actually
 *     using, which is the only question that matters when you are watching a
 *     live game. The "currently live" line reads from the last server
 *     response, so an unsaved edit never masquerades as the running config.
 *   - **An unmissable Force Trigger.** It makes every eligible hunt and travel
 *     produce an encounter, and left on by accident it looks like a bug in the
 *     drop rates. So it gets a warning banner rather than a quiet checkbox.
 *
 * Nothing here is trusted by the server: it re-validates the patch, clamps to
 * the same bounds, and takes the editing user's identity from the session, not
 * from this form.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getAdminEncounterSettings,
  updateAdminEncounterSettings,
  type AdminEncounterSettings,
  type AdminEncounterSettingsPatch,
} from '@/api/adminEncounters';
import { useHasPermission } from '@/auth/useSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';

const SETTINGS_KEY = ['admin', 'encounters', 'settings'] as const;

interface FormState {
  huntChance: string;
  travelChance: string;
  defaultExpirySeconds: string;
  forceTrigger: boolean;
}

function formFrom(s: AdminEncounterSettings): FormState {
  return {
    huntChance: String(s.huntChance),
    travelChance: String(s.travelChance),
    defaultExpirySeconds: String(s.defaultExpirySeconds),
    forceTrigger: s.forceTrigger,
  };
}

/** A percentage reads better than `0.35` when you are judging a drop rate. */
function asPercent(chance: number): string {
  return `${(chance * 100).toFixed(1)}%`;
}

export function GlobalEncounterSettingsPanel() {
  const canPublish = useHasPermission('encounters.publish');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => getAdminEncounterSettings(signal),
  });

  const [form, setForm] = useState<FormState | null>(null);
  // Re-sync whenever the server's answer changes — on first load, and after a
  // save, so the inputs always start from what is actually live.
  useEffect(() => {
    if (query.data) setForm(formFrom(query.data));
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (patch: AdminEncounterSettingsPatch) => updateAdminEncounterSettings(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
    },
  });

  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load encounter settings"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const live = query.data;
  if (!live || !form) return null;

  const bounds = live.bounds;
  const parsedHunt = Number(form.huntChance);
  const parsedTravel = Number(form.travelChance);
  const parsedExpiry = Number(form.defaultExpirySeconds);

  // Mirror the server's rules so a bad value is caught before a round trip.
  // The server still enforces them — this is courtesy, not the boundary.
  const errors: string[] = [];
  const checkChance = (label: string, value: number) => {
    if (!Number.isFinite(value)) errors.push(`${label} must be a number.`);
    else if (value < bounds.chance.min || value > bounds.chance.max) {
      errors.push(`${label} must be between ${bounds.chance.min} and ${bounds.chance.max}.`);
    }
  };
  checkChance('Hunt chance', parsedHunt);
  checkChance('Travel chance', parsedTravel);
  if (!Number.isInteger(parsedExpiry)) {
    errors.push('Expiry must be a whole number of seconds.');
  } else if (
    parsedExpiry < bounds.expirySeconds.min ||
    parsedExpiry > bounds.expirySeconds.max
  ) {
    errors.push(
      `Expiry must be between ${bounds.expirySeconds.min} and ${bounds.expirySeconds.max} seconds.`,
    );
  }

  const dirty =
    parsedHunt !== live.huntChance ||
    parsedTravel !== live.travelChance ||
    parsedExpiry !== live.defaultExpirySeconds ||
    form.forceTrigger !== live.forceTrigger;

  const save = () => {
    // Send only what changed, so two operators editing different fields do
    // not overwrite each other.
    const patch: AdminEncounterSettingsPatch = {};
    if (parsedHunt !== live.huntChance) patch.huntChance = parsedHunt;
    if (parsedTravel !== live.travelChance) patch.travelChance = parsedTravel;
    if (parsedExpiry !== live.defaultExpirySeconds) patch.defaultExpirySeconds = parsedExpiry;
    if (form.forceTrigger !== live.forceTrigger) patch.forceTrigger = form.forceTrigger;
    if (Object.keys(patch).length > 0) mutation.mutate(patch);
  };

  return (
    <Card className="space-y-4 p-4" data-testid="global-encounter-settings">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">
          Global Encounter Settings
        </h3>
        {live.forceTrigger && (
          <Badge variant="danger" data-testid="force-trigger-badge">
            FORCE TRIGGER ON
          </Badge>
        )}
      </div>

      {/*
        The live values, stated separately from the inputs. While an edit is
        unsaved these disagree, and that disagreement is the useful part.
      */}
      <dl
        className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken p-3 text-sm tabular"
        data-testid="effective-settings"
      >
        <dt className="text-ink-muted">Hunt chance (live)</dt>
        <dd className="text-right">
          {asPercent(live.huntChance)} <span className="text-ink-muted">({live.huntChance})</span>
        </dd>
        <dt className="text-ink-muted">Travel chance (live)</dt>
        <dd className="text-right">
          {asPercent(live.travelChance)}{' '}
          <span className="text-ink-muted">({live.travelChance})</span>
        </dd>
        <dt className="text-ink-muted">Expiry (live)</dt>
        <dd className="text-right">{live.defaultExpirySeconds}s</dd>
        <dt className="text-ink-muted">Force trigger (live)</dt>
        <dd className="text-right">{live.forceTrigger ? 'ON' : 'off'}</dd>
      </dl>

      {live.forceTrigger && (
        <p
          className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
          data-testid="force-trigger-warning"
          role="status"
        >
          <strong>Force Trigger is on.</strong> Every eligible hunt and travel produces a
          world encounter, ignoring the chances above. Cooldowns, region rules and the
          one-encounter-at-a-time limit still apply. Turn this off before normal play.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-ink-muted">
          Hunt chance ({bounds.chance.min}–{bounds.chance.max})
          <Input
            type="number"
            step="0.01"
            min={bounds.chance.min}
            max={bounds.chance.max}
            value={form.huntChance}
            disabled={!canPublish}
            onChange={(e) => setForm({ ...form, huntChance: e.target.value })}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Travel chance ({bounds.chance.min}–{bounds.chance.max})
          <Input
            type="number"
            step="0.01"
            min={bounds.chance.min}
            max={bounds.chance.max}
            value={form.travelChance}
            disabled={!canPublish}
            onChange={(e) => setForm({ ...form, travelChance: e.target.value })}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Expiry seconds ({bounds.expirySeconds.min}–{bounds.expirySeconds.max})
          <Input
            type="number"
            step="10"
            min={bounds.expirySeconds.min}
            max={bounds.expirySeconds.max}
            value={form.defaultExpirySeconds}
            disabled={!canPublish}
            onChange={(e) => setForm({ ...form, defaultExpirySeconds: e.target.value })}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.forceTrigger}
          disabled={!canPublish}
          data-testid="force-trigger-input"
          onChange={(e) => setForm({ ...form, forceTrigger: e.target.checked })}
        />
        <span>
          Force encounter trigger — <span className="text-ink-muted">testing only</span>
        </span>
      </label>

      {errors.length > 0 && (
        <ul className="text-xs text-danger" data-testid="settings-validation">
          {errors.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {mutation.isError && (
        <ErrorState title="Could not save settings" error={mutation.error} />
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!canPublish || !dirty || errors.length > 0 || mutation.isPending}
          onClick={save}
        >
          {mutation.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        {dirty && errors.length === 0 && (
          <span className="text-xs text-ink-muted">Unsaved changes.</span>
        )}
        {!canPublish && (
          <span className="text-xs text-ink-muted">
            Read-only — changing these needs the publish permission.
          </span>
        )}
        {live.updatedAt && (
          <span className="ml-auto text-xs text-ink-muted">
            Last saved {new Date(live.updatedAt).toLocaleString()}
            {live.updatedBy ? ` by ${live.updatedBy}` : ''}
          </span>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        Saved changes apply to the running game within a few seconds — no redeploy.
      </p>
    </Card>
  );
}
