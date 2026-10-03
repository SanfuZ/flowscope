// 工作流文件夹（`/folder`）：git 团队流——团队把工作流 YAML 放 git 仓库管理，
// FlowScope 从磁盘目录只读列出 *.yaml/*.yml（后端已按名称字母序排序），
// 「在编辑器打开」把 YAML 经 location.state.importedYaml 带进新建工作流页，
// 编辑后「保存」进 FlowScope 数据库（不回写文件夹，回写走 git 提交流程）。
// 目录记忆在 localStorage `fs-workflow-dir`：挂载时有缓存目录直接读之，
// 没有则无参调用一次取后端默认目录（env FLOWSCOPE_WORKFLOW_DIR →
// ~/.flowscope/workflows）并回填输入框；读取成功后把实际目录写回缓存。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FolderWorkflow } from '../api/client';

const DIR_KEY = 'fs-workflow-dir';

export default function FolderWorkflows() {
  const navigate = useNavigate();
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_KEY) ?? '');
  const [files, setFiles] = useState<FolderWorkflow[] | null>(null);
  const [resolvedDir, setResolvedDir] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (d: string) => {
    const target = d.trim();
    setLoading(true);
    setError('');
    try {
      const res = await api.listFolderWorkflows(target ? target : undefined);
      setFiles(res.files);
      setResolvedDir(res.dir);
      if (!target) setDir(res.dir); // 首次无目录：回填后端默认目录
      localStorage.setItem(DIR_KEY, res.dir); // 读取成功才写缓存
    } catch (e) {
      setFiles(null);
      setResolvedDir('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // 挂载自动读取一次（useRef 守卫：StrictMode 双调用不重复请求）
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void load(dir);
  }, []);

  return (
    <div className="fs-page">
      <header className="fs-page__head">
        <h1>工作流文件夹</h1>
        <span className="fs-muted">
          把工作流 YAML 放进 git 仓库管理的文件夹，FlowScope 从这里读取（按名称字母序）
        </span>
      </header>
      <div className="fs-folder-bar">
        <label htmlFor="fs-folder-dir">目录路径</label>
        <input
          id="fs-folder-dir"
          className="fs-form-input"
          value={dir}
          placeholder="如 D:\team-repo\workflows（留空用默认目录）"
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(dir);
          }}
        />
        <button className="fs-btn fs-btn--primary" disabled={loading} onClick={() => void load(dir)}>
          {loading ? '读取中…' : '读取'}
        </button>
      </div>
      {resolvedDir && !error && <div className="fs-muted fs-folder-dir">目录：{resolvedDir}</div>}
      {error && <div className="fs-error-text">{error}</div>}
      {loading ? (
        <div className="fs-muted">加载中…</div>
      ) : files !== null && files.length === 0 ? (
        <div className="fs-empty">
          <div>该目录下没有 .yaml/.yml 工作流文件</div>
        </div>
      ) : files !== null ? (
        <table className="fs-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>版本</th>
              <th>文件</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.file}>
                <td>{f.name}</td>
                <td>{f.version == null ? '—' : `v${f.version}`}</td>
                <td>{f.file}</td>
                <td>
                  {f.valid ? (
                    <span className="fs-badge fs-badge--succeeded">✓ 可用</span>
                  ) : (
                    <span className="fs-badge fs-badge--cancelled" title={f.error ?? ''}>
                      解析失败
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="fs-btn"
                    onClick={() => navigate('/workflows/new', { state: { importedYaml: f.yaml } })}
                  >
                    在编辑器打开
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
