// 节点会话视图（M2c，/runs/:runId/sess/:nodeId）：全页回放/实时单个节点的对话流。
// 视觉对照 zcode-acp-demo/workflow-demo.html 的 #viewSession：顶栏 + nodeBanner
// （session/prompt）+ 860px 居中对话流（用户气泡 / 思考 details 折叠块 / 正文 /
// 工具卡 / stop chip）+ 底部协议事件抽屉。不搬 demo 的 composer（引擎单 turn 语义）。
// 数据与 RunMonitor 同一管线：getRun→workflow_id→getWorkflow 初始化 store
// （emptyView），SSE after=0 全量回放+实时；对话内容取 store NodeView，
// 本节点原始事件经 useRunEvents 的 onEvent 旁路收集供抽屉展示。
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FsEvent } from '../api/types';
import { useRunEvents } from '../api/useRunEvents';
import ProtocolDrawer from '../components/ProtocolDrawer';
import StatusBadge from '../components/StatusBadge';
import { emptyView, useRunStore, type NodeStatus } from '../store/runStore';

const TOOL_ICON: Record<string, string> = {
  edit: '✏️',
  execute: '⚙️',
  search: '🔍',
  other: '🔧',
};

/** 工具徽标文案：in_progress → running（demo 语义），其余原样。 */
const TOOL_BADGE: Record<string, string> = { in_progress: 'running' };

/** 终态 → stop chip 的 kind 文本（chip 在节点到达终态后展示）。 */
const STOP_KIND: Partial<Record<NodeStatus, string>> = {
  succeeded: 'node.finished',
  failed: 'node.failed',
  cancelled: 'node.cancelled',
  skipped: 'node.skipped',
};

export default function NodeSession({ runId, nodeId }: { runId: string; nodeId: string }) {
  const runQuery = useQuery({ queryKey: ['run', runId], queryFn: () => api.getRun(runId) });
  const run = runQuery.data;
  const wfQuery = useQuery({
    queryKey: ['workflow', run?.workflow_id],
    queryFn: () => api.getWorkflow(run!.workflow_id),
    enabled: !!run,
    staleTime: 60_000,
  });
  const graph = wfQuery.data?.graph;
  const graphNode = graph?.nodes.find((n) => n.id === nodeId);

  const view = useRunStore((s) => s.view);
  const setRun = useRunStore((s) => s.setRun);
  const node = view?.nodes[nodeId];
  const status: NodeStatus = node?.status ?? 'pending';

  // 本节点原始事件（抽屉数据源；store 只存聚合视图，保持干净）
  const [evs, setEvs] = useState<FsEvent[]>([]);

  // 进入/切换 run：清空旧视图与本地事件（保证 SSE after=0 全量回放语义）
  useEffect(() => {
    useRunStore.getState().reset();
    setEvs([]);
  }, [runId]);

  // 工作流图就绪 → 初始化全 pending 视图（幂等：同 run 不重复重置；镜像 RunMonitor）
  useEffect(() => {
    if (graph && useRunStore.getState().view?.runId !== runId) {
      setRun(emptyView(runId, graph.nodes.map((n) => n.id)));
    }
  }, [graph, runId, setRun]);

  // 视图初始化完成才开始订阅 SSE；旁路回调过滤出本节点事件供抽屉
  const ready = view?.runId === runId;
  const { connected } = useRunEvents(ready ? runId : null, (ev) => {
    if (ev.node_id === nodeId) setEvs((prev) => [...prev, ev]);
  });

  // 对话流自动跟随：贴底则随内容增长滚到底；用户上滚即暂停（近底恢复）
  const mainRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    if (followRef.current && mainRef.current) {
      mainRef.current.scrollTop = mainRef.current.scrollHeight;
    }
  }, [node?.message, node?.reasoning.length, node?.tools.length, node?.prompt]);

  if (runQuery.isError) {
    return (
      <div className="fs-page">
        <div className="fs-error-text">加载 run 失败：{String((runQuery.error as Error)?.message ?? runQuery.error)}</div>
        <Link className="fs-link" to={`/runs/${runId}`}>
          ← 返回监控
        </Link>
      </div>
    );
  }

  const stopKind = STOP_KIND[status];
  const failedReason = status === 'failed' ? node?.error : undefined;

  return (
    <div className="fs-sess">
      <header className="fs-topbar" data-testid="sess-topbar">
        <Link className="fs-link" to={`/runs/${runId}`}>
          ← 返回监控
        </Link>
        <span className="fs-topbar__id">节点会话</span>
        <span className="fs-muted">
          {graphNode?.agent ?? '…'} / {nodeId}
        </span>
        <StatusBadge status={status} />
        <span className={`fs-conn ${connected ? 'fs-conn--on' : 'fs-conn--off'}`} data-testid="sess-conn">
          ● {connected ? 'SSE 已连接' : 'SSE 重连中'}
        </span>
      </header>

      <div className="fs-sess__banner" data-testid="node-banner">
        <b>{nodeId}</b>
        <span className="fs-sess__banner-prompt" data-testid="node-banner-prompt">
          session/prompt: {node?.prompt ?? '等待事件…'}
        </span>
      </div>

      <main
        className="fs-sess__main"
        ref={mainRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        <div className="fs-sess__wrap">
          {node?.prompt != null && (
            <div className="fs-sess__user" data-testid="user-bubble">
              {node.prompt}
            </div>
          )}
          <div className="fs-sess__turn" data-testid="agent-turn">
            {node && node.reasoning.length > 0 && (
              // 运行中默认展开（流式可见），终态默认收起；React 仅在
              // running→终态跳变时改 open 属性，用户手动开合不被覆盖
              <details className="fs-sess__think" data-testid="think-block" open={status === 'running'}>
                <summary>思考过程（agent_thought_chunk）</summary>
                <div className="fs-sess__think-body">{node.reasoning.join('')}</div>
              </details>
            )}
            {node?.message && (
              <div className="fs-sess__content" data-testid="agent-message">
                {node.message}
              </div>
            )}
            {node?.tools.map((t) => (
              <div key={t.id} className={`fs-sess__tool fs-sess__tool--${t.status}`} data-testid="tool-card">
                <span className="fs-sess__tool-ico">{TOOL_ICON[t.kind ?? ''] ?? '🔧'}</span>
                <span className="fs-sess__tool-title">{t.title ?? t.id}</span>
                <span className="fs-sess__tool-badge">{TOOL_BADGE[t.status] ?? t.status}</span>
              </div>
            ))}
            {stopKind && (
              <span className="fs-sess__stop" data-testid="stop-chip">
                stopReason = {stopKind}
                {failedReason ? ` · ${failedReason}` : ''}
              </span>
            )}
            {!node && <div className="fs-muted">等待事件…</div>}
          </div>
        </div>
      </main>

      <ProtocolDrawer events={evs} />
    </div>
  );
}
