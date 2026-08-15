export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  thinking?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  usage?: { input: number; output: number; totalTokens: number };
  /** 此条回复经历的 LLM 调用次数（agent 模式可能多次） */
  llmCallCount?: number;
  /** LLM 调用失败的人类可读原因（模型连接失败/超时/401 等），非空时渲染错误提示块 */
  errorMessage?: string;
  /** AI 回复耗时（秒） */
  duration?: number;
  /** 用户消息附带的图片 */
  images?: ImageAttachment[];
}

export interface ImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  /** 前端预览用的 object URL（不传给后端） */
  previewUrl?: string;
}

export interface ToolCallInfo {
  id: string;
  toolName: string;
  args: any;
  status: 'pending' | 'running' | 'completed' | 'error' | 'streaming';
  result?: any;
  errorMessage?: string;
  startTime?: number;
  endTime?: number;
  /** 流式输出缓冲（命令执行实时输出） */
  streamingOutput?: string;
}

/**
 * 子代理实时事件（后端 subagent 工具 onUpdate 推送，经 SSE tool_update.partialResult.details.subagentEvent 到达）。
 * 字段风格与 ToolCallInfo 对齐：toolName/args/result/isError。
 */
export interface SubagentEvent {
  kind: 'tool_start' | 'tool_end' | 'text_delta' | 'thinking_delta' | 'agent_end';
  /** 事件发生时间（毫秒时间戳，格式化 HH:MM:SS.mmm） */
  ts?: number;
  /** 子代理 id（= 外层 subagent 工具调用的 toolCallId） */
  agentId?: string;
  /** 子代理调用的工具名（tool_start / tool_end） */
  toolName?: string;
  /** 工具参数摘要（tool_start） */
  args?: unknown;
  /** 工具结果摘要（tool_end） */
  result?: unknown;
  /** 回复文本增量（text_delta）或思考增量（thinking_delta） */
  text?: string;
  /** 是否出错（tool_end） */
  isError?: boolean;
}

/** 干活的子代理（会话级，切会话清空） */
export interface AgentInfo {
  /** = 外层 subagent 工具调用的 toolCallId */
  id: string;
  /** 子代理任务描述（subagent 工具 args.task） */
  task: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  endedAt?: number;
  /** 实时过程事件流（子代理内部工具调用 / 文本增量 / 结束标记） */
  events: SubagentEvent[];
  /** 子代理最终摘要（tool_end 的 result.details.summary） */
  summary?: string;
}

/** 扩展 UI 交互请求 */
export interface ExtensionUIRequest {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'notify';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  notifyType?: 'info' | 'warning' | 'error';
}

export type AgentMode = 'chat' | 'agent';

export interface SessionInfo {
  id: string;
  name: string;
  mode: AgentMode;
  createdAt: string;
  lastActiveAt: string;
}
