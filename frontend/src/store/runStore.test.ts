import { describe, expect, it } from 'vitest';
import type { FsEvent } from '../api/types';
import { applyEvent, emptyView, useRunStore } from './runStore';

const ev = (seq: number, kind: FsEvent['kind'], node_id: string | null, payload: any): FsEvent =>
  ({ seq, ts: '2026-09-22T10:00:00Z', run_id: 'r', node_id, session_id: null, kind, payload });

describe('applyEvent：节点生命周期', () => {
  it('started→running，finished→succeeded，text delta 累积', () => {
    let v = emptyView('r', ['a']);
    expect(v.nodes.a.status).toBe('pending');
    v = applyEvent(v, ev(1, 'node.started', 'a', {}));
    expect(v.nodes.a.status).toBe('running');
    expect(v.nodes.a.startedAt).toBe('2026-09-22T10:00:00Z');
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: '你', contentType: 'text' }));
    v = applyEvent(v, ev(3, 'msg.delta', 'a', { delta: '好', contentType: 'text' }));
    expect(v.nodes.a.message).toBe('你好');
    v = applyEvent(v, ev(4, 'node.finished', 'a', { durationMs: 100 }));
    expect(v.nodes.a.status).toBe('succeeded');
    expect(v.nodes.a.endedAt).toBe('2026-09-22T10:00:00Z');
    expect(v.lastSeq).toBe(4);
  });

  it('node.retry 保持 running（pending 则转 running）', () => {
    let v = emptyView('r', ['a', 'b']);
    v = applyEvent(v, ev(1, 'node.started', 'a', {}));
    v = applyEvent(v, ev(2, 'node.retry', 'a', { attempt: 1, max: 2 }));
    expect(v.nodes.a.status).toBe('running');
    // 未 started 的节点收到 retry：视为即将重跑 → running
    v = applyEvent(v, ev(3, 'node.retry', 'b', { attempt: 1, max: 2 }));
    expect(v.nodes.b.status).toBe('running');
  });

  it('重复/迟到 seq 直接丢弃', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'node.started', 'a', {}));
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: 'x', contentType: 'text' }));
    // SSE 重连重放 seq=2：不得二次拼接
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: 'x', contentType: 'text' }));
    expect(v.nodes.a.message).toBe('x');
    expect(v.lastSeq).toBe(2);
  });
});

