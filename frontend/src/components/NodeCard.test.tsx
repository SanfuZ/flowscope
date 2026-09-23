// R6 裁定：一个 it 内多次 render 时用解构 container + within 定位，
// 避免 getByTestId('node-card') 多匹配抛错（brief 原始示例写法的问题）。
// Handle 组件依赖 React Flow 内部 store，单测直渲染时需 ReactFlowProvider 包裹。
import { ReactFlowProvider } from '@xyflow/react';
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NodeCard from './NodeCard';

function renderCard(data: Parameters<typeof NodeCard>[0]['data']) {
  return render(
    <ReactFlowProvider>
      <NodeCard data={data} />
    </ReactFlowProvider>,
  );
}

describe('NodeCard：状态着色与内容', () => {
  it('running 蓝色类 + elapsed 秒 + lastToolTitle', () => {
    const { container: c1 } = renderCard({
      id: 'a',
      agent: 'enterprise',
      status: 'running',
      elapsedMs: 1200,
      lastToolTitle: '查询',
    });
    expect(within(c1).getByTestId('node-card').className).toMatch(/fs-node--running/);
    expect(within(c1).getByText(/1\.2s/)).toBeTruthy();
    expect(within(c1).getByText(/查询/)).toBeTruthy();
  });

  it('failed 红色类 + error 行', () => {
    const { container } = renderCard({ id: 'a', agent: 'mock', status: 'failed', error: 'process_exit' });
    expect(within(container).getByTestId('node-card').className).toMatch(/fs-node--failed/);
    expect(within(container).getByText(/process_exit/)).toBeTruthy();
  });

  it('skipped 灰色类 / pending 灰色类，无 running 内容', () => {
    const { container: c1 } = renderCard({ id: 'a', agent: 'mock', status: 'skipped' });
    expect(within(c1).getByTestId('node-card').className).toMatch(/fs-node--skipped/);
    const { container: c2 } = renderCard({ id: 'b', agent: 'mock', status: 'pending' });
    expect(within(c2).getByTestId('node-card').className).toMatch(/fs-node--pending/);
    expect(within(c2).queryByText(/s$/)).toBeNull();
  });
});
