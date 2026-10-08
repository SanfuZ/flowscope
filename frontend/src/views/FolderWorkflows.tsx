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
// 行内「标记」编辑：行操作列的标记按钮在该行下方展开 fs-tagpop 面板（同一时间
// 只开一个），保存=只改 meta.tags 的文档手术（setYamlTags，保留注释/排版）→
// saveFolderWorkflow 写回 → 重走刷新的 load 路径即时重分组；失败在面板内提示。
// 解析失败文件（valid:false）标记按钮禁用（先去编辑器修复）。
// 行内「派生」（快速另存）：每行「派生」按钮（valid:false 禁用同标记）打开
// fs-folderdlg 小对话框——文件名预填 <stem>-copy.<原扩展名>、标记预填源
// tags、目录预填当前 resolvedDir；保存=对**源文件 yaml 原文**做 setYamlTags
// 手术（标记有变时；注释/排版保留）→ saveFolderWorkflow 写新文件（源文件不动）
// → 关对话框 + 重载列表（新文件即时出现，可能进新分组）；失败在对话框内提示。
// 目录记忆在 localStorage `fs-workflow-dir`：挂载时有缓存目录直接读之，
// 没有则无参调用一次取后端默认目录（env FLOWSCOPE_WORKFLOW_DIR →
// ~/.flowscope/workflows）并回填输入框；读取成功后把实际目录写回缓存。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FolderWorkflow } from '../api/client';
import { setYamlTags } from '../api/workflowModel';

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
  // 行内标记编辑：当前打开面板的文件名（null=无）；草稿/错误/保存中随行面板展示
  const [tagEditFile, setTagEditFile] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState('');
  const [tagSaving, setTagSaving] = useState(false);
  // 派生（快速另存）：当前派生源（null=对话框关）；目录/文件名/标记草稿随
  // fs-folderdlg 对话框展示（与编辑器「另存到文件夹」同一皮肤）
  const [deriveFrom, setDeriveFrom] = useState<FolderWorkflow | null>(null);
  const [deriveDir, setDeriveDir] = useState('');
  const [deriveFile, setDeriveFile] = useState('');
  const [deriveTags, setDeriveTags] = useState('');
  const [deriveError, setDeriveError] = useState('');
  const [deriveSaving, setDeriveSaving] = useState(false);

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

  /** 打开行内标记面板：每次打开都按当前 tags 重新铺初值；单例（开新关旧）。 */
  const openTagEdit = (f: FolderWorkflow) => {
    setTagEditFile(f.file);
    setTagDraft(f.tags.join(', '));
    setTagError('');
  };

  /** 保存标记：中英文逗号切分（与编辑器「标签」同一约定）→ meta.tags 文档手术
   *  （保留注释/排版，手术抛错就地提示且不发请求）→ 写回来源文件 → 关面板 +
   *  重走「刷新」的 load 路径即时重分组；服务端失败在面板内提示、不关面板。 */
  const saveTags = async (f: FolderWorkflow) => {
    const tags = tagDraft
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t !== '');
    let yaml: string;
    try {
      yaml = setYamlTags(f.yaml, tags);
    } catch (e) {
      setTagError(e instanceof Error ? e.message : String(e));
      return;
    }
    setTagSaving(true);
    setTagError('');
    try {
      await api.saveFolderWorkflow({ dir: resolvedDir, file: f.file, yaml });
      setTagEditFile(null);
      await load(resolvedDir || dir); // 与「刷新」同一路径：保存后即时重分组
    } catch (e) {
      setTagError(e instanceof Error ? e.message : String(e));
    } finally {
      setTagSaving(false);
    }
  };

  /** 打开派生对话框：文件名 = 源 stem + `-copy`（保留源的 .yaml/.yml 扩展名），
   *  标记 = 源 tags join，目录 = 当前 resolvedDir；与行内标记面板互斥。 */
  const openDerive = (f: FolderWorkflow) => {
    setTagEditFile(null); // 与行内标记面板互斥（单例弹出层）
    const stem = f.file.replace(/\.ya?ml$/i, '');
    const ext = /\.yml$/i.test(f.file) ? '.yml' : '.yaml';
    setDeriveFrom(f);
    setDeriveDir(resolvedDir);
    setDeriveFile(`${stem}-copy${ext}`);
    setDeriveTags(f.tags.join(', '));
    setDeriveError('');
  };

  /** 派生保存：预校验（目录非空、文件名非空且无 / \、缺 .yaml/.yml 补 .yaml）
   *  → 标记与源 tags 不同时对**源文件 yaml 原文**做 setYamlTags 手术（注释/
   *  排版保留；源文件本身不动）→ saveFolderWorkflow 写新文件 → 关对话框 +
   *  重走「刷新」的 load 路径（新文件即时出现，可能进新分组）；失败对话框内
   *  提示、不关。 */
  const saveDerive = async () => {
    if (!deriveFrom) return;
    const dir = deriveDir.trim();
    let file = deriveFile.trim();
    if (dir === '') {
      setDeriveError('目录路径不能为空');
      return;
    }
    if (file === '') {
      setDeriveError('文件名不能为空');
      return;
    }
    if (file.includes('/') || file.includes('\\')) {
      setDeriveError('文件名不能包含 / 或 \\');
      return;
    }
    if (!/\.ya?ml$/i.test(file)) file = `${file}.yaml`;
    const tags = deriveTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t !== '');
    let yaml = deriveFrom.yaml; // 无标记变化：源原文整写
    if (tags.join('\u0000') !== deriveFrom.tags.join('\u0000')) {
      try {
        yaml = setYamlTags(deriveFrom.yaml, tags); // 手术在源原文上：注释保留
      } catch (e) {
        setDeriveError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setDeriveSaving(true);
    setDeriveError('');
    try {
      await api.saveFolderWorkflow({ dir, file, yaml });
      setDeriveFrom(null);
      await load(resolvedDir || dir); // 与「刷新」同路径：新文件即时出现（可能进新组）
    } catch (e) {
      setDeriveError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeriveSaving(false);
    }
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
                      <Fragment key={f.file}>
                        <tr>
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
                            {/* 行内标记编辑：解析失败文件禁用（YAML 动不了） */}
                            <button
                              className="fs-btn fs-btn--ghost fs-btn--compact"
                              data-testid={`tag-edit-${f.file}`}
                              disabled={!f.valid}
                              title={f.valid ? undefined : '文件无法解析，请先在编辑器中修复'}
                              onClick={() => openTagEdit(f)}
                            >
                              标记
                            </button>
                            {/* 派生（快速另存）：解析失败文件禁用（源 YAML 动不了） */}
                            <button
                              className="fs-btn fs-btn--compact"
                              data-testid={`derive-${f.file}`}
                              disabled={!f.valid}
                              title={f.valid ? '从此工作流另存为新文件' : '文件无法解析，请先在编辑器中修复'}
                              onClick={() => openDerive(f)}
                            >
                              派生
                            </button>
                          </td>
                        </tr>
                        {/* 标记面板：插在目标行正下方的全宽行（单例），保存/取消就地反馈 */}
                        {tagEditFile === f.file && (
                          <tr className="fs-tagpop-row">
                            <td colSpan={5}>
                              <div className="fs-tagpop">
                                <label
                                  className="fs-form-label fs-tagpop__label"
                                  htmlFor={`fs-tag-input-${f.file}`}
                                >
                                  标记
                                </label>
                                <input
                                  id={`fs-tag-input-${f.file}`}
                                  className="fs-form-input fs-tagpop__input"
                                  placeholder="逗号分隔，首个用于文件夹页分组；清空=删除标记"
                                  value={tagDraft}
                                  onChange={(e) => setTagDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !tagSaving) void saveTags(f);
                                  }}
                                />
                                <button
                                  className="fs-btn fs-btn--compact"
                                  disabled={tagSaving}
                                  onClick={() => setTagEditFile(null)}
                                >
                                  取消
                                </button>
                                <button
                                  className="fs-btn fs-btn--primary fs-btn--compact"
                                  disabled={tagSaving}
                                  onClick={() => void saveTags(f)}
                                >
                                  保存
                                </button>
                                {tagError && <span className="fs-error-text">{tagError}</span>}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {/* 派生对话框（fs-folderdlg，与编辑器「另存到文件夹」同一皮肤）：
          目录/文件名/标记三字段，预检与服务端错误就地显示（失败不关）。 */}
      {deriveFrom && (
        <div className="fs-folderdlg" role="dialog" aria-label="派生工作流">
          <div className="fs-folderdlg__card">
            <h3 className="fs-folderdlg__title">派生工作流</h3>
            <p className="fs-folderdlg__text">
              从 <b>{deriveFrom.file}</b> 另存为新文件（源文件不变，可改标记分组）
            </p>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-derive-dir">
                目录路径
              </label>
              <input
                id="fs-derive-dir"
                className="fs-form-input"
                value={deriveDir}
                placeholder="如 D:\team-repo\workflows"
                onChange={(e) => setDeriveDir(e.target.value)}
              />
            </div>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-derive-file">
                文件名
              </label>
              <input
                id="fs-derive-file"
                className="fs-form-input"
                value={deriveFile}
                placeholder="如 my-workflow-copy.yaml（缺 .yaml/.yml 自动补全）"
                onChange={(e) => setDeriveFile(e.target.value)}
              />
            </div>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-derive-tags">
                标记
              </label>
              <input
                id="fs-derive-tags"
                className="fs-form-input"
                value={deriveTags}
                placeholder="逗号分隔，首个用于文件夹页分组；留空=不写标记"
                onChange={(e) => setDeriveTags(e.target.value)}
              />
            </div>
            {deriveError && <div className="fs-error-text fs-folderdlg__error">{deriveError}</div>}
            <div className="fs-folderdlg__actions">
              <button type="button" className="fs-btn" disabled={deriveSaving} onClick={() => setDeriveFrom(null)}>
                取消
              </button>
              <button
                type="button"
                className="fs-btn fs-btn--primary"
                disabled={deriveSaving}
                onClick={() => void saveDerive()}
              >
                {deriveSaving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
