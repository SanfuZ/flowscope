// 工作流 YAML → 图（nodes/edges）最小提取器。
//
// 【设计取舍（控制器裁定）】M1 不引入 YAML 解析依赖，仅用行扫描提取顶层
// `nodes:` / `edges:` 两个列表里每个条目的 `id/agent` 与 `from/to/when`，
// 供图视图画 DAG。这是【故意脆弱】的解析器，已知局限：
//   1. 只认顶层（0 缩进）的 `nodes:` / `edges:` 段，行内注释不剥离
//      （仅跳过整行注释与空行）；
//   2. flow 风格 `- {k: v, ...}` 按逗号裸切分——值内未加引号的逗号会切错
//      （种子/示例工作流的值均带引号或不含逗号）；
//   3. block 风格只取 `k: v` 单行，`|`/`>` 多行标量的内容行被忽略，
//      嵌套映射（如 `retry:` 子块）的键会混入条目但无害（只读白名单键）；
//   4. 引号只剥一层成对的 ' 或 "。
// 任何解析失败一律兜底返回空图 `{nodes: [], edges: []}`，编辑器仍可用原文。
import type { WorkflowGraph } from './types';

/** 剥一层成对引号 + 去首尾空白。 */
function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 按不在引号内的逗号切分 flow map 内容。 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** `k: v`（或 flow map 整体）→ 键值映射；v 中不再剥大括号嵌套。 */
function parseKv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  let body = text.trim();
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1);
  for (const part of splitTop(body)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    map[part.slice(0, i).trim()] = unquote(part.slice(i + 1));
  }
  return map;
}

/** 提取 `key:` 顶层段内的列表条目（flow 或 block 风格），直到下一个顶层键。 */
function sectionItems(lines: string[], key: string): Record<string, string>[] {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
  if (start === -1) return [];
  const items: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s/.test(line)) break; // 下一个顶层键，段结束
    const stripped = line.replace(/^\s+/, '');
    if (!stripped || stripped.startsWith('#')) continue;
    const dash = stripped.match(/^-\s+(.*)$/);
    if (dash) {
      cur = parseKv(dash[1]);
      items.push(cur);
    } else if (cur) {
      // block 条目的续行（含嵌套子键/多行标量内容行）；无冒号的行跳过
      if (/^[^\s:]+:/.test(stripped)) Object.assign(cur, parseKv(stripped));
    }
  }
  return items;
}

/** 从 YAML 文本提取图结构；失败/缺失兜底空图（见文件头局限说明）。 */
export function parseWorkflowGraph(yaml: string): WorkflowGraph {
  try {
    const lines = yaml
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    const nodes = sectionItems(lines, 'nodes')
      .filter((m) => m.id !== undefined)
      .map((m) => ({ id: m.id, agent: m.agent ?? '' }));
    const edges = sectionItems(lines, 'edges')
      .filter((m) => m.from !== undefined && m.to !== undefined)
      .map((m) => {
        const e: { from: string; to: string; when?: string } = { from: m.from, to: m.to };
        if (m.when !== undefined && m.when !== '') e.when = m.when;
        return e;
      });
    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}
