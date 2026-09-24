// 工作流前端校验（保存门槛）：纯函数，镜像后端规则——
//   crates/flowscope-core/src/workflow.rs::validate（id 唯一/边引用/Kahn 无环）
//   crates/flowscope-core/src/cond.rs::parse（when 语法）
// 与后端不同的是这里【收集全部错误】一次返回（后端 Result 首错即返），
// 便于编辑器一次性展示。消息为中文且尽量点名肇事的 id/表达式。
import type { WorkflowModel } from '../api/workflowModel';

/** 镜像后端校验规则的纯函数；返回中文错误消息数组（空=通过）。
 *  规则：节点 id 非空且唯一；边 from/to 必须引用存在节点；DAG 无环（Kahn）；
 *  when 语法 = ("output."path " == " literal | "output."path " contains " 字符串字面量)（" and " 连接）；
 *  agent 非空；version >= 1；name 非空。 */
export function validateWorkflow(model: WorkflowModel): string[] {
  const errors: string[] = [];

  if (typeof model.name !== 'string' || model.name.trim() === '') {
    errors.push('meta.name 不能为空');
  }
  if (!(typeof model.version === 'number' && Number.isFinite(model.version) && model.version >= 1)) {
    errors.push('meta.version 必须 >= 1');
  }

  // 节点 id 非空且唯一（镜像 workflow.rs，另加非空检查）
  const ids = new Set<string>();
  let structuralError = false; // 重复 id / 悬空引用会破坏 Kahn 入度表
  for (const n of model.nodes) {
    if (typeof n.id !== 'string' || n.id.trim() === '') {
      errors.push(`节点 id 不能为空（agent: ${n.agent}）`);
    } else if (ids.has(n.id)) {
      errors.push(`重复节点 id: ${n.id}`);
      structuralError = true;
    } else {
      ids.add(n.id);
    }
    if (typeof n.agent !== 'string' || n.agent.trim() === '') {
      errors.push(`节点 ${n.id || '(空 id)'} 的 agent 不能为空`);
    }
  }

  // 边引用存在节点 + when 语法
  for (const e of model.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push(`边引用不存在的节点: ${e.from} -> ${e.to}`);
      structuralError = true;
    }
    if (e.when !== undefined) {
      const whenErr = checkWhen(e.when);
      if (whenErr !== null) {
        errors.push(`when 语法非法（仅支持 output.<path> == 字面量 / contains "字符串"，可用 and 连接）: "${e.when}"（${whenErr}）`);
      }
    }
  }

  // Kahn 拓扑排序判环（含自环）。存在重复 id / 悬空引用时入度表已被破坏
  //（indeg 按键去重会使 seen < nodes.length 恒成立，环必误报），此时跳过
  // 环检测只报结构错误——后端同样在环检测前对这些情况提前返回 Err。
  if (structuralError) return errors;
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of model.nodes) indeg.set(n.id, 0);
  for (const e of model.edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    const succ = adj.get(e.from);
    if (succ) succ.push(e.to);
    else adj.set(e.from, [e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length > 0) {
    const n = queue.pop()!;
    seen += 1;
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (seen !== model.nodes.length) {
    const stuck = model.nodes.filter((n) => (indeg.get(n.id) ?? 0) > 0).map((n) => n.id);
    errors.push(`工作流存在环（无法拓扑排序的节点: ${stuck.join(', ')}）`);
  }

  return errors;
}

// --- when 语法（逐条镜像 cond.rs::parse） ---

/** `and` 连接的原子条件序列，任一原子非法即失败。 */
function checkWhen(expr: string): string | null {
  const parts = expr.split(' and ');
  for (const p of parts) {
    const err = checkAtom(p);
    if (err !== null) return err;
  }
  return null;
}

/** 单原子：先按 " == " 切（首个匹配），否则按 " contains " 切——与 Rust
 *  split_once 的判定顺序一致。 */
function checkAtom(s: string): string | null {
  const t = s.trim();
  const eq = t.indexOf(' == ');
  if (eq !== -1) {
    return checkPath(t.slice(0, eq)) ?? checkLiteral(t.slice(eq + 4).trim());
  }
  const cont = t.indexOf(' contains ');
  if (cont !== -1) {
    const path = t.slice(0, cont);
    const lit = t.slice(cont + ' contains '.length).trim();
    const litErr = checkLiteral(lit);
    if (litErr !== null) return litErr;
    if (!isQuotedString(lit)) return `contains 仅支持字符串字面量: ${lit}`;
    return checkPath(path);
  }
  return `无法解析条件（仅支持 == / contains）: ${t}`;
}

/** 路径必须以 `output.` 开头且剩余非空（镜像 parse_path）。 */
function checkPath(path: string): string | null {
  const p = path.trim();
  return p.startsWith('output.') && p.length > 'output.'.length
    ? null
    : `路径必须以 output. 开头: ${p}`;
}

/** 字面量：true/false、i64 整数、双引号字符串（内容原样，不处理转义）。 */
function checkLiteral(s: string): string | null {
  if (s === 'true' || s === 'false') return null;
  if (isInt64(s)) return null;
  if (isQuotedString(s)) return null;
  return `无法解析字面量: ${s}`;
}

function isQuotedString(s: string): boolean {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"');
}

/** Rust `s.parse::<i64>()` 的等价判定：可选符号 + 纯数字 + i64 范围。 */
function isInt64(s: string): boolean {
  if (!/^[+-]?\d+$/.test(s)) return false;
  try {
    const b = BigInt(s);
    return b >= -9223372036854775808n && b <= 9223372036854775807n;
  } catch {
    return false;
  }
}
