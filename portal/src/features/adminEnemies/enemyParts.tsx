/**
 * Small pieces the enemy pages share — and the two the Dungeon editor borrows
 * to point at an enemy without editing it ({@link ViewEnemyLink}).
 */
import { useState } from 'react';
import { Link } from 'react-router';

import type { EnemyIssue, EnemyOrigin, EnemyStat } from '@/api/adminEnemies';
import { useHasPermission } from '@/auth/useSession';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import {
  ENEMY_STATS,
  ORIGIN_LABELS,
  STAT_LABELS,
  enemyPath,
  statError,
  tagFrom,
  type EnemyForm,
} from './enemyModel';

/**
 * Opens an enemy's own page in a new tab, so an editor with unsaved changes —
 * a dungeon half-built — is not navigated away from. Renders nothing for
 * someone who could not open that page: a dungeon author without
 * `enemies.read` still picks enemies and sees their stats.
 */
export function ViewEnemyLink({ enemyKey, name }: { enemyKey: string; name: string }) {
  const canOpen = useHasPermission('enemies.read');
  if (!canOpen) return null;
  return (
    <Link
      to={enemyPath(enemyKey)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-accent underline"
      aria-label={`View Enemy: ${name} (opens in a new tab)`}
    >
      View Enemy
    </Link>
  );
}

/** Where an enemy stands relative to Git, in one badge. */
export function EnemyOriginBadge({ origin }: { origin: EnemyOrigin }) {
  if (origin === 'custom') return <Badge variant="outline">{ORIGIN_LABELS.custom}</Badge>;
  if (origin === 'shipped') return <Badge variant="default">{ORIGIN_LABELS.shipped}</Badge>;
  return (
    <Badge
      variant="solid"
      title="Edited here; deploys will not overwrite it. Export to commit it to Git."
    >
      {ORIGIN_LABELS.edited}
    </Badge>
  );
}

export function EnemyIssues({ issues, testId }: { issues: EnemyIssue[]; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid={testId ?? 'enemy-issues'}>
      {issues.map((i) => (
        <li
          key={`${i.path}:${i.message}`}
          className={i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
          {...(i.severity === 'error' ? { role: 'alert' } : {})}
        >
          {i.severity === 'error' ? '' : '⚠ '}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

/** ATK, DEF and HP. A value outside the server's bounds is named, never rounded. */
export function StatFields({
  form,
  disabled,
  onChange,
}: {
  form: Pick<EnemyForm, EnemyStat>;
  disabled: boolean;
  onChange: (patch: Partial<Pick<EnemyForm, EnemyStat>>) => void;
}) {
  const problems = ENEMY_STATS.flatMap((stat) => statError(stat, form[stat]) ?? []);
  return (
    <div className="space-y-1" data-testid="enemy-stats">
      <div className="flex flex-wrap items-end gap-3">
        {ENEMY_STATS.map((stat) => (
          <label key={stat} className="text-xs text-ink-muted">
            {STAT_LABELS[stat]}
            <Input
              aria-label={STAT_LABELS[stat]}
              className="w-28"
              inputMode="numeric"
              value={form[stat]}
              disabled={disabled}
              aria-invalid={statError(stat, form[stat]) !== null}
              onChange={(e) => onChange({ [stat]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {problems.map((problem) => (
        <p key={problem} className="text-xs text-danger" role="alert">
          {problem}
        </p>
      ))}
    </div>
  );
}

/**
 * Tags as chips: type one and press Enter or comma. What is typed is tidied
 * into lower_snake_case; something that cannot be a tag is refused with the
 * reason, not silently dropped.
 */
export function TagInput({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const result = tagFrom(text, value);
    if (result === null) return;
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onChange([...value, result.tag]);
    setText('');
    setError(null);
  };
  return (
    <div className="space-y-1 text-xs text-ink-muted" data-testid="enemy-tags">
      <span>Tags</span>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((tag) => (
          <Badge key={tag} variant="outline" data-testid="enemy-tag">
            {tag}
            {!disabled && (
              <button
                type="button"
                className="text-ink-subtle hover:text-danger"
                aria-label={`Remove tag ${tag}`}
                onClick={() => onChange(value.filter((t) => t !== tag))}
              >
                ×
              </button>
            )}
          </Badge>
        ))}
        {value.length === 0 && disabled && <span className="text-ink-subtle">No tags.</span>}
        {!disabled && (
          <Input
            aria-label="Add tag"
            className="w-44"
            placeholder="robotic, boss…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
            }}
            // A tag typed and tabbed away from is still meant.
            onBlur={commit}
          />
        )}
      </div>
      {error && (
        <p className="text-danger" role="alert" data-testid="enemy-tag-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Asked before an enemy that something still names is switched off. Disabling
 * keeps every reference; this says what each kind of reference does meanwhile.
 */
export function DisableEnemyDialog({
  open,
  name,
  usageCount,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  name: string;
  usageCount: number;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel disabling">
        <div
          className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="disable-enemy-confirm"
        >
          <DialogTitle className="text-base font-semibold">Disable {name}?</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            It is used in {usageCount} place{usageCount === 1 ? '' : 's'}. Those references are kept
            — nothing is removed from any dungeon or trial.
          </DialogDescription>
          <ul className="ml-4 list-disc space-y-1 text-sm text-ink-muted">
            <li>The dungeon generator stops drawing it from pools.</li>
            <li>Hand-placed rooms keep fighting it until someone changes them.</li>
            <li>Combat Trials that use it become unavailable.</li>
          </ul>
          <p className="text-xs text-ink-subtle">
            Runs already started keep the enemy they started with. Enable it again to undo this.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="accent" disabled={pending} onClick={onConfirm}>
              {pending ? 'Disabling…' : 'Disable enemy'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Keep it enabled
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
