// dagre LR 布局：workflow 图（nodes/edges）→ React Flow 节点左上角坐标。
// dagre 给出的是节点中心点，React Flow 需要左上角，故减去宽高的一半。
import dagre from '@dagrejs/dagre';

export const NODE_W = 200;
export const NODE_H = 64;

export interface XY {
  x: number;
  y: number;
}

/** 计算各节点左上角坐标；边引用未知节点时忽略（防御半解析的 yaml 图）。 */
export function layoutGraph(
  nodes: { id: string }[],
  edges: { from: string; to: string }[],
): Map<string, XY> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  const out = new Map<string, XY>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) out.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return out;
}
