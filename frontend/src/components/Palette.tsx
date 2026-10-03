// agent 节点面板：浮在编辑画布左上的卡片（绝对定位见 styles.css）。
// 每项三触发（save-ux 起整行可点）：
//   - 整行点击（li onClick → addNode(key)）：行即按钮——cursor pointer、
//     hover 高亮、按压微缩（见 .fs-palette__item 样式）；data-agent-key
//     供测试直接定位行；行内「添加」按钮 stopPropagation 防止双触发；
//   - HTML5 拖拽（dataTransfer 'application/flowscope-agent'，text/plain 兜底）
//     → 画布 onDrop 以落点坐标 addNode；
//   - 「添加」按钮（键盘可达 / e2e 路径）→ addNode(key)，不传位置，
//     由 store 视觉级联兜底。
// 演示 agent 过滤：mock / bad-mock 是 FlowScope 内置演示 agent，一律不进
// 新建面板（新建工作流面向企业 agent）；过滤后为空且确有注册（全是 demo）
// 显示提示文案。注意不对称：PropertyPanel 的 Agent 下拉不过滤（存量 mock
// 工作流仍可编辑）。e2e：冻结的 build-via-canvas.spec.ts 原经
// palette-add-mock 搭建工作流，T1 起授权换成 palette-add-zcode（e2e home
// bootstrap 在桥文件存在时自动注册 zcode，见 controller 裁定）。
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useEditorStore } from '../store/editorStore';

/** 内置演示 agent 的 key（新建面板过滤对象；导出供测试）。 */
export const DEMO_AGENT_KEYS = new Set(['mock', 'bad-mock']);

export default function Palette() {
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api.listAgents() });
  const addNode = useEditorStore((s) => s.addNode);
  const agents = agentsQuery.data;
  // 严格过滤演示 agent（不回退展示——回退会让「隐藏 demo」语义形同虚设）；
  // agents 未就绪时 visible 为空数组，由下方分支的加载/空态先行兜住
  const visible = agents?.filter((a) => !DEMO_AGENT_KEYS.has(a.key)) ?? [];

  return (
    <aside className="fs-palette" data-testid="palette">
      <div className="fs-palette__title">Agent</div>
      {agentsQuery.isError ? (
        <div className="fs-palette__empty">
          agent 加载失败：{String((agentsQuery.error as Error)?.message ?? agentsQuery.error)}
        </div>
      ) : agents == null ? (
        <div className="fs-palette__empty">加载 agent…</div>
      ) : agents.length === 0 ? (
        <div className="fs-palette__empty">未注册 agent，请编辑 agents.toml</div>
      ) : visible.length === 0 ? (
        <div className="fs-palette__empty">
          内置演示 agent 已隐藏——注册企业 agent 后显示于此（现有使用 mock 的工作流不受影响）
        </div>
      ) : (
        <ul className="fs-palette__list">
          {visible.map((a) => (
            <li
              key={a.key}
              className="fs-palette__item"
              data-agent-key={a.key}
              title={`添加 ${a.name} 到画布`}
              draggable
              onClick={() => addNode(a.key)}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/flowscope-agent', a.key);
                e.dataTransfer.setData('text/plain', a.key);
              }}
            >
              <span className="fs-palette__name">
                ◆ {a.name} <span className="fs-palette__key">({a.key})</span>
              </span>
              <button
                type="button"
                className="fs-btn fs-palette__add"
                data-testid={`palette-add-${a.key}`}
                onClick={(e) => {
                  e.stopPropagation(); // 行 onClick 同为 addNode，阻断冒泡防双触发
                  addNode(a.key);
                }}
              >
                添加
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
