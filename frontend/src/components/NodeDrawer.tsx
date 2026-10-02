// 右侧节点抽屉（360px，五 tab）：消息/工具/Plan/日志/输入输出。
// 数据从 zustand store 按 nodeId 选择；output artifact 成功后经 react-query 拉取。
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useRunStore } from '../store/runStore';
import LogList from './LogList';

type TabKey = 'msg' | 'tools' | 'plan' | 'logs' | 'io';

const TABS: { key: TabKey; label: string; testid: string }[] = [
  { key: 'msg', label: '消息', testid: 'drawer-message' },
  { key: 'tools', label: '工具', testid: 'drawer-tools' },
  { key: 'plan', label: 'Plan', testid: 'drawer-plan' },
  { key: 'logs', label: '日志', testid: 'drawer-logs' },
  { key: 'io', label: '输入输出', testid: 'drawer-io' },
];

const TOOL_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  error: '✗',
};

/** plan entry.status 与四态图标（非 completed/in_progress 一律 pending ○）。 */
function planIcon(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '◐';
  return '○';
}

export default function NodeDrawer({
  runId,
  nodeId,
  onClose,
}: {
  runId: string;
  nodeId: string;
  onClose: () => void;
}) {
  const node = useRunStore((s) => s.view?.nodes[nodeId]);
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('msg');

  if (!node) {
    return (
      <aside className="fs-drawer" data-testid="drawer">
        <div className="fs-drawer__head">
          <span className="fs-drawer__title">{nodeId}</span>
          <button className="fs-btn fs-btn--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="fs-drawer__empty">暂无该节点数据</div>
      </aside>
    );
  }

  return (
    <aside className="fs-drawer" data-testid="drawer">
      <div className="fs-drawer__head">
        <span className="fs-drawer__title">{nodeId}</span>
        <div className="fs-drawer__headbtns">
          {/* M2c 入口：跳全页节点会话视图（回放+实时统一） */}
          <button
            className="fs-btn"
            data-testid="drawer-open-session"
            onClick={() => navigate(`/runs/${runId}/sess/${nodeId}`)}
          >
            会话视图
          </button>
          <button className="fs-btn fs-btn--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <div className="fs-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`fs-tab ${tab === t.key ? 'fs-tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="fs-drawer__body">
        {tab === 'msg' && <MessageTab nodeId={nodeId} />}
        {tab === 'tools' && <ToolsTab nodeId={nodeId} />}
        {tab === 'plan' && <PlanTab nodeId={nodeId} />}
        {tab === 'logs' && <LogsTab nodeId={nodeId} />}
        {tab === 'io' && <IoTab runId={runId} nodeId={nodeId} succeeded={node.status === 'succeeded'} />}
      </div>
    </aside>
  );
}

// --- 各 tab：均从 store 按 nodeId 取最新数据（事件驱动即时刷新） ---

function MessageTab({ nodeId }: { nodeId: string }) {
  const node = useRunStore((s) => s.view?.nodes[nodeId])!;
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  // 自动跟随：贴底则随消息增长滚到底；用户上滚即暂停（onScroll 判定近底恢复）
  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [follow, node.message, node.reasoning.length]);

  return (
    <div data-testid="drawer-message">
      {node.reasoning.length > 0 && (
        <div className="fs-reasoning">
          {node.reasoning.map((r, i) => (
            <details key={i} className="fs-reasoning__block">
              <summary>思考 {i + 1}</summary>
              <p>{r}</p>
            </details>
          ))}
        </div>
      )}
      <div
        ref={boxRef}
        className="fs-msg"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {node.message || <span className="fs-muted">（暂无消息）</span>}
      </div>
      {!follow && <div className="fs-follow-pause">已暂停自动滚动，滚到底部恢复</div>}
    </div>
  );
}

function ToolsTab({ nodeId }: { nodeId: string }) {
  const node = useRunStore((s) => s.view?.nodes[nodeId])!;
  return (
    <div data-testid="drawer-tools" className="fs-tools">
      {node.tools.length === 0 && <Empty>暂无工具调用</Empty>}
      {node.tools.map((t) => (
        <div key={t.id} className="fs-tool-row">
          <span className={`fs-tool-icon fs-tool-icon--${t.status}`}>{TOOL_ICON[t.status] ?? '○'}</span>
          <span className="fs-tool-title">{t.title ?? t.id}</span>
          {t.kind && <span className="fs-tool-kind">{t.kind}</span>}
        </div>
      ))}
    </div>
  );
}

function PlanTab({ nodeId }: { nodeId: string }) {
  const node = useRunStore((s) => s.view?.nodes[nodeId])!;
  const entries = node.plan?.entries ?? [];
  return (
    <div data-testid="drawer-plan" className="fs-plan">
      {entries.length === 0 && <Empty>暂无 Plan 快照</Empty>}
      {entries.map((e, i) => (
        // 契约：plan entry 无 id（扁平快照），以 content+序号作 key
        <div key={`${i}:${e.content}`} className="fs-plan-row">
          <span className={`fs-plan-icon fs-plan-icon--${e.status}`}>{planIcon(e.status)}</span>
          <span className="fs-plan-content">{e.content}</span>
          {e.priority && <span className="fs-plan-priority">{e.priority}</span>}
        </div>
      ))}
    </div>
  );
}

function LogsTab({ nodeId }: { nodeId: string }) {
  const node = useRunStore((s) => s.view?.nodes[nodeId])!;
  return (
    <div data-testid="drawer-logs">
      {node.logs.length === 0 ? <Empty>暂无日志</Empty> : <LogList logs={node.logs} height={480} />}
    </div>
  );
}

function IoTab({ runId, nodeId, succeeded }: { runId: string; nodeId: string; succeeded: boolean }) {
  const artifact = useQuery({
    queryKey: ['artifact', runId, nodeId, 'output'],
    queryFn: () => api.getArtifact(runId, nodeId, 'output'),
    enabled: succeeded,
    retry: false,
  });

  let outputView: ReactNode;
  if (!succeeded) {
    outputView = <Empty>节点完成后可查看 output 产物</Empty>;
  } else if (artifact.isPending) {
    outputView = <span className="fs-muted">加载 output 产物…</span>;
  } else if (artifact.isError) {
    outputView = <span className="fs-error-text">产物加载失败：{String(artifact.error?.message ?? artifact.error)}</span>;
  } else {
    // 尽量美化 JSON；非 JSON 原样展示
    let text = artifact.data;
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 非 JSON 文本，保持原样 */
    }
    outputView = (
      <pre className="fs-io-pre">
        <code>{text}</code>
      </pre>
    );
  }

  return (
    <div data-testid="drawer-io" className="fs-io">
      <section>
        <h4>输入（渲染后 prompt）</h4>
        {/* 后端缺口（T11 记录）：SSE/REST 均不回传渲染后的 prompt，M2 补 */}
        <p className="fs-muted">M2：渲染后的输入 prompt 暂不可用（后端未回传）</p>
      </section>
      <section>
        <h4>输出（output artifact）</h4>
        {outputView}
      </section>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="fs-drawer__empty">{children}</div>;
}
