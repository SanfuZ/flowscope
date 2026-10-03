// Task 5：属性面板（三态表单），由 store.selected 驱动：
//   ① node 态 —— 节点属性：id（失焦提交，输入即时查重就地红字但仍允许提交——保存门统一拦）/
//      agent 下拉（listAgents，onChange 提交）/ prompt（onChange 防抖 300ms + 失焦立即冲刷，
//      点画布丢输入的 UX 陷阱已消）/
//      retry.max + retry.backoff_ms + timeout_ms（数字，空串 = 删除字段）/
//      output_schema（失焦 JSON.parse：成功提交解析对象，失败红框不提交，空串删字段）/ 删除节点。
//   ② edge 态 —— 条件边：结构化三件套（字段路径/操作符/值）任一变更即拼装 when 提交；
//      「高级：直接编辑表达式」details 内 raw textarea 失焦提交原文（语法校验失败红框不动
//      store）；when 变更（提交回写/撤销/清除）后三件套随之回填——解析镜像 lib/validate
//      的 when 文法（== / contains，contains 仅字符串字面量；多原子 and 结构化表达不了，
//      三件套留空、仅 raw 可表达）。「清除条件」when → undefined；「删除连线」删边并清选中。
//   ③ settings 态（selected 为 null 或 {type:'settings'}）—— name（失焦）/ version（失焦）/
//      params 键值编辑器（行 = 参数名 + 参数值 + 删除；「添加参数」追加空行；值按标量解析
//      true/false → 布尔、整数 → number、其余字符串；任一行失焦整体提交 updateModelMeta）/
//      新节点默认（T2：retry/backoff/timeout 三数字，失焦提交 updateNodeDefaults——
//      编辑器偏好，不进历史不置脏，只影响此后 addNode 的播种，0=不重试/不限时）。
// 公共底部：problems 逐条红字展示，空数组显示「✓ 校验通过」。
// 提交纪律：受控读 store，本地草稿 + 失焦/防抖/受控 onChange 时刻写 store；
// 历史（pushHistory）与 dirty 由 store 动作统一管理，面板不触碰 past/future。
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { EdgeModel, NodeModel } from '../api/workflowModel';
import { useEditorStore } from '../store/editorStore';

type Op = '==' | 'contains';

/** when 三件套：path 含 output. 前缀；value 为字符串字面量去引号后的原文。 */
interface WhenParts {
  path: string;
  op: Op;
  value: string;
}

const EMPTY_PARTS: WhenParts = { path: '', op: '==', value: '' };

function isQuoted(s: string): boolean {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"');
}

function isIntLiteral(s: string): boolean {
  return /^-?\d+$/.test(s);
}

function isValidPath(path: string): boolean {
  return path.startsWith('output.') && path.length > 'output.'.length;
}

/** 解析单原子 when（镜像 lib/validate checkAtom：先 == 后 contains）。不可解析 → null。 */
function parseWhenAtom(atom: string): WhenParts | null {
  const t = atom.trim();
  const eq = t.indexOf(' == ');
  if (eq !== -1) {
    const path = t.slice(0, eq).trim();
    const lit = t.slice(eq + 4).trim();
    if (!isValidPath(path)) return null;
    if (lit === 'true' || lit === 'false' || isIntLiteral(lit)) return { path, op: '==', value: lit };
    if (isQuoted(lit)) return { path, op: '==', value: lit.slice(1, -1) };
    return null;
  }
  const cont = t.indexOf(' contains ');
  if (cont !== -1) {
    const path = t.slice(0, cont).trim();
    const lit = t.slice(cont + ' contains '.length).trim();
    if (!isValidPath(path)) return null;
    if (!isQuoted(lit)) return null; // contains 仅支持字符串字面量（镜像后端）
    return { path, op: 'contains', value: lit.slice(1, -1) };
  }
  return null;
}

