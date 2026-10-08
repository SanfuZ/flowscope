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
//   - 保存到文件夹（通用化 + 另存派生）：任何工作流（new 或已入库）工具栏
//     常驻两个同级 fs-btn——「保存到文件夹」：有 effectiveOrigin（文件夹页
//     「在编辑器打开」经 location.state 带的 originDir/originFile，或对话框/
//     另存保存过的本地 savedOrigin）→ 一键写回该文件；无 → 弹 fs-folderdlg
//     对话框选目录+文件名。「另存到文件夹…」：总是弹对话框（Save As 一等
//     公民，预填 effectiveOrigin ?? localStorage 目录 + model.name 合法化），
//     可改目录/文件名并**派生标记**——对话框「标记」初值 = model.tags join，
//     保存时若与画布 tags 不同则对 yaml 做 setYamlTags 文档手术（只改
//     meta.tags 行，画布 model 本身不动：文件派生、画布保持）。两条保存
//     路径的 yaml 均由 buildFolderYaml 组装（**等价手术优先**）：有 origin
//     且来源文件内容与画布等价（modelsEqualExceptTags，忽略 tags）→ 以文件
//     原文为基（tags 相同整写、不同只动 tags 行——**注释/排版保留**，与文件
//     夹页「标记/派生」同一手术纪律）；内容已真改/读取失败/无 origin →
//     toYaml() 全量序列化（绑在旧内容上的注释无从保留）+ 可选 tags 手术。
//     目录预填 localStorage fs-workflow-dir（文件夹页同键）→ 后端默认目录；
//     文件名缺 .yaml/.yml 后缀自动补 .yaml。保存成功更新 savedOrigin（后续
//     主按钮一键直达新路径）+ toast + 失效 ['folder-workflows'] + 关对话框；
//     失败对话框保留就地显错。与「保存」进数据库并存；校验门/busy 共用，
//     点击先 blur 冲刷。
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
//     文件夹导入的 YAML 解析失败时自动打开浮层展示原文+错误（model null、
//     toYaml() 导不出），修复后应用落地画布并退出「导入失败」态。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../api/client';
import type { WorkflowDetail as WorkflowDetailRow } from '../api/types';
import { parseWorkflowModel, setYamlTags } from '../api/workflowModel';
import type { WorkflowModel } from '../api/workflowModel';
import { validateWorkflow } from '../lib/validate';
import { useEditorStore } from '../store/editorStore';
import { DEMO_AGENT_KEYS } from '../components/Palette';
import EditableCanvas from '../components/EditableCanvas';
import PropertyPanel from '../components/PropertyPanel';

/** 深比较两个文档模型是否等价（**忽略 tags**——tags 差异永远走 setYamlTags
 *  手术通道，不构成「内容已变」）。用 JSON.stringify 直接比较的前提（成立）：
 *  两边都出自 parseWorkflowModel 的同一构造路径（文件侧刚解析、画布侧
 *  loadYaml 时解析），对象键为固定的构造插入序，无需稳定化键序。 */
