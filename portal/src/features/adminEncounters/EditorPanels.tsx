/**
 * Smaller pieces of the encounter editor: the validation summary, the chain
 * context panel, the "what are you creating?" chooser and the preview drawer.
 */
import { Link } from 'react-router';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { AdminEncounterPreviewPanel } from './AdminEncounterPreviewPanel';
import { BRANCH_LABEL, type ChainLink, type EncounterGraph } from './encounterGraph';
import { TEMPLATES, type EncounterTemplate } from './templates';

/* ─────────────────────── Validation ─────────────────────── */

export function ValidationSummary({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
          data-testid="save-blockers"
        >
          <p className="font-medium">Fix {errors.length === 1 ? 'this' : 'these'} before saving.</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {errors.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="validation-warnings"
        >
          <p className="font-medium">
            {warnings.length === 1 ? 'One thing to check' : `${warnings.length} things to check`} —
            saving is still allowed.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
            {warnings.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Chain context ─────────────────────── */

function linkWhere(link: ChainLink): string {
  if (link.branch === 'after_any') return 'after any choice';
  const branch = link.branch === 'outcome' ? '' : ` · ${BRANCH_LABEL[link.branch].toLowerCase()}`;
  return `“${link.choiceLabel ?? `Choice #${(link.choiceIndex ?? 0) + 1}`}”${branch}`;
}

/** Where this encounter sits in any chain: what leads here, and where it leads. */
export function ChainContextPanel({ slug, graph }: { slug: string; graph: EncounterGraph | null }) {
  if (!graph) return null;
  const incoming = (graph.incoming.get(slug) ?? []).filter((l) => l.from !== slug);
  const outgoing = (graph.outgoing.get(slug) ?? []).filter((l) => l.deadReason !== 'self');
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const link = (target: string) => {
    const e = graph.encounters.get(target);
    if (!e) return <span className="text-danger">“{target}” (missing)</span>;
    return e.id != null ? (
      <Link to={`/admin/encounters/${e.id}`} className="text-accent underline">
        {e.name}
      </Link>
    ) : (
      <span>{e.name}</span>
    );
  };
  return (
    <Card className="space-y-2 p-4 text-sm" data-testid="chain-context">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Chain</h3>
        <div className="flex-1" />
        <Link
          to={`/admin/encounters/chains?focus=${encodeURIComponent(slug)}`}
          className="text-xs text-accent underline"
        >
          View chain
        </Link>
      </div>
      {incoming.length > 0 && (
        <div>
          <p className="text-xs text-ink-muted">Reached from</p>
          <ul className="space-y-0.5">
            {incoming.map((l, i) => (
              <li key={i}>
                {link(l.from)} <span className="text-ink-muted">— {linkWhere(l)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outgoing.length > 0 && (
        <div>
          <p className="text-xs text-ink-muted">Leads to</p>
          <ul className="space-y-0.5">
            {outgoing.map((l, i) => (
              <li key={i} className={l.live ? '' : 'opacity-60'}>
                <span className="text-ink-muted">{linkWhere(l)} →</span> {link(l.to)}
                {!l.live && <span className="text-xs text-ink-muted"> (never used)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ─────────────────────── New encounter ─────────────────────── */

export function NewEncounterChooser({ onPick }: { onPick: (t: EncounterTemplate) => void }) {
  return (
    <div className="space-y-3" data-testid="template-chooser">
      <h2 className="text-lg font-semibold">What are you creating?</h2>
      <p className="text-sm text-ink-muted">
        A starting point only — every option leads to the same editor, and anything can be changed
        later.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-raised"
          >
            <span className="block font-medium">{t.title}</span>
            <span className="mt-1 block text-sm text-ink-muted">{t.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────── Preview drawer ─────────────────────── */

export function PreviewDrawer({
  open,
  onOpenChange,
  encounterId,
  reference,
  dirty,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  encounterId: number;
  reference: AdminEncounterReference | undefined;
  dirty: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        closeLabel="Close preview"
        className="w-[28rem] overflow-y-auto p-4"
      >
        <SheetTitle className="text-base font-semibold">Preview</SheetTitle>
        <SheetDescription className="mb-3 text-xs text-ink-muted">
          Success chances for the last <strong>saved</strong> version
          {dirty ? ' — you have unsaved changes, so save first to preview them' : ''}.
        </SheetDescription>
        <AdminEncounterPreviewPanel encounterId={encounterId} reference={reference} />
        <Button variant="outline" size="sm" asChild className="mt-3">
          <Link to={`/admin/encounters/${encounterId}/preview`}>Full preview &amp; simulator</Link>
        </Button>
      </SheetContent>
    </Sheet>
  );
}
