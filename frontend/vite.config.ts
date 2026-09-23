import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 前端与后端同源部署（后端静态托管 frontend/dist）；开发模式下用代理把
// /api 转发到 flowscope-dev（默认端口 39271，见 crates/flowscope-core/src/bin/dev.rs），
// 使 window.location.origin 基址在 dev 与 prod 行为一致。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:39271',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