function modelsEqualExceptTags(a: WorkflowModel, b: WorkflowModel): boolean {
  const strip = (m: WorkflowModel): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...m };
    delete copy.tags;
    return copy;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

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
  // 导入解析失败的原始 YAML（非 null = 处于「导入失败」态）：YAML 源码层的
  // 快照/错误展示改用它兜底（此时 model null，toYaml() 为空串导不出内容）。
  const [importFailedYaml, setImportFailedYaml] = useState<string | null>(null);
  // 文件夹工作流「在编辑器打开」入口（FolderWorkflows → navigate state）：
  // importedYaml 是权威内容 → 替代 loadBlank 直接 loadYaml；同时置 importedRef
  // 令下方种子换选 effect 跳过（导入的单节点 mock 文档不被自动改 agent）。
  // originDir/originFile（来源文件）：在 new 页据此显示「保存到文件夹」——把
  // 画布内容写回来源 git 文件夹的同名文件（与「保存」进数据库并存，用户自选）。
  const location = useLocation();
  const importedRef = useRef(false);
  const locationState = location.state as
    | { importedYaml?: unknown; originDir?: unknown; originFile?: unknown }
    | null;
  const importedYaml = locationState?.importedYaml;
  const hasImport = typeof importedYaml === 'string' && importedYaml.length > 0;
  const originDir =
    typeof locationState?.originDir === 'string' && locationState.originDir !== ''
      ? locationState.originDir
      : undefined;
  const originFile =
    typeof locationState?.originFile === 'string' && locationState.originFile !== ''
      ? locationState.originFile
      : undefined;
  const hasOrigin = originDir !== undefined && originFile !== undefined;
  // origin 可写化（通用化）：location.state 只读且随路由消失（new 保存成功
  // replace 后即丢），对话框/另存保存成功的路径记入本地 savedOrigin；
  // effectiveOrigin = savedOrigin ?? location.state 的 origin，驱动主按钮
  // 一键直存 vs 弹对话框的分流与「另存…」的显隐。
  const [savedOrigin, setSavedOrigin] = useState<{ dir: string; file: string } | null>(null);
  const effectiveOrigin = savedOrigin ?? (hasOrigin ? { dir: originDir!, file: originFile! } : null);
  useEffect(() => {
    if (isNew) {
      if (hasImport) {
        loadYaml(importedYaml as string); // 幂等：同一 YAML 重载为同一文档
        importedRef.current = true;
        // 导入解析失败（如文件夹里的坏 YAML）：loadYaml 不落地文档（model
        // 保持 null、画布为空），且 toYaml() 无从导出 → 自动打开 YAML 源码
        // 展示原文 + 解析错误，用户就地修复后「应用到画布」落地文档。
        if (useEditorStore.getState().parseErrors.length > 0) {
          setImportFailedYaml(importedYaml as string);
          setYamlDraft(importedYaml as string);
          setYamlErrors(useEditorStore.getState().parseErrors);
          setYamlOpen(true);
        }
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
  // folderFile 变体：「保存到文件夹」成功（已保存到 <file> ✓）。
  const [toast, setToast] = useState<{ name: string; created: boolean; folderFile?: string } | null>(null);
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

  // --- 保存到文件夹（通用化 + 另存派生）：一键写回 effectiveOrigin 或对话框
  // 选定路径。yaml 组装走 buildFolderYaml（**等价手术优先**）：有 origin 且来
  // 源文件内容与画布等价（忽略 tags）→ 以文件原文为基（保留注释/排版），只
  // 在 tags 有变时 setYamlTags 手术；内容已真改/无 origin/读取失败 → toYaml()
  // 全量序列化（绑在旧内容上的注释无从保留），对话框「标记」与画布 tags 不同
  // 再手术（model 本身不动：保存的是派生文件，画布保持原 tags）。校验门与
  // 「保存」一致（problems 非空禁用）；点击先 blur 冲刷属性面板的防抖提交
  // （复用 Ctrl+S 的冲刷纪律）再取文档。成功 → 记 savedOrigin + toast「已保存
  // 到 <file> ✓」+ 失效文件夹查询缓存 + 关对话框（若经对话框发起）；失败 →
  // mutation.error 就地显示（对话框开着显在对话框内，直存显在 fs-editor-msgs）。
  const [folderDlgOpen, setFolderDlgOpen] = useState(false);
  const [folderDir, setFolderDir] = useState('');
  const [folderFile, setFolderFile] = useState('');
  // 对话框「标记」草稿（中英文逗号切分，与属性面板「标签」同一约定）
  const [folderTags, setFolderTags] = useState('');
  const [folderError, setFolderError] = useState('');
  // onSuccess 里读对话框开闭（mutation 回调闭包的是渲染期值，ref 恒新）
  const folderDlgOpenRef = useRef(false);
  folderDlgOpenRef.current = folderDlgOpen;
  // 后端默认目录只静默取一次（首次打开且无 localStorage 缓存时；失败留空不重试）
  const folderDlgDirFetchedRef = useRef(false);

  const folderSaveMut = useMutation({
    mutationFn: (target: { dir: string; file: string; yaml: string }) =>
      api.saveFolderWorkflow(target),
    onSuccess: (_res, target) => {
      setSavedOrigin({ dir: target.dir, file: target.file }); // 后续主按钮一键直达（含另存改路径后的更新）
      qc.invalidateQueries({ queryKey: ['folder-workflows'] });
      window.clearTimeout(toastTimerRef.current);
      setToast({ name: '', created: false, folderFile: target.file });
      toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
      if (folderDlgOpenRef.current) {
        setFolderError('');
        setFolderDlgOpen(false);
      }
    },
  });

  /** 组装「保存到文件夹」的 yaml（直存/对话框两条路径共用）：内容未变优先
   *  等价手术——直存不再无条件 toYaml() 重排（那会丢掉来源文件的注释与排版，
   *  用户实测踩过：01-collect.yaml 被重写成序列化格式）。
   *  - 有 effectiveOrigin：静默 listFolderWorkflows(dir) 找来源文件，合法 →
   *    parseWorkflowModel 与画布比较（modelsEqualExceptTags，忽略 tags）：
   *    等价 → 以**文件原文**为基：targetTags 与文件 tags 相同 → 原文整写
   *    （零改动）；不同 → setYamlTags 只动 meta.tags 行（注释/排版保留）。
   *    网络/解析失败、文件不在（另存到的新路径）或内容已真改 → 走下述退回。
   *  - 退回路径（无 origin 或内容已变）：toYaml()；targetTags 与画布 tags
   *    不同再 setYamlTags（画布 model 恒不动）。 */
  const buildFolderYaml = async (targetTags: string[]): Promise<string> => {
    const model = useEditorStore.getState().model;
    if (model && effectiveOrigin) {
      try {
        const res = await api.listFolderWorkflows(effectiveOrigin.dir);
        const row = res.files.find((f) => f.file === effectiveOrigin.file);
        if (row && row.valid) {
          const parsed = parseWorkflowModel(row.yaml);
          if (parsed.model && modelsEqualExceptTags(parsed.model, model)) {
            const fileTags = parsed.model.tags ?? [];
            return targetTags.join('\u0000') === fileTags.join('\u0000')
              ? row.yaml // tags 也一致：文件原文整写（注释/排版一字不动）
              : setYamlTags(row.yaml, targetTags); // 只改 meta.tags：文档手术
          }
        }
      } catch {
        /* 读取/解析失败（网络、目录变化等）：退回全量序列化（后端校验兜底） */
      }
    }
    let yaml = useEditorStore.getState().toYaml();
    const modelTags = useEditorStore.getState().model?.tags ?? [];
    if (targetTags.join('\u0000') !== modelTags.join('\u0000')) {
      yaml = setYamlTags(yaml, targetTags); // 只改 meta.tags：序列化文本上的手术
    }
    return yaml;
  };

  /** 一键直存（有 effectiveOrigin 时主按钮路径）：目标 tags = 画布 tags——
   *  内容未变时保留来源文件注释/排版（buildFolderYaml 等价手术），已变则
   *  全量序列化。 */
  const saveToFolder = async () => {
    if (!effectiveOrigin) return; // 按钮已分流，防御性兜底
    (document.activeElement as HTMLElement | null)?.blur(); // 冲刷防抖提交
    if (folderSaveMut.isPending) return;
    try {
      const yaml = await buildFolderYaml(useEditorStore.getState().model?.tags ?? []);
      if (!folderSaveMut.isPending) folderSaveMut.mutate({ ...effectiveOrigin, yaml });
    } catch {
      // 手术抛错（理论不可达）：退回纯序列化保底，不让保存卡死
      if (!folderSaveMut.isPending) {
        folderSaveMut.mutate({ ...effectiveOrigin, yaml: useEditorStore.getState().toYaml() });
      }
    }
  };

  /** 打开「保存到文件夹/另存」对话框。prefill（另存/有 origin 改路径）：目录/
   *  文件名直接取之；否则目录预填 localStorage fs-workflow-dir（文件夹页同键）
   *  → 无则静默 listFolderWorkflows() 取后端默认目录 res.dir（失败留空），文件
   *  名取 model.name 合法化（trim，空则 workflow；不以 .yaml/.yml 结尾自动补
   *  .yaml）。「标记」初值恒为画布 model.tags join(', ')（导入文件时即文件 tags）。
   */
  const openFolderDialog = (prefill?: { dir: string; file: string }) => {
    folderSaveMut.reset(); // 清历史失败态：错误只属于本次对话框会话
    setFolderError('');
    setFolderTags(useEditorStore.getState().model?.tags?.join(', ') ?? '');
    if (prefill) {
      setFolderDir(prefill.dir);
      setFolderFile(prefill.file);
      setFolderDlgOpen(true);
      return;
    }
    const rawName = (useEditorStore.getState().model?.name ?? '').trim() || 'workflow';
    setFolderFile(/\.ya?ml$/i.test(rawName) ? rawName : `${rawName}.yaml`);
    const cached = localStorage.getItem('fs-workflow-dir');
    if (cached) {
      setFolderDir(cached);
      setFolderDlgOpen(true);
      return;
    }
    setFolderDir('');
    setFolderDlgOpen(true);
    if (folderDlgDirFetchedRef.current) return; // 已取过：成功值已在 state
    folderDlgDirFetchedRef.current = true;
    api
      .listFolderWorkflows() // 静默：失败留空（后端仍兜底目录校验）
      .then((res) => setFolderDir((cur) => (cur === '' ? res.dir : cur)))
      .catch(() => {});
  };

  const closeFolderDialog = () => {
    folderSaveMut.reset();
    setFolderError('');
    setFolderDlgOpen(false);
  };

  /** 对话框保存：客户端预校验（目录非空、文件名非空且无 / \、缺 .yaml/.yml
   *  后缀自动补 .yaml——后端仍兜底）→ blur 冲刷 → buildFolderYaml（与直存
   *  同一等价手术逻辑：另存到 origin 同路径且内容未变时保留文件原文；目标
   *  tags = 对话框「标记」，与画布 tags 不同则手术，model 不动）→
   *  saveFolderWorkflow；失败对话框保留并显示服务端错误。 */
  const saveViaDialog = async () => {
    const dir = folderDir.trim();
    let file = folderFile.trim();
    if (dir === '') {
      setFolderError('目录路径不能为空');
      return;
    }
    if (file === '') {
      setFolderError('文件名不能为空');
      return;
    }
    if (file.includes('/') || file.includes('\\')) {
      setFolderError('文件名不能包含 / 或 \\');
      return;
    }
    if (!/\.ya?ml$/i.test(file)) file = `${file}.yaml`;
    const dialogTags = folderTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t !== '');
    setFolderError('');
    (document.activeElement as HTMLElement | null)?.blur(); // 冲刷防抖提交
    // 手术抛错（toYaml 输出恒有 meta，理论不可达）→ 就地提示不发请求
    try {
      const yaml = await buildFolderYaml(dialogTags);
      if (!folderSaveMut.isPending) folderSaveMut.mutate({ dir, file, yaml });
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    }
  };

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
    if (importFailedYaml != null) {
      // 导入失败态：快照用导入原文（toYaml() 为空串），并回显 store 解析错误
      setYamlDraft(importFailedYaml);
      setYamlErrors(useEditorStore.getState().parseErrors);
      setYamlOpen(true);
      return;
    }
    setYamlDraft(useEditorStore.getState().toYaml());
    setYamlErrors([]);
    setYamlOpen(true);
  };
  // [刷新]：导入失败态且用户未修复时 toYaml() 为空串、草稿会被清空——可接受
  // （草稿原文已展示过；重新点「YAML 源码」按导入失败态兜底取回原文）。
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
    setImportFailedYaml(null); // 修复并应用成功：退出「导入失败」态
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
          {/* 保存到文件夹（通用化）：常驻按钮。有 effectiveOrigin → 一键写回该
              文件（title 示目标路径）；无 → 弹对话框选目录/文件名。与「保存」
              （进数据库）并存；校验门/busy 共用。 */}
          <button
            className="fs-btn"
            disabled={problems.length > 0 || folderSaveMut.isPending}
            title={
              problems.length > 0
                ? problems[0]
                : effectiveOrigin
                  ? `${effectiveOrigin.dir}\\${effectiveOrigin.file}`
                  : '选择目录与文件名，保存到 git 文件夹'
            }
            onClick={() => (effectiveOrigin ? saveToFolder() : openFolderDialog())}
          >
            {folderSaveMut.isPending ? '保存中…' : '保存到文件夹'}
          </button>
          {/* 另存到文件夹…（Save As 一等公民）：常驻按钮，总是弹对话框（预填
              effectiveOrigin ?? localStorage 目录 + 文件名合法化），可改目录/
              文件名并派生标记；成功后主按钮一键直达新路径。 */}
          <button
            className="fs-btn"
            disabled={problems.length > 0 || folderSaveMut.isPending}
            title="另存为新文件：可改目录、文件名与标记"
            onClick={() => openFolderDialog(effectiveOrigin ?? undefined)}
          >
            另存到文件夹…
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
      {folderSaveMut.isError && !folderDlgOpen && (
        <div className="fs-editor-msgs">
          <span className="fs-error-text">
            保存到文件夹失败：{String((folderSaveMut.error as Error)?.message ?? folderSaveMut.error)}
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

      {/* 保存到文件夹/另存对话框（fs-folderdlg）：目录/文件名/标记三字段，
          预检与服务端错误就地显示（失败不关，可改可取消）。 */}
      {folderDlgOpen && (
        <div className="fs-folderdlg" role="dialog" aria-label="保存到文件夹">
          <div className="fs-folderdlg__card">
            <h3 className="fs-folderdlg__title">保存到文件夹</h3>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-folderdlg-dir">
                目录路径
              </label>
              <input
                id="fs-folderdlg-dir"
                className="fs-form-input"
                value={folderDir}
                placeholder="如 D:\team-repo\workflows（留空用默认目录）"
                onChange={(e) => setFolderDir(e.target.value)}
              />
            </div>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-folderdlg-file">
                文件名
              </label>
              <input
                id="fs-folderdlg-file"
                className="fs-form-input"
                value={folderFile}
                placeholder="如 my-workflow.yaml（缺 .yaml/.yml 自动补全）"
                onChange={(e) => setFolderFile(e.target.value)}
              />
            </div>
            <div className="fs-folderdlg__field">
              <label className="fs-form-label" htmlFor="fs-folderdlg-tags">
                标记
              </label>
              <input
                id="fs-folderdlg-tags"
                className="fs-form-input"
                value={folderTags}
                placeholder="逗号分隔，首个用于文件夹页分组；留空=不写标记（仅影响本次保存的文件）"
                onChange={(e) => setFolderTags(e.target.value)}
              />
            </div>
            {(folderError || folderSaveMut.isError) && (
              <div className="fs-error-text fs-folderdlg__error">
                {folderError ||
                  `保存失败：${String((folderSaveMut.error as Error)?.message ?? folderSaveMut.error)}`}
              </div>
            )}
            <div className="fs-folderdlg__actions">
              <button type="button" className="fs-btn" disabled={folderSaveMut.isPending} onClick={closeFolderDialog}>
                取消
              </button>
              <button type="button" className="fs-btn fs-btn--primary" disabled={folderSaveMut.isPending} onClick={saveViaDialog}>
                {folderSaveMut.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 保存成功 toast（save-ux）：右下角 2.2s 自动消失 */}
      {toast && (
        <div className="fs-toast" role="status" data-testid="save-toast">
          {toast.folderFile !== undefined ? (
            <span className="fs-toast__check">已保存到 {toast.folderFile} ✓</span>
          ) : (
            <>
              <span className="fs-toast__check">✓ 已保存</span>
              {toast.name && <span className="fs-toast__name">{toast.name}</span>}
              {toast.created && <span className="fs-toast__created">· 已创建</span>}
            </>
          )}
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
