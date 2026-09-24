// 工作流列表（`/workflows`）：卡片（name/version），点开进详情编辑/预览/启动。
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export default function WorkflowList() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api.listWorkflows() });
  const rows = q.data ?? [];

  return (
    <div className="fs-page">
      <header className="fs-page__head">
        <h1>工作流</h1>
        <button className="fs-btn" onClick={() => navigate('/workflows/new')}>
          新建工作流
        </button>
      </header>
      {q.isError && (
        <div className="fs-error-text">加载失败：{String((q.error as Error)?.message ?? q.error)}</div>
      )}
      {q.isLoading ? (
        <div className="fs-muted">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="fs-empty">
          <div>暂无工作流</div>
          <div className="fs-empty__hint">点击右上角「新建工作流」，粘贴 YAML 定义你的第一个 DAG</div>
        </div>
      ) : (
        <div className="fs-cards">
          {rows.map((w) => (
            <Link key={w.id} to={`/workflows/${w.id}`} className="fs-card">
              <div className="fs-card__name">{w.name}</div>
              <div className="fs-card__meta">
                <span className="fs-badge fs-badge--pending">v{w.version}</span>
                <span className="fs-muted fs-card__id">{w.id}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
