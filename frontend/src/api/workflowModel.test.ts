// workflowModel tags（meta.tags）解析/序列化往返测试：
//   - parse：字符串数组收为 model.tags；非数组/元素非字符串 → error
//     「meta.tags 必须是字符串数组」；缺省/空数组 → 不携带（undefined）；
//   - serialize：meta 键序 name/version/tags，有值输出、空数组省略；
//   - roundtrip：parse → serialize → parse 内容不丢。
import { describe, expect, it } from 'vitest';
import { parseWorkflowModel, serializeWorkflowYaml } from './workflowModel';

const BASE_MODEL = {
  name: 'demo',
  version: 2,
  params: {},
  nodes: [{ id: 'n1', agent: 'm', prompt: 'p' }],
  edges: [],
};

describe('workflowModel：meta.tags', () => {
  it('parse：字符串数组收为 tags；缺省不携带', () => {
    const yaml = 'meta: {name: demo, version: 2, tags: [演示, alpha]}\nnodes:\n  - {id: n1, agent: m, prompt: p}\n';
    const { model, errors } = parseWorkflowModel(yaml);
    expect(errors).toEqual([]);
    expect(model?.tags).toEqual(['演示', 'alpha']);

    const plain = parseWorkflowModel('meta: {name: demo, version: 2}\nnodes:\n  - {id: n1, agent: m, prompt: p}\n');
    expect(plain.errors).toEqual([]);
    expect(plain.model?.tags).toBeUndefined();
  });

  it('parse：非数组 / 元素非字符串 → error meta.tags 必须是字符串数组', () => {
    const notArray = parseWorkflowModel('meta: {name: demo, version: 2, tags: 演示}\nnodes: []\n');
    expect(notArray.model).toBeUndefined();
    expect(notArray.errors).toContain('meta.tags 必须是字符串数组');

    const mixedElements = parseWorkflowModel(
      'meta: {name: demo, version: 2, tags: [演示, 3]}\nnodes: []\n',
    );
    expect(mixedElements.model).toBeUndefined();
    expect(mixedElements.errors).toContain('meta.tags 必须是字符串数组');
  });

  it('serialize：有 tags 时 meta 键序 name/version/tags；空数组省略字段', () => {
    const withTags = serializeWorkflowYaml({ ...BASE_MODEL, tags: ['演示', 'alpha'] });
    expect(withTags).toContain('tags:');
    expect(withTags).toContain('- 演示');
    expect(withTags).toContain('- alpha');
    // 键序：tags 在 meta.name/version 之后（roundtrip 由 parse 再验证）
    const { model, errors } = parseWorkflowModel(withTags);
    expect(errors).toEqual([]);
    expect(model?.tags).toEqual(['演示', 'alpha']);

    // 空数组 = 未设：序列化省略 tags 字段
    const emptyTags = serializeWorkflowYaml({ ...BASE_MODEL, tags: [] });
    expect(emptyTags).not.toContain('tags');
    expect(parseWorkflowModel(emptyTags).model?.tags).toBeUndefined();
  });

  it('roundtrip：parse(tags) → serialize → parse 内容不丢', () => {
    const yaml = 'meta:\n  name: demo\n  version: 2\n  tags:\n    - 演示\n    - alpha\nparams: {}\nnodes:\n  - id: n1\n    agent: m\n    prompt: p\nedges: []\n';
    const first = parseWorkflowModel(yaml);
    expect(first.errors).toEqual([]);
    const second = parseWorkflowModel(serializeWorkflowYaml(first.model!));
    expect(second.errors).toEqual([]);
    expect(second.model?.tags).toEqual(['演示', 'alpha']);
    expect(second.model?.name).toBe('demo');
    expect(second.model?.version).toBe(2);
  });
});
