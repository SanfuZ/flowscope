// 工作流详情（`/workflows/:id`，`new` 为新建）——M2a 重写：画布为主交互。
// 结构：header（标题 + dirty 圆点 | 工具栏 [撤销][重做] | [YAML 源码] | 校验徽章 |
// [保存][启动运行]）+ .fs-editor-layout（左 EditableCanvas flex-1，右 PropertyPanel 384px）。
// 文档事实源在 editorStore（Task 3~5）；本页只做装配：
//   - 载入：new → loadBlank()；既有 → wfQuery.data.yaml → loadYaml。
//     用 lastDocRef 记录已处理的 {id, data}（比简报的 !loaded 守卫更强：同一份
//     data 的 effect 重跑/StrictMode 双调用被引用相等拦下，且能处理 id 切换）。
//     同 id 的 refetch 新数据（react-query 结构共享保证引用变⇔内容变）：脏 → 不
//     覆盖编辑、显示「服务器数据已更新」提示；干净 → 重载。
//   - 保存门：problems = validateWorkflow(model)（未加载时 ['未加载']），
//     非空禁用保存并以 title 列出首条；不设 dirty 门槛（M1 语义：干净文档允许
//     显式重存）。成功 → markSaved + invalidate ['workflows']/['workflow']，
//     isNew 跳 `/workflows/${res.id}`（replace）。
//   - 启动（控制器最终裁定，取代简报的对话框方案）：一键直发，无对话框——
//     params = model.params ?? {}（在设置态属性面板编辑，随文档保存）。
//     空参数即 {}，与 M1「params 默认 {} 直接接受」等价，既有 e2e
//     （run.spec.ts 不可改）点「启动运行」后直接落 /runs/:id 的契约保持不变。
//   - 撤销/重做：按钮随 past/future 启停；快捷键挂页面容器（tabIndex -1）。
//     输入控件聚焦时不拦截（保留浏览器原生文本撤销）。
//   - YAML 源码：fixed 右侧滑入浮层（520px）。打开时对 toYaml() 取快照，
//     打开期间画布编辑不回写文本（快照语义）；[刷新] 重取；[应用到画布] →
//     loadYaml，解析失败就地显示 parseErrors 且不关闭，成功关闭浮层。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../api/client';
import type { WorkflowDetail as WorkflowDetailRow } from '../api/types';
import { validateWorkflow } from '../lib/validate';
import { useEditorStore } from '../store/editorStore';
import EditableCanvas from '../components/EditableCanvas';
import PropertyPanel from '../components/PropertyPanel';

