// 可编辑 DAG 画布（M2a）：agent 面板浮层 + ReactFlow 编辑画布。
// 文档事实源是 editorStore（model），positions 为并行视图态：
//   - 节点坐标 = positions[id] ?? dagre 布局兜底 ?? (0,0)；布局仅对无存储
//     坐标的节点重算（useMemo 按 model/positions 引用记忆化）；
//   - 连线/删除/拖拽/选中全部回写 store，删除键 Backspace/Delete。
// RF12 受控模式（传 nodes 而非 defaultNodes）下 change 不会自动落地，故用
// useNodesState/useEdgesState 本地镜像承接拖拽/选中的瞬态，store 变更时
// （derived 引用变化）再整体同步回来；拖拽结束才批量写 store.positions。
// ReactFlow 须在 <ReactFlowProvider> 内取 useReactFlow 实例：onDrop 的
// screenToFlowPosition 接 clientX/clientY（RF12 内部自扣容器 bounds）。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
} from '@xyflow/react';
import Palette from './Palette';
import { layoutGraph } from '../lib/layout';
import { nodeTypes } from '../lib/nodeTypes';
import { useEditorStore } from '../store/editorStore';

/** 内层画布：必须位于 <ReactFlowProvider> 内（useReactFlow 从 Provider 取实例）。 */
function EditCanvas() {
  const model = useEditorStore((s) => s.model);
  const positions = useEditorStore((s) => s.positions);
  const addNode = useEditorStore((s) => s.addNode);
  const connect = useEditorStore((s) => s.connect);
  const removeNode = useEditorStore((s) => s.removeNode);
  const removeEdge = useEditorStore((s) => s.removeEdge);
  const setPositions = useEditorStore((s) => s.setPositions);
  const setSelection = useEditorStore((s) => s.setSelection);

  const { screenToFlowPosition } = useReactFlow();

  // --- 落场动画（save-ux）：观测 model.nodes 的增量变化，新增节点短暂挂
  // fs-node--pop（RF 节点包裹层 className）→ 内层 .fs-node 播放 fs-pop 弹入。
  // 仅「纯增量」变化才弹（prev 非空且无删除）：初次装载 / loadYaml 整体
  // 重置（换文档、refetch 重载）不弹；撤销删除后 redo 恢复节点视为新增会弹。
  const [popId, setPopId] = useState<string | null>(null);
  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(model ? model.nodes.map((n) => n.id) : []);
    const prev = knownIdsRef.current;
    knownIdsRef.current = ids;
    if (prev == null || prev.size === 0) return; // 初次观测 / 空画布 → 装载不弹
    let additive = true;
    for (const id of prev) if (!ids.has(id)) additive = false;
    if (!additive) return; // 整体重置（loadYaml 换文档）不弹
    for (const id of ids) {
      if (!prev.has(id)) {
        setPopId(id);
        break;
      }
    }
  }, [model]);
  useEffect(() => {
    if (popId == null) return;
    const t = window.setTimeout(() => setPopId(null), 750);
    return () => window.clearTimeout(t);
  }, [popId]);

  // 布局兜底：仅当存在无存储坐标的节点时才跑 dagre（model/positions 引用不变则跳过）
  const layout = useMemo(() => {
    if (!model || model.nodes.every((n) => positions[n.id] != null)) return null;
    return layoutGraph(model.nodes, model.edges);
  }, [model, positions]);

  const derivedNodes = useMemo(() => {
    if (!model) return [];
    return model.nodes.map((n) => ({
      id: n.id,
      type: 'agent' as const,
      position: positions[n.id] ?? layout?.get(n.id) ?? { x: 0, y: 0 },
      data: { id: n.id, agent: n.agent, status: 'pending' as const },
      className: n.id === popId ? 'fs-node--pop' : undefined,
    }));
  }, [model, positions, layout, popId]);

  const derivedEdges: Edge[] = useMemo(() => {
    if (!model) return [];
    return model.edges.map((e) => ({
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      label: e.when,
      className: e.when ? 'fs-edge--cond' : undefined,
    }));
  }, [model]);

  // 本地镜像承接瞬态（拖拽中坐标/选中态）；store 变更后整体同步
  const [nodes, setNodes, onNodesChange] = useNodesState(derivedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(derivedEdges);
  useEffect(() => setNodes(derivedNodes), [derivedNodes, setNodes]);
  useEffect(() => setEdges(derivedEdges), [derivedEdges, setEdges]);

  if (!model) {
    return <div className="fs-muted fs-canvas__loading">未加载工作流</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onConnect={(c) => {
        if (c.source && c.target) connect(c.source, c.target);
      }}
      onNodesDelete={(deleted) => {
        for (const n of deleted) removeNode(n.id);
      }}
      onEdgesDelete={(deleted) => {
        // edge.id 约定 `${from}->${to}`，解析回 from/to（to 含 '->' 也不误切）
        for (const e of deleted) {
          const sep = e.id.indexOf('->');
          if (sep < 0) continue;
          removeEdge(e.id.slice(0, sep), e.id.slice(sep + 2));
        }
      }}
      onNodeDragStop={(_, node, dragged) => {
        // 批量合并为一次 setPositions（不进 history、不动 dirty）
        const next = { ...useEditorStore.getState().positions };
        for (const n of dragged?.length ? dragged : [node]) next[n.id] = n.position;
        setPositions(next);
      }}
      onNodeClick={(_, node) => setSelection({ type: 'node', id: node.id })}
      onEdgeClick={(_, edge) => setSelection({ type: 'edge', id: edge.id })}
      onPaneClick={() => setSelection(null)}
      onDrop={(event) => {
        event.preventDefault();
        const key =
          event.dataTransfer.getData('application/flowscope-agent') ||
          event.dataTransfer.getData('text/plain');
        if (!key) return;
        addNode(key, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
      onDragOver={(event) => event.preventDefault()}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      deleteKeyCode={['Backspace', 'Delete']}
      minZoom={0.2}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function EditableCanvas() {
  return (
    <div className="fs-editwrap">
      <Palette />
      <div className="fs-canvas fs-canvas--edit">
        <ReactFlowProvider>
          <EditCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
