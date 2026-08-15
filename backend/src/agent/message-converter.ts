/**
 * 向后兼容的消息转换器
 * 实际逻辑已迁移至 rpc-event-adapter.ts
 */
import { adaptAgentEvent } from '../rpc/rpc-event-adapter.js';
import type { SSEEvent } from '../utils/sse.js';

export function agentEventToSSE(event: { type: string; [key: string]: unknown }): SSEEvent | SSEEvent[] | null {
  return adaptAgentEvent(event) as SSEEvent | SSEEvent[] | null;
}

// 重新导出扩展事件类型
export type { ClientEvent } from '../rpc/rpc-event-adapter.js';
