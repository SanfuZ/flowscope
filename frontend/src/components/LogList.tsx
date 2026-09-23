// 节点日志虚拟列表（react-window FixedSizeList，单行等高，等宽字体）。
// store 侧已做 500 条环形裁剪，此处直接全量交给虚拟化窗口渲染。
import { FixedSizeList } from 'react-window';

export const LOG_ROW_HEIGHT = 20;

export default function LogList({ logs, height = 520 }: { logs: string[]; height?: number }) {
  return (
    <FixedSizeList
      height={height}
      width="100%"
      itemSize={LOG_ROW_HEIGHT}
      itemCount={logs.length}
      overscanCount={10}
      className="fs-loglist"
    >
      {({ index, style }) => (
        <div style={style} className="fs-log-row" title={logs[index]}>
          {logs[index]}
        </div>
      )}
    </FixedSizeList>
  );
}
