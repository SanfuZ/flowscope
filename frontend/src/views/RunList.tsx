// 运行列表（`/`）：3 秒自动刷新；工作流名经 listWorkflows 查表回显。
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import StatusBadge from '../components/StatusBadge';

/** sqlite datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"（UTC、空格分隔）→ 本地化显示。 */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export default function RunList() {
  const runsQuery = useQuery({
    queryKey: ['runs'],
    queryFn: () => api.listRuns(),
    refetchInterval: 3000,
  });
  const wfsQuery = useQuery({ queryKey: ['workflows'], queryFn: () => api.listWorkflows() });
  const nameOf = (workflowId: string) =>
    wfsQuery.data?.find((w) => w.id === workflowId)?.name ?? workflowId;

  const rows = runsQuery.data ?? [];

  return (
    <div className="fs-page">
      <header className="fs-page__head">
        <h1>运行</h1>
        <span className="fs-muted">每 3 秒自动刷新</span>
      </header>
      {runsQuery.isError && (
        <div className="fs-error-text">加载失败：{String((runsQuery.error as Error)?.message ?? runsQuery.error)}</div>
      )}
      {runsQuery.isLoading ? (
        <div className="fs-muted">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="fs-muted">暂无运行。到「工作流」页启动一个试试。</div>
      ) : (
        <table className="fs-table">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>工作流</th>
              <th>状态</th>
              <th>开始时间</th>
              <th>结束时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link className="fs-link" to={`/runs/${r.id}`}>
                    {r.id}
                  </Link>
                </td>
                <td>{nameOf(r.workflow_id)}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="fs-time">{fmtTime(r.started_at)}</td>
                <td className="fs-time">{fmtTime(r.ended_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
