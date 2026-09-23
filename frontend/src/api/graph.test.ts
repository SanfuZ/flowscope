import { describe, expect, it } from 'vitest';
import { parseWorkflowGraph } from './graph';

describe('parseWorkflowGraph：最小 YAML 图提取器', () => {
  it('flow 风格（dev.rs 种子 weekly-report 同款）', () => {
    const yaml = [
      '# 示例：3 节点线性周报（collect → analyze → report）',
      'meta: {name: weekly-report, version: 1}',
      'params:',
      '  week: {type: integer, default: 1}',
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

  it('block 风格（含多行 prompt 与嵌套 retry）', () => {
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

  it('flow 风格带 when 且引号剥除；缺 id 的条目跳过', () => {
    const yaml = [
      'meta: {name: w, version: 1}',
      'nodes:',
      '  - {id: a, agent: m, prompt: p}',
      '  - {agent: no-id}',
      'edges:',
      '  - {from: a, to: b, when: "x > 1"}',
      '',
    ].join('\n');
    const g = parseWorkflowGraph(yaml);
    expect(g.nodes).toEqual([{ id: 'a', agent: 'm' }]);
    expect(g.edges).toEqual([{ from: 'a', to: 'b', when: 'x > 1' }]);
  });

  it('无法解析 / 无 nodes 段 → 空图兜底', () => {
    expect(parseWorkflowGraph('meta: [broken')).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowGraph('foo: bar\nother: 1\n')).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowGraph('')).toEqual({ nodes: [], edges: [] });
  });
});
