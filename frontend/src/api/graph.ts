// 工作流 YAML → 图（nodes/edges）薄适配：委托 workflowModel 的严格解析，
// 成功时投影 nodes/edges；任何解析失败（语法错误/结构不符/未知顶层键）
// 一律兜底空图 {nodes: [], edges: []}——WorkflowDetail 预览的兜底行为不变。
//
// 【设计沿革】M1 的行扫描器（只认顶层 nodes:/edges: 段、flow 风格裸切分）
// 已按 M2a 计划退役，解析权威收敛到 workflowModel.ts（yaml@2 包驱动）。
import type { WorkflowGraph } from './types';
import { parseWorkflowModel } from './workflowModel';

/** 从 YAML 文本提取图结构；解析失败/结构不符兜底空图（不抛异常）。 */
export function parseWorkflowGraph(yaml: string): WorkflowGraph {
  const { model } = parseWorkflowModel(yaml);
  if (model === undefined) return { nodes: [], edges: [] };
  return {
    nodes: model.nodes.map((n) => ({ id: n.id, agent: n.agent })),
    edges: model.edges.map((e) =>
      e.when === undefined ? { from: e.from, to: e.to } : { from: e.from, to: e.to, when: e.when },
    ),
  };
}