describe('applyEvent：tool / plan / 日志与终态', () => {
  it('tool.update 按 toolCallId 合并，lastToolTitle 跟随', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'tool.update', 'a', { toolCallId: 't1', title: '查询', kind: 'fetch', status: 'in_progress' }));
    expect(v.nodes.a.tools).toHaveLength(1);
    expect(v.nodes.a.tools[0]).toEqual({ id: 't1', title: '查询', kind: 'fetch', status: 'in_progress' });
    expect(v.nodes.a.lastToolTitle).toBe('查询');
    // 同 toolCallId 二次更新：合并字段，不新增条目，title 保留
    v = applyEvent(v, ev(2, 'tool.update', 'a', { toolCallId: 't1', status: 'completed' }));
    expect(v.nodes.a.tools).toHaveLength(1);
    expect(v.nodes.a.tools[0].status).toBe('completed');
    expect(v.nodes.a.tools[0].title).toBe('查询');
    // 新 toolCallId：追加
    v = applyEvent(v, ev(3, 'tool.update', 'a', { toolCallId: 't2', title: '写文件', status: 'pending' }));
    expect(v.nodes.a.tools).toHaveLength(2);
    expect(v.nodes.a.lastToolTitle).toBe('写文件');
  });

  it('plan.snapshot：扁平 entries（无 id，按 content 渲染）', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'plan.snapshot', 'a', {
      entries: [
        { content: '收集数据', status: 'completed' },
        { content: '生成摘要', priority: 'high', status: 'in_progress' },
      ],
    }));
    expect(v.nodes.a.plan?.entries).toHaveLength(2);
    expect(v.nodes.a.plan?.entries[0].content).toBe('收集数据');
    expect(v.nodes.a.plan?.entries[1].priority).toBe('high');
    // 二次快照整体替换
    v = applyEvent(v, ev(2, 'plan.snapshot', 'a', { entries: [{ content: 'done', status: 'completed' }] }));
    expect(v.nodes.a.plan?.entries).toHaveLength(1);
    expect(v.nodes.a.plan?.entries[0].content).toBe('done');
  });

  it('log.lines 追加且上限 500 条裁剪', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'log.lines', 'a', { lines: ['l1', 'l2'], level: 'info' }));
    expect(v.nodes.a.logs).toEqual(['l1', 'l2']);
    const many = Array.from({ length: 550 }, (_, i) => `x${i}`);
    v = applyEvent(v, ev(2, 'log.lines', 'a', { lines: many, level: 'info' }));
    expect(v.nodes.a.logs).toHaveLength(500);
    expect(v.nodes.a.logs[0]).toBe('x50');
    expect(v.nodes.a.logs[499]).toBe('x549');
  });

  it('node.failed 记录 error=reason；node.skipped / node.cancelled 终态', () => {
    let v = emptyView('r', ['a', 'b', 'c']);
    v = applyEvent(v, ev(1, 'node.started', 'a', {}));
    v = applyEvent(v, ev(2, 'node.failed', 'a', { durationMs: 9, reason: 'process_exit' }));
    expect(v.nodes.a.status).toBe('failed');
    expect(v.nodes.a.error).toBe('process_exit');
    v = applyEvent(v, ev(3, 'node.skipped', 'b', { reason: 'no satisfiable incoming edges' }));
    expect(v.nodes.b.status).toBe('skipped');
    v = applyEvent(v, ev(4, 'node.started', 'c', {}));
    v = applyEvent(v, ev(5, 'node.cancelled', 'c', { durationMs: 5, reason: 'cancelled by user' }));
    expect(v.nodes.c.status).toBe('cancelled');
  });
});

describe('applyEvent：run 级事件与 reasoning 块', () => {
  it('run.started→running，run.failed→failed', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'run.started', null, { workflowName: 'weekly-report', params: { week: 1 } }));
    expect(v.status).toBe('running');
    v = applyEvent(v, ev(2, 'run.failed', null, { reason: 'boom' }));
    expect(v.status).toBe('failed');
  });

  it('run.finished / cancelled / interrupted 终态', () => {
    let v = emptyView('r', []);
    v = applyEvent(v, ev(1, 'run.finished', null, {}));
    expect(v.status).toBe('finished');
    v = applyEvent(v, ev(2, 'run.cancelled', null, { reason: 'cancelled by user' }));
    expect(v.status).toBe('cancelled');
    v = applyEvent(v, ev(3, 'run.interrupted', null, {}));
    expect(v.status).toBe('interrupted');
  });

  it('reasoning delta 进 reasoning 数组，不污染 message', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'run.started', null, {}));
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: '思', contentType: 'reasoning' }));
    v = applyEvent(v, ev(3, 'msg.delta', 'a', { delta: '考', contentType: 'reasoning' }));
    v = applyEvent(v, ev(4, 'msg.delta', 'a', { delta: '答', contentType: 'text' }));
    expect(v.nodes.a.message).toBe('答');
    expect(v.nodes.a.reasoning).toEqual(['思', '考']);
  });
});

describe('useRunStore：zustand 封装', () => {
  it('setRun → apply → view 更新；reset 清空', () => {
    useRunStore.getState().reset();
    expect(useRunStore.getState().view).toBeNull();
    useRunStore.getState().setRun(emptyView('r', ['a']));
    useRunStore.getState().apply(ev(1, 'run.started', null, {}));
    expect(useRunStore.getState().view?.status).toBe('running');
    useRunStore.getState().apply(ev(2, 'msg.delta', 'a', { delta: 'hi', contentType: 'text' }));
    expect(useRunStore.getState().view?.nodes.a.message).toBe('hi');
    useRunStore.getState().reset();
    expect(useRunStore.getState().view).toBeNull();
  });
});
