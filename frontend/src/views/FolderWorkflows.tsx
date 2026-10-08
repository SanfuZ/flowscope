// 工作流文件夹（`/folder`）：git 团队流——团队把工作流 YAML 放 git 仓库管理，
// FlowScope 从磁盘目录列出 *.yaml/*.yml（后端已按名称字母序排序，含 meta.tags）。
// 分组与标记（meta.tags）：按**首个 tag** 分组（无 tag → 「未分类」组恒排最后），
// 组名集合字母序、组内名称字母序（后端已排序，前端重排兜底）；组行可展开/收起，
// 收起集合按目录记在 localStorage `fs-folder-collapsed`（`{[dir]: string[]}`，
// 读取成功时按当前目录装载，切换目录自然换组记忆）；行上显示全部 tag 小徽标。
// 「在编辑器打开」把 YAML 经 location.state.importedYaml 带进新建工作流页，
// 并带 originDir/originFile（来源文件）——编辑器据此显示「保存到文件夹」按钮，
// 可把画布内容（含 tags）写回来源文件（POST /api/fs/workflows/save），与「保存」
// （进 FlowScope 数据库）并存，用户自选。「刷新」重读当前目录（保存到文件夹后
// 可刷出最新内容）。
// 目录记忆在 localStorage `fs-workflow-dir`：挂载时有缓存目录直接读之，
// 没有则无参调用一次取后端默认目录（env FLOWSCOPE_WORKFLOW_DIR →
// ~/.flowscope/workflows）并回填输入框；读取成功后把实际目录写回缓存。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FolderWorkflow } from '../api/client';

const DIR_KEY = 'fs-workflow-dir';
const COLLAPSED_KEY = 'fs-folder-collapsed';
/** 无 tag 条目的分组名（恒排最后）。 */
const UNGROUPED = '未分类';

/** 读某目录的收起组名集合（localStorage 损坏/缺省 → 空集）。 */
function readCollapsed(dir: string): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const list = (parsed as Record<string, unknown>)[dir];
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/** 写回某目录的收起组名集合（其余目录的记录保留）。 */
function writeCollapsed(dir: string, groups: string[]): void {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const store =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, string[]>)
        : {};
    store[dir] = groups;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(store));
  } catch {
    /* localStorage 不可用（隐私模式等）：收起状态仅本次会话内生效 */
  }
}

/** 分组视图：[{key, items}]，组名集合字母序（未分类恒最后），组内名称字母序。 */
function buildGroups(files: FolderWorkflow[]): { key: string; items: FolderWorkflow[] }[] {
  const byGroup = new Map<string, FolderWorkflow[]>();
  for (const f of files) {
    const key = f.tags[0] ?? UNGROUPED;
    const list = byGroup.get(key);
    if (list) list.push(f);
    else byGroup.set(key, [f]);
  }
  const keys = [...byGroup.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1; // 未分类恒最后
    if (b === UNGROUPED) return -1;
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  });
  return keys.map((key) => ({
    key,
    items: [...byGroup.get(key)!].sort((a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1,
    ),
  }));
}

export default function FolderWorkflows() {
  const navigate = useNavigate();
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_KEY) ?? '');
  const [files, setFiles] = useState<FolderWorkflow[] | null>(null);
  const [resolvedDir, setResolvedDir] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const load = async (d: string) => {
    const target = d.trim();
    setLoading(true);
    setError('');
    try {
      const res = await api.listFolderWorkflows(target ? target : undefined);
      setFiles(res.files);
      setResolvedDir(res.dir);
      setCollapsed(readCollapsed(res.dir)); // 收起集合按目录记忆
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

  const groups = useMemo(() => (files ? buildGroups(files) : []), [files]);

  /** 组行整行可点：切换收起/展开并按目录写回 localStorage。 */
  const toggleGroup = (g: string) => {
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g];
    setCollapsed(next);
    if (resolvedDir) writeCollapsed(resolvedDir, next);
  };

  return (
    <div className="fs-page">
      <header className="fs-page__head">
        <h1>工作流文件夹</h1>
        <span className="fs-muted">
          把工作流 YAML 放进 git 仓库管理的文件夹，FlowScope 从这里读取（按标记分组、名称字母序）
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
        {/* 刷新：重读当前（已解析）目录——「保存到文件夹」写回后可刷出最新内容 */}
        <button className="fs-btn" disabled={loading} onClick={() => void load(resolvedDir || dir)}>
          刷新
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
            {groups.map((g) => {
              const isCollapsed = collapsed.includes(g.key);
              return (
                <Fragment key={g.key}>
                  <tr
                    className="fs-folder-group"
                    onClick={() => toggleGroup(g.key)}
                    title={isCollapsed ? '展开分组' : '收起分组'}
                  >
                    <td colSpan={5}>
                      <span className="fs-folder-group__chevron" aria-hidden>
                        {isCollapsed ? '▶' : '▾'}
                      </span>
                      <span className="fs-folder-group__label">
                        {g.key} ({g.items.length})
                      </span>
                    </td>
                  </tr>
                  {!isCollapsed &&
                    g.items.map((f) => (
                      <tr key={f.file}>
                        <td>
                          <span className="fs-folder-name">{f.name}</span>
                          {f.tags.map((t) => (
                            <span key={t} className="fs-tag-pill">
                              {t}
                            </span>
                          ))}
                        </td>
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
                            onClick={() =>
                              navigate('/workflows/new', {
                                state: {
                                  importedYaml: f.yaml,
                                  originDir: resolvedDir,
                                  originFile: f.file,
                                },
                              })
                            }
                          >
                            在编辑器打开
                          </button>
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
