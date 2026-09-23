// React Flow 自定义节点（type: 'agent'）：纯展示组件。
// elapsedMs / lastToolTitle 由 RunMonitor 每秒 tick 计算后传入（NodeCard 自身无定时器）。
// 只声明 data prop：NodeTypes 允许（多余 props 由 RF 注入并被忽略），也便于单测直接渲染。
import { Handle, Position } from '@xyflow/react';

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface NodeCardData {
  id: string;
  agent: string;
  status: NodeStatus;
  /** running 时显示的已运行毫秒数。 */
  elapsedMs?: number;
  lastToolTitle?: string;
  error?: string;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: '待运行',
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '跳过',
};

export default function NodeCard({ data }: { data: NodeCardData }) {
  const { status } = data;
  return (
    <div className={`fs-node fs-node--${status}`} data-testid="node-card">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="fs-node__head">
        <span className="fs-node__agent">{data.agent || 'agent'}</span>
        <span className="fs-node__id">{data.id}</span>
      </div>
      <div className="fs-node__status">
        <span className={`fs-badge fs-badge--${status}`}>{STATUS_LABEL[status]}</span>
        {status === 'running' && data.elapsedMs != null && (
          <span className="fs-node__elapsed">{formatElapsed(data.elapsedMs)}</span>
        )}
      </div>
      {status === 'running' && data.lastToolTitle && (
        <div className="fs-node__tool" title="最近工具">
          ⚙ {data.lastToolTitle}
        </div>
      )}
      {status === 'failed' && data.error && (
        <div className="fs-node__error" title="失败原因">
          ✗ {data.error}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
