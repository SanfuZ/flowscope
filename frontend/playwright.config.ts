// Playwright E2E 冒烟（Task 16）：webServer 先确保 mock-agent 已构建（增量缓存），
// 再 `cd ..` 到仓库根启动 flowscope dev bin——dev.rs 相对自身 cwd 解析
// --home/--frontend-dist/--mock-agent-bin，仓库根下即 target/ 与 frontend/dist。
// vitest 的 include 已限定 src/**，不会拾取 e2e/ 目录。
import { defineConfig } from '@playwright/test';

const PORT = 39271;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command:
      'cargo build -p flowscope-mock-agent && cd .. && cargo run -p flowscope-core --bin dev ' +
      `-- --port ${PORT} --home target/e2e-home --frontend-dist frontend/dist ` +
      '--mock-agent-bin target/debug/flowscope-mock-agent.exe',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
