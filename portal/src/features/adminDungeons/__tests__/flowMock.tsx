/**
 * jsdom cannot lay out a canvas, so tests swap React Flow for buttons that
 * call the same callbacks the real canvas does. Use as
 * `vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow())`.
 */
import type { ReactNode } from 'react';

interface MockNode {
  id: string;
  selected?: boolean;
  position: { x: number; y: number };
  data: { name: string; onAddNext?: () => void };
}
interface MockEdge {
  id: string;
  source: string;
  target: string;
  label?: ReactNode;
}
export async function mockFlow() {
  const actual = await import('@xyflow/react');
  return {
    ...actual,
    ReactFlow: (props: {
      nodes: MockNode[];
      edges: MockEdge[];
      onConnect: (c: { source: string; target: string }) => void;
      onNodeClick: (e: null, n: { id: string }) => void;
      onEdgeClick: (e: null, edge: { id: string }) => void;
      onNodeDragStop: (e: null, n: { id: string; position: { x: number; y: number } }) => void;
      onMoveEnd: (e: MouseEvent, v: { x: number; y: number; zoom: number }) => void;
    }) => {
      const name = (id: string) => props.nodes.find((n) => n.id === id)?.data.name ?? id;
      return (
        <div data-testid="flow">
          <output data-testid="flow-nodes">{JSON.stringify(props.nodes)}</output>
          <output data-testid="flow-edges">{JSON.stringify(props.edges)}</output>
          {props.nodes.map((n) => (
            <span key={n.id}>
              <button aria-pressed={n.selected} onClick={() => props.onNodeClick(null, n)}>
                Canvas room {n.data.name}
              </button>
              {n.data.onAddNext && (
                <button onClick={n.data.onAddNext}>Add next room after {n.data.name}</button>
              )}
              {props.nodes
                .filter((other) => other.id !== n.id)
                .map((other) => (
                  <button
                    key={other.id}
                    onClick={() => props.onConnect({ source: n.id, target: other.id })}
                  >
                    Drag {n.data.name} to {other.data.name}
                  </button>
                ))}
            </span>
          ))}
          {props.edges.map((e) => (
            <button key={e.id} onClick={() => props.onEdgeClick(null, e)}>
              Canvas path {name(e.source)} to {name(e.target)}
            </button>
          ))}
          <button
            onClick={() =>
              props.onNodeDragStop(null, { id: props.nodes[0]!.id, position: { x: 300, y: 120 } })
            }
          >
            Drag room
          </button>
          <button
            onClick={() => props.onMoveEnd(new MouseEvent('move'), { x: 10, y: 20, zoom: 2 })}
          >
            Pan canvas
          </button>
        </div>
      );
    },
  };
}
