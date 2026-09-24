// 运行监控（`/runs/:id`）：核心视图。
// 顶栏（run id/状态/SSE 连接态/取消）+ 左侧 ReactFlow 实时 DAG（dagre LR、
// NodeCard 状态着色、running 1s tick elapsed）+ 右侧 NodeDrawer（点节点打开）。
import { useMutation, useQuery } from '@tanstack/react-query';
import { Background, Controls, ReactFlow, type Edge } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import NodeDrawer from '../components/NodeDrawer';
import StatusBadge from '../components/StatusBadge';
import { layoutGraph } from '../lib/layout';
import { nodeTypes } from '../lib/nodeTypes';
import { emptyView, useRunStore } from '../store/runStore';
import { useRunEvents } from '../api/useRunEvents';

const TERMINAL = ['finished', 'failed', 'cancelled', 'interrupted'];

/** running 节点存在时每秒 tick（NodeCard 保持纯展示，elapsed 由这里算好传入）。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export default function RunMonitor() {
  const { id } = useParams<{ id: string }>();
  const runId = id ?? '';

  const runQuery = useQuery({ queryKey: ['run', runId], queryFn: () => api.getRun(runId) });
  const run = runQuery.data;
  const wfQuery = useQuery({
    queryKey: ['workflow', run?.workflow_id],
    queryFn: () => api.getWorkflow(run!.workflow_id),
    enabled: !!run,
    staleTime: 60_000,
  });
  const graph = wfQuery.data?.graph;

  const view = useRunStore((s) => s.view);
  const setRun = useRunStore((s) => s.setRun);
  const [selected, setSelected] = useState<string | null>(null);

  // 进入/切换 run：先清空旧视图（保证 SSE after=0 全量回放语义）
  useEffect(() => {
    useRunStore.getState().reset();
    setSelected(null);
  }, [runId]);

  // 工作流图就绪 → 初始化全 pending 视图（幂等：同 run 不重复重置）
  useEffect(() => {
    if (graph && useRunStore.getState().view?.runId !== runId) {
      setRun(emptyView(runId, graph.nodes.map((n) => n.id)));
    }
  }, [graph, runId, setRun]);

  // 视图初始化完成才开始订阅 SSE（避免旧视图的 lastSeq 造成跳过回放）
  const ready = view?.runId === runId;
  const { connected } = useRunEvents(ready ? runId : null);

  const anyRunning =
    !!view && Object.values(view.nodes).some((n) => n.status === 'running');
  const now = useNow(anyRunning);

  // 事件到达后状态优先取 store（live），首个事件前回退 run 行状态
  const status = view && view.lastSeq > 0 ? view.status : (run?.status ?? '…');
  const terminal = TERMINAL.includes(status);

  const [cancelError, setCancelError] = useState('');
  const cancelMut = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onError: (e) => setCancelError(e instanceof Error ? e.message : String(e)),
  });

  // --- React Flow 节点/边：布局稳定（graph 不变），数据随事件流更新 ---
  const rfNodes = useMemo(() => {
    if (!graph) return [];
    const pos = layoutGraph(graph.nodes, graph.edges);
    return graph.nodes.map((n) => {
      const nv = view?.nodes[n.id];
      const started = nv?.startedAt ? Date.parse(nv.startedAt) : NaN;
      return {
        id: n.id,
        type: 'agent' as const,
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: {
          id: n.id,
          agent: n.agent,
          status: nv?.status ?? 'pending',
          elapsedMs:
            nv?.status === 'running' && !Number.isNaN(started)
              ? Math.max(0, now - started)
              : undefined,
          lastToolTitle: nv?.lastToolTitle,
          error: nv?.error,
        },
      };
    });
  }, [graph, view, now]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      label: e.when,
      animated: view?.nodes[e.from]?.status === 'running',
    }));
  }, [graph, view]);

  if (runQuery.isError) {
    return (
      <div className="fs-page">
        <div className="fs-error-text">加载 run 失败：{String((runQuery.error as Error)?.message ?? runQuery.error)}</div>
        <Link className="fs-link" to="/">
          ← 返回运行列表
        </Link>
      </div>
    );
  }

  return (
    <div className="fs-monitor">
      <header className="fs-topbar">
        <Link className="fs-link" to="/">
          ← 运行
        </Link>
        <span className="fs-topbar__id" title={runId}>
          {runId}
        </span>
        {/* Task 7 授权的唯一样式外改动：给状态徽章加稳定 testid 供 e2e 断言 */}
        <span data-testid="run-status">
          <StatusBadge status={status} />
        </span>
        <span className={`fs-conn ${connected ? 'fs-conn--on' : 'fs-conn--off'}`}>
          ● {connected ? 'SSE 已连接' : 'SSE 重连中'}
        </span>
        <span className="fs-topbar__spacer" />
        {cancelError && <span className="fs-error-text">{cancelError}</span>}
        <button
          className="fs-btn fs-btn--danger"
          disabled={!ready || terminal || cancelMut.isPending}
          onClick={() => cancelMut.mutate()}
        >
          取消运行
        </button>
      </header>
      {ready && !connected && <div className="fs-banner">事件流连接断开，自动重连中…（已收事件不会丢失）</div>}
      <div className="fs-monitor__main">
        <div className="fs-canvas">
          {graph == null ? (
            <div className="fs-muted fs-canvas__loading">
              {wfQuery.isError
                ? `工作流图加载失败：${String((wfQuery.error as Error)?.message ?? wfQuery.error)}`
                : '加载工作流图…'}
            </div>
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelected(node.id)}
              fitView
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              minZoom={0.2}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {selected && (
          <NodeDrawer runId={runId} nodeId={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
