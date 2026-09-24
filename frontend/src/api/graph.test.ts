import { describe, expect, it } from 'vitest';
import { parseWorkflowGraph } from './graph';
import { parseWorkflowModel, serializeWorkflowYaml } from './workflowModel';

const VALID = `meta: {name: demo, version: 3}
params: {week: "W38"}
nodes:
  - id: collect
    agent: enterprise
    prompt: "收集 {{ params.week }}"
  - id: analyze
    agent: enterprise
    prompt: "分析 {{ nodes.collect.output }}"
    output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}
    retry: {max: 2, backoff_ms: 3000}
    timeout_ms: 600000
edges:
  - {from: collect, to: analyze}
  - {from: analyze, to: report, when: "output.ok == true"}
`;

describe('parseWorkflowGraph：workflowModel 薄适配', () => {
  it('解析完整 YAML（含 block 风格与嵌套 output_schema）', () => {
    const g = parseWorkflowGraph(VALID);
    expect(g.nodes.map((n) => n.id)).toEqual(['collect', 'analyze']);
    expect(g.edges[1]).toEqual({ from: 'analyze', to: 'report', when: 'output.ok == true' });
  });

  it('flow 风格（种子 weekly-report 同款，params 为标量映射）', () => {
    const yaml = [
      '# 示例：3 节点线性周报（collect → analyze → report）',
      'meta: {name: weekly-report, version: 1}',
      'params: {week: "W38"}',
      'nodes:',
      '  - {id: collect, agent: mock, prompt: 收集数据}',
      '  - {id: analyze, agent: mock, prompt: 分析}',
      '  - {id: report, agent: mock, prompt: "基于分析撰写 {{ params.week }} 周报"}',
      'edges:',
      '  - {from: collect, to: analyze}',
      '  - {from: analyze, to: report}',
      '',
    ].join('\n');
    const g = parseWorkflowGraph(yaml);
    expect(g.nodes.map((n) => [n.id, n.agent])).toEqual([
      ['collect', 'mock'],
      ['analyze', 'mock'],
      ['report', 'mock'],
    ]);
    expect(g.edges).toEqual([
      { from: 'collect', to: 'analyze' },
      { from: 'analyze', to: 'report' },
    ]);
  });

  it('block 风格（多行 prompt 与嵌套 retry）', () => {
    const yaml = [
      'meta:',
      '  name: blocky',
      '  version: 2',
      'nodes:',
      '  - id: collect',
      '    agent: mock',
      '    prompt: |',
      '      多行提示词',
      '      第二行',
      '    retry: {max: 2, backoff_ms: 100}',
      '  - id: report',
      '    agent: bad-mock',
      '    prompt: 写报告',
      'edges:',
      '  - from: collect',
      '    to: report',
      '    when: output.ok == true',
      '',
    ].join('\n');
    const g = parseWorkflowGraph(yaml);
    expect(g.nodes).toEqual([
      { id: 'collect', agent: 'mock' },
      { id: 'report', agent: 'bad-mock' },
    ]);
    expect(g.edges).toEqual([{ from: 'collect', to: 'report', when: 'output.ok == true' }]);
  });

  it('nodes 可缺省（空工作流合法加载）→ 空图而非报错路径', () => {
    expect(parseWorkflowGraph('meta: {name: x}\n')).toEqual({ nodes: [], edges: [] });
  });

  it('对非法 YAML / 结构不符返回空图（兜底不抛异常）', () => {
    expect(parseWorkflowGraph('::::not yaml')).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowGraph('meta: [broken')).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowGraph('foo: bar\n')).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowGraph('')).toEqual({ nodes: [], edges: [] });
  });
});

