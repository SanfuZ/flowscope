// 工作流详情（`/workflows/:id`，`new` 为新建）——M2a 重写：画布为主交互。
// 结构：header（标题 + dirty 圆点 | 工具栏 [撤销][重做] | [YAML 源码] | 校验徽章 |
// [保存][启动运行]）+ .fs-editor-layout（左 EditableCanvas flex-1，右 PropertyPanel 384px）。
// save-ux 增强：
//   - Ctrl/Cmd+S 快捷保存（window 捕获；先 blur 冲刷属性面板防抖提交）；
//   - 保存按钮脏态高亮（dirty → fs-btn--primary，干净态普通样式）；
//   - 保存成功 toast（右下角 fs-toast，2.2s 自动消失，替代原 inline「已保存」）；
//   - 未保存离开拦截：beforeunload（原生）+ useBlocker（站内路由，自定义模态，
//     不用 window.confirm）。保存成功路径 markSaved() 先于 navigate 且 shouldBlock
//     实时读 store.getState()，不会被拦截卡住；启动运行用 allowNextNavRef
//     一次性放行（明确离开意图，不伪装已保存）。
// 文档事实源在 editorStore（Task 3~5）；本页只做装配：
//   - 载入：new → loadBlank()（或 location.state.importedYaml → loadYaml，
//     文件夹工作流入口，见 effect 处注释）；既有 → wfQuery.data.yaml → loadYaml。
//     T1 收尾：new 页 agents 就绪后自动把未碰过的 mock 种子换成首个非演示
//     agent（详见 effect 处注释——脏态跳过、纯演示环境跳过、可撤销）。
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
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../api/client';
import type { WorkflowDetail as WorkflowDetailRow } from '../api/types';
import { validateWorkflow } from '../lib/validate';
import { useEditorStore } from '../store/editorStore';
import { DEMO_AGENT_KEYS } from '../components/Palette';
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

  // 仅新建页需要 agent 清单（种子节点换选用；面板/画布各自的 ['agents'] 查询
  // 照常自取）。enabled: isNew 避免既有工作流页的无谓请求。
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.listAgents(),
    enabled: isNew,
  });

  // --- 载入（new → loadBlank；既有 → loadYaml，含 refetch/切 id 策略） ---
  const lastDocRef = useRef<{ id: string; data: WorkflowDetailRow } | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);
  // 文件夹工作流「在编辑器打开」入口（FolderWorkflows → navigate state）：
  // importedYaml 是权威内容 → 替代 loadBlank 直接 loadYaml；同时置 importedRef
  // 令下方种子换选 effect 跳过（导入的单节点 mock 文档不被自动改 agent）。
  const location = useLocation();
  const importedRef = useRef(false);
  const importedYaml = (location.state as { importedYaml?: unknown } | null)?.importedYaml;
  const hasImport = typeof importedYaml === 'string' && importedYaml.length > 0;
  useEffect(() => {
    if (isNew) {
      if (hasImport) {
        loadYaml(importedYaml as string); // 幂等：同一 YAML 重载为同一文档
        importedRef.current = true;
      } else {
        importedRef.current = false;
        loadBlank(); // 幂等：StrictMode 双调用重置为同一空白文档
      }
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
  }, [wfQuery.data, id, isNew, loadBlank, loadYaml, hasImport, importedYaml]);

  // --- T1 收尾：新建工作流种子节点自动选用首个非演示 agent ---
  // loadBlank 的种子固定 agent 'mock'（演示 agent）；T1 起 demo agent 不进
  // palette，新建页却仍摆着 mock 节点，违背「新建面向企业 agent」意图 →
  // agents 就绪后把未被碰过的种子换成首个非演示 agent。守卫刻意收紧：
  //   - !dirty：用户已编辑（含刚加的节点）就不动其文档；
  //   - 单节点且 id=step1、agent=mock：换过/撤回过/改过即不再匹配，天然幂等
  //     （swap 本身置脏，StrictMode/依赖重跑不会二次触发）；
  //   - 无非演示 agent（纯 mock 环境的 home）保持种子原样——不把新建页弄成
  //     无法运行。
  // e2e 兼容（已 grep 核实）：冻结的 build-via-canvas.spec 对 step1 只断言
  // data-id/handle 与 YAML 的 from/to，无任何 agent 名断言；e2e home 注册了
  // zcode → step1 换成 zcode，两例均不依赖 step1 的 agent 身份（条件边的
  // when 求值的是 source 输出，zcode 空跑不产 ok=true，node-1 照旧 skipped）。
  // 走 updateNode 正常编辑纪律（进历史、置脏）：用户 Ctrl+Z 可撤回换选。
  useEffect(() => {
    if (importedRef.current) return; // 导入的 YAML 是权威内容：不做种子换选
    if (!isNew || dirty || !loaded) return;
    const m = useEditorStore.getState().model;
    if (m == null || m.nodes.length !== 1) return;
    const seed = m.nodes[0];
    if (seed.id !== 'step1' || seed.agent !== 'mock') return;
    const first = agentsQuery.data?.find((a) => !DEMO_AGENT_KEYS.has(a.key));
    if (!first) return; // 纯演示环境：保持 mock 种子（新建页仍可用）
    useEditorStore.getState().updateNode('step1', { agent: first.key });
  }, [agentsQuery.data, dirty, isNew, loaded]);

  // --- 保存门 ---
  const problems = useMemo(
    () => (loaded && model ? validateWorkflow(model) : ['未加载']),
    [loaded, model],
  );

  // --- 保存 toast（save-ux）：成功后右下角浮现 2.2s（替代原 inline「已保存」）---
  const [toast, setToast] = useState<{ name: string; created: boolean } | null>(null);
  const toastTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  const saveMut = useMutation({
    mutationFn: () => {
      const s = useEditorStore.getState();
      return api.saveWorkflow(s.model?.name ?? '', s.model?.version ?? 1, s.toYaml());
    },
    onSuccess: (res) => {
      // 顺序裁定（e2e 安全）：markSaved 必须先于 navigate——脏态先清零，
      // useBlocker 的 shouldBlock 实时读 store（getState），保存后的
      // new → /workflows/:id 跳转不会被未保存拦截卡住。
      useEditorStore.getState().markSaved();
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow'] });
      const name = useEditorStore.getState().model?.name ?? '';
      window.clearTimeout(toastTimerRef.current);
      setToast({ name, created: isNew });
      toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
      if (isNew) navigate(`/workflows/${res.id}`, { replace: true });
    },
  });

  // --- Ctrl/Cmd+S 快捷保存（save-ux）：window 捕获阶段接管浏览器「保存网页」；
  // 仅在可保存态（无校验问题、非保存中、已载入）挂监听；先 blur 焦点元素
  // 触发属性面板的失焦提交（名称/prompt 防抖 300ms 落库），再取文档保存。 ---
  const saveMutRef = useRef(saveMut);
  saveMutRef.current = saveMut;
  const canSave = problems.length === 0 && !saveMut.isPending && loaded;
  useEffect(() => {
    if (!canSave) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur(); // 冲刷防抖提交
      if (!saveMutRef.current.isPending) saveMutRef.current.mutate();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [canSave]);

  // --- 未保存离开拦截（save-ux） ---
  // beforeunload：刷新/关闭标签页时的浏览器原生确认（仅脏态挂载）。
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 站内路由拦截：useBlocker（react-router 6.19+ 稳定导出，须 data router，
  // App.tsx 已迁移 createBrowserRouter）。shouldBlock 实时读 store 而非闭包
  // 捕获渲染值——保存 onSuccess 里 markSaved() 后同步 navigate 时，闭包里的
  // dirty 还是旧值，getState() 才读到已清零的脏态（e2e 成功路径不触发拦截）。
  // allowNextNavRef：启动运行是明确的离开意图，startRun 成功后紧贴 navigate
  // 置 true 一次性放行（语义上不是「已保存」，只是「用户明确选择离开」）；
  // 请求进行中不置位（旁路窗口最小），失败路径不进入放行、天然复位。
  const allowNextNavRef = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    currentLocation.pathname !== nextLocation.pathname &&
    useEditorStore.getState().dirty &&
    !allowNextNavRef.current,
  );

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
      // 放行标志在启动成功后、紧贴 navigate 才置 true：旁路窗口最小化
      //（请求期间脏态导航仍走拦截确认），失败路径根本不会置位，天然复位。
      allowNextNavRef.current = true; // 明确离开：放行本次路由跳转（不伪装已保存）
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
      allowNextNavRef.current = false; // 未离开：防御性复位（正常不会置位）
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
            className={dirty ? 'fs-btn fs-btn--primary' : 'fs-btn'}
            disabled={problems.length > 0 || saveMut.isPending}
            title={problems.length > 0 ? problems[0] : 'Ctrl+S'}
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

      {/* 保存成功 toast（save-ux）：右下角 2.2s 自动消失 */}
      {toast && (
        <div className="fs-toast" role="status" data-testid="save-toast">
          <span className="fs-toast__check">✓ 已保存</span>
          {toast.name && <span className="fs-toast__name">{toast.name}</span>}
          {toast.created && <span className="fs-toast__created">· 已创建</span>}
        </div>
      )}

      {/* 未保存离开拦截（save-ux）：自定义模态（不用 window.confirm——headless
          e2e 自动关闭原生对话框会失控） */}
      {blocker.state === 'blocked' && (
        <div className="fs-confirm" role="dialog" aria-label="有未保存的修改">
          <div className="fs-confirm__card">
            <h3 className="fs-confirm__title">有未保存的修改</h3>
            <p className="fs-confirm__text">离开将丢失画布上的修改（可先 Ctrl+S 保存）</p>
            <div className="fs-confirm__actions">
              <button type="button" className="fs-btn" onClick={() => blocker.reset()}>
                留下
              </button>
              <button type="button" className="fs-btn fs-btn--danger" onClick={() => blocker.proceed()}>
                离开
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
