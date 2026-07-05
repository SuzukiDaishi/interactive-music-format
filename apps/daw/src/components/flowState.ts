import { useEffect, useState } from 'react';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';

/**
 * React Flow state for graphs derived from the project model.
 *
 * RF must receive its own change events back (applyNodeChanges) or nodes stay
 * `visibility: hidden` forever — it hides nodes until their measured size is
 * committed. Re-deriving from the store keeps the model authoritative while
 * measurement/selection state survives via the previous local state.
 */
export function useDerivedFlow(
  derive: () => { nodes: RFNode[]; edges: RFEdge[] },
  deps: unknown[],
): {
  nodes: RFNode[];
  edges: RFEdge[];
  applyNodes: (changes: NodeChange[]) => void;
  applyEdges: (changes: EdgeChange[]) => void;
} {
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);

  useEffect(() => {
    const d = derive();
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return d.nodes.map((n) => {
        const old = byId.get(n.id);
        return old
          ? { ...n, measured: old.measured, selected: old.selected, dragging: old.dragging }
          : n;
      });
    });
    setEdges((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      return d.edges.map((e) => {
        const old = byId.get(e.id);
        return old ? { ...e, selected: old.selected } : e;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    nodes,
    edges,
    applyNodes: (changes) => setNodes((ns) => applyNodeChanges(changes, ns)),
    applyEdges: (changes) => setEdges((es) => applyEdgeChanges(changes, es)),
  };
}
