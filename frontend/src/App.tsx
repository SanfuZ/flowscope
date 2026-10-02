// 应用壳：react-query Provider + 路由（/、/workflows、/workflows/:id、/runs/:id）+ 侧栏。
// save-ux：BrowserRouter → createBrowserRouter + RouterProvider（data router）。
// 原因：WorkflowDetail 的 useBlocker（未保存离开拦截）在 react-router 6.19+
// 仅于 data router 上下文可用（useDataRouterContext 会抛错），路由结构不变。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  useParams,
  RouterProvider,
} from 'react-router-dom';
import { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import NodeSession from './views/NodeSession';
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

/** 布局壳：侧栏 + <Outlet/>（data router 的嵌套路由出口）。 */
function AppShell() {
  return (
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
        <Outlet />
      </main>
    </div>
  );
}

/** 节点会话路由薄壳：NodeSession 本体以 props 接参（便于直渲染单测）。 */
function NodeSessionRoute() {
  const { runId, nodeId } = useParams<{ runId: string; nodeId: string }>();
  return <NodeSession runId={runId ?? ''} nodeId={nodeId ?? ''} />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <RunList /> },
      { path: 'workflows', element: <WorkflowList /> },
      { path: 'workflows/:id', element: <WorkflowDetail /> },
      { path: 'runs/:id', element: <RunMonitor /> },
      { path: 'runs/:runId/sess/:nodeId', element: <NodeSessionRoute /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
