/**
 * chat-store 的类型定义
 *
 * 按业务域拆成 6 个 slice 接口，`ChatStore` 是它们的交叉类型：
 *   Session  会话域（CRUD + 工作目录 + 服务端配置）
 *   Message  消息域（发送 / 停止 / 编辑删除 / 压缩 / 断线恢复）
 *   Stream   事件编排（SSE / WS 事件分发 + 运行状态 + token 统计）
 *   Subagent 子代理域（列表 / 详情 / 飞行动画）
 *   Queue    消息队列（AI 处理中的入队与出队）
 *   Ui       界面状态（模式 / 计划 / 滚动 / 拖拽 / 确认 / 扩展 UI）
 *
 * 拆分原则：一个 slice 一个业务域，state 与其操作同处；slice 之间通过 get() 互相调用，
 * 不做跨 slice 的 state 复制。
 *
 * 注：Stream（事件分发）不是业务域而是**编排层** —— 它按事件类型驱动其余各域，故单列。
 */
import type { ChatMessage, AgentMode, SessionInfo, ExtensionUIRequest, AgentInfo } from '../../types/chat';
import type { SSEEvent } from '../../types/events';
import type { ConfigData } from '../../types/api';
import type { WSStatus } from '../../services/ws-client';

/** 工具执行确认请求（待用户确认的命令） */
export interface ConfirmationRequest {
  sessionId: string;
  command: string;
  reason: string;
}

// ─── 会话域 ──────────────────────────────────────────────────

export interface SessionSlice {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  config: ConfigData | null;
  directoryNotice: string | null;
  loadSessions: () => Promise<void>;
  createNewSession: (opts?: { workDir?: string; mode?: AgentMode }) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  switchWorkDir: (dirPath: string) => Promise<void>;
  clearDirectoryNotice: () => void;
  loadConfig: () => Promise<void>;
  saveConfig: (config: ConfigData) => Promise<void>;
}

// ─── 消息域 ──────────────────────────────────────────────────

export interface MessageSlice {
  messages: ChatMessage[];
  needsRebuild: boolean;
  /**
   * 发送消息。
   *
   * `opts.force`：跳过「本轮仍在处理」的并发守卫。仅 processQueue 出队时使用 ——
   * 那一刻上一轮刚结束，队列里的（带图）消息需要真正发出去，不能再被挡回队列。
   */
  sendMessage: (text: string, images?: { type: string; data: string; mimeType: string }[], opts?: { force?: boolean }) => Promise<void>;
  stopGeneration: () => void;
  deleteMessagePair: (assistantMsgId: string) => Promise<void>;
  /** 编辑用户消息：删除原消息对（含后端落库）后作为新消息重发 */
  editMessage: (userMsgId: string, newText: string) => Promise<void>;
  /** 手动压缩会话（TokenBar「压缩对话」按钮）：失败时设置 store.error 并 rethrow 供按钮旁红字提示 */
  compactSession: (sessionId: string) => Promise<any>;
  /** 断线恢复：轮询拉取会话完整消息直至稳定（SSE 流中断后） */
  recoverSessionAfterInterrupt: (sessionId: string) => Promise<void>;
  regenerateLastMessage: () => void;
}

// ─── 事件编排（SSE / WS） ─────────────────────────────────────

export interface StreamSlice {
  isProcessing: boolean;
  /**
   * 正在执行的会话 id 列表（不止当前显示的那个）。
   *
   * 用户在 A 执行中切到 B 时，A 后端仍在跑 —— 侧栏据此给这些会话显示动态边框，
   * 让用户知道"哪个会话还在干活"，而不是切走后就无从感知。
   */
  runningSessions: string[];
  wsStatus: WSStatus;
  engineStatus: { initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] } | null;
  /** 累计 token 使用量（从 SDK message_end.usage 累积） */
  totalUsage: { input: number; output: number; total: number };
  /** 标记某会话开始/结束执行（去重；结束用 done/error/aborted 驱动） */
  setSessionRunning: (id: string, running: boolean) => void;
  handleSSEEvent: (event: SSEEvent) => void;
  handleWSEvent: (event: SSEEvent) => void;
}

// ─── 子代理域 ────────────────────────────────────────────────

export interface SubagentSlice {
  /** 干活的子代理列表（会话级，切换会话清空；由 subagent 工具调用的 tool_start/tool_update/tool_end 驱动） */
  agents: AgentInfo[];
  /**
   * 魔法飞行请求：subagent 工具 tool_start 时触发一次（新调用覆盖旧请求）。
   * MagicFly 组件监听 id 变化播放"消息区 → Agent 面板"飞行动画，完成后 clearFly。
   */
  flyRequest: { id: string; task: string; ts: number } | null;
  clearFly: () => void;
  /** 停止指定子代理（agentId = AgentInfo.id = subagent 工具调用的 toolCallId） */
  stopSubAgent: (agentId: string) => Promise<void>;
  /** 停止当前会话下所有运行中的子代理（主代理不受影响） */
  stopAllSubAgents: () => Promise<void>;
}

// ─── 消息队列 ────────────────────────────────────────────────

export interface QueueSlice {
  /** 消息队列（AI 处理中用户输入入队） */
  messageQueue: { text: string; images?: { type: string; data: string; mimeType: string }[] }[];
  /** 已通过 steer 成功注入的消息数（用于 QueueIndicator 实时反馈） */
  steerQueueCount: number;
  queueMessage: (text: string, images?: { type: string; data: string; mimeType: string }[]) => void;
  processQueue: () => void;
}

// ─── 界面状态 ────────────────────────────────────────────────

export interface UiSlice {
  mode: AgentMode;
  /** 规划模式开关（web/SSE；只读调研，plan 轮完成后展示计划卡片） */
  planMode: boolean;
  /** 规划轮完成的计划文本（最后一条 assistant 消息），PlanCard 展示 */
  planReady: string | null;
  error: string | null;
  pendingConfirmation: ConfirmationRequest | null;
  extensionUI: ExtensionUIRequest | null;
  scrolledAway: boolean;
  scrollToBottomTrigger: number;
  /** ChatWindow 拖放文件桥接到 InputBar */
  pendingDropFiles: File[] | null;
  /** InputBar 消费 drop 后通知 ChatWindow 清除遮罩 */
  dragClearSignal: number;
  setMode: (mode: AgentMode) => void;
  setPlanMode: (on: boolean) => void;
  /** 「按此计划执行」：关闭规划并发送执行指令 */
  executePlan: () => Promise<void>;
  clearError: () => void;
  confirmDecision: (decision: 'allow' | 'always_allow' | 'block') => void;
  resolveExtensionUI: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
  setScrolledAway: (away: boolean) => void;
  scrollToBottom: () => void;
  addDropFiles: (files: File[]) => void;
  consumeDropFiles: () => File[] | null;
  signalDragClear: () => void;
}

export type ChatStore = SessionSlice & MessageSlice & StreamSlice & SubagentSlice & QueueSlice & UiSlice;
