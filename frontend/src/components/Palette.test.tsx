// T1：Palette 演示 agent 过滤断言。jsdom 直渲染独立 aside（无需画布/store 交互），
// api 客户端整体 mock（仅 listAgents 被面板消费）；store 用真实 zustand 单例
//（不触发 addNode，无需还原）。沿用项目测试约定（未引入 jest-dom）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { AgentRow } from '../api/types';
import Palette, { DEMO_AGENT_KEYS } from './Palette';

vi.mock('../api/client', () => ({
  api: { listAgents: vi.fn() },
}));

const row = (key: string, name = key): AgentRow => ({
  key,
  name,
  permission_default: 'ask',
  healthy: true,
});

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Palette />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Palette：演示 agent 过滤（T1）', () => {
  it('DEMO_AGENT_KEYS 固定为内置演示 agent 的 key', () => {
    expect([...DEMO_AGENT_KEYS].sort()).toEqual(['bad-mock', 'mock']);
  });

  it('mock/bad-mock 不渲染，企业 agent（zcode）可见', async () => {
    vi.mocked(api.listAgents).mockResolvedValue([row('mock', 'Mock'), row('zcode', 'ZCode'), row('bad-mock', 'Bad')]);
    renderPalette();
    // 企业 agent 的行与添加按钮就绪（异步等待 listAgents resolve）
    expect(await screen.findByTestId('palette-add-zcode')).toBeTruthy();
    expect(screen.getByText(/◆ ZCode/)).toBeTruthy();
    // 演示 agent 整行（含添加按钮）均不出现
    expect(screen.queryByTestId('palette-add-mock')).toBeNull();
    expect(screen.queryByTestId('palette-add-bad-mock')).toBeNull();
    expect(screen.queryByText(/◆ Mock/)).toBeNull();
    // 仅剩一行
    expect(document.querySelectorAll('.fs-palette__item')).toHaveLength(1);
  });

  it('注册的全是演示 agent：显示提示文案而非空列表', async () => {
    vi.mocked(api.listAgents).mockResolvedValue([row('mock', 'Mock'), row('bad-mock', 'Bad')]);
    renderPalette();
    expect(
      await screen.findByText('内置演示 agent 已隐藏——注册企业 agent 后显示于此（现有使用 mock 的工作流不受影响）'),
    ).toBeTruthy();
    expect(screen.queryByTestId('palette-add-mock')).toBeNull();
  });

  it('未注册任何 agent：仍显示「未注册 agent」空态（区别于全 demo 提示）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue([]);
    renderPalette();
    expect(await screen.findByText('未注册 agent，请编辑 agents.toml')).toBeTruthy();
  });
});
