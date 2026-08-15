/**
 * RPC 事件适配器
 * 将 Agent SDK 事件翻译为客户端格式（兼容 RPC 协议格式 + 原有 SSE 格式）
 */
import type { SSEEvent } from '../utils/sse.js';

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 从 pi-ai / agent 的错误消息中提取人类可读原因。
 * 常见格式：`"400: {\"message\":\"Failed to load model ...\",\"type\":...}"`
 * 或 `{"error":{"message":"..."}}` / `{"message":"..."}`，解析失败时保留原文并截断。
 */
export function extractErrorReason(errorMessage: unknown): string {
  if (errorMessage === undefined || errorMessage === null) return '';
  let raw = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
  if (!raw) return '';

  // "400: {...}" / "401: {...}" 等带状态码前缀的 JSON
  const prefixed = raw.match(/^\s*\d{3}\s*:\s*(\{.*\})\s*$/s);
  const candidates = prefixed ? [prefixed[1], raw] : [raw];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const msg =
        parsed?.message ||
        parsed?.error?.message ||
        parsed?.errorMessage ||
        parsed?.error ||
        parsed?.detail;
      if (typeof msg === 'string' && msg.trim()) {
        raw = msg.trim();
        break;
      }
    } catch {
      // 非 JSON，保留原文
    }
  }

  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

/**
 * 将 Agent 事件转换为客户端事件
 * 支持两类事件：
 * 1. RPC 协议事件（agent_start, message_update, tool_execution_start 等）
 * 2. 扩展事件（extension_ui_request, confirmation_required 等）
 */
export function adaptAgentEvent(event: { type: string; [key: string]: unknown }): ClientEvent | ClientEvent[] | null {
  switch (event.type) {
    case 'agent_start':
      return { type: 'agent_start' };

    case 'turn_start':
      return { type: 'turn_start' };

    case 'message_start': {
      const msg = event.message as { role: string } | undefined;
      return { type: 'message_start', role: msg?.role ?? 'assistant' };
    }

    case 'message_update': {
      const evt = event.assistantMessageEvent as { type: string; [key: string]: unknown } | undefined;
      if (!evt) return null;

      if (evt.type === 'text_delta') {
        return { type: 'message_delta', delta: evt.delta as string };
      }
      if (evt.type === 'thinking_delta') {
        return { type: 'message_delta', delta: evt.delta as string, thinking: true };
      }
      if (evt.type === 'toolcall_start') {
        return {
          type: 'tool_call_start',
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          contentIndex: evt.contentIndex,
        };
      }
      return null;
    }

    case 'message_end': {
      const msg = event.message as
        | { usage?: Record<string, unknown>; stopReason?: string; errorMessage?: unknown }
        | undefined;
      const out: ClientEvent = { type: 'message_end', usage: msg?.usage ?? null };
      // 本轮 LLM 调用失败（如模型未加载 400）：把可读原因透传给前端，前端可立即挂到消息上
      if (msg?.stopReason === 'error' && msg?.errorMessage) {
        out.errorMessage = extractErrorReason(msg.errorMessage);
      }
      return out;
    }

    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };

    case 'tool_execution_update':
      return {
        type: 'tool_update',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };

    case 'tool_execution_end':
      return {
        type: 'tool_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };

    case 'turn_end':
      return { type: 'turn_end' };

    case 'agent_end': {
      const msgs = (event.messages as any[] | undefined) ?? [];
      // 取最后一条带 errorMessage 的 assistant 消息（LLM 失败时错误写在该消息上）
      let errorMessage: unknown;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role === 'assistant' && m.errorMessage) {
          errorMessage = m.errorMessage;
          break;
        }
      }
      const agentEndEvent: ClientEvent = {
        type: 'agent_end',
        messages: event.messages,
        willRetry: event.willRetry,
      };
      if (errorMessage !== undefined) {
        agentEndEvent.errorMessage = extractErrorReason(errorMessage);
        // 优先补发 error 事件（含人类可读原因），前端据此展示错误提示块
        return [{ type: 'error', message: agentEndEvent.errorMessage }, agentEndEvent];
      }
      return agentEndEvent;
    }

    case 'agent_settled':
      return { type: 'done' };

    // 扩展事件
    case 'confirmation_required':
      return {
        type: 'confirmation_required',
        sessionId: event.sessionId,
        command: event.command,
        reason: event.reason,
      };

    default:
      return null;
  }
}

/**
 * 兼容旧的 agentEventToSSE 接口
 */
export function agentEventToSSE(event: { type: string; [key: string]: unknown }): SSEEvent | SSEEvent[] | null {
  return adaptAgentEvent(event) as SSEEvent | SSEEvent[] | null;
}
