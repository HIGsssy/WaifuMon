/**
 * `/admin/test-controls/:playerId` — Staging Test Controls for one account.
 *
 * Compact on purpose: three groups (Progression, Travel / Keys, Testing), each
 * control one row. Every action posts to the API, which re-validates the
 * value against live limits, writes an audit row, and answers with exactly
 * what changed plus the account's fresh state — so this page never computes a
 * balance or a level itself, it only shows what the server reports.
 *
 * Revoking the Beacon, the Staging Boost and the Belt reset ask first.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import {
  getTestControlsInfo,
  getTestControlsPlayer,
  testControlMutations,
  type TestControlResult,
  type TestControlsInfo,
  type TestControlsPlayerState,
} from '@/api/adminTestControls';
import { isPortalApiError } from '@/api/client';
import { queryKeys } from '@/api/queryKeys';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';

import { errorText } from './errorText';
import { ConfirmDialog, DisabledNotice, StagingBanner } from './shared';

type Confirmable = 'revokeBeacon' | 'stagingBoost' | 'resetBelt';

export function TestControlsPlayerPage() {
  const params = useParams();
  const playerId = Number(params.playerId);
  const validId = Number.isInteger(playerId) && playerId > 0;

  const info = useQuery({
    queryKey: queryKeys.adminTestControls(),
    queryFn: ({ signal }) => getTestControlsInfo(signal),
    retry: false,
  });
  const state = useQuery({
    queryKey: queryKeys.adminTestControlsPlayer(playerId),
    queryFn: ({ signal }) => getTestControlsPlayer(playerId, signal),
    enabled: validId && info.isSuccess,
    retry: false,
  });

  const disabled = isPortalApiError(info.error) && info.error.status === 404;
  const notFound = !validId || (isPortalApiError(state.error) && state.error.status === 404);

  return (
    <div className="space-y-6">
      <PageHeader
        title={state.data ? `Test Controls — ${state.data.displayName}` : 'Staging Test Controls'}
        {...(state.data ? { description: `Player #${state.data.playerId}` } : {})}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/admin/test-controls">
              <ArrowLeft aria-hidden="true" />
              Choose another player
            </Link>
          </Button>
        }
      />
      <StagingBanner deploymentEnv={info.data?.deploymentEnv} />

      {disabled && <DisabledNotice />}
      {info.isError && !disabled && (
        <Alert>{errorText(info.error, 'Test controls could not be loaded.')}</Alert>
      )}
      {info.isSuccess && notFound && <Alert>No player with that id in the selected server.</Alert>}
      {info.isSuccess && !notFound && state.isError && (
        <Alert>{errorText(state.error, 'This player could not be loaded.')}</Alert>
      )}
      {(info.isPending || (validId && info.isSuccess && state.isPending)) && (
        <Skeleton className="h-96 rounded-2xl" data-testid="test-controls-loading" />
      )}
      {info.data && state.data && (
        // Keyed by player so switching accounts resets every input.
        <Controls key={state.data.playerId} info={info.data} state={state.data} />
      )}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm"
    >
      {children}
    </div>
  );
}

function parseWhole(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function Controls({ info, state }: { info: TestControlsInfo; state: TestControlsPlayerState }) {
  const queryClient = useQueryClient();
  const id = state.playerId;
  const [level, setLevel] = useState(String(state.level));
  const [bux, setBux] = useState('5000');
  const [energy, setEnergy] = useState(String(state.maxEnergy));
  const [inputError, setInputError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmable | null>(null);
  const [last, setLast] = useState<TestControlResult | null>(null);

  const action = useMutation({
    mutationFn: (run: () => Promise<TestControlResult>) => run(),
    onSuccess: (result) => {
      setLast(result);
      setConfirm(null);
      queryClient.setQueryData(queryKeys.adminTestControlsPlayer(id), result.state);
    },
  });

  const submit = (run: () => Promise<TestControlResult>) => {
    setInputError(null);
    action.mutate(run);
  };

  /** Client-side check for a friendly message; the server decides for real. */
  const withNumber = (
    raw: string,
    label: string,
    min: number,
    max: number,
    go: (n: number) => void,
  ) => {
    const n = parseWhole(raw);
    if (n === null || n < min || n > max) {
      setInputError(
        `${label} must be a whole number from ${formatNumber(min)} to ${formatNumber(max)}.`,
      );
      return;
    }
    go(n);
  };

  const busy = action.isPending;
  const boost = info.stagingBoost;

  return (
    <div className="space-y-6">
      <Card className="border-warning/40">
        <dl
          className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6"
          data-testid="test-controls-summary"
        >
          <Stat label="Level" value={`${state.level} / ${state.maxLevel}`} />
          <Stat label="XP" value={formatNumber(state.xp)} />
          <Stat label="WaifuBux" value={formatNumber(state.waifubux)} />
          <Stat label="Energy" value={`${state.energy} / ${state.maxEnergy}`} />
          <Stat label="Region" value={state.currentRegionName} />
          <Stat
            label={state.beacon?.name ?? 'Transporter Beacon'}
            value={state.beacon?.owned ? 'Owned' : 'Not owned'}
          />
          <Stat
            label="Belt level requirement"
            value={state.beacon ? levelRequirement(state.beacon.requiredLevel) : '—'}
          />
        </dl>
      </Card>

      {inputError && <Alert>{inputError}</Alert>}
      {action.isError && <Alert>{errorText(action.error, 'That action failed.')}</Alert>}
      {last && <ResultPanel result={last} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Player progression</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <Row label="Level" htmlFor="tc-level">
              <Input
                id="tc-level"
                inputMode="numeric"
                className="w-24"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  withNumber(level, 'Level', 1, state.maxLevel, (n) =>
                    submit(() => testControlMutations.setLevel(id, n)),
                  )
                }
              >
                Set
              </Button>
            </Row>
            <Row label="WaifuBux" htmlFor="tc-bux">
              <Input
                id="tc-bux"
                inputMode="numeric"
                className="w-24"
                value={bux}
                onChange={(e) => setBux(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  withNumber(bux, 'Amount', 1, info.maxWaifubuxPerAction, (n) =>
                    submit(() => testControlMutations.addWaifubux(id, n)),
                  )
                }
              >
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  withNumber(bux, 'Amount', 1, info.maxWaifubuxPerAction, (n) =>
                    submit(() => testControlMutations.removeWaifubux(id, n)),
                  )
                }
              >
                Remove
              </Button>
            </Row>
            <Row label="Energy" htmlFor="tc-energy" hint={`0–${state.maxEnergy}`}>
              <Input
                id="tc-energy"
                inputMode="numeric"
                className="w-24"
                value={energy}
                onChange={(e) => setEnergy(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  withNumber(energy, 'Energy', 0, state.maxEnergy, (n) =>
                    submit(() => testControlMutations.setEnergy(id, n)),
                  )
                }
              >
                Set
              </Button>
            </Row>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Travel / Keys</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              disabled={busy || state.beacon === null}
              onClick={() => submit(() => testControlMutations.grantBeacon(id))}
            >
              Grant Transporter Beacon
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || state.beacon === null}
              onClick={() => setConfirm('revokeBeacon')}
            >
              Revoke Transporter Beacon
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => submit(() => testControlMutations.grantStandardTravel(id))}
            >
              Grant All Standard Travel Access
            </Button>
          </div>
          <ul className="mt-4 space-y-1 text-sm" aria-label="Travel access">
            {state.passes.map((p) => (
              <Owned key={p.id} owned={p.owned} label={p.name} />
            ))}
            {state.routes.map((r) => (
              <Owned
                key={r.regionId}
                owned={r.unlocked}
                label={`${r.name} (${levelRequirement(r.requiredLevel)})`}
              />
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Testing</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => setConfirm('stagingBoost')}
            >
              Prepare Player for Current Content
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || state.beacon === null}
              onClick={() => setConfirm('resetBelt')}
            >
              Reset Assteroid Belt Unlock Test State
            </Button>
          </div>
          <ul className="mt-4 space-y-1 text-sm" aria-label="Belt unlock state">
            {state.beltComponents.map((c) => (
              <Owned
                key={c.slug}
                owned={c.owned >= c.required}
                label={`${c.name} ${c.owned}/${c.required}`}
              />
            ))}
            {state.legacyBeltRoute && (
              <li className="text-ink-muted">Legacy Belt route row present</li>
            )}
            {state.beltEncounterCooldowns > 0 && (
              <li className="text-ink-muted">Belt component encounter on cooldown</li>
            )}
          </ul>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm === 'stagingBoost'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Prepare player for current content?"
        description={`Applies the Staging Boost to ${state.displayName}.`}
        details={[
          `Set Trainer Level to ${boost.level}`,
          `Add ${formatNumber(boost.waifubux)} WaifuBux`,
          'Refill Energy to the normal maximum',
          'Grant every standard pass and route unlock',
          'Does not grant the Transporter Beacon or its components',
        ]}
        confirmLabel="Apply Staging Boost"
        pending={busy}
        onConfirm={() => submit(() => testControlMutations.stagingBoost(id))}
      />
      <ConfirmDialog
        open={confirm === 'resetBelt'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Reset Assteroid Belt unlock state?"
        description={`Returns ${state.displayName} to the start of the Belt unlock flow.`}
        details={[
          'Return the player to Waifu Valley if they are in the Belt',
          'Remove the Transporter Beacon',
          `Remove Belt components: ${state.beltComponents.map((c) => c.name).join(', ') || 'none configured'}`,
          'Remove any legacy Belt route unlock',
          'Clear cooldowns on any encounter that awards a Belt component',
          'Nothing else — level, WaifuBux, other items and encounters are untouched',
        ]}
        confirmLabel="Reset Belt state"
        destructive
        pending={busy}
        onConfirm={() => submit(() => testControlMutations.resetAssteroidBelt(id))}
      />
      <ConfirmDialog
        open={confirm === 'revokeBeacon'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Revoke the Transporter Beacon?"
        description="The player loses Assteroid Belt access. If they are in the Belt they are returned to Waifu Valley."
        confirmLabel="Revoke Beacon"
        destructive
        pending={busy}
        onConfirm={() => submit(() => testControlMutations.revokeBeacon(id))}
      />
    </div>
  );
}

/** A null level requirement is none at all, never "level 1". */
function levelRequirement(level: number | null): string {
  return level == null ? 'No level requirement' : `Lv ${level}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-ink-subtle">{label}</dt>
      <dd className="truncate font-medium text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={htmlFor} className="w-20 shrink-0 text-sm text-ink-muted">
        {label}
        {hint && <span className="block text-xs text-ink-subtle">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Owned({ owned, label }: { owned: boolean; label: string }) {
  const Icon = owned ? CheckCircle2 : Circle;
  return (
    <li className="flex items-center gap-2">
      <Icon
        className={owned ? 'size-4 text-success' : 'size-4 text-ink-subtle'}
        aria-hidden="true"
      />
      <span className={owned ? 'text-ink' : 'text-ink-muted'}>{label}</span>
      <span className="sr-only">{owned ? '(yes)' : '(no)'}</span>
    </li>
  );
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ');
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null || value === undefined) return '—';
  return String(value);
}

/** Exactly what the server says changed — nothing inferred here. */
function ResultPanel({ result }: { result: TestControlResult }) {
  return (
    <div
      role="status"
      data-testid="test-controls-result"
      className="rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-sm"
    >
      <p className="font-medium text-ink">{result.message}</p>
      {result.changes.length > 0 && (
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-ink-subtle">
            <tr>
              <th className="py-0.5 pr-3 font-normal">Field</th>
              <th className="py-0.5 pr-3 font-normal">Before</th>
              <th className="py-0.5 font-normal">After</th>
            </tr>
          </thead>
          <tbody>
            {result.changes.map((c) => (
              <tr key={c.field}>
                <td className="py-0.5 pr-3 font-mono">{c.field}</td>
                <td className="py-0.5 pr-3 tabular-nums">{show(c.before)}</td>
                <td className="py-0.5 tabular-nums">{show(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
