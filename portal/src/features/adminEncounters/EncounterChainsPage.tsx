/**
 * World Encounters — Chains.
 *
 * Every chain drawn as a tree, root first:
 *
 *   A Strange Door
 *   └ Open it
 *      ├ On success → Security Override
 *      │  └ Hack terminal → Hidden Laboratory
 *      └ On failure → Alarm Triggered
 *
 * Read-only and navigational: every encounter links to its editor. Problems
 * the graph can see — chain-only encounters nothing reaches, links to missing
 * or inactive encounters, loops, follow-ups that never run, children that also
 * appear on their own — are listed at the top and marked in the tree.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import {
  BRANCH_LABEL,
  buildChainTree,
  buildEncounterGraph,
  chainRoots,
  type ChainBranch,
  type ChainNode,
  type EncounterGraph,
} from './encounterGraph';
import { useEncounterList } from './useAuthoringData';

const DEAD_REASON: Record<string, string> = {
  shadowed: 'never used — an earlier follow-up wins',
  failure_never_runs: 'never used — automatic choices always succeed',
  self: 'links to itself — skipped',
};

function slugsIn(node: ChainNode, out = new Set<string>()): Set<string> {
  out.add(node.slug);
  for (const c of node.choices) for (const b of c.branches) slugsIn(b.node, out);
  if (node.afterAny) slugsIn(node.afterAny.node, out);
  return out;
}

function NodeLabel({
  node,
  graph,
  focus,
}: {
  node: ChainNode;
  graph: EncounterGraph;
  focus: string | null;
}) {
  const e = node.encounter;
  if (!e) {
    return (
      <span className="text-danger" data-testid="chain-missing">
        “{node.slug}” — missing
      </span>
    );
  }
  const role = graph.roleOf(node.slug);
  const issues = graph.issuesFor(node.slug).filter((i) => i.code !== 'cycle');
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-1.5',
        focus === node.slug && 'rounded bg-accent/15 px-1',
      )}
    >
      {e.id != null ? (
        <Link to={`/admin/encounters/${e.id}`} className="font-medium text-ink hover:underline">
          {e.name}
        </Link>
      ) : (
        <span className="font-medium">{e.name}</span>
      )}
      {e.lifecycle !== 'active' && <Badge variant="outline">{e.lifecycle}</Badge>}
      <Badge variant="outline">
        {role.spawns
          ? [e.huntEligible && 'Hunt', e.travelEligible && 'Travel'].filter(Boolean).join(' + ')
          : 'chain-only'}
      </Badge>
      {node.repeat && <span className="text-xs text-ink-muted">↻ shown above (loop)</span>}
      {!node.repeat && issues.length > 0 && (
        <span className="text-xs text-amber-500" title={issues.map((i) => i.message).join('\n')}>
          ⚠ {issues.length}
        </span>
      )}
    </span>
  );
}

function Branch({
  branch,
  graph,
  focus,
}: {
  branch: ChainBranch;
  graph: EncounterGraph;
  focus: string | null;
}) {
  const { link, node } = branch;
  return (
    <li className={cn('pl-4', !link.live && 'opacity-60')} data-testid="chain-branch">
      <span className="text-xs text-ink-muted">
        {link.branch === 'outcome' ? '→' : `${BRANCH_LABEL[link.branch]} →`}
      </span>{' '}
      <NodeLabel node={node} graph={graph} focus={focus} />
      {!link.live && link.deadReason && (
        <span className="ml-1 text-xs text-ink-muted">({DEAD_REASON[link.deadReason]})</span>
      )}
      {!node.repeat && <ChainChildren node={node} graph={graph} focus={focus} />}
    </li>
  );
}

function ChainChildren({
  node,
  graph,
  focus,
}: {
  node: ChainNode;
  graph: EncounterGraph;
  focus: string | null;
}) {
  if (node.choices.length === 0 && !node.afterAny) return null;
  return (
    <ul className="mt-1 space-y-1 border-l border-border pl-3">
      {node.choices.map((c) => (
        <li key={c.index}>
          <span className="text-sm">
            “{c.label}”
            {c.auto ? '' : <span className="text-xs text-ink-muted"> · skill check</span>}
          </span>
          <ul className="space-y-1">
            {c.branches.map((b, i) => (
              <Branch key={i} branch={b} graph={graph} focus={focus} />
            ))}
          </ul>
        </li>
      ))}
      {node.afterAny && (
        <li>
          <ul>
            <Branch branch={node.afterAny} graph={graph} focus={focus} />
          </ul>
        </li>
      )}
    </ul>
  );
}

export function EncounterChainsPage() {
  const query = useEncounterList();
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  const [q, setQ] = useState('');

  const graph = useMemo(() => buildEncounterGraph(query.data?.encounters ?? []), [query.data]);
  const trees = useMemo(
    () => chainRoots(graph).map((slug) => buildChainTree(graph, slug)),
    [graph],
  );
  const visible = trees.filter((tree) => {
    const slugs = slugsIn(tree);
    if (focus && !slugs.has(focus)) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [...slugs].some((s) =>
      `${s} ${graph.encounters.get(s)?.name ?? ''}`.toLowerCase().includes(needle),
    );
  });
  const issues = [...graph.issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1,
  );
  const focusName = focus ? (graph.encounters.get(focus)?.name ?? focus) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Encounter Chains"
        description="How encounters lead into one another. Click any encounter to edit it."
      />
      {query.isPending && <Skeleton className="h-40 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load encounters"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <>
          {issues.length > 0 && (
            <Card className="space-y-2 p-4" data-testid="chain-issues">
              <h2 className="text-sm font-semibold uppercase text-ink-muted">
                Chain problems ({issues.length})
              </h2>
              <ul className="space-y-1 text-sm">
                {issues.map((issue, i) => {
                  const e = graph.encounters.get(issue.slug);
                  return (
                    <li key={i} className={issue.severity === 'error' ? 'text-danger' : 'text-ink'}>
                      {issue.severity === 'error' ? '✖' : '⚠'} {issue.message}{' '}
                      {e?.id != null && (
                        <Link
                          to={`/admin/encounters/${e.id}`}
                          className="text-xs text-accent underline"
                        >
                          Edit
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                aria-label="Search chains"
                placeholder="Find a chain by encounter name"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="max-w-sm"
              />
              {focus && (
                <span className="text-sm text-ink-muted">
                  Showing chains through <strong>{focusName}</strong> ·{' '}
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => setParams({})}
                  >
                    Show all
                  </button>
                </span>
              )}
            </div>
            {visible.length === 0 ? (
              <p className="text-sm text-ink-muted" data-testid="no-chains">
                {trees.length === 0
                  ? 'No encounter continues to another yet. Add a follow-up to a choice to start a chain.'
                  : 'No chains match.'}
              </p>
            ) : (
              <ul className="space-y-4">
                {visible.map((tree) => (
                  <li
                    key={tree.slug}
                    className="overflow-x-auto rounded-md border border-border p-3"
                    data-testid="chain-tree"
                  >
                    <NodeLabel node={tree} graph={graph} focus={focus} />
                    <ChainChildren node={tree} graph={graph} focus={focus} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
