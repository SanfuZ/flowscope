import { describe, expect, it } from 'vitest';
import { validateWorkflow } from './validate';
import type { WorkflowModel } from '../api/workflowModel';

const base = (): WorkflowModel => ({
  name: 't',
  version: 1,
  params: {},
  nodes: [
    { id: 'a', agent: 'mock', prompt: 'p' },
    { id: 'b', agent: 'mock', prompt: 'p' },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

describe('validateWorkflow：镜像后端规则', () => {
  it('合法模型通过', () => expect(validateWorkflow(base())).toEqual([]));

  it('重复 id / 悬空边 / 自环与环 / 非法 when / 空 agent / 空 name 各报错', () => {
    const dup = base();
    dup.nodes[1].id = 'a';
    expect(validateWorkflow(dup).some((m) => m.includes('重复'))).toBe(true);
    const dangling = base();
    dangling.edges.push({ from: 'a', to: 'ghost' });
    expect(validateWorkflow(dangling).some((m) => m.includes('ghost'))).toBe(true);
    const cycle = base();
    cycle.edges.push({ from: 'b', to: 'a' });
    const self = base();
    self.edges.push({ from: 'a', to: 'a' });
    expect(validateWorkflow(cycle).some((m) => m.includes('环'))).toBe(true);
    expect(validateWorkflow(self).some((m) => m.includes('环'))).toBe(true);
    const badWhen = base();
    badWhen.edges[0].when = 'output.a >= 5';
    expect(validateWorkflow(badWhen).some((m) => m.includes('when'))).toBe(true);
    const noAgent = base();
    noAgent.nodes[0].agent = '';
    expect(validateWorkflow(noAgent).some((m) => m.includes('agent'))).toBe(true);
    const noName = base();
    noName.name = '';
    expect(validateWorkflow(noName).some((m) => m.includes('name'))).toBe(true);
  });

  it('合法 when（等值/包含/and 连接）通过，缺字面量与非 output 路径报错', () => {
    const okEq = base();
    okEq.edges[0].when = 'output.ok == true';
    expect(validateWorkflow(okEq)).toEqual([]);
    const okContains = base();
    okContains.edges[0].when = 'output.summary contains "完成"';
    expect(validateWorkflow(okContains)).toEqual([]);
    const okAnd = base();
    okAnd.edges[0].when = 'output.summary contains "完成" and output.code == 0 and output.ok == false';
    expect(validateWorkflow(okAnd)).toEqual([]);
    const missingLiteral = base();
    missingLiteral.edges[0].when = 'output.a == ';
    expect(validateWorkflow(missingLiteral).some((m) => m.includes('when'))).toBe(true);
    const badPath = base();
    badPath.edges[0].when = 'params.a == 1';
    expect(validateWorkflow(badPath).some((m) => m.includes('when'))).toBe(true);
  });

  it('version < 1 报错', () => {
    const v0 = base();
    v0.version = 0;
    expect(validateWorkflow(v0).some((m) => m.includes('version'))).toBe(true);
  });
});
