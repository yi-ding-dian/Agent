// SubagentEvent 定义在 src/shared/types.ts（前后端单一事实源）。
// 需 import 到本地作用域供下方 AgentInfo.events 使用，同时 re-export 给既有引用方。
import type { SubagentEvent } from '../../shared/types.js';

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
 * 定义已迁至 src/shared/types.ts（前后端单一事实源；原前后端逐字段一致，仅注释措辞不同）。
 */
export type { SubagentEvent };

/** 干活的子代理（会话级，切会话清空） */
export interface AgentInfo {
  /** = 外层 subagent 工具调用的 toolCallId */
  id: string;
  /** 子代理任务描述（subagent 工具 args.task） */
  task: string;
  status: 'running' | 'completed' | 'error' | 'aborted';
  startedAt: number;
  endedAt?: number;
  /** 实时过程事件流（子代理内部工具调用 / 文本增量 / 结束标记） */
  events: SubagentEvent[];
  /** 子代理最终摘要（tool_end 的 result.details.summary） */
  summary?: string;
  /**
   * 过程事件缺失标记：刷新/切换会话后由消息重建的条目为 true。
   * 实时事件流（events）不随消息持久化，只有任务/状态/摘要能从消息恢复。
   */
  eventsLost?: boolean;
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
  /**
   * 后端此刻是否正在执行该会话的一轮对话。
   *
   * runningSessions 是前端内存态，刷新页面 / HMR 热重载后会整个丢失，
   * 靠这个字段在列表加载时把「执行中」标识恢复回来。
   */
  running?: boolean;
  /**
   * 会话级工作目录；null/undefined = 未显式选择，跟随全局默认（config.work_dir）。
   *
   * 全局 config.work_dir 自会话级改造后只是「默认值」：只在 work_dir 为空时生效，
   * 显式选过目录的会话不受全局变更影响。
   */
  work_dir?: string | null;
}
