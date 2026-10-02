// 底部协议事件抽屉（M2c，对照 zcode-acp-demo/workflow-demo.html 的 #drawer）：
// 默认折叠；行 = seq + kind + payload 单行摘要，单击行展开完整 pretty JSON（再点收起）。
// 事件由 NodeSession 按 node_id 过滤后按 seq 序传入，本组件纯展示。
import { useState } from 'react';
import type { FsEvent } from '../api/types';

/** 摘要行截断长度（与 demo 的 150 字符同级）。 */
const SUMMARY_MAX = 160;

export default function ProtocolDrawer({ events }: { events: FsEvent[] }) {
  const [open, setOpen] = useState(false);
  // 已展开完整 JSON 的行（按 seq 记，SSE 追加不打断已展开状态）
  const [fullSeqs, setFullSeqs] = useState<ReadonlySet<number>>(new Set());

  const toggleFull = (seq: number) => {
    setFullSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <div className="fs-proto" data-testid="protocol-drawer">
      <button
        type="button"
        className="fs-proto__toggle"
        data-testid="protocol-drawer-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} 协议事件流（{events.length} 条，单击行展开完整 JSON）
      </button>
      {open && (
        <div className="fs-proto__body" data-testid="protocol-drawer-body">
          {events.length === 0 && <div className="fs-proto__empty">暂无该节点事件</div>}
          {events.map((ev) => {
            const full = fullSeqs.has(ev.seq);
            const payload = ev.payload ?? {};
            return (
              <div
                key={ev.seq}
                className={`fs-proto__evt ${full ? 'fs-proto__evt--full' : ''}`}
                data-testid="proto-row"
                onClick={() => toggleFull(ev.seq)}
              >
                <span className="fs-proto__seq">#{ev.seq}</span>
                <span className="fs-proto__kind">{ev.kind}</span>
                <span className="fs-proto__json">
                  {full
                    ? JSON.stringify(payload, null, 2)
                    : JSON.stringify(payload).slice(0, SUMMARY_MAX)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
