import { BrowserRouter, Route, Routes } from 'react-router-dom';

/** T14 会填充的真实页面占位（M1 Task 13 仅路由骨架）。 */
function Placeholder({ title }: { title: string }) {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>FlowScope</h1>
      <p>{title}（T14 填充）</p>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Placeholder title="Run 列表" />} />
        <Route path="/workflows" element={<Placeholder title="工作流列表 / 编辑" />} />
        <Route path="/runs/:id" element={<Placeholder title="Run 详情（图 + 事件流）" />} />
      </Routes>
    </BrowserRouter>
  );
}
