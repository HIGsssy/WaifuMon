/**
 * Admin — import a Complete Dungeon Bundle (ZIP): one dungeon from another
 * environment with its artwork, enemies, Scene Sprites and shared WaifuMon
 * pools. The sibling of `DungeonImportPanel` (Dungeon JSON) on the Dungeons
 * list; both write only the dungeon's draft.
 *
 * Choose the file → the server checks every byte and reviews it against this
 * server → decide each conflict → (optionally) review those choices → confirm
 * → import. Nothing is written before the last step, and the import applies
 * exactly what was reviewed: if anything it relied on changed, nothing is
 * imported and the panel asks for a fresh review. Retrying the same import
 * never applies it twice.
 *
 * Editors see names and plain outcomes; ids and hashes are under "Technical
 * details". Afterwards the panel links to the imported draft, where the
 * existing Validate and Publish tools take over.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  applyDungeonBundle,
  DUNGEON_BUNDLE_MAX_BYTES,
  previewDungeonBundle,
  type BundleDecisions,
  type BundleReadiness,
  type DungeonBundlePreview,
} from '@/api/adminDungeonBundles';
import { DUNGEONS_QUERY_KEY, type DungeonLootImportDecisions } from '@/api/adminDungeons';
import { DUNGEON_LOOT_TABLES_QUERY_KEY } from '@/api/adminDungeonLootTables';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { DungeonLootImportReview } from './DungeonLootImportReview';

const READINESS: Record<BundleReadiness, { label: string; text: string }> = {
  ready: { label: 'Complete', text: 'Everything this dungeon needs is in the bundle or already here. After import, validate and publish it with the usual tools.' },
  needs_enabling: {
    label: 'Complete — enable dependencies before publishing',
    text: 'Everything is in the bundle or already here, but some imported dependencies arrive disabled. Enable them, then validate and publish.',
  },
  incomplete: {
    label: 'Incomplete — repair draft only',
    text: 'Content this dungeon needs is missing here. It can only be imported as an incomplete draft for repair; it cannot be published until that content is deployed.',
  },
  blocked: { label: 'Cannot be imported', text: 'This bundle cannot be imported here as it stands. See the problems below.' },
};
const DUNGEON_DECISION: Record<DungeonBundlePreview['dungeon']['decision'], string> = {
  create: 'New dungeon here — created disabled and unpublished.',
  replace: 'Replaces this dungeon’s draft. The published revision is not changed.',
  unchanged: 'The draft here already matches. Only missing dependencies are installed.',
};
const ENEMY_OUTCOME: Record<DungeonBundlePreview['enemies'][number]['outcome'], string> = {
  create: 'New — arrives disabled',
  update: 'Changed',
  conflict: 'Changed — in use here',
  unchanged: 'Unchanged',
  invalid: 'Cannot import',
};
const OUTCOME: Record<'create' | 'identical' | 'conflict', string> = {
  create: 'New here',
  identical: 'Already here, identical',
  conflict: 'Differs here',
};
const PREREQUISITE_KIND: Record<DungeonBundlePreview['prerequisites'][number]['kind'], string> = {
  species: 'WaifuMon',
  item: 'Item',
  equipment: 'Equipment',
  currency: 'Currency',
  region: 'Region',
  reward_table: 'Legacy reward table',
};
const imageDestination = (d: 'shipped_file' | 'reuse' | 'create') =>
  d === 'shipped_file' ? 'already on this server' : d === 'reuse' ? 'uses an image this server already has' : 'new image added';

type Choices = Required<Pick<BundleDecisions, 'enemies' | 'sceneSprites' | 'sharedPools'>> & { lootTables: DungeonLootImportDecisions };
const NO_CHOICES: Choices = { enemies: {}, sceneSprites: {}, sharedPools: {}, lootTables: {} };

export function DungeonBundleImportPanel({ onCancel }: { onCancel: () => void }) {
  const queryClient = useQueryClient();
  const canPreview = useHasPermission('dungeons.write');
  const canWriteEnemies = useHasPermission('enemies.write');
  const canWriteArtwork = useHasPermission('artwork.write');
  const canApply = canPreview && canWriteEnemies && canWriteArtwork;
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices>(NO_CHOICES);
  /** The choices the shown review was computed with. */
  const [reviewedChoices, setReviewedChoices] = useState<Choices>(NO_CHOICES);
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  /** One per review: a retry of the same import replays rather than applying twice. */
  const [requestId, setRequestId] = useState('');

  const decisionsOf = (c: Choices, plan?: DungeonBundlePreview): BundleDecisions => ({
    ...(plan ? { dungeon: plan.dungeon.decision } : {}),
    enemies: c.enemies,
    sceneSprites: c.sceneSprites,
    sharedPools: c.sharedPools,
    ...(Object.keys(c.lootTables).length ? { lootTables: c.lootTables } : {}),
    allowIncomplete,
  });
  const preview = useMutation({
    mutationFn: ({ f, c }: { f: File; c: Choices }) => previewDungeonBundle(f, decisionsOf(c)),
    onSuccess: (_plan, { c }) => {
      setReviewedChoices(c);
      setConfirmed(false);
      setRequestId(crypto.randomUUID());
    },
  });
  const plan = preview.data;
  const apply = useMutation({
    mutationFn: () => applyDungeonBundle(file!, { expectedPlanHash: plan!.planHash, requestId, decisions: decisionsOf(choices, plan) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: DUNGEON_LOOT_TABLES_QUERY_KEY });
    },
  });

  const choose = (next: File | undefined) => {
    preview.reset();
    apply.reset();
    setFileError(null);
    setChoices(NO_CHOICES);
    setAllowIncomplete(false);
    setFile(next ?? null);
    if (!next) return;
    if (next.size > DUNGEON_BUNDLE_MAX_BYTES) {
      setFileError('That file is larger than a dungeon bundle can be (64 MB).');
      return;
    }
    preview.mutate({ f: next, c: NO_CHOICES });
  };
  const decide = <K extends 'enemies' | 'sceneSprites' | 'sharedPools'>(kind: K, key: string, value: Choices[K][string] | '') => {
    setChoices((current) => {
      const next = { ...current[kind] } as Record<string, string>;
      if (value) next[key] = value;
      else delete next[key];
      return { ...current, [kind]: next };
    });
    setConfirmed(false);
  };

  const issuesOf = (error: unknown) =>
    isPortalApiError(error) && Array.isArray((error.details as { issues?: unknown } | undefined)?.issues)
      ? (error.details as { issues: { path: string; message: string }[] }).issues
      : [];
  const bundleIssues = isPortalApiError(preview.error) && preview.error.code === 'DUNGEON_BUNDLE_INVALID' ? issuesOf(preview.error) : [];
  const stale = isPortalApiError(apply.error) && apply.error.code === 'DUNGEON_BUNDLE_STALE';
  const rejected = isPortalApiError(apply.error) && apply.error.code === 'DUNGEON_BUNDLE_REJECTED' ? issuesOf(apply.error) : [];
  const choicesChanged = JSON.stringify(choices) !== JSON.stringify(reviewedChoices);
  const pending = plan
    ? [
        ...plan.enemies.filter((e) => (e.outcome === 'update' || e.outcome === 'conflict') && !choices.enemies[e.key]).map((e) => e.name),
        ...plan.sceneSprites.filter((s) => s.outcome === 'conflict' && !choices.sceneSprites[s.key]).map((s) => s.name),
        ...plan.sharedPools.filter((p) => p.outcome === 'conflict' && !choices.sharedPools[p.key]).map((p) => p.name),
        ...(plan.dungeon.plan.lootTables ?? []).filter((t) => t.status === 'different' && !choices.lootTables[t.key]).map((t) => t.name),
      ]
    : [];
  const errors = plan ? plan.issues.filter((i) => i.severity === 'error' && i.code !== 'loot_table_decision_required') : [];
  const warnings = plan ? plan.issues.filter((i) => i.severity === 'warning') : [];
  const blocked = !plan || plan.readiness === 'blocked' || (plan.readiness === 'incomplete' && !allowIncomplete);
  const canImport = !!plan && canApply && !pending.length && !choicesChanged && !blocked && confirmed && !apply.isPending;

  if (!canPreview) return <Card className="p-4">Importing a dungeon bundle requires dungeons.write permission.</Card>;
  const result = apply.data;
  return (
    <Card className="space-y-4 p-4" data-testid="dungeon-bundle-import">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Import Complete Dungeon Bundle (ZIP)</h2>
        <p className="text-sm">
          A Complete Dungeon Bundle includes the dungeon with its artwork, enemies, Scene Sprites and shared
          WaifuMon pools. WaifuMon species, items, equipment, currencies and regions are never imported: they must
          already be deployed here, and the review checks them. Only the dungeon’s draft is written; publishing is a
          separate step. For a definition-only file, use Import Dungeon (JSON).
        </p>
        {!canApply && (
          <p className="text-sm text-warning" role="note">
            You can review bundles. Importing one also needs enemies.write and artwork.write, because it may add
            enemies and artwork.
          </p>
        )}
      </div>

      <label className="block text-sm">
        Dungeon bundle file
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Dungeon bundle file"
          className="mt-1 block text-sm"
          disabled={apply.isPending}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      {preview.isPending && <p className="text-sm text-ink-muted">Checking the bundle and reviewing it against this server…</p>}
      {fileError && (
        <p className="text-sm text-danger" role="alert">
          {fileError}
        </p>
      )}
      {bundleIssues.length > 0 && (
        <div className="space-y-1" data-testid="bundle-invalid">
          <p className="text-sm font-medium text-danger">This bundle cannot be used:</p>
          <ul className="list-disc pl-5 text-sm text-danger">
            {bundleIssues.map((i, n) => (
              <li key={n}>
                {i.path && <span className="font-mono">{i.path}</span>} {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.isError && bundleIssues.length === 0 && <ErrorState variant="inline" title="Could not review the bundle" error={preview.error} />}

      {plan && !result && (
        <div className="space-y-4" data-testid="bundle-review">
          <section className="space-y-1" aria-label="Dungeon">
            <h3 className="font-semibold">
              {plan.dungeon.name} <span className="font-mono text-sm text-ink-muted">({plan.dungeon.key})</span>
            </h3>
            <p>{DUNGEON_DECISION[plan.dungeon.decision]}</p>
            {plan.dungeon.plan.target && plan.dungeon.plan.target.status !== 'new' && (
              <p className="text-sm">
                Current state here: {plan.dungeon.plan.target.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                {plan.dungeon.plan.target.publishedRevision ? `Published revision ${plan.dungeon.plan.target.publishedRevision}` : 'Unpublished'}.{' '}
                {plan.dungeon.plan.target.publishedRevision
                  ? `Revision ${plan.dungeon.plan.target.publishedRevision} stays live for players, active runs and acquisition terms until you publish the imported draft.`
                  : 'It stays unpublished until you publish it.'}
              </p>
            )}
            {plan.dungeon.plan.target?.changedFields.length ? (
              <p className="text-sm text-ink-muted">Draft changes: {plan.dungeon.plan.target.changedFields.join(', ')}</p>
            ) : null}
            <p className="text-xs text-ink-muted">
              From <span className="font-mono">{plan.bundle.sourceEnvironment}</span>,{' '}
              {plan.bundle.origin === 'draft' ? 'its draft' : `published revision ${plan.bundle.publishedRevision}`}, exported{' '}
              {new Date(plan.bundle.exportedAt).toLocaleString()}.
            </p>
          </section>

          <div className={plan.readiness === 'blocked' ? 'rounded-md border border-danger p-3' : 'rounded-md border border-border p-3'} role="status" data-testid="bundle-readiness">
            <Badge variant={plan.readiness === 'ready' ? 'outline' : plan.readiness === 'needs_enabling' ? 'default' : 'danger'}>{READINESS[plan.readiness].label}</Badge>
            <p className="mt-1 text-sm">{READINESS[plan.readiness].text}</p>
          </div>

          {errors.length > 0 && (
            <section aria-label="Problems" className="space-y-1">
              <h3 className="font-semibold text-danger">Problems</h3>
              <ul className="list-disc pl-5 text-sm text-danger">
                {errors.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </section>
          )}

          {plan.enemies.length > 0 && (
            <section aria-label="Enemies" className="space-y-2">
              <h3 className="font-semibold">Enemies</h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {plan.enemies.map((enemy) => (
                  <li key={enemy.key} className="space-y-1 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{enemy.name}</span>
                      <Badge variant={enemy.outcome === 'conflict' || enemy.outcome === 'invalid' ? 'danger' : 'outline'}>{ENEMY_OUTCOME[enemy.outcome]}</Badge>
                    </div>
                    {enemy.changedFields.length > 0 && <p className="text-sm text-ink-muted">Changes: {enemy.changedFields.join(', ')}</p>}
                    {enemy.references.length > 0 && (
                      <p className="text-sm">Used here by {enemy.references.map((r) => r.name ?? r.key).join(', ')}.</p>
                    )}
                    <p className="text-xs text-ink-muted">
                      Full art: {enemy.artwork.source === 'none' ? 'none' : enemy.artwork.destination.kind === 'shipped_file' ? 'already on this server' : enemy.artwork.destination.kind === 'reuse' ? 'uses an image this server already has' : 'new image added'} ·
                      Sprite: {enemy.sprite.source === 'none' ? 'none' : enemy.sprite.destination.kind === 'shipped_file' ? 'already on this server' : enemy.sprite.destination.kind === 'reuse' ? 'uses an image this server already has' : 'new image added'}
                    </p>
                    {(enemy.outcome === 'update' || enemy.outcome === 'conflict') && (
                      <label className="block text-sm">
                        Decision for enemy {enemy.name}
                        <select
                          aria-label={`Decision for enemy ${enemy.key}`}
                          className="ml-2"
                          value={choices.enemies[enemy.key] ?? ''}
                          onChange={(e) => decide('enemies', enemy.key, e.target.value as 'update' | 'keep' | '')}
                        >
                          <option value="">Choose a decision</option>
                          <option value="keep">Keep this server’s enemy</option>
                          <option value="update">Update it to the bundled version (keeps its enabled state)</option>
                        </select>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.sceneSprites.length > 0 && (
            <section aria-label="Scene Sprites" className="space-y-2">
              <h3 className="font-semibold">Scene Sprites</h3>
              <p className="text-sm text-ink-muted">
                {plan.bundle.sceneSpriteEvidence === 'revision_snapshot'
                  ? 'Exported from a published revision: these are the visuals frozen in that revision.'
                  : 'Exported from a draft: these are the catalogue sprites as they were at export.'}{' '}
                Published revisions here always keep their own frozen sprite visuals.
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {plan.sceneSprites.map((sprite) => (
                  <li key={sprite.key} className="space-y-1 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{sprite.name}</span>
                      <Badge variant={sprite.outcome === 'conflict' ? 'danger' : 'outline'}>{OUTCOME[sprite.outcome]}</Badge>
                    </div>
                    {sprite.changedFields.length > 0 && <p className="text-sm text-ink-muted">Differs in: {sprite.changedFields.join(', ')}</p>}
                    {sprite.references.length > 0 && (
                      <p className="text-sm">
                        Used here by {[...new Set(sprite.references.map((r) => `${r.name} (${r.source})`))].join(', ')}.
                      </p>
                    )}
                    {sprite.outcome === 'conflict' && (
                      <label className="block text-sm">
                        Decision for Scene Sprite {sprite.name}
                        <select
                          aria-label={`Decision for Scene Sprite ${sprite.key}`}
                          className="ml-2"
                          value={choices.sceneSprites[sprite.key] ?? ''}
                          onChange={(e) => decide('sceneSprites', sprite.key, e.target.value as 'update' | 'keep' | 'copy' | '')}
                        >
                          <option value="">Choose a decision</option>
                          <option value="keep">Keep this server’s sprite</option>
                          <option value="copy">Import a copy for this dungeon only</option>
                          <option value="update">Update the shared sprite</option>
                        </select>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.sharedPools.length > 0 && (
            <section aria-label="Shared WaifuMon pools" className="space-y-2">
              <h3 className="font-semibold">Shared WaifuMon pools</h3>
              <p className="text-sm text-ink-muted">
                Pool membership grants no acquisition rights: this dungeon’s own Species access and central policy still
                decide. New pools arrive disabled; the dungeon cannot be published until each pool it uses is enabled.
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {plan.sharedPools.map((pool) => (
                  <li key={pool.key} className="space-y-1 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{pool.name}</span>
                      <Badge variant={pool.outcome === 'conflict' ? 'danger' : 'outline'}>{OUTCOME[pool.outcome]}</Badge>
                      <span className="text-sm">{pool.enabledAfterImport ? 'Enabled here' : 'Disabled after import'}</span>
                    </div>
                    {pool.changedFields.length > 0 && <p className="text-sm text-ink-muted">Differs in: {pool.changedFields.join(', ')}</p>}
                    {pool.otherDungeons.length > 0 && (
                      <p className="text-sm">Also used here by {[...new Set(pool.otherDungeons.map((d) => d.name))].join(', ')}.</p>
                    )}
                    {pool.outcome === 'conflict' && (
                      <>
                        <p className="text-sm">
                          {pool.decision === 'update' ? 'The bundled version will be used.' : 'This server’s version will be used unless you update it.'}
                        </p>
                        <label className="block text-sm">
                          Decision for shared pool {pool.name}
                          <select
                            aria-label={`Decision for shared pool ${pool.key}`}
                            className="ml-2"
                            value={choices.sharedPools[pool.key] ?? ''}
                            onChange={(e) => decide('sharedPools', pool.key, e.target.value as 'update' | 'keep' | '')}
                          >
                            <option value="">Choose a decision</option>
                            <option value="keep">Keep this server’s pool</option>
                            <option value="update">Update it — other dungeons’ future runs change too</option>
                          </select>
                        </label>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <DungeonLootImportReview
            plan={plan.dungeon.plan}
            choices={choices.lootTables}
            onChange={(key, choice) => {
              setChoices((current) => {
                const lootTables = { ...current.lootTables };
                if (choice) lootTables[key] = choice;
                else delete lootTables[key];
                return { ...current, lootTables };
              });
              setConfirmed(false);
            }}
          />

          <section aria-label="Artwork" className="space-y-1">
            <h3 className="font-semibold">Artwork</h3>
            <p className="text-sm">
              {plan.artwork.assets.filter((a) => a.action === 'create').length} images to add ·{' '}
              {plan.artwork.assets.filter((a) => a.action === 'reuse').length} already here. Existing artwork is never replaced.
            </p>
            <ul className="text-sm">
              {plan.artwork.dungeon.map((a) => (
                <li key={`${a.asset}:${a.usage.join()}`}>
                  {a.usage.join(', ')}: {imageDestination(a.destination)}
                  {a.rebound && ' (this server lacks the shipped file; the bundled copy is used as managed artwork)'}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Required content on this server" className="space-y-1">
            <h3 className="font-semibold">Required content on this server</h3>
            <p className="text-sm text-ink-muted">Deployed through the content release, never by this import.</p>
            {plan.prerequisites.length === 0 ? (
              <p className="text-sm">No external content required.</p>
            ) : (
              <ul className="text-sm">
                {plan.prerequisites.map((p) => (
                  <li key={`${p.kind}:${p.key}`} className={p.status === 'available' ? '' : 'text-danger'}>
                    {PREREQUISITE_KIND[p.kind]} {p.name}: {p.status === 'available' ? 'available here' : p.status === 'missing' ? 'missing here' : 'disabled here'}
                    {p.notes.length > 0 && <span className="block text-xs text-ink-muted">{p.notes.join(' ')}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="After import" className="space-y-1">
            <h3 className="font-semibold">After import</h3>
            <ul className="list-disc pl-5 text-sm">
              <li>Only the dungeon’s draft changes. Nothing is published or enabled.</li>
              {plan.remainsDisabled.map((d) => (
                <li key={`${d.kind}:${d.key}`}>
                  {d.kind === 'shared_pool' ? 'Shared pool' : 'Enemy'} {d.name} remains disabled
                  {d.requiredForPublication ? ' — enable it before publishing.' : '; enable it in Enemies when it is ready.'}
                </li>
              ))}
              <li>Then open the draft, validate it and publish it with the existing tools.</li>
            </ul>
          </section>

          {warnings.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer">Warnings ({warnings.length})</summary>
              <ul className="list-disc pl-5">
                {warnings.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </details>
          )}

          <details className="text-xs text-ink-muted" data-testid="bundle-technical">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-2">
              Plan <span className="font-mono">{plan.planHash}</span> · bundle <span className="font-mono">{plan.bundle.bundleHash}</span> ·{' '}
              Dungeon JSON v{plan.bundle.packageSchemaVersion}
            </p>
            <ul className="mt-2">
              {plan.artwork.assets.map((a) => (
                <li key={a.id}>
                  <span className="font-mono">{a.id}</span> {a.category} {a.width}×{a.height} {a.sha256.slice(0, 16)}… —{' '}
                  {a.action === 'create' ? 'added' : a.action === 'reuse' ? `reuses ${a.reuse.join(', ')}` : 'not needed'} ({a.usedBy.join('; ')})
                </li>
              ))}
            </ul>
          </details>

          {plan.readiness === 'incomplete' && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={allowIncomplete} onChange={(e) => { setAllowIncomplete(e.target.checked); setConfirmed(false); }} />
              Import as an incomplete draft for repair. It cannot be published until the missing content is deployed.
            </label>
          )}
          {pending.length > 0 && <p className="text-sm text-warning">Choose what to do with: {pending.join(', ')}.</p>}
          {choicesChanged && pending.length === 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">Review the result of your choices before importing.</p>
              <Button variant="outline" size="sm" disabled={preview.isPending} onClick={() => file && preview.mutate({ f: file, c: choices })}>
                Review choices
              </Button>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={!!pending.length || choicesChanged || blocked} onChange={(e) => setConfirmed(e.target.checked)} />
            I reviewed this. Import it into the dungeon’s draft.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" disabled={!canImport} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Importing…' : 'Import bundle'}
            </Button>
            <Button variant="outline" disabled={apply.isPending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
          {stale && (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-danger">Something this import depends on changed since you reviewed it. Nothing was imported.</p>
              <Button variant="outline" size="sm" onClick={() => file && preview.mutate({ f: file, c: choices })}>
                Review again
              </Button>
            </div>
          )}
          {rejected.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-danger" role="alert">
              {rejected.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
          {apply.isError && !stale && rejected.length === 0 && <ErrorState variant="inline" title="Could not import" error={apply.error} />}
        </div>
      )}

      {result && (
        <div className="space-y-2" role="status" data-testid="bundle-import-result">
          <p className="font-medium">
            {result.dungeonResult === 'created' ? 'Imported as a new, disabled and unpublished draft.' : result.dungeonResult === 'replaced' ? 'The draft was replaced.' : 'The draft was already up to date.'}{' '}
            {result.publishedRevision ? `Published revision ${result.publishedRevision} is still live` : 'Nothing is published'}; the dungeon is{' '}
            {result.enabled ? 'enabled' : 'disabled'}.
          </p>
          <p className="text-sm">
            Enemies: {result.enemies.created.length} added, {result.enemies.updated.length} updated · Scene Sprites:{' '}
            {result.sceneSprites.created.length + result.sceneSprites.copied.length} added, {result.sceneSprites.updated.length} updated · Shared pools:{' '}
            {result.sharedPools.created.length} added, {result.sharedPools.updated.length} updated · Images: {result.assets.created} added,{' '}
            {result.assets.reused} reused.
          </p>
          {result.readiness === 'incomplete' && <p className="text-sm text-danger">This is an incomplete draft for repair. It cannot be published yet.</p>}
          {result.remainsDisabled.length > 0 && (
            <p className="text-sm">Still disabled: {result.remainsDisabled.map((d) => d.name).join(', ')}.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={`/admin/dungeons/definitions/${encodeURIComponent(result.dungeonKey)}`}>Open imported draft</Link>
            </Button>
            {result.remainsDisabled.some((d) => d.kind === 'shared_pool') && (
              <Button variant="outline" asChild>
                <Link to="/admin/dungeons/waifumon-pools">Dungeon WaifuMon Pools</Link>
              </Button>
            )}
            <Button variant="outline" onClick={onCancel}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