export default function WorkflowDetail() {
  const { id = '' } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const loaded = useEditorStore((s) => s.loaded);
  const model = useEditorStore((s) => s.model);
  const dirty = useEditorStore((s) => s.dirty);
  const pastLen = useEditorStore((s) => s.past.length);
  const futureLen = useEditorStore((s) => s.future.length);
  const loadBlank = useEditorStore((s) => s.loadBlank);
  const loadYaml = useEditorStore((s) => s.loadYaml);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const wfQuery = useQuery({
    queryKey: ['workflow', id],
    queryFn: () => api.getWorkflow(id),
    enabled: !isNew,
  });

  // --- 载入（new → loadBlank；既有 → loadYaml，含 refetch/切 id 策略） ---
  const lastDocRef = useRef<{ id: string; data: WorkflowDetailRow } | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);
  useEffect(() => {
    if (isNew) {
      loadBlank(); // 幂等：StrictMode 双调用重置为同一空白文档
      lastDocRef.current = null;
      setStaleNotice(false);
      return;
    }
    const data = wfQuery.data;
    if (!data) return;
    const prev = lastDocRef.current;
    if (prev && prev.id === id && prev.data === data) return; // 同一份数据已处理
    lastDocRef.current = { id, data };
    if (!prev || prev.id !== id) {
      loadYaml(data.yaml); // 首次装载该 id（含从 new/其它工作流切来）
      setStaleNotice(false);
      return;
    }
    // 同 id 的 refetch 新数据：脏 → 保留编辑只提示；干净 → 重载
    if (useEditorStore.getState().dirty) {
      setStaleNotice(true);
    } else {
      loadYaml(data.yaml);
      setStaleNotice(false);
    }
  }, [wfQuery.data, id, isNew, loadBlank, loadYaml]);

  // --- 保存门 ---
  const problems = useMemo(
    () => (loaded && model ? validateWorkflow(model) : ['未加载']),
    [loaded, model],
  );

  const saveMut = useMutation({
    mutationFn: () => {
      const s = useEditorStore.getState();
      return api.saveWorkflow(s.model?.name ?? '', s.model?.version ?? 1, s.toYaml());
    },
    onSuccess: (res) => {
      useEditorStore.getState().markSaved();
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow'] });
      if (isNew) navigate(`/workflows/${res.id}`, { replace: true });
    },
  });

  // --- 启动：一键直发（见文件头裁定说明），params 取文档当前 params ---
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const launch = async () => {
    const m = useEditorStore.getState().model;
    if (m == null) return;
    setLaunching(true);
    setLaunchError('');
    try {
      const res = await api.startRun(id, m.params ?? {});
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
      setLaunching(false);
    }
  };

  // --- 撤销/重做快捷键（页面容器；输入控件内不拦截，保留原生文本撤销） ---
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      redo();
    }
  };

  // --- YAML 源码浮层（快照语义） ---
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlDraft, setYamlDraft] = useState('');
  const [yamlErrors, setYamlErrors] = useState<string[]>([]);
  const openYamlView = () => {
    setYamlDraft(useEditorStore.getState().toYaml());
    setYamlErrors([]);
    setYamlOpen(true);
  };
  const refreshYamlDraft = () => {
    setYamlDraft(useEditorStore.getState().toYaml());
    setYamlErrors([]);
  };
  const applyYamlDraft = () => {
    loadYaml(yamlDraft);
    const errs = useEditorStore.getState().parseErrors;
    if (errs.length > 0) {
      setYamlErrors(errs); // 解析失败：就地显示，不关闭、不覆盖画布
      return;
    }
    setYamlErrors([]);
    setYamlOpen(false);
  };

  const title = isNew ? '新建工作流' : `工作流：${model?.name ?? wfQuery.data?.name ?? id}`;

  return (
    <div className="fs-page fs-page--editor" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="fs-page__head">
        <h1>
          {title}
          {dirty && <span className="fs-dirty-dot" title="有未保存修改" />}
          {dirty ? ' ·未保存' : ''}
        </h1>
        <div className="fs-edit-toolbar">
          <button className="fs-btn" disabled={pastLen === 0} onClick={() => undo()}>
            撤销
          </button>
          <button className="fs-btn" disabled={futureLen === 0} onClick={() => redo()}>
            重做
          </button>
          <span className="fs-edit-toolbar__sep" aria-hidden />
          <button className="fs-btn" onClick={openYamlView}>
            YAML 源码
          </button>
          {problems.length > 0 ? (
            <span className="fs-badge fs-badge--cancelled" title={problems.join('\n')}>
              ⚠ {problems.length}
            </span>
          ) : (
            <span className="fs-badge fs-badge--succeeded">✓ 通过</span>
          )}
          <span className="fs-edit-toolbar__sep" aria-hidden />
          <button
            className="fs-btn"
            disabled={problems.length > 0 || saveMut.isPending}
            title={problems.length > 0 ? problems[0] : undefined}
            onClick={() => saveMut.mutate()}
          >
            {saveMut.isPending ? '保存中…' : '保存'}
          </button>
          <button
            className="fs-btn fs-btn--primary"
            disabled={isNew || launching || !loaded}
            title={isNew ? '请先保存' : undefined}
            onClick={launch}
          >
            {launching ? '启动中…' : '启动运行'}
          </button>
        </div>
      </header>

      {wfQuery.isError && (
        <div className="fs-editor-msgs">
          <span className="fs-error-text">
            加载失败：{String((wfQuery.error as Error)?.message ?? wfQuery.error)}
          </span>
        </div>
      )}
      {saveMut.isError && (
        <div className="fs-editor-msgs">
          <span className="fs-error-text">
            保存失败：{String((saveMut.error as Error)?.message ?? saveMut.error)}
          </span>
        </div>
      )}
      {launchError && (
        <div className="fs-editor-msgs">
          <span className="fs-error-text">{launchError}</span>
        </div>
      )}
      {saveMut.isSuccess && !isNew && !dirty && (
        <div className="fs-editor-msgs">
          <span className="fs-ok-text">已保存</span>
        </div>
      )}
      {staleNotice && (
        <div className="fs-editor-msgs">
          <span className="fs-muted">服务器数据已更新，未刷新画布</span>
        </div>
      )}

      <div className="fs-editor-layout">
        <EditableCanvas />
        <PropertyPanel problems={problems} />
      </div>

      {yamlOpen && (
        <aside className="fs-yamlview" role="dialog" aria-label="YAML 源码">
          <div className="fs-yamlview__head">
            <h3>YAML 源码</h3>
            <span className="fs-yamlview__note">图形编辑后导出会重排格式、注释不保留</span>
            <div className="fs-yamlview__headbtns">
              <button type="button" className="fs-btn fs-btn--ghost" onClick={refreshYamlDraft}>
                刷新
              </button>
              <button type="button" className="fs-btn fs-btn--ghost" onClick={() => setYamlOpen(false)}>
                关闭
              </button>
            </div>
          </div>
          <div className="fs-yamlview__body">
            <textarea
              aria-label="YAML 内容"
              spellCheck={false}
              value={yamlDraft}
              onChange={(e) => setYamlDraft(e.target.value)}
            />
          </div>
          {yamlErrors.length > 0 && (
            <div className="fs-yamlview__errors">
              {yamlErrors.map((e, i) => (
                <div key={i} className="fs-error-text">
                  {e}
                </div>
              ))}
            </div>
          )}
          <div className="fs-yamlview__foot">
            <button type="button" className="fs-btn fs-btn--primary" onClick={applyYamlDraft}>
              应用到画布
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
