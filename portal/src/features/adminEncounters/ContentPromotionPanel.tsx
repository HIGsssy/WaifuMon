/**
 * Content promotion — export encounters from one environment, import them into
 * another.
 *
 * The workflow this replaces is a database dump, which carries surrogate keys,
 * player rows and live encounter state along with the content. So the screen
 * is built around making a promotion *reviewable*: you get a file you can read
 * and diff, and you cannot apply one without first being shown exactly what it
 * would do.
 *
 * Three things it owes an operator:
 *
 *   - **Preview is mandatory and obviously separate.** Apply is disabled until
 *     a plan has come back clean for the file currently selected. Choosing a
 *     different file clears the plan, so an Apply button can never refer to a
 *     package other than the one on screen.
 *   - **Errors and warnings read differently.** A missing item blocks the
 *     import; artwork that has not been deployed yet does not, because assets
 *     ship on their own schedule. Presenting both as "problems" would train
 *     operators to click through the ones that matter.
 *   - **Honesty about what import does not do.** It never deletes. An operator
 *     looking at "3 created, 1 updated" needs to know the other forty
 *     encounters on this server are simply untouched.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import {
  applyAdminEncounterImport,
  exportAdminEncounters,
  previewAdminEncounterImport,
  type ImportPlan,
  type ImportPlanIssue,
} from '@/api/adminEncounters';
import { describeIssue } from './waifumonSelection';
import { useHasPermission } from '@/auth/useSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/** Trigger a browser download of `data` as a .json file. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * One plan issue in author-facing words. Selector issues get an explanation
 * (with region names rather than ids); the server's own message stays
 * underneath so nothing it said is lost.
 */
