/**
 * Small pieces the Boss Management pages share: the section tabs, the
 * lifecycle badge, the artwork thumbnail and the issue list.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { BossIssue, BossStatus } from '@/api/adminBosses';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import {
  BOSSES_PATH,
  BOSS_ACTIVITY_PATH,
  STATUS_LABELS,
  bossArtworkSource,
  loadBossArtwork,
} from './bossModel';

/** The two halves of Boss Management: what bosses are, and what they are doing. */
export function BossTabs({ current }: { current: 'bosses' | 'activity' }) {
  const tabs = [
    { id: 'bosses', label: 'Bosses', to: BOSSES_PATH },
    { id: 'activity', label: 'Activity', to: BOSS_ACTIVITY_PATH },
  ] as const;
  return (
    <nav className="flex gap-2" aria-label="Boss Management sections">
      {tabs.map((tab) => (
        <Button key={tab.id} asChild size="sm" variant={tab.id === current ? 'default' : 'ghost'}>
          <Link to={tab.to} {...(tab.id === current ? { 'aria-current': 'page' as const } : {})}>
            {tab.label}
          </Link>
        </Button>
      ))}
    </nav>
  );
}

/** Draft, Active or Disabled. Only an Active boss can spawn. */
export function BossStatusBadge({ status }: { status: BossStatus }) {
  const variant = status === 'active' ? 'default' : status === 'disabled' ? 'danger' : 'outline';
  return (
    <Badge variant={variant} data-testid="boss-status">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** A small picture of a boss's artwork (uploaded, else shipped), or "No art". */
export function BossThumb({
  path,
  assetId,
  label,
  testId,
}: {
  path: string | null;
  assetId?: string | null;
  label: string;
  testId: string;
}) {
  return (
    <AuthoredArtwork
      source={bossArtworkSource({ artwork: path, artworkAssetId: assetId })}
      load={loadBossArtwork}
      className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-sunken text-[10px] text-ink-subtle"
      testIdPrefix={testId}
      emptyLabel="No art"
      missingLabel={() => 'Missing'}
      alt={() => label}
    />
  );
}

export function BossIssues({ issues, testId }: { issues: BossIssue[]; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid={testId ?? 'boss-issues'}>
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

/** One titled card of an editor or of the Activity page. */
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
