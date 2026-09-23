// SSE 订阅 hook：连接 GET /api/runs/:id/events?after=<lastSeq>，
// 帧事件名为 "fs"（后端 sse_frame 固定 .event("fs")），data 为 FsEvent JSON。
// 断线（onerror）→ 主动 close + 指数退避重连（1s 起、翻倍、上限 10s）；
// 重连时以 store 内最新 lastSeq 为 after，配合服务端回放不丢不重
// （applyEvent 还有 seq<=lastSeq 丢弃兜底）。connected 在断线间隙为 false。
// 刻意保持薄：状态转移全在 runStore.applyEvent，本 hook 不参与（T14/E2E 覆盖）。
import { useEffect, useState } from 'react';
import { api } from './client';
import { useRunStore } from '../store/runStore';
import type { FsEvent } from './types';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

export function useRunEvents(runId: string | null): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const apply = useRunStore((s) => s.apply);

  useEffect(() => {
    if (!runId) {
      setConnected(false);
      return;
    }
    let es: EventSource | null = null;
    let timer: number | undefined;
    let delay = RECONNECT_MIN_MS;
    let disposed = false;

    const connect = () => {
      // 连接（含重连）时刻取 store 最新 lastSeq，避免 effect 依赖事件流
      const after = useRunStore.getState().view?.lastSeq ?? 0;
      es = new EventSource(api.eventsUrl(runId, after));
      es.onopen = () => {
        delay = RECONNECT_MIN_MS; // 成功一次即重置退避
        setConnected(true);
      };
      // 后端帧带 event: "fs"，必须 addEventListener；onmessage 收不到命名事件
      es.addEventListener('fs', (e: MessageEvent<string>) => {
        try {
          apply(JSON.parse(e.data) as FsEvent);
        } catch {
          /* 坏帧忽略，不断流 */
        }
      });
      es.onerror = () => {
        es?.close(); // 接管重连节奏：禁用 EventSource 自动重连
        setConnected(false);
        if (!disposed) {
          timer = window.setTimeout(connect, delay);
          delay = Math.min(delay * 2, RECONNECT_MAX_MS);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      es?.close();
      window.clearTimeout(timer);
      setConnected(false);
    };
  }, [runId, apply]);

  return { connected };
}
