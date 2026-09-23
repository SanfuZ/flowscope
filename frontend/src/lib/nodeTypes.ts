// 共享 React Flow nodeTypes：RunMonitor 实时画布与 WorkflowDetail 只读预览复用。
import type { NodeTypes } from '@xyflow/react';
import NodeCard from '../components/NodeCard';

export const nodeTypes: NodeTypes = { agent: NodeCard };
