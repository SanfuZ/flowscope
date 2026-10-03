// Task 7：从零画布搭建工作流的真实浏览器全链路 E2E（纯黑盒，不触碰 store / 不注入事件）。
//
// 链路：/workflows/new → palette「添加」→ handle 拖拽连线 → 属性面板填 prompt
//       → 空白处取消选中 → 设置态改名 → 保存（跳 /workflows/:id）→ 启动运行
//       → /runs/:id 节点点亮 + 顶栏徽章 finished。
//
// 选择器清单（全部来自真实实现，除授权的 run-status 外未为测试新增 hook）：
// - Palette：`data-testid="palette-add-zcode"`（T1 起 demo agent 不再进面板，
//   经 controller 授权由 palette-add-mock 换成 zcode——e2e home bootstrap 在
//   桥文件存在时自动注册 zcode）；
// - EditableCanvas（RF12）：节点包裹层 `.react-flow__node[data-id]`（data-id = 节点 id），
//   handle `.react-flow__handle.source|target`（NodeCard 的 Right/Left Handle），
//   边 `.react-flow__edge[data-id="from->to"]`（store 边 id 约定 `${from}->${to}`），
//   条件边样式 `.fs-edge--cond`（label 取 when），空白点击落在 `.react-flow__pane`
//   （Background/viewport 均 pointer-events:none，onPaneClick → setSelection(null)），
//   控件缩放按钮 `.react-flow__controls-zoomout`；
// - PropertyPanel：`data-testid="property-panel"`，包裹 label 的可访问名
//   「Prompt」「名称」「字段路径」「值」（本环境 Playwright 分支为 getByLabel），
//   标题「节点属性」「工作流设置」「连线：step1 → node-1」；
// - WorkflowDetail 工具栏：「保存」（problems 非空禁用；new 保存后 replace 到
//   /workflows/:id）、「启动运行」（isNew 或未载入时禁用；一键直发后跳 /runs/:id）、
//   「YAML 源码」「刷新」（浮层内，每次点击重读 store 快照）；
// - RunMonitor：`.fs-node--succeeded|skipped`（NodeCard 状态类）、
//   顶栏 `data-testid="run-status"`（Task 7 唯一授权的 RunMonitor 改动）。
//
// 对简报 Step-1 示例的三处有意偏差（原因见行内注释）：
// 1. centerXY 不存在 → boundingBox 中心数学（简报注释本就要求如此）；
// 2. 空白点击不用 (40,40)/(60,60)：palette 浮层绝对定位在画布左上（190px 宽、
//    最高 420px），该坐标会点进 palette 而非 pane → 改取画布右下象限；
// 3. prompt 提交是 300ms 防抖，且属性面板 NodeForm 卸载会取消挂起的提交
//    （设计如此）——因此必须在【保持节点选中】时用 YAML 浮层「刷新」轮询
//    store 快照确认提交落库，之后才能取消选中；全程无固定 sleep。
import { expect, test, type Page } from '@playwright/test';

/** handle 的 boundingBox 中心（RF 把 handle 定位在节点左右边中点）。 */
async function handleCenter(page: Page, nodeId: string, kind: 'source' | 'target') {
  const handle = page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${kind}`,
  );
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`handle ${nodeId}.${kind} 无 boundingBox（画布未布局）`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function boxOrThrow(locator: ReturnType<Page['locator']>, what: string) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} 无 boundingBox（画布未布局）`);
  return box;
}

/** 把 node-1 水平拖到 step1 source handle 右侧 40px、且 handle 等高对齐的位置。
 *  addNode 的视觉级联默认位置让两张卡片斜向重叠（fitView 后 zoom=2 更甚），
 *  连线几乎全被卡片盖住——真实用户也会先拖开节点；先缩小画布腾出横向空间，
 *  再等高拖放 → 之后 step1→node-1 的连线是一条完全露出的水平直线（可点击）。
 *  该操作同时覆盖 Task 4 的节点拖拽（onNodeDragStop 批量回写 store.positions）。 */
async function dragNodeAside(page: Page, nodeId: string) {
  const paneBox = await boxOrThrow(page.locator('.react-flow__pane'), 'pane');
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const srcHandle = page.locator('.react-flow__node[data-id="step1"] .react-flow__handle.source');
  const zoomout = page.locator('.react-flow__controls-zoomout');
  // 画布横向放不下「source handle 右侧 40px + 整张卡」就先缩小（minZoom 0.2 前必然够用）
  for (let i = 0; i < 6; i++) {
    const src = await boxOrThrow(srcHandle, 'source handle');
    const n = await boxOrThrow(node, `node ${nodeId}`);
    const dropX = src.x + src.width + 40 + n.width / 2;
    const roomX = paneBox.x + paneBox.width - n.width / 2 - 8;
    if (dropX <= roomX) break;
    await zoomout.click();
  }
  const src = await boxOrThrow(srcHandle, 'source handle');
  const n = await boxOrThrow(node, `node ${nodeId}`);
  const dropX = Math.min(
    src.x + src.width + 40 + n.width / 2,
    paneBox.x + paneBox.width - n.width / 2 - 8,
  );
  const targetY = src.y + src.height / 2; // handle 垂直居中：卡心对齐 → 连线水平直线
  await page.mouse.move(n.x + n.width / 2, n.y + n.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropX, targetY, { steps: 8 });
  await page.mouse.up();
}

/** source handle → target handle 真实鼠标拖拽连线，并确认边进入文档 store。 */
async function dragConnect(page: Page, fromId: string, toId: string) {
  const from = await handleCenter(page, fromId, 'source');
  const to = await handleCenter(page, toId, 'target');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  // 落点校验（RF12 isValidHandle 认可目标 handle 的 connectable 类）→ onConnect
  // → store.connect → derivedEdges 同步回 RF：以边元素出现为连线成立的硬证据。
  await expect(page.locator(`.react-flow__edge[data-id="${fromId}->${toId}"]`)).toHaveCount(1);
}

