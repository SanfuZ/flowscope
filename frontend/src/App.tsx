// 应用壳：react-query Provider + 路由（/、/workflows、/workflows/:id、/runs/:id）+ 侧栏。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import '@xyflow/react/dist/style.css';
import './styles.css';
import RunList from './views/RunList';
import RunMonitor from './views/RunMonitor';
import WorkflowDetail from './views/WorkflowDetail';
import WorkflowList from './views/WorkflowList';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function SideLink({ to, end, children }: { to: string; end?: boolean; children: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `fs-nav${isActive ? ' fs-nav--active' : ''}`}>
      {children}
    </NavLink>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="fs-app">
          <aside className="fs-side">
            <div className="fs-side__logo">FlowScope</div>
            <nav className="fs-side__nav">
              <SideLink to="/" end>
                运行
              </SideLink>
              <SideLink to="/workflows">工作流</SideLink>
            </nav>
          </aside>
          <main className="fs-main">
            <Routes>
              <Route path="/" element={<RunList />} />
              <Route path="/workflows" element={<WorkflowList />} />
              <Route path="/workflows/:id" element={<WorkflowDetail />} />
              <Route path="/runs/:id" element={<RunMonitor />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
