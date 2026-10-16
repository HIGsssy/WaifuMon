/**
 * Region Pools — small presentational pieces shared by the list, the editor,
 * the review dialogs and history.
 *
 * Artwork uses the shared `ArtworkThumbnail` over the Region Pools species
 * artwork route, so `regions.read` (which every page here already requires)
 * is enough. The Portal never turns `imagePath` into a URL; missing or refused
 * artwork shows the thumbnail's "Preview unavailable" placeholder.
 */
import { AlertTriangle, CircleAlert } from 'lucide-react';

import {
  regionSpeciesArtworkBlob,
  type RegionPoolDiff,
  type RegionPoolIssue,
  type RegionPoolStaleDetails,
  type RegionRef,
} from '@/api/adminRegionPools';
import { ArtworkThumbnail } from '@/components/media/ArtworkThumbnail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { formatWhen, type SpeciesFacts } from './regionPoolModel';

export function RegionSpeciesThumb({ slug, name }: { slug: string; name: string }) {
  return (
    <div className="w-12 shrink-0 sm:w-14" data-testid={`region-species-${slug}-thumbnail`}>
      <ArtworkThumbnail path={slug} load={regionSpeciesArtworkBlob} alt={name} />
    </div>
  );
}

/** Region-exclusive, disabled, not in content, dungeon-exclusive, EX: in words, never colour alone. */
export function SpeciesFlags({ facts }: { facts: SpeciesFacts | undefined }) {
  if (!facts || facts.name === null) return <Badge variant="danger">Unknown species</Badge>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {facts.regionExclusive && <Badge variant="outline">Region-exclusive</Badge>}
      {facts.dungeonExclusive && <Badge variant="danger">Dungeon-exclusive</Badge>}
      {!facts.inContent ? (
        <Badge variant="danger">Not in content</Badge>
      ) : facts.enabled ? (
        <Badge variant="solid">Enabled</Badge>
      ) : (
        <Badge variant="danger">Disabled</Badge>
      )}
      {facts.rarity === 'EX' && <Badge variant="outline">Not huntable</Badge>}
    </span>
  );
}

export function ReleaseBadge({ region }: { region: RegionRef }) {
  return region.released ? (
    <Badge variant="solid">Released</Badge>
  ) : (
    <Badge variant="outline">Unreleased</Badge>
  );
}

/** Server issues, in the server's words, with the regions involved named. */
export function IssueList({
  issues,
  regionNames,
  label = 'Validation issues',
  testId,
}: {
  issues: readonly RegionPoolIssue[];
  regionNames?: ReadonlyMap<string, RegionRef>;
  label?: string;
  testId?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label={label} data-testid={testId}>
      {issues.map((i) => (
        <li
          key={i.id}
          className={`flex gap-1.5 text-xs ${i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}`}
          data-issue-id={i.id}
        >
          {i.severity === 'error' ? (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 break-words">
            <span className="sr-only">{i.severity === 'error' ? 'Error: ' : 'Warning: '}</span>
            {i.message}
            {i.code === 'region_exclusive_conflict' && i.regions && regionNames && (
              <ConflictRegions regions={i.regions} regionNames={regionNames} />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Who the conflict is with, and whether that region is released. The release
 * state is shown for information only: the server decides whether the conflict
 * blocks, and today it blocks either way.
 */
function ConflictRegions({
  regions,
  regionNames,
}: {
  regions: readonly string[];
  regionNames: ReadonlyMap<string, RegionRef>;
}) {
  return (
    <span className="block text-ink-subtle" data-testid="exclusive-conflict-regions">
      Conflicts with:{' '}
      {regions
        .map((id) => {
          const r = regionNames.get(id);
          return r ? `${r.name} (${r.released ? 'released' : 'unreleased'})` : id;
        })
        .join(', ')}
      .
    </span>
  );
}

/** 409 REGION_POOL_STALE: someone else saved, published or rolled back first. */
export function StaleDraftBanner({
  details,
  onReload,
}: {
  details: RegionPoolStaleDetails;
  onReload: () => void;
}) {
  return (
    <Card
      className="space-y-2 border-danger/40 p-4 text-sm"
      role="alert"
      data-testid="stale-banner"
    >
      <p className="font-medium text-danger">Another administrator changed this draft.</p>
      <p className="text-ink-muted">
        You were editing draft revision {details.expectedDraftRevision ?? '?'}; it is now at
        revision {details.currentDraftRevision ?? '?'}
        {details.updatedBy ? `, saved by ${details.updatedBy}` : ''}
        {details.updatedAt ? ` on ${formatWhen(details.updatedAt)}` : ''}. Nothing you did was
        saved. Reload to see their version — your unsaved edits on this page will be discarded.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>
        Reload latest draft
      </Button>
    </Card>
  );
}

/** Added / removed / reweighted, with names where known. */
export function DiffList({
  diff,
  nameOf,
  testId,
  empty = 'No species changes.',
}: {
  diff: RegionPoolDiff;
  nameOf: (slug: string) => string;
  testId: string;
  empty?: string;
}) {
  const none = diff.added.length + diff.removed.length + diff.reweighted.length === 0;
  return (
    <div className="space-y-1 text-sm" data-testid={testId}>
      {none && <p className="text-ink-muted">{empty}</p>}
      {diff.added.length > 0 && (
        <p>
          <span className="font-medium">Added ({diff.added.length}):</span>{' '}
          {diff.added.map((e) => `${nameOf(e.species)} (weight ${e.weight})`).join(', ')}
        </p>
      )}
      {diff.removed.length > 0 && (
        <p>
          <span className="font-medium">Removed ({diff.removed.length}):</span>{' '}
          {diff.removed.map((e) => nameOf(e.species)).join(', ')}
        </p>
      )}
      {diff.reweighted.length > 0 && (
        <p>
          <span className="font-medium">Weight changes ({diff.reweighted.length}):</span>{' '}
          {diff.reweighted.map((e) => `${nameOf(e.species)} ${e.from} → ${e.to}`).join(', ')}
        </p>
      )}
    </div>
  );
}
