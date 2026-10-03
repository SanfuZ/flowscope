// FolderWorkflows 页测试：api 客户端整体 mock，createMemoryRouter 定路由
// （/folder + /workflows/new 探针读 location.state.importedYaml，断言带 state
// 导航——同 WorkflowDetail 测试的 data router 手法）。localStorage 记忆目录，
// afterEach 清理；项目未引入 jest-dom，沿用既有测试约定（.disabled/textContent）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import FolderWorkflows from './FolderWorkflows';

vi.mock('../api/client', () => ({
  api: {
    listFolderWorkflows: vi.fn(),
  },
}));

const YAML_A = 'meta: {name: Alpha, version: 1}\nnodes:\n  - {id: n1, agent: m, prompt: p}\n';
const YAML_B = 'meta: {name: beta, version: 2}\nnodes:\n  - {id: n1, agent: m, prompt: p}\n';
const YAML_BAD = '---\n: : :\n';

/** 与后端响应同形：后端已按名称字母序排序，前端原样渲染。 */
const FILES = [
  { file: 'a.yaml', name: 'Alpha', version: 1, valid: true, error: null, yaml: YAML_A },
  { file: 'beta.yaml', name: 'beta', version: 2, valid: true, error: null, yaml: YAML_B },
  {
    file: 'c.yml',
    name: 'c',
    version: null,
    valid: false,
    error: 'yaml: 解析失败示例',
    yaml: YAML_BAD,
  },
];

/** 编辑器探针：显示路由 state 里的 importedYaml。 */
function EditorProbe() {
  const state = useLocation().state as { importedYaml?: string } | null;
  return <div data-testid="editor-probe">imported:{state?.importedYaml ?? 'none'}</div>;
}

function renderFolder() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/folder', element: <FolderWorkflows /> },
      { path: '/workflows/new', element: <EditorProbe /> },
    ],
    { initialEntries: ['/folder'] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('fs-workflow-dir');
  vi.clearAllMocks();
});

describe('FolderWorkflows', () => {
  it('挂载无缓存目录：无参调用取后端默认目录并回填输入框，列表按后端顺序渲染', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/default/wf', files: FILES });
    renderFolder();
    await screen.findByText('Alpha');
    expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith(undefined);
    expect((screen.getByLabelText('目录路径') as HTMLInputElement).value).toBe('D:/default/wf');
    expect(localStorage.getItem('fs-workflow-dir')).toBe('D:/default/wf'); // 成功才写缓存
    // 表头 + 3 行；行序 = 后端给的名称字母序（Alpha < beta < 解析失败项）
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain('Alpha');
    expect(rows[1].textContent).toContain('v1');
    expect(rows[2].textContent).toContain('beta');
    expect(rows[2].textContent).toContain('v2');
    expect(rows[3].textContent).toContain('c.yml');
    expect(screen.getAllByText('✓ 可用')).toHaveLength(2); // 两行合法工作流
    const bad = screen.getByText('解析失败');
    expect(bad.getAttribute('title')).toBe('yaml: 解析失败示例');
  });

  it('localStorage 已有缓存目录：挂载直接带 dir 读取', async () => {
    localStorage.setItem('fs-workflow-dir', 'D:/cached');
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/cached', files: [] });
    renderFolder();
    await screen.findByText('该目录下没有 .yaml/.yml 工作流文件');
    expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith('D:/cached');
  });

  it('读取按钮以输入框的值调用 listFolderWorkflows，成功后写 localStorage', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: FILES });
    renderFolder();
    await screen.findByText('Alpha'); // 挂载自动读取完成
    vi.mocked(api.listFolderWorkflows).mockClear();
    fireEvent.change(screen.getByLabelText('目录路径'), { target: { value: 'D:/team/wf' } });
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith('D:/team/wf'));
    await waitFor(() => expect(localStorage.getItem('fs-workflow-dir')).toBe('D:/team/wf'));
  });

  it('在编辑器打开：navigate /workflows/new 并带 state.importedYaml（文件全文）', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: FILES });
    renderFolder();
    await screen.findByText('Alpha');
    const openBtns = screen.getAllByRole('button', { name: '在编辑器打开' });
    expect(openBtns).toHaveLength(3);
    fireEvent.click(openBtns[1]); // 第二行 beta
    expect(screen.getByTestId('editor-probe').textContent).toBe(`imported:${YAML_B}`);
  });

  it('目录不存在（400）：fs-error-text 显示后端 error', async () => {
    vi.mocked(api.listFolderWorkflows)
      .mockResolvedValueOnce({ dir: 'D:/default/wf', files: [] })
      .mockRejectedValueOnce(new Error('目录不存在: D:/nope'));
    renderFolder();
    await screen.findByText('该目录下没有 .yaml/.yml 工作流文件');
    fireEvent.change(screen.getByLabelText('目录路径'), { target: { value: 'D:/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    const err = await screen.findByText('目录不存在: D:/nope');
    expect(err.className).toContain('fs-error-text');
  });
});
