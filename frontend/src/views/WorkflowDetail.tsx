// 工作流详情（`/workflows/:id`，`new` 为新建）：
// YAML 编辑 + 保存 + 只读 DAG 预览（编辑实时重排）+ 启动（params 为自由 JSON 文本域）。
//
// 【M1 简化（控制器裁定）】启动参数不做表单生成，直接给 JSON 文本域（默认 {}）；
// 后端 startRun 请求体契约见 client.ts。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlow, type Edge } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, parseWorkflowGraph } from '../api/client';
import type { WorkflowGraph } from '../api/types';
import { layoutGraph } from '../lib/layout';
import { nodeTypes } from '../lib/nodeTypes';

const DEFAULT_YAML = `meta: {name: my-workflow, version: 1}
nodes:
  - {id: step1, agent: mock, prompt: "你好"}
edges: []
`;

export default function WorkflowDetail() {
  const { id = '' } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const wfQuery = useQuery({
    queryKey: ['workflow', id],
    queryFn: () => api.getWorkflow(id),
    enabled: !isNew,
  });

  const [yamlText, setYamlText] = useState(DEFAULT_YAML);
  useEffect(() => {
    if (wfQuery.data) setYamlText(wfQuery.data.yaml);
  }, [wfQuery.data]);

  // 编辑实时预览：从当前文本重新提取图
  const graph = useMemo(() => parseWorkflowGraph(yamlText), [yamlText]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.saveWorkflow(wfQuery.data?.name ?? '', wfQuery.data?.version ?? 1, yamlText),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow'] });
      if (isNew) navigate(`/workflows/${res.id}`, { replace: true });
    },
  });

  // --- 启动（M1：自由 JSON params） ---
  const [paramsText, setParamsText] = useState('{}');
  const [launchError, setLaunchError] = useState('');
  const [launching, setLaunching] = useState(false);

  const launch = async () => {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(paramsText.trim() === '' ? '{}' : paramsText);
    } catch (e) {
      setLaunchError(`params 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setLaunchError('');
    setLaunching(true);
    try {
      const res = await api.startRun(id, params);
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
      setLaunching(false);
    }
  };

  return (
    <div className="fs-page">
      <header className="fs-page__head">
        <h1>{isNew ? '新建工作流' : `工作流：${wfQuery.data?.name ?? id}`}</h1>
        <span className="fs-muted">{isNew ? '保存后生成 ID' : wfQuery.data ? `v${wfQuery.data.version} · ${id}` : ''}</span>
      </header>
      {wfQuery.isError && (
        <div className="fs-error-text">加载失败：{String((wfQuery.error as Error)?.message ?? wfQuery.error)}</div>
      )}
      <div className="fs-wfdetail">
        <section className="fs-wfdetail__editor">
          <h3>YAML</h3>
          <textarea
            className="fs-yaml"
            value={yamlText}
            spellCheck={false}
            onChange={(e) => setYamlText(e.target.value)}
            rows={20}
          />
          <div className="fs-wfdetail__actions">
            <button className="fs-btn" disabled={saveMut.isPending || yamlText.trim() === ''} onClick={() => saveMut.mutate()}>
              {saveMut.isPending ? '保存中…' : '保存'}
            </button>
            {saveMut.isError && (
              <span className="fs-error-text">保存失败：{String((saveMut.error as Error)?.message ?? saveMut.error)}</span>
            )}
            {saveMut.isSuccess && !isNew && <span className="fs-ok-text">已保存</span>}
          </div>
        </section>
        <section className="fs-wfdetail__side">
          <h3>DAG 预览（只读，编辑实时更新）</h3>
          <GraphPreview graph={graph} />
          <h3>启动</h3>
          <label className="fs-label">
            params（JSON，M1 不做表单生成）
            <textarea
              className="fs-params"
              value={paramsText}
              spellCheck={false}
              onChange={(e) => setParamsText(e.target.value)}
              rows={4}
            />
          </label>
          <div className="fs-wfdetail__actions">
            <button
              className="fs-btn fs-btn--primary"
              disabled={isNew || graph.nodes.length === 0 || launching}
              onClick={launch}
              title={isNew ? '请先保存' : graph.nodes.length === 0 ? '未解析到节点' : undefined}
            >
              {launching ? '启动中…' : '启动运行'}
            </button>
            {launchError && <span className="fs-error-text">{launchError}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 只读预览：全部 pending 样式，与监控画布同一 NodeCard。 */
function GraphPreview({ graph }: { graph: WorkflowGraph }) {
  const pos = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph]);
  const nodes = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'agent' as const,
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { id: n.id, agent: n.agent, status: 'pending' as const },
      })),
    [graph, pos],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        label: e.when,
      })),
    [graph],
  );

  if (graph.nodes.length === 0) {
    return <div className="fs-muted fs-preview">未从 YAML 解析到节点（检查顶层 nodes: 段）</div>;
  }
  return (
    <div className="fs-preview">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.2}
      />
    </div>
  );
}
