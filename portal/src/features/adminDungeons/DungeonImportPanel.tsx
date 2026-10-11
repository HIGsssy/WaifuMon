import { useContext, useEffect, useRef, useState } from 'react';
import { Link, UNSAFE_DataRouterContext, useBlocker } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';
import {
  decisionsComplete,
  draftOperation,
  importBlockers,
  IMPORT_BODY_LIMIT,
  packageInformation,
  requestBytes,
} from './dungeonImportModel';

type Phase =
  | 'empty'
  | 'reading'
  | 'planning'
  | 'ready'
  | 'applying'
  | 'success'
  | 'stale'
  | 'rejected'
  | 'uncertain';
const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsText(file);
  });
export function DungeonImportPanel({ onCancel }: { onCancel: () => void }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const canWrite = useHasPermission('dungeons.write');
  const client = useQueryClient();
  const [phase, setPhase] = useState<Phase>('empty');
  const [selected, setSelected] = useState<{ name: string; pkg: unknown } | null>(null);
  const [plan, setPlan] = useState<api.DungeonImportPlan | null>(null);
  const [enemies, setEnemies] = useState<api.DungeonImportDecisions['enemies']>({});
  const [allowMissing, setAllowMissing] = useState(false);
  const [approveDraft, setApproveDraft] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<api.DungeonImportResult | null>(null);
  const operation = useRef<api.DungeonImportApplyInput | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const locked = phase === 'applying' || phase === 'uncertain';
  const loading = phase === 'reading' || phase === 'planning' || phase === 'applying';
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!locked) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const holdNavigation = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.('a[href]')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    if (!dataRouter) document.addEventListener('click', holdNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', holdNavigation, true);
    };
  }, [locked, dataRouter]);
  const review = async (pkg: unknown, token: number) => {
    setPhase('planning');
    setError(null);
    setPlan(null);
    setEnemies({});
    setAllowMissing(false);
    setApproveDraft(false);
    setAcknowledge(false);
    operation.current = null;
    try {
      if (requestBytes({ package: pkg }) > IMPORT_BODY_LIMIT)
        throw new Error('The wrapped planning request exceeds 2 MiB. Select a smaller package.');
      const next = await api.planDungeonImport(pkg);
      if (token === generation.current) {
        setPlan(next);
        setPhase('ready');
      }
    } catch (e) {
      if (token === generation.current) {
        setError(e);
        setPhase('rejected');
      }
    } finally {
      busy.current = false;
    }
  };
  const select = async (file: File) => {
    if (busy.current || locked || !canWrite) return;
    busy.current = true;
    const token = ++generation.current;
    setSelected(null);
    setPlan(null);
    setError(null);
    setResult(null);
    operation.current = null;
    setPhase('reading');
    try {
      if (!file.name.toLowerCase().endsWith('.json'))
        throw new Error('Select a .json Dungeon Content Package.');
      if (file.size > IMPORT_BODY_LIMIT) throw new Error('The selected file exceeds 2 MiB.');
      const pkg: unknown = JSON.parse(await readFile(file));
      if (token !== generation.current) return;
      setSelected({ name: file.name, pkg });
      await review(pkg, token);
    } catch (e) {
      if (token === generation.current) {
        setError(
          e instanceof SyntaxError
            ? new Error('Invalid JSON. Select a valid Dungeon Content Package.')
            : e,
        );
        setPhase('rejected');
      }
      busy.current = false;
    }
  };
  const decisions: api.DungeonImportDecisions = {
    dungeon: plan ? draftOperation(plan) : 'create',
    enemies,
    allowMissingDependencies: allowMissing,
  };
  const blockers = plan ? importBlockers(plan, decisions) : [];
  const warnings = plan?.issues.filter((i) => i.severity === 'warning') ?? [];
  const eligible =
    !!plan?.validPackage &&
    !!plan.planHash &&
    !!plan.target &&
    approveDraft &&
    decisionsComplete(plan, decisions) &&
    blockers.length === 0 &&
    (!warnings.length || acknowledge);
  const apply = async () => {
    const retryingUncertain = phase === 'uncertain';
    if (busy.current || !canWrite || (!operation.current && (!eligible || phase !== 'ready')))
      return;
    const input = operation.current ?? {
      package: selected!.pkg,
      requestId: crypto.randomUUID(),
      expectedPlanHash: plan!.planHash!,
      expectedRevision: plan!.target!.expectedRevision,
      decisions: structuredClone(decisions),
    };
    if (requestBytes(input) > IMPORT_BODY_LIMIT) {
      setError(
        new Error(
          'The wrapped apply request exceeds 2 MiB, including decisions. Select a smaller package.',
        ),
      );
      return;
    }
    operation.current = input;
    busy.current = true;
    setPhase('applying');
    setError(null);
    try {
      const receipt = await api.applyDungeonImport(input);
      if (
        !receipt ||
        !Number.isInteger(receipt.importId) ||
        receipt.importId <= 0 ||
        !receipt.dungeonKey ||
        !['created', 'replaced', 'unchanged'].includes(receipt.result) ||
        !Number.isInteger(receipt.draftRevision) ||
        receipt.draftRevision <= 0 ||
        !Array.isArray(receipt.createdEnemies) ||
        !receipt.createdEnemies.every((key) => typeof key === 'string') ||
        !Array.isArray(receipt.issues) ||
        !receipt.issues.every(
          (i) =>
            i &&
            typeof i.message === 'string' &&
            typeof i.path === 'string' &&
            ['error', 'warning'].includes(i.severity),
        ) ||
        typeof receipt.publishable !== 'boolean' ||
        typeof receipt.replayed !== 'boolean'
      )
        throw new Error('The response did not confirm the import result.');
      setResult(receipt);
      setPhase('success');
      operation.current = null;
      void client.invalidateQueries({ queryKey: api.DUNGEONS_QUERY_KEY });
    } catch (e) {
      setError(e);
      if (
        isPortalApiError(e) &&
        e.status >= 400 &&
        e.status < 500 &&
        ![408, 429].includes(e.status) &&
        (!retryingUncertain || e.code === 'DUNGEON_IMPORT_STALE')
      ) {
        operation.current = null;
        setPhase(e.status === 409 ? 'stale' : 'rejected');
      } else setPhase('uncertain');
    } finally {
      busy.current = false;
    }
  };
  const info = packageInformation(selected?.pkg);
  const rejectionIssues =
    isPortalApiError(error) && Array.isArray(error.details?.issues)
      ? error.details.issues.filter(
          (i): i is { message: string; path: string } =>
            i != null &&
            typeof i === 'object' &&
            typeof i.message === 'string' &&
            typeof i.path === 'string',
        )
      : [];
  if (!canWrite) return <Card className="p-4">Import requires dungeons.write permission.</Card>;
  return (
    <Card className="space-y-4 p-4">
      {dataRouter && <ImportNavigationGuard locked={locked} />}
      <h2 className="text-lg font-semibold">Import Dungeon</h2>
      <p>
        Upload a JSON package, review its target dependencies, then apply it as a draft. Publication
        requires a separate action.
      </p>
      <label className="block">
        Dungeon package file
        <input
          aria-label="Dungeon package file"
          type="file"
          accept=".json,application/json"
          disabled={loading || locked}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void select(file);
          }}
        />
      </label>
      {!selected && phase === 'empty' && (
        <p>
          No file selected. Choose a .json Dungeon Content Package (up to 2 MiB including request
          fields).
        </p>
      )}
      {selected && (
        <div className="space-y-1 break-all">
          <p>Selected file: {selected.name}</p>
          <p>
            Dungeon: {info.name} · {plan?.dungeonKey ?? info.key}
          </p>
          <p>
            Package format: {info.format} · Schema version: {info.version}
          </p>
          {plan && (
            <>
              <p>Source environment: {plan.sourceEnvironment ?? 'Unknown'}</p>
              <p>Package identity: {plan.packageId ?? 'Unavailable'}</p>
              <p>Content hash: {plan.contentHash ?? 'Unavailable'}</p>
              <p>Package hash: {plan.packageHash ?? 'Unavailable'}</p>
            </>
          )}
        </div>
      )}
      {phase === 'reading' && <p role="status">Reading package…</p>}
      {phase === 'planning' && <p role="status">Planning import… No changes are being made.</p>}
      {plan && (
        <>
          <p role="status">
            {!plan.validPackage
              ? 'Invalid package — import blocked.'
              : blockers.length
                ? 'Blocking errors remain.'
                : 'Plan ready for review.'}
          </p>
          {plan.target && (
            <fieldset disabled={locked || phase !== 'ready'} className="space-y-3">
              <p>
                Target dungeon: {plan.target.status === 'new' ? 'Does not exist' : 'Already exists'}{' '}
                · Proposed operation: {draftOperation(plan)}
              </p>
              <p>Existing target draft revision: {plan.target.expectedRevision ?? 'None'}</p>
              {plan.target.changedFields.length > 0 && (
                <p>Changed draft fields: {plan.target.changedFields.join(', ')}</p>
              )}
              {draftOperation(plan) === 'replace' && (
                <p className="text-danger">
                  Replacement overwrites existing draft changes. Published revisions and active runs
                  remain untouched.
                </p>
              )}
              <label className="block">
                <input
                  type="checkbox"
                  checked={approveDraft}
                  onChange={(e) => setApproveDraft(e.target.checked)}
                />{' '}
                Approve {draftOperation(plan)} dungeon draft
              </label>
              {plan.enemies.map((enemy) => (
                <div key={enemy.key} className="space-y-1">
                  <p>
                    Enemy {enemy.key}: {enemy.status.replaceAll('_', ' ')}
                    {enemy.currentRevision !== null
                      ? ` · Target revision ${enemy.currentRevision}`
                      : ''}
                  </p>
                  {enemy.changedFields.length > 0 && (
                    <p>Changed fields: {enemy.changedFields.join(', ')}</p>
                  )}
                  {enemy.status !== 'identical' && (
                    <label>
                      Decision for enemy {enemy.key}{' '}
                      <select
                        aria-label={`Decision for enemy ${enemy.key}`}
                        value={enemies[enemy.key] ?? ''}
                        onChange={(e) => {
                          const next = { ...enemies };
                          if (e.target.value)
                            Object.defineProperty(next, enemy.key, {
                              value: e.target.value,
                              enumerable: true,
                              writable: true,
                              configurable: true,
                            });
                          else delete next[enemy.key];
                          setEnemies(next);
                        }}
                      >
                        <option value="">Choose a decision</option>
                        {enemy.status === 'different' || enemy.status === 'existing_unverified' ? (
                          <option value="use_existing">Use existing target definition</option>
                        ) : (
                          <>
                            {enemy.status === 'missing_bundled' && (
                              <option value="create">Create bundled enemy</option>
                            )}
                            <option value="leave_missing">Leave missing in incomplete draft</option>
                          </>
                        )}
                      </select>
                    </label>
                  )}
                </div>
              ))}
              {(plan.enemies.some(
                (e) => e.status === 'missing' || e.status === 'missing_bundled',
              ) ||
                plan.issues.some((i) =>
                  ['reward_table_missing', 'region_missing', 'currency_missing'].includes(i.code),
                )) && (
                <label className="block">
                  <input
                    type="checkbox"
                    checked={allowMissing}
                    onChange={(e) => setAllowMissing(e.target.checked)}
                  />{' '}
                  Accept permitted missing dependencies as an incomplete draft. Install them before
                  publication.
                </label>
              )}
              {warnings.length > 0 && (
                <label className="block">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                  />{' '}
                  Acknowledge all reported warnings, including separately deployed artwork and
                  dependencies
                </label>
              )}
            </fieldset>
          )}
          <ul className="space-y-2">
            {plan.issues.map((issue, i) => (
              <li key={i} className={issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}>
                {issue.severity === 'warning'
                  ? 'Warning'
                  : blockers.includes(issue)
                    ? 'Blocking error'
                    : 'Dependency addressed by decisions'}
                : {issue.message} <span className="text-xs">({issue.path})</span>
              </li>
            ))}
          </ul>
          {!plan.issues.length && <p>Valid: no validation issues reported.</p>}
          {!plan.publishable && (
            <p>
              Publication is not currently ready; the plan checks dependencies before approved enemy
              creation.
            </p>
          )}
        </>
      )}
      {error != null && (
        <ErrorState
          title={
            phase === 'uncertain'
              ? 'Import outcome uncertain'
              : phase === 'stale'
                ? 'Import conflict — review again'
                : 'Import rejected'
          }
          error={error}
        />
      )}
      {rejectionIssues.length > 0 && (
        <ul className="text-danger">
          {rejectionIssues.map((i, n) => (
            <li key={n}>
              {i.message} ({i.path})
            </li>
          ))}
        </ul>
      )}
      {phase === 'stale' && (
        <p>
          The target or reviewed dependencies may have changed. Your package is preserved.
          Explicitly request a new plan and review new decisions before applying.
        </p>
      )}
      {phase === 'uncertain' && (
        <p>
          The server may have committed this import. Retry the same operation to confirm its
          receipt. Request ID: {operation.current?.requestId}. Keep this page open; the retry
          payload is retained in this session.
        </p>
      )}
      {phase === 'applying' && <p role="status">Applying import as a draft…</p>}
      {locked && <p>Navigation is held until the import result is confirmed.</p>}
      {result && (
        <div role="status" className="space-y-2">
          <p>
            {result.result === 'unchanged'
              ? 'Import unchanged.'
              : `Import successful: draft ${result.result}.`}{' '}
            Draft revision {result.draftRevision}. No publication performed.
            {result.replayed ? ' Original receipt confirmed by retry.' : ''}
          </p>
          {result.createdEnemies.length > 0 && (
            <p>Created enemies: {result.createdEnemies.join(', ')}</p>
          )}
          {result.issues.map((i, n) => (
            <p key={n}>
              {i.severity}: {i.message}
            </p>
          ))}
          <Link
            className="text-accent underline"
            to={`/admin/dungeons/definitions/${encodeURIComponent(result.dungeonKey)}`}
          >
            Open imported dungeon draft
          </Link>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {phase === 'ready' && (
          <Button disabled={!eligible} onClick={() => void apply()}>
            Apply import as draft
          </Button>
        )}
        {phase === 'uncertain' && <Button onClick={() => void apply()}>Retry same import</Button>}
        {selected && (phase === 'stale' || phase === 'rejected') && (
          <Button
            onClick={() => {
              if (!busy.current) {
                busy.current = true;
                void review(selected.pkg, ++generation.current);
              }
            }}
          >
            Review a new plan
          </Button>
        )}
        <Button variant="outline" disabled={loading || locked} onClick={onCancel}>
          {phase === 'success' ? 'Close import' : 'Cancel import'}
        </Button>
      </div>
    </Card>
  );
}

function ImportNavigationGuard({ locked }: { locked: boolean }) {
  const blocker = useBlocker(locked);
  useEffect(() => {
    if (blocker.state === 'blocked') blocker.reset();
  }, [blocker]);
  return null;
}
