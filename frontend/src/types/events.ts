/**
 * 后端下行事件。
 *
 * 所有事件都带 `sessionId`：后端在转发时统一附加（见 agent-service 的 emitEvent /
 * 事件转发、index.ts 的 onDone）。前端据此把增量路由到正确的会话 ——
 * 否则用户在 A 执行中切到 B，A 的增量既可能被丢弃、也可能画到 B 上。
 * 仅少数原本就带该字段的事件（session_created 等）标记为必填。
 */
export type SSEEvent =
  | { type: 'session_created'; sessionId: string; name: string }
  | { type: 'session_updated'; sessionId: string; name: string }
  | { type: 'agent_start'; sessionId?: string }
  | { type: 'agent_end'; messages?: any[]; errorMessage?: string; sessionId?: string }
  | { type: 'turn_start'; sessionId?: string }
  | { type: 'turn_end'; sessionId?: string }
  | { type: 'message_start'; role: string; sessionId?: string }
  | { type: 'message_delta'; delta: string; thinking?: boolean; sessionId?: string }
  | { type: 'message_end'; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null; errorMessage?: string; sessionId?: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: any; sessionId?: string }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partialResult: any; sessionId?: string }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: any; isError: boolean; sessionId?: string }
  | { type: 'error'; message: string; sessionId?: string }
  | { type: 'aborted'; sessionId?: string }
  | { type: 'done'; sessionId?: string }
  | { type: 'confirmation_required'; sessionId: string; command: string; reason: string }
  // 新增：扩展 UI 交互
  | ExtensionUIEvent
  // 新增：工具调用流式输出
  | { type: 'command_output_chunk'; toolCallId: string; chunk: string; sessionId?: string }
  // 新增：速率限制警告
  | { type: 'rate_limit_warning'; message: string; remaining: number; resetIn: number; sessionId?: string }
  // 新增：限流终止 agent（连续错误超限）
  | { type: 'rate_limit_abort'; message: string; reason?: string; sessionId?: string }
  // 新增：LLM 超时
  | { type: 'llm_timeout'; message: string; sessionId?: string }
  // 新增：自动上下文压缩
  | { type: 'auto_compact'; sessionId: string; message: string; percent: number }
  // 新增：排队中的消息已入队
  | { type: 'message_queued'; message: string; sessionId?: string };

/** 扩展 UI 交互事件 */
export type ExtensionUIEvent =
  | { type: 'extension_ui_select'; id: string; title: string; options: string[] }
  | { type: 'extension_ui_confirm'; id: string; title: string; message: string }
  | { type: 'extension_ui_input'; id: string; title: string; placeholder?: string }
  | { type: 'extension_ui_notify'; id: string; message: string; notifyType?: 'info' | 'warning' | 'error' };
