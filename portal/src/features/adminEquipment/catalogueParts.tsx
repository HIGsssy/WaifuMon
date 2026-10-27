/**
 * Pieces the Equipment Catalogue pages share: badges, issue lists, the
 * enable/disable confirmation (with the reward sources it would reach), the
 * duplicate dialog and the roll preview panel.
 *
 * Every number shown here comes from the server's analysis or its seeded
 * sample rolls — the Portal never rolls anything itself.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  EQUIPMENT_CATALOGUE_QUERY_KEY,
  SAMPLE_ROLL_MAX,
  duplicateCatalogueDefinition,
  formatFamilyValue,
  formatMultiplier,
  formatPercentBp,
  getRewardImpact,
  invalidateCatalogueQueries,
  previewEquipmentRoll,
  setCatalogueDefinitionEnabled,
  type Availability,
  type BonusFamilyRange,
  type CatalogueDefinition,
  type CatalogueDetail,
  type EquipmentDefinitionInput,
  type EquipmentIssue,
  type RewardImpact,
  type RollAnalysis,
} from '@/api/adminEquipment';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

import {
  SOURCE_LABELS,
  WHEN_LABELS,
  equipmentPath,
  formatProbability,
  isHighRarity,
  keyError,
  refusedIssues,
} from './equipmentModel';

export function RarityBadge({ rarity }: { rarity: string }) {
  return (
    <Badge variant={isHighRarity(rarity) ? 'solid' : 'outline'} data-testid="rarity-badge">
      {rarity}
    </Badge>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Badge variant="default">Enabled</Badge>
  ) : (
    <Badge variant="danger">Disabled</Badge>
  );
}

export function IssueList({
  issues,
  testId,
}: {
  issues: readonly EquipmentIssue[];
  testId: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-danger" data-testid={testId} role="alert">
      {issues.map((issue, i) => (
        <li key={`${issue.path}:${i}`}>
          {issue.path && <span className="font-mono text-xs">{issue.path}: </span>}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** Enabled, rollable and rewarded, said separately — enabled alone never means obtainable. */
