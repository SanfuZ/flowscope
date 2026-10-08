// workflowModel tags（meta.tags）解析/序列化/就地改写测试：
//   - parse：字符串数组收为 model.tags；非数组/元素非字符串 → error
//     「meta.tags 必须是字符串数组」；缺省/空数组 → 不携带（undefined）；
//   - serialize：meta 键序 name/version/tags，有值输出、空数组省略；
//   - roundtrip：parse → serialize → parse 内容不丢；
//   - setYamlTags（文档手术）：三态（新增/原位换值/空数组删键）+ 保留注释
//     与块式排版 + 无 meta 段抛错——文件夹页「标记」编辑的回写核心。
import { describe, expect, it } from 'vitest';
import { parseWorkflowModel, serializeWorkflowYaml, setYamlTags } from './workflowModel';

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

/** 手术fixture：顶部注释 + meta 注释 + 块式节点/参数行内注释，供保留性断言。 */
const DOC_WITH_TAGS = `# 顶部注释：团队工作流
meta:
  name: demo
  version: 2
  tags:
    - 旧标记
params:
  city: 杭州 # 参数注释
nodes:
  - id: n1
    agent: m
    prompt: p
edges: []
`;

const DOC_NO_TAGS = DOC_WITH_TAGS.replace('  tags:\n    - 旧标记\n', '');

describe('workflowModel：setYamlTags（meta.tags 文档手术）', () => {
  it('新增：无 tags 文档写入 tags 数组，注释与块式排版原样保留', () => {
    const out = setYamlTags(DOC_NO_TAGS, ['alpha', '演示']);
    // 手术只动 meta.tags：注释与原排版仍在
    expect(out).toContain('# 顶部注释：团队工作流');
    expect(out).toContain('city: 杭州 # 参数注释');
    expect(out).toContain('nodes:\n  - id: n1');
    // 新 tags 可被严格 parse 读回
    const { model, errors } = parseWorkflowModel(out);
    expect(errors).toEqual([]);
    expect(model?.tags).toEqual(['alpha', '演示']);
  });

  it('原位更新：已有 tags 换成新值集合，其余内容不动', () => {
    const out = setYamlTags(DOC_WITH_TAGS, ['新A', '新B', '新C']);
    expect(out).toContain('# 顶部注释：团队工作流'); // 注释保留
    expect(out).not.toContain('旧标记'); // 旧值整体替换
    const { model, errors } = parseWorkflowModel(out);
    expect(errors).toEqual([]);
    expect(model?.tags).toEqual(['新A', '新B', '新C']);
    expect(model?.name).toBe('demo'); // 其余字段不受影响
  });

  it('空数组：删除 tags 键（等同未设）', () => {
    const out = setYamlTags(DOC_WITH_TAGS, []);
    expect(out).not.toContain('tags:');
    expect(out).toContain('# 顶部注释：团队工作流');
    const { model, errors } = parseWorkflowModel(out);
    expect(errors).toEqual([]);
    expect(model?.tags).toBeUndefined();
  });

  it('无 meta 段 / meta 非映射 / 语法错误 → throw（调用方就地提示）', () => {
    expect(() => setYamlTags('nodes: []\n', ['a'])).toThrow('缺少 meta 段');
    expect(() => setYamlTags('meta: 5\nnodes: []\n', ['a'])).toThrow('缺少 meta 段');
    expect(() => setYamlTags('---\n: : :\n', ['a'])).toThrow();
  });
});