/** 从空白新建到「step1 → node-1 连线完成」的公共前缀（loadBlank 自带 step1/mock）。
 *  moveAside：连线前先把 node-1 拖开（后续要点击连线本身时必须让边露出来）。 */
async function newWorkflowWithConnectedNode(page: Page, moveAside = false) {
  await page.goto('/workflows/new');
  const paletteAdd = page.getByTestId('palette-add-zcode');
  await expect(paletteAdd).toBeVisible();
  await paletteAdd.click();
  // addNode 视觉级联：node-1 出现后才允许读 boundingBox（防布局未稳）
  await expect(page.locator('.react-flow__node[data-id="node-1"]')).toBeVisible();
  // T1 收尾（种子自动换选）引入的必要步骤：agents 就绪后 WorkflowDetail 会把
  // 未碰过的 mock 种子换成首个非演示 agent（e2e home → zcode），而 zcode 桥
  // 拒收空 prompt（协议层 "empty prompt" 硬失败）——本 spec 的 step1 依赖
  // mock 的确定性脚本（<1s、终态 {"ok": true} 驱动 test2 的条件边求值）。
  // 经属性面板 Agent 下拉把 step1 换回 mock；该下拉有意不过滤演示 agent
  // （T1 不对称：存量 mock 工作流仍可编辑），此处顺带 e2e 覆盖该语义。
  // 与换选的竞态无关紧要：palette 点击已置脏 → 换选守卫（!dirty）要么已
  // 触发（此处改回 mock）要么永不触发（种子仍是 mock），两序皆确定。
  await page.locator('.react-flow__node[data-id="step1"]').click();
  await page.getByLabel('Agent').selectOption('mock');
  if (moveAside) await dragNodeAside(page, 'node-1');
  await dragConnect(page, 'step1', 'node-1');
}

/** 保存（new → replace 到 /workflows/:id）并一键启动，落到 /runs/:id。 */
async function saveAndLaunch(page: Page) {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\/(?!new)[^/]+$/);
  const launch = page.getByRole('button', { name: '启动运行' });
  await expect(launch).toBeEnabled(); // 保存后 isNew=false 且文档已载入
  await launch.click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
}

test('从零画布搭一条 2 节点工作流并跑通', async ({ page }) => {
  await newWorkflowWithConnectedNode(page);

  const panel = page.getByTestId('property-panel');
  // addNode 已自动选中 node-1；再显式点一下节点卡（onNodeClick → 选中态）
  await page.locator('.react-flow__node[data-id="node-1"]').click();
  await expect(panel.getByText('节点属性')).toBeVisible();
  await page.getByLabel('Prompt').fill('输出 {"ok": true}');

  // prompt 是 300ms 防抖提交且面板卸载会取消挂起提交 → 保持选中，打开 YAML
  // 源码浮层，轮询「刷新」（每次重读 store 快照）直到防抖提交落库再取消选中。
  // 副产品：验证画布搭出的文档 YAML 往返（nodes/edges 齐全）。
  await page.getByRole('button', { name: 'YAML 源码' }).click();
  const yamlBody = page.getByLabel('YAML 内容');
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: '刷新' }).click();
      return yamlBody.inputValue();
    })
    .toContain('输出');
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: '刷新' }).click();
      const yaml = await yamlBody.inputValue();
      return (
        yaml.includes('- id: node-1') && yaml.includes('from: step1') && yaml.includes('to: node-1')
      );
    })
    .toBe(true);
  await page.getByRole('button', { name: '关闭' }).click();

  // 空白处点击 → 取消选中 → 属性面板切设置态（坐标取右下象限，避开左上 palette）
  const paneBox = await boxOrThrow(page.locator('.react-flow__pane'), 'pane');
  await page.locator('.react-flow__pane').click({
    position: { x: Math.round(paneBox.width * 0.75), y: Math.round(paneBox.height * 0.85) },
  });
  await expect(panel.getByText('工作流设置')).toBeVisible();
  await page.getByLabel('名称', { exact: true }).fill('canvas-e2e');
  // 名称失焦提交：保存按钮的 mousedown 先触发 blur 提交，click 才读取 store

  await saveAndLaunch(page);

  // 2 节点 mock 全绿（每节点 mock 进程 <1s）+ 顶栏徽章终态
  await expect(page.locator('.fs-node--succeeded')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('run-status')).toHaveText('finished');
});

test('条件边跳过链路：when output.ok == false 为假 → 下游 skipped，run 仍 finished', async ({
  page,
}) => {
  await newWorkflowWithConnectedNode(page, true);

  // 点击连线（已拖开节点、边完全露出）→ 属性面板 edge 态：结构化 when 三件套
  await page.locator('.react-flow__edge[data-id="step1->node-1"]').click();
  const panel = page.getByTestId('property-panel');
  await expect(panel.getByText(/连线：step1\s*→\s*node-1/)).toBeVisible();
  await page.getByLabel('字段路径', { exact: true }).fill('output.ok');
  await page.getByLabel('值', { exact: true }).fill('false');
  // 三件套拼装提交（output.ok == false）回写 store → 边带条件样式
  await expect(page.locator('.react-flow__edge.fs-edge--cond')).toHaveCount(1);

  await saveAndLaunch(page);

  // mock 终态消息含 "ok": true → 条件为假 → node-1 跳过；step1 完成，run finished
  await expect(page.locator('.fs-node--skipped')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.fs-node--succeeded')).toHaveCount(1);
  await expect(page.getByTestId('run-status')).toHaveText('finished');
});
