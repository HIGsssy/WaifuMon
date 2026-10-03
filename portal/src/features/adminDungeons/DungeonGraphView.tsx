/**
 * A generated dungeon, drawn as it is structured: one row per depth, a fork as
 * two cards side by side. Read-only — the same view serves the preview page
 * and the zone editor's draft preview.
 */
import type { DungeonGraph, DungeonGraphNode, DungeonPreview } from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { NODE_TYPE_LABELS, nodesByDepth } from './dungeonModel';

function contentName(node: DungeonGraphNode, names: DungeonPreview['names']): string | null {
  if (!node.content) return null;
  const lookup = node.content.kind === 'enemy' ? names.enemies : names.events;
  return lookup[node.content.key] ?? node.content.key;
}

/** `→ n4, n5` — where a node leads, by node id. */
function leadsTo(node: DungeonGraphNode, graph: DungeonGraph): string[] {
  return node.outgoing.flatMap((edgeId) => {
    const edge = graph.edges.find((e) => e.id === edgeId);
    return edge ? [edge.to] : [];
  });
}

export function DungeonGraphView({ preview }: { preview: DungeonPreview }) {
  const { graph, names } = preview;
  const rows = nodesByDepth(graph.nodes);
  const branches = graph.nodes.filter((n) => n.outgoing.length > 1).length;
  const extractionPoints = graph.nodes.filter((n) => n.extraction).length;

  return (
    <div className="space-y-3" data-testid="dungeon-graph">
      <p className="text-xs text-ink-muted" data-testid="dungeon-graph-summary">
        Seed <span className="font-mono text-ink">{preview.seed}</span> · {graph.nodes.length} nodes
        · depth {graph.depthCount} · {branches} branch{branches === 1 ? '' : 'es'} ·{' '}
        {extractionPoints} extraction point
        {extractionPoints === 1 ? '' : 's'}
        {graph.attempts > 1 ? ` · took ${graph.attempts} attempts` : ''}
      </p>
      <ol className="space-y-2">
        {rows.map((row) => (
          <li
            key={row[0]!.depth}
            className="flex items-stretch gap-2"
            data-testid="dungeon-depth-row"
          >
            <span className="w-16 shrink-0 pt-2 text-xs text-ink-subtle">
              Depth {row[0]!.depth}
            </span>
            <div className={cn('grid flex-1 gap-2', row.length > 1 && 'grid-cols-2')}>
              {row.map((node) => {
                const name = contentName(node, names);
                const next = leadsTo(node, graph);
                return (
                  <div
                    key={node.id}
                    data-testid="dungeon-node"
                    data-node-type={node.type}
                    className={cn(
                      'rounded-lg border border-border bg-surface px-3 py-2 text-sm',
                      node.boss && 'border-danger/50',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-ink-subtle">{node.id}</span>
                      <span className="font-medium text-ink">{NODE_TYPE_LABELS[node.type]}</span>
                      {name && <span className="text-ink-muted">{name}</span>}
                      {node.boss && <Badge variant="danger">Boss</Badge>}
                      {node.extraction && <Badge variant="outline">Extraction</Badge>}
                      {row.length > 1 && (
                        <Badge variant="outline">Branch {node.lane === 0 ? 'A' : 'B'}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-subtle">
                      {node.terminal ? 'End of the run' : `→ ${next.join(', ')}`}
                      {node.rewardBandId ? ` · pays band “${node.rewardBandId}”` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