export function AvailabilityCard({ availability }: { availability: Availability }) {
  const config: Record<Availability['rollConfiguration'], string> = {
    legacy: 'Standard N/R/SR rules',
    published: 'Published rarity rules',
    unconfigured: 'No published rules for this rarity',
    invalid: 'Published rules cannot roll it',
    unsupported: 'Not rollable',
  };
  return (
    <Card className="space-y-2 p-4 text-sm" data-testid="availability">
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">1. Definition</dt>
          <dd className="text-ink">{availability.enabled ? 'Enabled' : 'Disabled'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">2. Roll configuration</dt>
          <dd className="text-ink" data-testid="availability-rolls">
            {config[availability.rollConfiguration]} —{' '}
            {availability.rollable ? 'can roll' : 'cannot roll'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">3. Reward sources</dt>
          <dd className="text-ink" data-testid="availability-rewards">
            {availability.rewardRarity
              ? 'Automatic sources whose selectors match it'
              : 'None — no reward source can grant this rarity yet'}
          </dd>
        </div>
      </dl>
      <p className="text-ink-muted" data-testid="availability-summary">
        {availability.summary}
      </p>
    </Card>
  );
}

function ImpactList({ impact }: { impact: RewardImpact }) {
  const rows = [...impact.automatic, ...impact.deferred];
  if (rows.length === 0)
    return <p className="text-sm text-ink-muted">No automatic reward source would pay it.</p>;
  return (
    <ul className="max-h-56 space-y-1 overflow-y-auto text-sm" data-testid="impact-list">
      {rows.map((row, i) => (
        <li key={`${row.source}:${row.key}:${row.location}:${i}`} data-testid="impact-row">
          <Badge variant="outline">{SOURCE_LABELS[row.source]}</Badge>{' '}
          <span className="text-ink">{row.name}</span>{' '}
          <span className="text-ink-muted">
            — {row.location}, “{row.selector}”, {WHEN_LABELS[row.when]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Enable or disable a definition. Enabling reads the live reward impact first
 * and, when gear would join automatic rewards at once, will not proceed
 * without an explicit tick — the server refuses the same request otherwise.
 */
export function EnableDefinitionDialog({
  definition,
  onClose,
  onDone,
}: {
  definition: CatalogueDefinition;
  onClose: () => void;
  onDone?: (detail: CatalogueDetail) => void;
}) {
  const queryClient = useQueryClient();
  const enabling = !definition.enabled;
  const [acknowledged, setAcknowledged] = useState(false);
  const impact = useQuery({
    queryKey: [...EQUIPMENT_CATALOGUE_QUERY_KEY, 'impact', definition.key, definition.revision],
    queryFn: ({ signal }) => getRewardImpact(definition.key, signal),
    enabled: enabling,
  });
  const toggle = useMutation({
    mutationFn: () =>
      setCatalogueDefinitionEnabled(definition.key, enabling, definition.revision, acknowledged),
    onSuccess: (detail) => {
      invalidateCatalogueQueries(queryClient);
      onDone?.(detail);
      onClose();
    },
  });
  const automatic = impact.data?.automatic.length ?? 0;
  const needsAck = enabling && automatic > 0;
  const stale =
    isPortalApiError(toggle.error) && toggle.error.code === 'EQUIPMENT_DEFINITION_STALE';

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel">
        <div
          className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="enable-dialog"
        >
          <DialogTitle className="text-base font-semibold">
            {enabling ? 'Enable' : 'Disable'} {definition.name}
          </DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            {enabling
              ? isHighRarity(definition.rarity)
                ? 'Enabling SSR, UR or LR gear does not make it obtainable: it still needs published rarity rules, and no reward source can grant this rarity yet.'
                : 'Enabled N, R and SR gear can be handed out by every automatic reward whose selector matches it.'
              : 'Disabled gear stops being granted. Copies players already own stay owned and equipable.'}
          </DialogDescription>
          {enabling && impact.isPending && <Skeleton className="h-16 w-full" />}
          {enabling && impact.isError && (
            <ErrorState
              variant="inline"
              title="Could not check reward sources"
              error={impact.error}
            />
          )}
          {enabling && impact.data && <ImpactList impact={impact.data} />}
          {needsAck && (
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                aria-label="I understand it joins these rewards"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand it starts dropping from the {automatic} source
                {automatic === 1 ? '' : 's'} marked “immediately” as soon as it is enabled.
              </span>
            </label>
          )}
          {toggle.isError && (
            <ErrorState
              variant="inline"
              title={
                stale
                  ? 'Someone else changed this equipment first — reload it and try again'
                  : 'Could not change it'
              }
              error={toggle.error}
            />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="accent"
              disabled={
                toggle.isPending || (enabling && !impact.data) || (needsAck && !acknowledged)
              }
              onClick={() => toggle.mutate()}
            >
              {enabling ? 'Enable' : 'Disable'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Copy a definition's authoring fields under a new key. The copy starts disabled. */
export function DuplicateDefinitionDialog({
  source,
  onClose,
}: {
  source: CatalogueDefinition;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [key, setKey] = useState(`${source.key}_copy`.slice(0, 64));
  const [name, setName] = useState('');
  const copy = useMutation({
    mutationFn: () =>
      duplicateCatalogueDefinition(source.key, {
        key,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (detail) => {
      invalidateCatalogueQueries(queryClient);
      navigate(equipmentPath(detail.definition.key));
    },
  });
  const badKey = keyError(key);
  const taken = isPortalApiError(copy.error) && copy.error.code === 'EQUIPMENT_KEY_TAKEN';
  const refused = refusedIssues(copy.error);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel duplicating">
        <div
          className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="duplicate-dialog"
        >
          <DialogTitle className="text-base font-semibold">Duplicate {source.name}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Makes new equipment with the same settings. Nothing players own is copied, and the copy
            starts disabled so you can review it first.
          </DialogDescription>
          <label className="block text-xs text-ink-muted">
            Key of the copy (lower_snake_case, permanent)
            <Input
              aria-label="Key of the copy"
              className="mt-1 font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {badKey && (
            <p className="text-xs text-danger" role="alert">
              {badKey}
            </p>
          )}
          {taken && (
            <p className="text-xs text-danger" role="alert">
              Equipment with the key “{key}” already exists — choose another key.
            </p>
          )}
          <label className="block text-xs text-ink-muted">
            Name of the copy (optional)
            <Input
              aria-label="Name of the copy"
              className="mt-1"
              placeholder={`${source.name} (copy)`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <IssueList issues={refused} testId="duplicate-issues" />
          {copy.isError && !taken && refused.length === 0 && (
            <ErrorState variant="inline" title="Could not duplicate it" error={copy.error} />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="accent"
              disabled={badKey !== null || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending ? 'Duplicating…' : 'Duplicate'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FamilyTable({ families }: { families: BonusFamilyRange[] }) {
  if (families.length === 0)
    return <p className="text-xs text-ink-muted">No bonus families for this slot.</p>;
  return (
    <ul className="space-y-0.5 text-sm" data-testid="preview-families">
      {families.map((f) => (
        <li key={f.stat}>
          <span className="text-ink">{f.label}</span>{' '}
          <span className="text-ink-muted">
            {formatFamilyValue(f.unit, f.min)} – {formatFamilyValue(f.unit, f.max)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The analysis the server computed, in author words. */
export function RollAnalysisView({ analysis }: { analysis: RollAnalysis }) {
  if (analysis.mode === 'unsupported')
    return <IssueList issues={analysis.issues} testId="preview-issues" />;
  const multiplier = `${formatMultiplier(analysis.multiplier.min)} – ${formatMultiplier(analysis.multiplier.max)} (${analysis.multiplier.values} possible values)`;
  if (analysis.mode === 'legacy') {
    return (
      <div className="space-y-2 text-sm" data-testid="preview-legacy">
        <p className="text-xs text-ink-muted">Standard {analysis.rarity} rules — read-only here.</p>
        <p>
          <span className="text-ink-muted">Multiplier:</span> {multiplier}
        </p>
        <p>
          <span className="text-ink-muted">Additional bonuses:</span>{' '}
          {analysis.bonusCount === 0
            ? 'none'
            : `${analysis.bonusCount}, ${analysis.bonusChanceBp >= 10_000 ? 'always' : `${formatPercentBp(analysis.bonusChanceBp)} of the time`}`}
        </p>
        <FamilyTable families={analysis.families} />
        <p className="text-xs text-ink-muted">
          Affix: one of {analysis.enabledAffixes} enabled entries in {analysis.affixPool}.
        </p>
        <IssueList issues={analysis.issues} testId="preview-issues" />
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm" data-testid="preview-high">
      <p className="text-xs text-ink-muted" data-testid="preview-rules">
        {analysis.configured
          ? `Published ${analysis.rarity} rules (revision ${analysis.rulesRevision ?? '?'})`
          : `No ${analysis.rarity} rules are published yet`}
      </p>
      <p>
        <span className="text-ink-muted">Multiplier:</span> {multiplier}
      </p>
      {analysis.counts.length > 0 && (
        <p data-testid="preview-counts">
          <span className="text-ink-muted">Additional bonuses:</span>{' '}
          {analysis.counts
            .map((c) => `${c.count} (${formatProbability(c.probability)})`)
            .join(', ')}
          {analysis.maxAdditionalBonuses !== null && (
            <span className="text-ink-muted">
              {' '}
              — capped at {analysis.maxAdditionalBonuses} by this definition
            </span>
          )}
        </p>
      )}
      <FamilyTable families={analysis.families} />
      <p data-testid="preview-primary-sp">
        <span className="text-ink-muted">Primary SP:</span>{' '}
        {!analysis.primarySpEligible
          ? 'not eligible'
          : analysis.primarySp
            ? `${formatProbability(analysis.primarySp.probability)} chance of +${analysis.primarySp.min}–${analysis.primarySp.max} SP`
            : 'eligible, but the rarity rule grants none'}
      </p>
      {analysis.configured && (
        <p>
          <span className="text-ink-muted">Possible flat SP on one copy:</span> +
          {analysis.spRange.min} – +{analysis.spRange.max} SP
        </p>
      )}
      <p className="text-xs text-ink-muted" data-testid="preview-affix">
        Affix:{' '}
        {analysis.affix.mode === 'none'
          ? 'none (affixless)'
          : `library “${analysis.affix.library}”${analysis.affix.revision ? ` revision ${analysis.affix.revision}` : ''}${
              analysis.affix.candidates !== null
                ? `, ${analysis.affix.candidates} entries for this slot`
                : ''
            }`}
      </p>
      <IssueList issues={analysis.issues} testId="preview-issues" />
    </div>
  );
}

/**
 * Analysis plus optional seeded samples, for a stored key or the unsaved
 * form. The same seed always shows the same samples; nothing is granted.
 */
export function RollPreviewPanel({
  target,
}: {
  target: { key: string } | { definition: EquipmentDefinitionInput };
}) {
  const [seed, setSeed] = useState('1');
  const [count, setCount] = useState('5');
  const preview = useMutation({
    mutationFn: (withSamples: boolean) =>
      previewEquipmentRoll(
        target,
        withSamples
          ? {
              seed: Number(seed),
              count: Math.min(Math.max(Number(count) || 1, 1), SAMPLE_ROLL_MAX),
            }
          : {},
      ),
  });
  const badSeed = !/^\d{1,10}$/.test(seed) || Number(seed) > 0xffff_ffff;
  return (
    <div className="space-y-3" data-testid="roll-preview">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={preview.isPending}
          onClick={() => preview.mutate(false)}
        >
          Check roll configuration
        </Button>
        <label className="text-xs text-ink-muted">
          Seed
          <Input
            aria-label="Sample seed"
            className="w-28 font-mono"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Samples
          <Input
            aria-label="Sample count"
            className="w-16"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={preview.isPending || badSeed}
          onClick={() => preview.mutate(true)}
        >
          Roll samples
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Previews use the published rules and write nothing: no equipment is granted.
      </p>
      {preview.isError && (
        <>
          <IssueList issues={refusedIssues(preview.error)} testId="preview-refused" />
          {refusedIssues(preview.error).length === 0 && (
            <ErrorState variant="inline" title="Could not preview" error={preview.error} />
          )}
        </>
      )}
      {preview.data && (
        <>
          <RollAnalysisView analysis={preview.data.analysis} />
          {preview.data.sampleError && (
            <p className="text-sm text-danger" role="alert" data-testid="sample-error">
              {preview.data.sampleError}
            </p>
          )}
          {preview.data.samples && (
            <ol className="space-y-1 text-sm" data-testid="sample-rolls">
              {preview.data.samples.map((s, i) => (
                <li key={i} data-testid="sample-roll">
                  <span className="text-ink">{s.displayName}</span>{' '}
                  <span className="text-ink-muted">
                    {formatMultiplier(s.rolledMultiplierBp)}
                    {s.combatBonuses.length > 0 &&
                      ` · ${s.combatBonuses.map((b) => (b.stat === 'flat_sp' ? `+${b.valueBp} SP` : `${b.stat} ${formatPercentBp(b.valueBp)}`)).join(', ')}`}
                    {s.primarySp > 0 && ` · primary +${s.primarySp} SP`}
                    {s.totalFlatSp > 0 && ` · total +${s.totalFlatSp} SP`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
