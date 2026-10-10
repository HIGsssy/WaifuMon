import type * as api from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
export function Section({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      <div>
        <h2 className="text-sm font-semibold uppercase text-ink-muted">{title}</h2>
        {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

export function DungeonIssues({ issues }: { issues: api.DungeonIssue[] }) {
  return (
    <ul className="space-y-1" aria-label="Validation issues">
      {issues.map((i, n) => (
        <li
          key={n}
          role={i.severity === 'error' ? 'alert' : undefined}
          className={i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
        >
          {i.severity}: {i.path || 'definition'} — {i.message} ({i.code})
        </li>
      ))}
    </ul>
  );
}
export function errorIssues(error: unknown): api.DungeonIssue[] {
  if (!isPortalApiError(error) || !Array.isArray(error.details?.issues)) return [];
  return error.details.issues.filter(
    (i): i is api.DungeonIssue =>
      typeof i === 'object' &&
      i !== null &&
      typeof i.message === 'string' &&
      typeof i.path === 'string' &&
      typeof i.code === 'string' &&
      (i.severity === 'error' || i.severity === 'warning'),
  );
}