/** when 语法整体校验（and 连接的多原子也认），返回就地错误消息或 null。 */
function whenSyntaxError(expr: string): string | null {
  for (const a of expr.trim().split(' and ')) {
    if (parseWhenAtom(a) === null) {
      return `无法解析条件（仅支持 output.<path> == 字面量 / contains "字符串"，可用 and 连接）: ${a.trim()}`;
    }
  }
  return null;
}

/** 三件套 → when 表达式。引号策略：值已双引号包裹原样保留（避免双重包裹）；
 *  == 时 true/false/整数裸值；其余（contains 一律、== 的其它文本）自动包引号。
 *  字段路径容错：用户手输 output. 前缀则剥去再统一拼（'output.ok' 与 'ok' 等价）。 */
function assembleWhen(pathRaw: string, op: Op, valueRaw: string): string {
  const path = pathRaw.trim().replace(/^output\./, '');
  const v = valueRaw.trim();
  const bare = op === '==' && (v === 'true' || v === 'false' || isIntLiteral(v));
  const literal = isQuoted(v) || bare ? v : `"${v}"`;
  return `output.${path} ${op} ${literal}`;
}

/** params 表单文本 → 文档标量：true/false → 布尔、整数 → number、其余字符串。 */
function parseParamScalar(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

interface ParamRow {
  k: string;
  v: string;
}

function toParamRows(params: Record<string, string | number | boolean>): ParamRow[] {
  return Object.entries(params).map(([k, v]) => ({ k, v: String(v) }));
}

export default function PropertyPanel({ problems }: { problems: string[] }): JSX.Element {
  const selected = useEditorStore((s) => s.selected);
  const model = useEditorStore((s) => s.model);

  let body: JSX.Element;
  if (model == null) {
    body = <div className="fs-prop__empty">未载入文档</div>;
  } else if (selected?.type === 'node') {
    const node = model.nodes.find((n) => n.id === selected.id);
    body = node ? (
      // key = 节点 id：切换节点/改名后重挂载，草稿自然重置
      <NodeForm key={node.id} node={node} />
    ) : (
      <div className="fs-prop__empty">节点已不存在（可能已被删除或撤销）</div>
    );
  } else if (selected?.type === 'edge') {
    // 画布侧 selected.id 约定为 `${from}->${to}`
    const raw = selected.id ?? '';
    const sep = raw.indexOf('->');
    const from = sep === -1 ? raw : raw.slice(0, sep);
    const to = sep === -1 ? '' : raw.slice(sep + 2);
    const edge = model.edges.find((e) => e.from === from && e.to === to);
    body = edge ? (
      <EdgeForm key={`${edge.from}->${edge.to}`} edge={edge} />
    ) : (
      <div className="fs-prop__empty">连线已不存在（可能已被删除或撤销）</div>
    );
  } else {
    // selected 为 null 或 {type:'settings'} → 工作流设置
    body = <SettingsForm />;
  }

  return (
    <aside className="fs-prop" data-testid="property-panel">
      <div className="fs-prop__body">{body}</div>
      <div className="fs-prop__problems" data-testid="pp-problems">
        {problems.length === 0 ? (
          <div className="fs-ok-text">✓ 校验通过</div>
        ) : (
          problems.map((p, i) => (
            <div key={i} className="fs-error-text">
              {p}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function NodeForm({ node }: { node: NodeModel }) {
  const updateNode = useEditorStore((s) => s.updateNode);
  const removeNode = useEditorStore((s) => s.removeNode);
  const setSelection = useEditorStore((s) => s.setSelection);
  const model = useEditorStore((s) => s.model);
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api.listAgents() });
  const agents = agentsQuery.data;

  // id：失焦提交；输入过程即时查重（与其它节点比）就地红字，仍允许提交
  const [idDraft, setIdDraft] = useState(node.id);
  const idTrimmed = idDraft.trim();
  const idDuplicate =
    idTrimmed !== node.id && model != null && model.nodes.some((n) => n.id === idTrimmed);

  // prompt：onChange 防抖 300ms 提交；卸载时撤销挂起的提交
  const [promptDraft, setPromptDraft] = useState(node.prompt);
  const promptTimer = useRef<number | null>(null);
  useEffect(() => {
    setPromptDraft(node.prompt);
  }, [node.prompt]);
  useEffect(
    () => () => {
      if (promptTimer.current !== null) window.clearTimeout(promptTimer.current);
    },
    [],
  );

  // output_schema：失焦 JSON.parse 校验；非法红框不提交；空串删字段
  const stringifySchema = (v: unknown): string =>
    v === undefined ? '' : JSON.stringify(v, null, 2);
  const [schemaDraft, setSchemaDraft] = useState(() => stringifySchema(node.output_schema));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  useEffect(() => {
    setSchemaDraft(stringifySchema(node.output_schema));
    setSchemaError(null);
    // eslint 的 exhaustive-deps 不在门禁内；stringifySchema 为纯局部纯函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.output_schema]);

  const commitPrompt = (v: string) => {
    if (promptTimer.current !== null) window.clearTimeout(promptTimer.current);
    promptTimer.current = window.setTimeout(() => {
      promptTimer.current = null;
      updateNode(node.id, { prompt: v });
    }, 300);
  };

  /** 失焦立即冲刷挂起的防抖：点画布/切换选中必先失焦，输入不因 300ms 窗口而丢。
   *  草稿与 store 一致（或防抖已落定）时为 no-op。 */
  const flushPrompt = () => {
    if (promptTimer.current !== null) {
      window.clearTimeout(promptTimer.current);
      promptTimer.current = null;
    }
    if (promptDraft !== node.prompt) updateNode(node.id, { prompt: promptDraft });
  };

  const commitSchema = () => {
    const t = schemaDraft.trim();
    if (t === '') {
      setSchemaError(null);
      updateNode(node.id, { output_schema: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(t);
      setSchemaError(null);
      updateNode(node.id, { output_schema: parsed });
    } catch (e) {
      setSchemaError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // retry：空串删除整个 retry 字段；另一分量保持原值（backoff 缺省 1000，max 缺省 3）
  const commitRetryMax = (v: string) => {
    updateNode(node.id, {
      retry: v === '' ? undefined : { max: Number(v), backoff_ms: node.retry?.backoff_ms ?? 1000 },
    });
  };
  const commitRetryBackoff = (v: string) => {
    updateNode(node.id, {
      retry: v === '' ? undefined : { max: node.retry?.max ?? 3, backoff_ms: Number(v) },
    });
  };
  const commitTimeout = (v: string) => {
    updateNode(node.id, { timeout_ms: v === '' ? undefined : Number(v) });
  };

  return (
    <div>
      <h3 className="fs-prop__title">节点属性</h3>

      <div className="fs-form-row">
        <label className="fs-form-label">
          节点 ID
          <input
            className="fs-form-input"
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={() => updateNode(node.id, { id: idTrimmed })}
          />
        </label>
        {idDuplicate && (
          <div className="fs-form-hint fs-error-text">节点 id 与其它节点重复: {idTrimmed}</div>
        )}
      </div>

      {/* Agent 下拉不过滤演示 agent（与 Palette 相反）：属性面板服务于已存在的
          文档——存量 mock 工作流仍需可查看/改选/运行，屏蔽会让它们失去可编辑性；
          「隐藏演示 agent」只是新建引导语义，故仅 Palette 收敛列表。 */}
      <div className="fs-form-row">
        <label className="fs-form-label">
          Agent
          <select
            className="fs-form-input"
            value={node.agent}
            onChange={(e) => updateNode(node.id, { agent: e.target.value })}
          >
            {agents == null ? (
              <option value="">加载 agent…</option>
            ) : (
              agents.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name} ({a.key})
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      <div className="fs-form-row">
        <label className="fs-form-label">
          Prompt
          <textarea
            className="fs-form-input"
            rows={6}
            value={promptDraft}
            onChange={(e) => {
              setPromptDraft(e.target.value);
              commitPrompt(e.target.value);
            }}
            onBlur={flushPrompt}
          />
        </label>
      </div>

      <div className="fs-form-grid">
        <div className="fs-form-row">
          <label className="fs-form-label">
            重试次数
            <input
              className="fs-form-input"
              type="number"
              value={node.retry?.max ?? ''}
              onChange={(e) => commitRetryMax(e.target.value)}
            />
          </label>
        </div>
        <div className="fs-form-row">
          <label className="fs-form-label">
            重试退避(ms)
            <input
              className="fs-form-input"
              type="number"
              value={node.retry?.backoff_ms ?? ''}
              onChange={(e) => commitRetryBackoff(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="fs-form-row">
        <label className="fs-form-label">
          超时(ms)
          <input
            className="fs-form-input"
            type="number"
            value={node.timeout_ms ?? ''}
            onChange={(e) => commitTimeout(e.target.value)}
          />
        </label>
      </div>

      <div className="fs-form-row">
        <label className="fs-form-label">
          输出 Schema (JSON)
          <textarea
            className={`fs-form-input${schemaError !== null ? ' fs-form-input--error' : ''}`}
            rows={4}
            value={schemaDraft}
            onChange={(e) => setSchemaDraft(e.target.value)}
            onBlur={commitSchema}
          />
        </label>
        {schemaError !== null && <div className="fs-form-hint fs-error-text">{schemaError}</div>}
      </div>

      <button
        type="button"
        className="fs-btn fs-btn--danger"
        onClick={() => {
          removeNode(node.id);
          setSelection(null);
        }}
      >
        删除节点
      </button>
    </div>
  );
}

function EdgeForm({ edge }: { edge: EdgeModel }) {
  const updateEdge = useEditorStore((s) => s.updateEdge);
  const removeEdge = useEditorStore((s) => s.removeEdge);
  const setSelection = useEditorStore((s) => s.setSelection);

  // 结构化三件套与 raw 表达式共享 store 的 when 为事实源；本地仅草稿
  const [parts, setParts] = useState<WhenParts>(
    edge.when !== undefined ? (parseWhenAtom(edge.when) ?? EMPTY_PARTS) : EMPTY_PARTS,
  );
  const [rawDraft, setRawDraft] = useState(edge.when ?? '');
  const [rawError, setRawError] = useState<string | null>(null);

  // store 的 when 变更（结构化/raw 提交回写、撤销重做、清除）→ 双向同步回填
  useEffect(() => {
    setParts(edge.when !== undefined ? (parseWhenAtom(edge.when) ?? EMPTY_PARTS) : EMPTY_PARTS);
    setRawDraft(edge.when ?? '');
    setRawError(null);
  }, [edge.from, edge.to, edge.when]);

  /** 三件套任一变更即拼装提交；path/value 未齐不拼半成品（清除另有按钮）。 */
  const commitParts = (next: WhenParts) => {
    setParts(next);
    if (next.path.trim() === '' || next.value.trim() === '') return;
    updateEdge(edge.from, edge.to, { when: assembleWhen(next.path, next.op, next.value) });
  };

  /** raw 失焦：空 = 清除（无条件边）；语法非法红框不提交；合法提交原文（三件套随回填）。 */
  const commitRaw = () => {
    const t = rawDraft.trim();
    if (t === '') {
      setRawError(null);
      updateEdge(edge.from, edge.to, { when: undefined });
      return;
    }
    const err = whenSyntaxError(t);
    if (err !== null) {
      setRawError(err);
      return;
    }
    setRawError(null);
    updateEdge(edge.from, edge.to, { when: t });
  };

  return (
    <div>
      <h3 className="fs-prop__title">
        连线：{edge.from} → {edge.to}
      </h3>

      <div className="fs-form-row">
        <label className="fs-form-label">
          字段路径
          <input
            className="fs-form-input"
            placeholder="output.ok"
            value={parts.path}
            onChange={(e) => commitParts({ ...parts, path: e.target.value })}
          />
        </label>
      </div>

      <div className="fs-form-grid">
        <div className="fs-form-row">
          <label className="fs-form-label">
            操作符
            <select
              className="fs-form-input"
              value={parts.op}
              onChange={(e) => commitParts({ ...parts, op: e.target.value as Op })}
            >
              <option value="==">==</option>
              <option value="contains">contains</option>
            </select>
          </label>
        </div>
        <div className="fs-form-row">
          <label className="fs-form-label">
            值
            <input
              className="fs-form-input"
              placeholder='true 或 "文本"'
              value={parts.value}
              onChange={(e) => commitParts({ ...parts, value: e.target.value })}
            />
          </label>
        </div>
      </div>

      <details className="fs-prop__raw">
        <summary>高级：直接编辑表达式</summary>
        <div className="fs-form-row">
          <label className="fs-form-label">
            when 表达式
            <textarea
              className={`fs-form-input${rawError !== null ? ' fs-form-input--error' : ''}`}
              rows={3}
              value={rawDraft}
              onChange={(e) => setRawDraft(e.target.value)}
              onBlur={commitRaw}
            />
          </label>
          {rawError !== null && <div className="fs-form-hint fs-error-text">{rawError}</div>}
        </div>
      </details>

      <div className="fs-prop__actions">
        <button
          type="button"
          className="fs-btn"
          onClick={() => updateEdge(edge.from, edge.to, { when: undefined })}
        >
          清除条件
        </button>
        <button
          type="button"
          className="fs-btn fs-btn--danger"
          onClick={() => {
            removeEdge(edge.from, edge.to);
            setSelection(null);
          }}
        >
          删除连线
        </button>
      </div>
    </div>
  );
}

function SettingsForm() {
  // 父组件保证 model 非空才挂载本表单
  const model = useEditorStore((s) => s.model)!;
  const updateModelMeta = useEditorStore((s) => s.updateModelMeta);
  // T2：新节点默认偏好（编辑器偏好，非文档内容）——updateNodeDefaults 不进
  // 历史、不置脏，本区因此不参与脏标记，也不进撤销栈
  const newNodeDefaults = useEditorStore((s) => s.newNodeDefaults);
  const updateNodeDefaults = useEditorStore((s) => s.updateNodeDefaults);

  const [nameDraft, setNameDraft] = useState(model.name);
  const [versionDraft, setVersionDraft] = useState(String(model.version));
  const [rows, setRows] = useState<ParamRow[]>(() => toParamRows(model.params));

  // 新节点默认三个数字输入：本地草稿 + 失焦提交（镜像 version 字段的失焦纪律）
  const [retryMaxDraft, setRetryMaxDraft] = useState(String(newNodeDefaults.retryMax));
  const [backoffMsDraft, setBackoffMsDraft] = useState(String(newNodeDefaults.backoffMs));
  const [timeoutMsDraft, setTimeoutMsDraft] = useState(String(newNodeDefaults.timeoutMs));

  // store 回写/撤销重做/切换文档 → 草稿回填。依赖各字段自身标识：
  // params 以引用为依赖，仅 params 提交时变化，其它字段编辑不会误清行草稿；
  // 新节点默认以对象引用为依赖（updateNodeDefaults 每次整体换引用）
  useEffect(() => {
    setNameDraft(model.name);
  }, [model.name]);
  useEffect(() => {
    setVersionDraft(String(model.version));
  }, [model.version]);
  useEffect(() => {
    setRows(toParamRows(model.params));
  }, [model.params]);
  useEffect(() => {
    setRetryMaxDraft(String(newNodeDefaults.retryMax));
    setBackoffMsDraft(String(newNodeDefaults.backoffMs));
    setTimeoutMsDraft(String(newNodeDefaults.timeoutMs));
  }, [newNodeDefaults]);

  /** 任一行失焦/删行：整体提交 params（空名行跳过；后同名覆盖先名）。 */
  const commitParams = (next: ParamRow[]) => {
    const params: Record<string, string | number | boolean> = {};
    for (const r of next) {
      const k = r.k.trim();
      if (k === '') continue;
      params[k] = parseParamScalar(r.v);
    }
    updateModelMeta({ params });
  };

  /** 新节点默认数字失焦提交：空串 = 放弃编辑保留现值（偏好无「未设」语义）；
   *  负数/非有限数不提交；0 合法（0=不重试/不限时，addNode 省略对应字段）。 */
  const commitDefaultNum = (v: string, apply: (n: number) => void) => {
    const t = v.trim();
    if (t === '') return;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return;
    apply(n);
  };

  return (
    <div>
      <h3 className="fs-prop__title">工作流设置</h3>

      <div className="fs-form-row">
        <label className="fs-form-label">
          名称
          <input
            className="fs-form-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => updateModelMeta({ name: nameDraft })}
          />
        </label>
      </div>

      <div className="fs-form-row">
        <label className="fs-form-label">
          版本
          <input
            className="fs-form-input"
            type="number"
            value={versionDraft}
            onChange={(e) => setVersionDraft(e.target.value)}
            onBlur={() => {
              const n = Number(versionDraft);
              if (versionDraft.trim() !== '' && Number.isFinite(n)) updateModelMeta({ version: n });
            }}
          />
        </label>
      </div>

      <div className="fs-form-row">
        <div className="fs-form-label">参数</div>
        {rows.map((r, i) => (
          <div className="fs-params-row" key={i}>
            <label className="fs-form-label fs-params-row__field">
              参数名
              <input
                className="fs-form-input"
                value={r.k}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                onBlur={() => commitParams(rows)}
              />
            </label>
            <label className="fs-form-label fs-params-row__field">
              参数值
              <input
                className="fs-form-input"
                value={r.v}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                onBlur={() => commitParams(rows)}
              />
            </label>
            <button
              type="button"
              className="fs-btn fs-btn--ghost"
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                setRows(next);
                commitParams(next);
              }}
            >
              删除
            </button>
          </div>
        ))}
        <button type="button" className="fs-btn" onClick={() => setRows([...rows, { k: '', v: '' }])}>
          添加参数
        </button>
      </div>

      {/* T2：新节点默认——只影响此后 addNode 的播种值，不改已存在节点。
          失焦提交 updateNodeDefaults（不进历史/不置脏，本区无脏标记语义）。 */}
      <div className="fs-form-row">
        <div className="fs-form-label">新节点默认</div>
        <div className="fs-form-grid">
          <div className="fs-form-row">
            <label className="fs-form-label">
              新节点重试次数
              <input
                className="fs-form-input"
                type="number"
                min={0}
                value={retryMaxDraft}
                onChange={(e) => setRetryMaxDraft(e.target.value)}
                onBlur={() => commitDefaultNum(retryMaxDraft, (n) => updateNodeDefaults({ retryMax: n }))}
              />
            </label>
            <div className="fs-form-hint">0=不重试</div>
          </div>
          <div className="fs-form-row">
            <label className="fs-form-label">
              新节点重试退避(ms)
              <input
                className="fs-form-input"
                type="number"
                min={0}
                value={backoffMsDraft}
                onChange={(e) => setBackoffMsDraft(e.target.value)}
                onBlur={() => commitDefaultNum(backoffMsDraft, (n) => updateNodeDefaults({ backoffMs: n }))}
              />
            </label>
          </div>
          <div className="fs-form-row">
            <label className="fs-form-label">
              新节点超时(ms)
              <input
                className="fs-form-input"
                type="number"
                min={0}
                value={timeoutMsDraft}
                onChange={(e) => setTimeoutMsDraft(e.target.value)}
                onBlur={() => commitDefaultNum(timeoutMsDraft, (n) => updateNodeDefaults({ timeoutMs: n }))}
              />
            </label>
            <div className="fs-form-hint">0=不限时</div>
          </div>
        </div>
      </div>
    </div>
  );
}
