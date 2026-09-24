// 应用壳：react-query Provider + 路由（/、/workflows、/workflows/:id、/runs/:id）+ 侧栏。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import RunList from './views/RunList';
import RunMonitor from './views/RunMonitor';
import WorkflowDetail from './views/WorkflowDetail';
import WorkflowList from './views/WorkflowList';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** 16px 线性图标（无图标库依赖，currentColor 跟随文字色）。 */
function Icon({ path }: { path: ReactNode }) {
  return (
    <span className="fs-nav__icon">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    </span>
  );
}

const ICON_RUN = (
  <>
    <rect x="1.5" y="2" width="13" height="12" rx="2" />
    <path d="M4.5 8h7M4.5 5h4M4.5 11h5" />
  </>
);
const ICON_FLOW = (
  <>
    <rect x="1" y="6" width="4" height="4" rx="1" />
    <rect x="11" y="1.5" width="4" height="4" rx="1" />
    <rect x="11" y="10.5" width="4" height="4" rx="1" />
    <path d="M5 8h3m0 0V3.5h3M8 8v3h3" />
  </>
);

function SideLink({ to, end, icon, children }: { to: string; end?: boolean; icon: ReactNode; children: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `fs-nav${isActive ? ' fs-nav--active' : ''}`}>
      {icon}
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
            <div className="fs-side__logo">
              <span className="fs-logo-mark">F</span>
              <span className="fs-side__name">FlowScope</span>
              <span className="fs-side__ver">M1</span>
            </div>
            <nav className="fs-side__nav">
              <SideLink to="/" end icon={<Icon path={ICON_RUN} />}>
                运行
              </SideLink>
              <SideLink to="/workflows" icon={<Icon path={ICON_FLOW} />}>
                工作流
              </SideLink>
            </nav>
            <div className="fs-side__foot">
              ACP 工作流可视化监控
              <br />
              单机模式 · 事件溯源
            </div>
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
