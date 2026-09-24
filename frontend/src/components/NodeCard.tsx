// React Flow 自定义节点（type: 'agent'）：纯展示组件。
// elapsedMs / lastToolTitle 由 RunMonitor 每秒 tick 计算后传入（NodeCard 自身无定时器）。
// isConnectable 接收 RF NodeWrapper 注入的同名 prop（= node.connectable ?? nodesConnectable，
// 见 @xyflow/react NodeWrapper）：编辑画布 nodesConnectable → source/target handle 可拖拽连线；
// RunMonitor 传 nodesConnectable={false} → handle 不可连（默认 false，直渲染亦不可连）。
// 注意 RF12 的连线落点校验（system isValidHandle）读取 handle 上的 connectable 类——
// 硬编码 isConnectable={false} 会让编辑画布 onConnect 永远无法触发（e2e 实证）。
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

export default function NodeCard({
  data,
  isConnectable = false,
}: {
  data: NodeCardData;
  isConnectable?: boolean;
}) {
  const { status } = data;
  return (
    <div className={`fs-node fs-node--${status}`} data-testid="node-card">
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
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
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </div>
  );
}
