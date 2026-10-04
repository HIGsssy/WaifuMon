/**
 * A run graph, drawn as it is structured: one row per depth, a fork as cards
 * side by side. Read-only — the same view serves the preview page and the
 * editor's draft preview, for a generated dungeon and a room-by-room one
 * alike (they are the same graph by the time they get here).
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

/**
 * What this graph did with the zone's structural rules — regions it is open
 * in, where its rests and ways out fell, and whether the Rest → Boss guarantee
 * held. Computed by the server from the graph, not assumed from the zone, so a
 * guarantee the generator broke would show here as broken.
 */
function StructureSummary({
  structure,
  authored,
}: {
  structure: DungeonPreview['structure'];
  /** A room-by-room layout makes no generator guarantees to report on. */
  authored: boolean;
}) {
  const { restBeforeBoss } = structure;
  const depths = (nodes: Array<{ depth: number }>) =>
    nodes.length === 0 ? 'none' : nodes.map((n) => `depth ${n.depth}`).join(', ');
  return (
    <dl
      className="grid gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs sm:grid-cols-2"
      data-testid="dungeon-structure"
    >
      <div>
        <dt className="inline text-ink-muted">Available in: </dt>
        <dd className="inline text-ink" data-testid="structure-regions">
          {structure.availableRegions.length === 0
            ? 'no region'
            : structure.availableRegions.map((r) => r.name ?? `${r.id} (unknown)`).join(', ')}
        </dd>
      </div>
      <div>
        <dt className="inline text-ink-muted">Artwork: </dt>
        <dd className="inline font-mono text-ink">
          {structure.artworkPath ?? structure.backgroundArtworkPath ?? 'none'}
        </dd>
      </div>
      <div>
        <dt className="inline text-ink-muted">Rest nodes: </dt>
        <dd className="inline text-ink" data-testid="structure-rests">
          {structure.restNodes.length} ({depths(structure.restNodes)})
        </dd>
      </div>
      <div>
        <dt className="inline text-ink-muted">Extraction points: </dt>
        <dd className="inline text-ink" data-testid="structure-extraction">
          {structure.extractionNodes.length === 0
            ? 'none'
            : structure.extractionNodes
                .map((n) => `${NODE_TYPE_LABELS[n.type]} at depth ${n.depth}`)
                .join(', ')}
        </dd>
      </div>
      <div>
        <dt className="inline text-ink-muted">Final boss: </dt>
        <dd className="inline text-ink">{structure.bossNodeId ?? 'none — ends on an exit'}</dd>
      </div>
      <div className={authored ? 'hidden' : undefined}>
        <dt className="inline text-ink-muted">Rest before Boss: </dt>
        <dd
          className={cn(
            'inline',
            restBeforeBoss.required && !restBeforeBoss.satisfied ? 'text-danger' : 'text-ink',
          )}
          data-testid="structure-rest-before-boss"
        >
          {restBeforeBoss.required
            ? restBeforeBoss.satisfied
              ? 'guaranteed — satisfied'
              : 'guaranteed — NOT satisfied (this is a generator bug)'
            : restBeforeBoss.satisfied
              ? 'not required (this run happens to have one)'
              : 'not required'}
        </dd>
      </div>
    </dl>
  );
}

export function DungeonGraphView({ preview }: { preview: DungeonPreview }) {
  const { graph, names } = preview;
  const rows = nodesByDepth(graph.nodes);
  const branches = graph.nodes.filter((n) => n.outgoing.length > 1).length;
  const extractionPoints = graph.nodes.filter((n) => n.extraction).length;
  const authored = preview.layoutMode === 'authored';

  return (
    <div className="space-y-3" data-testid="dungeon-graph">
      <p className="text-xs text-ink-muted" data-testid="dungeon-graph-summary">
        {authored ? (
          'Room-by-room layout'
        ) : (
          <>
            Seed <span className="font-mono text-ink">{preview.seed}</span>
          </>
        )}{' '}
        · {graph.nodes.length} {authored ? 'rooms' : 'nodes'} · depth {graph.depthCount} ·{' '}
        {branches} branch{branches === 1 ? '' : 'es'} · {extractionPoints} extraction point
        {extractionPoints === 1 ? '' : 's'}
        {graph.attempts > 1 ? ` · took ${graph.attempts} attempts` : ''}
      </p>
      <StructureSummary structure={preview.structure} authored={authored} />
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
            <div
              className={cn(
                'grid flex-1 gap-2',
                row.length === 2 && 'grid-cols-2',
                row.length > 2 && 'grid-cols-3',
              )}
            >
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
                      {node.name && <span className="text-ink">{node.name}</span>}
                      {name && <span className="text-ink-muted">{name}</span>}
                      {node.boss && <Badge variant="danger">Boss</Badge>}
                      {node.extraction && <Badge variant="outline">Extraction</Badge>}
                      {row.length > 1 && (
                        <Badge variant="outline">
                          Branch {String.fromCharCode(65 + node.lane)}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-subtle">
                      {node.terminal ? 'End of the run' : `→ ${next.join(', ')}`}
                      {node.reward
                        ? ' · pays its own reward'
                        : node.rewardBandId
                          ? ` · pays band “${node.rewardBandId}”`
                          : ''}
                      {node.restHealBasisPoints !== undefined
                        ? ` · heals ${node.restHealBasisPoints / 100}%`
                        : ''}
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
