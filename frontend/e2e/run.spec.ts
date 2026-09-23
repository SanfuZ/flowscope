// E2E 冒烟（Task 16）：对 dev bin 种子的两个工作流走真实 UI 全链路。
//
// 选择器全部来自前端实现（未为测试改动 src）：
// - WorkflowList：卡片 `.fs-card`（内含工作流名文本）；
// - WorkflowDetail：启动按钮文案「启动运行」，params 默认 `{}` 直接接受；
// - RunMonitor：根节点类 `.fs-monitor`（无 testid），顶栏状态徽章
//   `.fs-topbar .fs-badge`（StatusBadge 文本即 run 状态字符串）；
// - NodeCard：类 `fs-node--succeeded` / `fs-node--failed`；
// - NodeDrawer：`data-testid="drawer-message"/"drawer-tools"`，tab 为 role=tab。
//
// mock agent 脚本（flowscope-core/src/api.rs 生成）：demo 脚本每节点流式消息 +
// 工具 t1「查询数据库」+ plan，最终消息 `{"ok": true, ...}`；crash 脚本 1 步后
// 进程 exit(3)，crash-demo 节点 retry 1 次后失败 → run failed。
import { test, expect } from '@playwright/test';

/** 从工作流列表进入详情并点击「启动运行」（params 用默认 `{}`）。 */
async function launchWorkflow(page: import('@playwright/test').Page, name: string) {
  await page.goto('/workflows');
  await page.locator('.fs-card', { hasText: name }).click();
  await page.getByRole('button', { name: '启动运行' }).click();
}

test('mock 工作流全链路：节点点亮 + 抽屉内容 + 终态 finished', async ({ page }) => {
  await launchWorkflow(page, 'weekly-report');

  // 落到运行监控页
  await expect(page.locator('.fs-monitor')).toBeVisible();

  // 三个节点依次变绿（collect → analyze → report，每个 mock 进程 <1s）
  await expect(page.locator('.fs-node--succeeded')).toHaveCount(3, { timeout: 15_000 });

  // 顶栏状态徽章显示 finished
  await expect(page.locator('.fs-topbar .fs-badge')).toHaveText('finished');

  // 点开第 2 个节点（analyze）抽屉：默认消息 tab 含 mock 最终 JSON 消息
  await page.locator('.fs-node--succeeded').nth(1).click();
  await expect(page.getByTestId('drawer')).toBeVisible();
  await expect(page.getByTestId('drawer-message').locator('.fs-msg')).toContainText('"ok": true');

  // 工具 tab 展示 mock 工具 t1「查询数据库」
  await page.getByRole('tab', { name: '工具' }).click();
  await expect(page.getByTestId('drawer-tools').getByText('查询数据库')).toBeVisible();
});

test('失败注入：crash-demo 节点红 + run failed', async ({ page }) => {
  await launchWorkflow(page, 'crash-demo');

  await expect(page.locator('.fs-monitor')).toBeVisible();

  // bad-mock 进程 exit(3)，retry 1 次（backoff 500ms）后节点失败
  await expect(page.locator('.fs-node--failed')).toHaveCount(1, { timeout: 15_000 });

  // run 终态 failed
  await expect(page.locator('.fs-topbar .fs-badge')).toHaveText('failed');
});