describe('parseWorkflowModel / serializeWorkflowYaml', () => {
  it('全字段解析 + serialize 往返', () => {
    const { model, errors } = parseWorkflowModel(VALID);
    expect(errors).toEqual([]);
    expect(model!.params).toEqual({ week: 'W38' });
    expect(model!.nodes[1].retry).toEqual({ max: 2, backoff_ms: 3000 });
    expect(model!.nodes[1].timeout_ms).toBe(600000);
    const back = parseWorkflowModel(serializeWorkflowYaml(model!));
    expect(back.errors).toEqual([]);
    expect(back.model).toEqual(model);
  });

  it('非字典/缺 meta/nodes 非 list/未知顶层键 → errors 非空', () => {
    expect(parseWorkflowModel('- a\n- b').errors.length).toBeGreaterThan(0);
    expect(parseWorkflowModel('foo: bar\n').errors.some((e) => /meta|顶层/.test(e))).toBe(true);
    expect(parseWorkflowModel('meta: {name: x, version: 1}\nnodes: 5\n').errors.length).toBeGreaterThan(0);
    const unknown = parseWorkflowModel('meta: {name: x}\nextra: 1\n');
    expect(unknown.errors.some((e) => e.includes('后端将拒绝'))).toBe(true);
    expect(unknown.model).toBeUndefined();
  });

  it('节点缺 id / 缺 agent / 非字符串 prompt、边缺 from/to → errors 非空', () => {
    expect(parseWorkflowModel('meta: {name: x}\nnodes:\n  - agent: m\n').errors.length).toBeGreaterThan(0);
    expect(parseWorkflowModel('meta: {name: x}\nnodes:\n  - id: a\n').errors.length).toBeGreaterThan(0);
    expect(
      parseWorkflowModel('meta: {name: x}\nnodes:\n  - id: a\n    agent: m\n    prompt: 5\n').errors.length,
    ).toBeGreaterThan(0);
    expect(parseWorkflowModel('meta: {name: x}\nedges:\n  - {from: a}\n').errors.length).toBeGreaterThan(0);
  });

  it('缺省值：version 默认 1、params 默认 {}、prompt 默认 ""、nodes/edges 可缺省', () => {
    const { model, errors } = parseWorkflowModel('meta: {name: x}\n');
    expect(errors).toEqual([]);
    expect(model).toEqual({ name: 'x', version: 1, params: {}, nodes: [], edges: [] });
    const withNode = parseWorkflowModel('meta: {name: x}\nnodes:\n  - id: a\n    agent: m\n');
    expect(withNode.model!.nodes[0].prompt).toBe('');
  });

  it('on_node_failure：解析透传 + 往返保真；不含该键时序列化也不输出', () => {
    const withOnf = parseWorkflowModel(
      'meta: {name: x}\nparams: {week: W38}\non_node_failure: continue_independent\nnodes:\n  - id: a\n    agent: m\n',
    );
    expect(withOnf.errors).toEqual([]);
    expect(withOnf.model!.on_node_failure).toBe('continue_independent');
    const back = parseWorkflowModel(serializeWorkflowYaml(withOnf.model!));
    expect(back.errors).toEqual([]);
    expect(back.model).toEqual(withOnf.model);
    expect(back.model!.on_node_failure).toBe('continue_independent');
    // 顶层键顺序：on_node_failure 位于 params 之后、nodes 之前
    const lines = serializeWorkflowYaml(withOnf.model!).split('\n');
    const topKeys = lines.filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.replace(/:.*/, ''));
    expect(topKeys).toEqual(['meta', 'params', 'on_node_failure', 'nodes', 'edges']);

    const without = parseWorkflowModel('meta: {name: x}\nnodes:\n  - id: a\n    agent: m\n');
    expect(without.model!.on_node_failure).toBeUndefined();
    const back2 = parseWorkflowModel(serializeWorkflowYaml(without.model!));
    expect(back2.errors).toEqual([]);
    expect(back2.model).toEqual(without.model);
    expect(back2.model!.on_node_failure).toBeUndefined();
  });

  it('meta.name 非空 / meta.version 非数字 / params 非标量值 → errors 非空', () => {
    expect(parseWorkflowModel('meta: {name: "", version: 1}\n').errors.length).toBeGreaterThan(0);
    expect(parseWorkflowModel('meta: {name: x, version: "3"}\n').errors.length).toBeGreaterThan(0);
    expect(
      parseWorkflowModel('meta: {name: x}\nparams:\n  week: {type: integer}\n').errors.length,
    ).toBeGreaterThan(0);
  });

  it('serialize：顶层键顺序 meta/params/nodes/edges，2 空格缩进，空 params 仍输出，不折叠长行', () => {
    const longPrompt = '很长的提示词'.repeat(40); // 240 字符，默认 lineWidth=80 会折叠
    const model = {
      name: 'n',
      version: 2,
      params: {},
      nodes: [
        { id: 'a', agent: 'mock', prompt: longPrompt },
        { id: 'b', agent: 'mock', prompt: 'p' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const y = serializeWorkflowYaml(model);
    const lines = y.split('\n');
    const topKeys = lines.filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.replace(/:.*/, ''));
    expect(topKeys).toEqual(['meta', 'params', 'nodes', 'edges']);
    expect(lines[0]).toBe('meta:');
    expect(lines[1]).toBe('  name: n');
    expect(lines[2]).toBe('  version: 2');
    expect(lines).toContain('params: {}');
    expect(lines).toContain('  - id: a');
    expect(lines).toContain('    prompt: ' + longPrompt); // lineWidth: 0 不折叠
    expect(lines).toContain('  - from: a');
  });

  it('serialize 往返保留标量类型（字符串 "true" 不变布尔）', () => {
    const model = {
      name: 'n',
      version: 1,
      params: { flag: 'true', n: 5, b: false },
      nodes: [{ id: 'a', agent: 'mock', prompt: '' }],
      edges: [],
    };
    const back = parseWorkflowModel(serializeWorkflowYaml(model));
    expect(back.errors).toEqual([]);
    expect(back.model!.params).toEqual({ flag: 'true', n: 5, b: false });
    expect(back.model!.nodes[0].prompt).toBe('');
  });
});
