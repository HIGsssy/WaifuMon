/**
 * Components both Staging Test Controls pages share: the unmistakable banner,
 * the "not on this server" notice, and a confirmation dialog.
 */
import { FlaskConical, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The striped warning band across the top of every test-controls page. It is
 * meant to look nothing like ordinary player management.
 */
export function StagingBanner({ deploymentEnv }: { deploymentEnv?: string | undefined }) {
  return (
    <div
      role="note"
      data-testid="staging-banner"
      className="flex items-start gap-3 rounded-xl border-2 border-dashed border-warning bg-warning-soft px-4 py-3 text-sm text-ink"
      style={{
        backgroundImage:
          'repeating-linear-gradient(-45deg, transparent 0 14px, color-mix(in oklab, var(--color-warning) 10%, transparent) 14px 28px)',
      }}
    >
      <FlaskConical className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="font-semibold tracking-wide text-warning uppercase">
          Staging test controls
          {deploymentEnv ? (
            <span className="ml-2 font-mono normal-case">[{deploymentEnv}]</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-ink-muted">
          Debug tools for preparing test accounts, not player management. Changes are applied
          directly to the account and every action is recorded in the admin audit log.
        </p>
      </div>
    </div>
  );
}

export function DisabledNotice() {
  return (
    <Card data-testid="test-controls-disabled">
      <p className="text-sm text-ink">
        <strong className="font-medium">
          Staging Test Controls are not available on this server.
        </strong>{' '}
        They exist only on deployments started with{' '}
        <code className="rounded bg-surface-sunken px-1">ENABLE_TEST_ADMIN_CONTROLS=true</code> and
        a non-production <code className="rounded bg-surface-sunken px-1">DEPLOYMENT_ENV</code>.
      </p>
    </Card>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** What will happen, one line each. */
  details?: readonly ReactNode[];
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details = [],
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl sm:p-6">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className={destructive ? 'mt-0.5 size-5 text-danger' : 'mt-0.5 size-5 text-warning'}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-ink">{title}</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-ink-muted">
                {description}
              </DialogDescription>
            </div>
          </div>
          {details.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 pl-9 text-sm text-ink">
              {details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              variant={destructive ? 'danger' : 'accent'}
              disabled={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