function IssueText({ issue }: { issue: ImportPlanIssue }) {
  const { headline, detail } = describeIssue(issue);
  return (
    <>
      {headline}
      {detail ? <span className="block opacity-80">{detail}</span> : null}
    </>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'That did not work.';
}

export function ContentPromotionPanel({
  /** Slugs currently selected in the list, if any. */
  selectedSlugs = [],
}: {
  selectedSlugs?: readonly string[];
}) {
  const canRead = useHasPermission('encounters.read');
  const canWrite = useHasPermission('encounters.write');
  const canPublish = useHasPermission('encounters.publish');

  const [label, setLabel] = useState('');
  const [file, setFile] = useState<{ name: string; parsed: unknown } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: (slugs: readonly string[]) =>
      exportAdminEncounters({ slugs, label: label.trim() || null }),
    onSuccess: (pkg) => {
      setError(null);
      const stamp = new Date().toISOString().slice(0, 10);
      const scope = pkg.encounters.length === 1 ? pkg.encounters[0]!.slug : 'all';
      downloadJson(`world-encounters-${scope}-${stamp}.json`, pkg);
    },
    onError: (err) => setError(messageOf(err)),
  });

  const previewMutation = useMutation({
    mutationFn: () => previewAdminEncounterImport(file?.parsed, file?.name ?? null),
    onSuccess: (next) => {
      setError(null);
      setPlan(next);
    },
    onError: (err) => setError(messageOf(err)),
  });

  const applyMutation = useMutation({
    mutationFn: () => applyAdminEncounterImport(file?.parsed, file?.name ?? null),
    onSuccess: (result) => {
      setError(null);
      setPlan(result.plan);
      setApplied(
        `Imported: ${result.plan.counts.created} created, ` +
          `${result.plan.counts.updated} updated, ${result.plan.counts.unchanged} unchanged.`,
      );
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (!canRead) return null;

  const onFile = async (chosen: File | null) => {
    // Selecting a new file invalidates the plan on screen: Apply must never be
    // able to act on a package other than the one that was previewed.
    setPlan(null);
    setApplied(null);
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    try {
      setFile({ name: chosen.name, parsed: JSON.parse(await chosen.text()) });
    } catch {
      setFile(null);
      setError(`${chosen.name} is not valid JSON.`);
    }
  };

  const errors = plan?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = plan?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <Card className="space-y-4 p-4" data-testid="content-promotion">
      <div>
        <h2 className="text-lg font-medium">Content promotion</h2>
        <p className="text-sm text-muted-foreground">
          Export encounter definitions as a portable package, or import one authored on another
          server. Importing never deletes encounters that are missing from the package.
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* ── Export ── */}
      <section className="space-y-2 rounded-md border p-3">
        <h3 className="text-sm font-medium">Export</h3>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">
            Label (optional) — recorded in the target server&rsquo;s import log
          </span>
          <Input
            aria-label="Package label"
            placeholder="e.g. staging 2026-09-05"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exportMutation.isPending}
            onClick={() => exportMutation.mutate([])}
          >
            Export all encounters
          </Button>
          <Button
            variant="outline"
            disabled={exportMutation.isPending || selectedSlugs.length === 0}
            onClick={() => exportMutation.mutate(selectedSlugs)}
          >
            {selectedSlugs.length > 0
              ? `Export selected (${selectedSlugs.length})`
              : 'Export selected'}
          </Button>
        </div>
      </section>

      {/* ── Import ── */}
      {canWrite ? (
        <section className="space-y-3 rounded-md border p-3">
          <h3 className="text-sm font-medium">Import</h3>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Package file (.json)</span>
            <input
              aria-label="Package file"
              type="file"
              accept="application/json,.json"
              className="text-sm"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={!file || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? 'Checking…' : 'Preview import'}
            </Button>
            <Button
              // Apply needs a clean plan for *this* file, and the publish
              // permission. An Encounter Editor can prepare a promotion and
              // see exactly what it would do, but not perform it.
              disabled={
                !plan || !plan.ok || !canPublish || applyMutation.isPending || applied !== null
              }
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? 'Importing…' : 'Apply import'}
            </Button>
            {!canPublish ? (
              <span className="text-xs text-muted-foreground">
                Applying an import needs the publish permission.
              </span>
            ) : null}
          </div>

          {applied ? (
            <p className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
              {applied}
            </p>
          ) : null}

          {plan ? (
            <div className="space-y-3" data-testid="import-plan">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge>{plan.counts.created} new</Badge>
                <Badge>{plan.counts.updated} updated</Badge>
                <Badge>{plan.counts.unchanged} unchanged</Badge>
                {plan.counts.vendorsCreated + plan.counts.vendorsUpdated > 0 ? (
                  <Badge>
                    {plan.counts.vendorsCreated + plan.counts.vendorsUpdated} vendor(s)
                  </Badge>
                ) : null}
                {plan.label ? <Badge>from: {plan.label}</Badge> : null}
              </div>

              {errors.length > 0 ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                  <p className="text-sm font-medium text-destructive">
                    {errors.length} problem(s) block this import
                  </p>
                  <ul className="mt-1 space-y-1 text-xs text-destructive">
                    {errors.map((issue, i) => (
                      <li key={`${issue.code}-${i}`}>
                        {issue.subject ? <strong>{issue.subject}: </strong> : null}
                        <IssueText issue={issue} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {warnings.length > 0 ? (
                <div className="rounded-md border p-3">
                  {/* Warnings never block: artwork in particular deploys on its
                      own schedule, and an encounter without its image renders
                      text-only rather than breaking. */}
                  <p className="text-sm font-medium">{warnings.length} warning(s)</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {warnings.map((issue, i) => (
                      <li key={`${issue.code}-${i}`}>
                        {issue.subject ? <strong>{issue.subject}: </strong> : null}
                        <IssueText issue={issue} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {plan.encounters.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {plan.encounters.map((entry) => (
                    <li key={entry.slug} className="flex items-center gap-2">
                      <Badge>{entry.status}</Badge>
                      <span>{entry.name}</span>
                      <code className="text-xs text-muted-foreground">{entry.slug}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </Card>
  );
}
