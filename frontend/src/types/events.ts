export type SSEEvent =
  | { type: 'session_created'; sessionId: string; name: string }
  | { type: 'session_updated'; sessionId: string; name: string }
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: any[]; errorMessage?: string }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; role: string }
  | { type: 'message_delta'; delta: string; thinking?: boolean }
  | { type: 'message_end'; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null; errorMessage?: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: any }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partialResult: any }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: any; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  | { type: 'done' }
  | { type: 'confirmation_required'; sessionId: string; command: string; reason: string }
  // 新增：扩展 UI 交互
  | ExtensionUIEvent
  // 新增：工具调用流式输出
  | { type: 'command_output_chunk'; toolCallId: string; chunk: string }
  // 新增：速率限制警告
  | { type: 'rate_limit_warning'; message: string; remaining: number; resetIn: number }
  // 新增：限流终止 agent（连续错误超限）
  | { type: 'rate_limit_abort'; message: string }
  // 新增：LLM 超时
  | { type: 'llm_timeout'; message: string }
  // 新增：自动上下文压缩
  | { type: 'auto_compact'; sessionId: string; message: string; percent: number };

/** 扩展 UI 交互事件 */
export type ExtensionUIEvent =
  | { type: 'extension_ui_select'; id: string; title: string; options: string[] }
  | { type: 'extension_ui_confirm'; id: string; title: string; message: string }
  | { type: 'extension_ui_input'; id: string; title: string; placeholder?: string }
  | { type: 'extension_ui_notify'; id: string; message: string; notifyType?: 'info' | 'warning' | 'error' };
