import { useRef, useState, type ReactNode } from 'react';
import type {
  ManagedRarityRule,
  RollRulesPreview,
  RollRulesValidation,
} from '@/api/adminEquipmentRules';
import * as api from '@/api/adminEquipmentRules';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { RuleIssues } from './RulesFields';
import { familyText, percent } from './rulesModel';

export function RulesDialog({
  title,
  description,
  children,
  close,
}: {
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <div className="max-h-[85vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-lg">
          <DialogTitle className="font-display text-xl">{title}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">{description}</DialogDescription>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ValidationResult({ value }: { value: RollRulesValidation }) {
  return (
    <div className="space-y-3">
      <p className={value.ok ? 'text-success' : 'text-danger'}>
        {value.ok ? 'Backend validation passed.' : 'Backend validation found problems.'}
      </p>
      <RuleIssues issues={value.errors} label="Errors" />
      <RuleIssues issues={value.warnings} label="Warnings" />
    </div>
  );
}

function describe(path: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return 'Not configured';
  if (path === 'flatSpLimits') {
    const limits = value as { perItemMax: number; perLoadoutMax: number };
    return `${limits.perItemMax} SP per copy; ${limits.perLoadoutMax} SP per loadout`;
  }
  if (path.endsWith('bonusCountWeightsBp'))
    return (value as number[]).map((w, i) => `${i} bonuses: ${percent(w)}%`).join('; ');
  if (path.endsWith('families'))
    return (
      <ul className="space-y-1">
        {(value as ManagedRarityRule['families']).map((f) => (
          <li key={f.stat}>{familyText(f)}</li>
        ))}
      </ul>
    );
  if (path.endsWith('primarySp')) {
    const primary = value as NonNullable<ManagedRarityRule['primarySp']>;
    return `${percent(primary.chanceBp)}% chance; ${primary.min}–${primary.max} SP; step ${primary.step} SP`;
  }
  if (path.endsWith('affixes')) {
    const affixes = value as ManagedRarityRule['affixes'];
    return affixes.mode === 'none' ? 'Affixless' : `Library: ${affixes.library}`;
  }
  if (/^rarities\.(SSR|UR|LR)$/.test(path)) {
    const rule = value as ManagedRarityRule;
    return (
      <div className="space-y-2">
        {(['bonusCountWeightsBp', 'families', 'primarySp', 'affixes'] as const).map((field) => (
          <div key={field}>{describe(`${path}.${field}`, rule[field])}</div>
        ))}
      </div>
    );
  }
  return 'Protected legacy configuration';
}
const changeLabel = (path: string) =>
  path
    .replace('flatSpLimits', 'Equipment SP safety limits')
    .replace('rarities.', '')
    .replace('.bonusCountWeightsBp', ' additional bonus chances')
    .replace('.families', ' bonus families')
    .replace('.primarySp', ' primary SP')
    .replace('.affixes', ' affix assignment');

export function RulesDiff({ preview }: { preview: RollRulesPreview }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Compared with published revision {preview.publishedRevision} · draft revision{' '}
        {preview.draftRevision}
      </p>
      {preview.changes.length === 0 && <p>No changes from published rules.</p>}
      {preview.changes.map((change) => (
        <section className="space-y-2 rounded border border-line p-3" key={change.path}>
          <h3 className="font-medium">
            {changeLabel(change.path)} — {change.kind}
          </h3>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-1 font-medium text-ink-muted">Published</p>
              {describe(change.path, change.before)}
            </div>
            <div>
              <p className="mb-1 font-medium text-ink-muted">Proposed draft</p>
              {describe(change.path, change.after)}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

export function RulesImportDialog({
  revision,
  onApplied,
  onFailure,
  close,
}: {
  revision: number;
  onApplied: () => Promise<void>;
  onFailure: (err: unknown) => void;
  close: () => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<(RollRulesPreview & { handEdited: boolean }) | null>(null);
  const [parsed, setParsed] = useState<unknown>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [fileLoading, setFileLoading] = useState(false);
  const fileVersion = useRef(0);
  const changeText = (next: string) => {
    fileVersion.current++;
    setText(next);
    setPreview(null);
    setParsed(null);
    setConfirmed(false);
    setError(null);
  };
  const run = async (apply: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (apply) {
        await api.importDraft(parsed, revision);
        await onApplied();
      } else {
        const value: unknown = JSON.parse(text);
        const next = await api.previewImport(value, revision);
        setParsed(value);
        setPreview(next);
        setConfirmed(false);
      }
    } catch (err) {
      setPreview(null);
      setConfirmed(false);
      setError(err);
      onFailure(err);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <RulesDialog
      title="Import rarity rules"
      description="Preview a rules JSON export, then apply it to the draft only. Publication is a separate action. N/R/SR rules remain protected."
      close={() => {
        if (!busy && !fileLoading) close();
      }}
    >
      <label className="grid gap-1 text-sm">
        Upload rules JSON
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy || fileLoading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            changeText('');
            const version = fileVersion.current;
            setFileLoading(true);
            if (file.size > 900000) {
              setError(new Error('Choose a file smaller than 900 KB.'));
              setFileLoading(false);
              return;
            }
            void file
              .text()
              .then((value) => {
                if (fileVersion.current === version) changeText(value);
              })
              .catch(setError)
              .finally(() => setFileLoading(false));
          }}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Rules JSON
        <textarea
          className="min-h-40 w-full rounded border border-line bg-surface p-2 font-mono text-xs"
          value={text}
          disabled={busy || fileLoading}
          onChange={(e) => changeText(e.target.value)}
        />
      </label>
      <Button
        variant="outline"
        disabled={busy || fileLoading || !text.trim()}
        onClick={() => void run(false)}
      >
        {busy ? 'Working…' : 'Preview import'}
      </Button>
      {error !== null && <ErrorState error={error} />}
      {preview && (
        <>
          <ValidationResult value={preview.validation} />
          {preview.handEdited && (
            <p className="text-sm">
              This file was edited after export. The server has validated the proposed content.
            </p>
          )}
          <RulesDiff preview={preview} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Replace the saved draft with this import. Do not publish.
          </label>
          <Button
            disabled={busy || !confirmed || !preview.validation.ok}
            onClick={() => void run(true)}
          >
            Apply import to draft
          </Button>
        </>
      )}
    </RulesDialog>
  );
}
