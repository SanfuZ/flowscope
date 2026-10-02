// useRunEvents 单测：jsdom 无 EventSource，用桩类替代并手动发帧。
// 覆盖 M2c 的 onEvent 旁路契约——与 store.apply 并行触发、不传则零行为变化、
// 连接 URL 带 after=<store lastSeq>（回放语义）。
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsEvent } from './types';
import { useRunEvents } from './useRunEvents';
import { emptyView, useRunStore } from '../store/runStore';

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, (e: { data: string }) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, cb: (e: { data: string }) => void): void {
    this.listeners.set(type, cb);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(ev: unknown): void {
    this.listeners.get('fs')?.({ data: JSON.stringify(ev) });
  }
}

vi.stubGlobal('EventSource', EventSourceStub);

const frame = (seq: number, kind: FsEvent['kind'], payload: any, node_id: string | null = 'a'): FsEvent => ({
  seq,
  ts: '2026-10-03T10:00:00Z',
  run_id: 'r',
  node_id,
  session_id: null,
  kind,
  payload,
});

afterEach(() => {
  EventSourceStub.instances = [];
  useRunStore.getState().reset();
});

describe('useRunEvents：onEvent 旁路（M2c）', () => {
  it('onEvent 与 store.apply 并行触发；URL 带 after=<lastSeq>', () => {
    useRunStore.getState().setRun(emptyView('r', ['a']));
    // 预置 lastSeq=5 → 连接应从 after=5 续传
    useRunStore.getState().apply(frame(5, 'run.started', {}, null));
    const seen: FsEvent[] = [];
    const { result, unmount } = renderHook(() => useRunEvents('r', (ev) => seen.push(ev)));

    const es = EventSourceStub.instances.at(-1)!;
    expect(es.url).toContain('after=5');
    act(() => es.open());
    expect(result.current.connected).toBe(true);

    act(() => es.emit(frame(6, 'node.started', { prompt: 'x' })));
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.prompt).toBe('x');
    expect(useRunStore.getState().view?.nodes.a.status).toBe('running'); // store 同帧更新
    unmount();
    expect(es.closed).toBe(true); // 卸载断流
  });

  it('不传 onEvent（向后兼容）：仅 store 更新，不报错', () => {
    useRunStore.getState().setRun(emptyView('r', ['a']));
    const { result, unmount } = renderHook(() => useRunEvents('r'));
    const es = EventSourceStub.instances.at(-1)!;
    expect(es.url).toContain('after=0');
    act(() => es.open());
    expect(result.current.connected).toBe(true);
    act(() => es.emit(frame(1, 'msg.delta', { delta: 'hi', contentType: 'text' })));
    expect(useRunStore.getState().view?.nodes.a.message).toBe('hi');
    unmount();
  });
});
