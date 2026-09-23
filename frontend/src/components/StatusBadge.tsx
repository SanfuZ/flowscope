// 通用状态徽章：run 状态（finished/interrupted…）归一到六色节点状态类。
const KNOWN = ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] as const;

/** run 行状态 → 节点六态类名（finished→succeeded 绿，interrupted→cancelled 橙）。 */
export function statusClass(status: string): string {
  if ((KNOWN as readonly string[]).includes(status)) return status;
  if (status === 'finished') return 'succeeded';
  if (status === 'interrupted') return 'cancelled';
  return 'pending';
}

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`fs-badge fs-badge--${statusClass(status)}`}>{status}</span>;
}
