// FolderWorkflows 页测试：api 客户端整体 mock，createMemoryRouter 定路由
// （/folder + /workflows/new 探针读 location.state.importedYaml 与
// originDir/originFile，断言带 state 导航——同 WorkflowDetail 测试的 data
// router 手法）。localStorage 记忆目录与收起分组（fs-folder-collapsed），
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

/** 与后端响应同形：后端已按名称字母序排序，前端原样渲染（tags 空 = 未分类）。 */
const FILES = [
  { file: 'a.yaml', name: 'Alpha', version: 1, valid: true, error: null, yaml: YAML_A, tags: [] as string[] },
  { file: 'beta.yaml', name: 'beta', version: 2, valid: true, error: null, yaml: YAML_B, tags: [] },
  {
    file: 'c.yml',
    name: 'c',
    version: null,
    valid: false,
    error: 'yaml: 解析失败示例',
    yaml: YAML_BAD,
    tags: [],
  },
];

/** 乱序 tags 数据：分组按首个 tag、组名集合字母序（alpha < 演示，CJK 码点高）、
 *  未分类恒最后；组内按 name.to_lowercase()（beta < Zeta）。 */
const GROUPED_FILES = [
  { file: 'z.yaml', name: 'Zeta', version: 1, valid: true, error: null, yaml: YAML_B, tags: ['演示', 'bonus'] },
  { file: 'a.yaml', name: 'Alpha', version: 1, valid: true, error: null, yaml: YAML_A, tags: ['alpha'] },
  { file: 'b.yaml', name: 'beta', version: 2, valid: true, error: null, yaml: YAML_B, tags: ['演示'] },
  { file: 'n.yaml', name: 'NoTag', version: 1, valid: true, error: null, yaml: YAML_A, tags: [] as string[] },
];

/** 编辑器探针：显示路由 state 里的 importedYaml 与 origin 信息。 */
function EditorProbe() {
  const state = useLocation().state as
    | { importedYaml?: string; originDir?: string; originFile?: string }
    | null;
  return (
    <div data-testid="editor-probe">
      imported:{state?.importedYaml ?? 'none'}|originDir:{state?.originDir ?? 'none'}|originFile:{state?.originFile ?? 'none'}
    </div>
  );
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
  localStorage.removeItem('fs-folder-collapsed');
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
    // 全部无 tag → 单一「未分类」组：表头 + 组行 + 3 行；行序 = 后端给的名称字母序
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(5);
    screen.getByText('未分类 (3)');
    expect(rows[2].textContent).toContain('Alpha');
    expect(rows[2].textContent).toContain('v1');
    expect(rows[3].textContent).toContain('beta');
    expect(rows[3].textContent).toContain('v2');
    expect(rows[4].textContent).toContain('c.yml');
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

  it('刷新按钮：以当前（已解析）目录重新调用 listFolderWorkflows', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: FILES });
    renderFolder();
    await screen.findByText('Alpha'); // 挂载自动读取完成
    vi.mocked(api.listFolderWorkflows).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    // 刷新读的是上次成功的 resolved dir（输入框即使被改空也不受影响）
    await waitFor(() => expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith('D:/team/wf'));
  });

  it('在编辑器打开：navigate /workflows/new 并带 state.importedYaml + originDir/originFile', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: FILES });
    renderFolder();
    await screen.findByText('Alpha');
    const openBtns = screen.getAllByRole('button', { name: '在编辑器打开' });
    expect(openBtns).toHaveLength(3);
    fireEvent.click(openBtns[1]); // 第二行 beta
    expect(screen.getByTestId('editor-probe').textContent).toBe(
      `imported:${YAML_B}|originDir:D:/team/wf|originFile:beta.yaml`,
    );
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

describe('FolderWorkflows：分组与收起（meta.tags）', () => {
  /** 取组行的展开箭头状态（▾ 展开 / ▶ 收起）。 */
  function groupChevron(label: string): string {
    const row = screen.getByText(label).closest('tr')!;
    return row.querySelector('.fs-folder-group__chevron')!.textContent ?? '';
  }

  it('乱序数据：组名集合字母序、未分类恒最后、组内名称不区分大小写排序、行显示全部 tag 徽标', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: GROUPED_FILES });
    renderFolder();
    await screen.findByText('alpha (1)');

    // 组序：alpha（ASCII）→ 演示（CJK 码点高）→ 未分类（恒最后）
    const labels = screen
      .getAllByRole('row')
      .map((r) => r.querySelector('.fs-folder-group__label')?.textContent)
      .filter((t): t is string => t !== undefined);
    expect(labels).toEqual(['alpha (1)', '演示 (2)', '未分类 (1)']);
    expect(groupChevron('演示 (2)')).toBe('▾'); // 默认展开

    // 行结构：表头 / alpha组行 / Alpha / 演示组行 / beta / Zeta / 未分类组行 / NoTag。
    // 组内：beta < Zeta（不区分大小写）；Zeta 行显示全部 tag 徽标（演示 + bonus）
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(rows[2].textContent).toContain('Alpha');
    expect(rows[4].textContent).toContain('beta'); // 演示组第 1 行（beta < Zeta）
    expect(rows[5].textContent).toContain('Zeta'); // 演示组第 2 行
    const pills = rows[5].querySelectorAll('.fs-tag-pill');
    expect(Array.from(pills).map((p) => p.textContent)).toEqual(['演示', 'bonus']);
    expect(rows[7].textContent).toContain('NoTag'); // 未分类行
  });

  it('组行整行可点：收起隐藏组内行并写 localStorage（按 dir 记忆），再点展开', async () => {
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: GROUPED_FILES });
    renderFolder();
    await screen.findByText('演示 (2)');
    expect(screen.queryByText('Zeta')).not.toBeNull(); // 展开：组内行在

    fireEvent.click(screen.getByText('演示 (2)')); // 收起
    expect(groupChevron('演示 (2)')).toBe('▶'); // 箭头翻转
    expect(screen.queryByText('Zeta')).toBeNull(); // 组内行隐藏
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.getByText('alpha (1)')).toBeTruthy(); // 其它组不受影响
    expect(JSON.parse(localStorage.getItem('fs-folder-collapsed')!)).toEqual({ 'D:/team/wf': ['演示'] });

    fireEvent.click(screen.getByText('演示 (2)')); // 再点展开
    expect(groupChevron('演示 (2)')).toBe('▾');
    expect(screen.queryByText('Zeta')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('fs-folder-collapsed')!)).toEqual({ 'D:/team/wf': [] });
  });

  it('收起集合按目录记忆：重挂载（缓存目录）后仍收起', async () => {
    localStorage.setItem('fs-workflow-dir', 'D:/team/wf');
    localStorage.setItem('fs-folder-collapsed', JSON.stringify({ 'D:/team/wf': ['演示'] }));
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/team/wf', files: GROUPED_FILES });
    renderFolder();
    await waitFor(() => expect(groupChevron('演示 (2)')).toBe('▶')); // 装载该目录的收起集合
    expect(screen.queryByText('Zeta')).toBeNull();
    expect(screen.queryByText('NoTag')).not.toBeNull(); // 未分类组不受影响
  });
});
