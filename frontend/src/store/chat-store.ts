import { create } from 'zustand';
import type { ChatMessage, ImageAttachment, AgentMode, SessionInfo, ToolCallInfo, ExtensionUIRequest, AgentInfo, SubagentEvent } from '../types/chat';
import type { SSEEvent } from '../types/events';
import type { ConfigData } from '../types/api';
import { fetchSSE, StreamInterruptedError } from '../services/sse-client';
import { getLlmOverrides, apiUrl, isElectron } from '../services/api-config';
import { getWSClient, type WSStatus } from '../services/ws-client';
import { confirmDialog } from './confirm-dialog';
import * as api from '../services/api';

interface ConfirmationRequest {
  sessionId: string;
  command: string;
  reason: string;
}

interface ChatStore {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  /** 干活的子代理列表（会话级，切换会话清空；由 subagent 工具调用的 tool_start/tool_update/tool_end 驱动） */
  agents: AgentInfo[];
  /**
   * 魔法飞行请求：subagent 工具 tool_start 时触发一次（新调用覆盖旧请求）。
   * MagicFly 组件监听 id 变化播放"消息区 → Agent 面板"飞行动画，完成后 clearFly。
   */
  flyRequest: { id: string; task: string; ts: number } | null;
  clearFly: () => void;
  isProcessing: boolean;
  /**
   * 正在执行的会话 id 列表（不止当前显示的那个）。
   *
   * 用户在 A 执行中切到 B 时，A 后端仍在跑 —— 侧栏据此给这些会话显示动态边框，
   * 让用户知道"哪个会话还在干活"，而不是切走后就无从感知。
   */
  runningSessions: string[];
  /** 标记某会话开始/结束执行（去重；结束用 done/error/aborted 驱动） */
  setSessionRunning: (id: string, running: boolean) => void;
  mode: AgentMode;
  /** 规划模式开关（web/SSE；只读调研，plan 轮完成后展示计划卡片） */
  planMode: boolean;
  /** 规划轮完成的计划文本（最后一条 assistant 消息），PlanCard 展示 */
  planReady: string | null;
  error: string | null;
  config: ConfigData | null;
  pendingConfirmation: ConfirmationRequest | null;
  scrolledAway: boolean;
  scrollToBottomTrigger: number;
  needsRebuild: boolean;
  directoryNotice: string | null;
  // WebSocket 状态
  wsStatus: WSStatus;
  // Electron 引擎状态
  engineStatus: { initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] } | null;
  // 扩展 UI
  extensionUI: ExtensionUIRequest | null;
  // 消息队列（AI 处理中用户输入入队）
  messageQueue: { text: string; images?: { type: string; data: string; mimeType: string }[] }[];
  /** 已通过 steer 成功注入的消息数（用于 QueueIndicator 实时反馈） */
  steerQueueCount: number;
  // 累计 token 使用量（从 SDK message_end.usage 累积）
  totalUsage: { input: number; output: number; total: number };
  // ChatWindow 拖放文件桥接到 InputBar
  pendingDropFiles: File[] | null;
  addDropFiles: (files: File[]) => void;
  consumeDropFiles: () => File[] | null;
  // InputBar 消费 drop 后通知 ChatWindow 清除遮罩
  dragClearSignal: number;
  signalDragClear: () => void;

  setMode: (mode: AgentMode) => void;
  setPlanMode: (on: boolean) => void;
  /** 「按此计划执行」：关闭规划并发送执行指令 */
  executePlan: () => Promise<void>;
  clearError: () => void;
  loadSessions: () => Promise<void>;
  createNewSession: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  deleteMessagePair: (assistantMsgId: string) => Promise<void>;
  /** 编辑用户消息：删除原消息对（含后端落库）后作为新消息重发 */
  editMessage: (userMsgId: string, newText: string) => Promise<void>;
  /** 手动压缩会话（TokenBar「压缩对话」按钮）：失败时设置 store.error 并 rethrow 供按钮旁红字提示 */
  compactSession: (sessionId: string) => Promise<any>;
  /** 断线恢复：轮询拉取会话完整消息直至稳定（SSE 流中断后） */
  recoverSessionAfterInterrupt: (sessionId: string) => Promise<void>;
  /**
   * 发送消息。
   *
   * `opts.force`：跳过「本轮仍在处理」的并发守卫。仅 processQueue 出队时使用 ——
   * 那一刻上一轮刚结束，队列里的（带图）消息需要真正发出去，不能再被挡回队列。
   */
  sendMessage: (text: string, images?: { type: string; data: string; mimeType: string }[], opts?: { force?: boolean }) => Promise<void>;
  stopGeneration: () => void;
  /** 停止指定子代理（agentId = AgentInfo.id = subagent 工具调用的 toolCallId） */
  stopSubAgent: (agentId: string) => Promise<void>;
  /** 停止当前会话下所有运行中的子代理（主代理不受影响） */
  stopAllSubAgents: () => Promise<void>;
  handleSSEEvent: (event: SSEEvent) => void;
  handleWSEvent: (event: SSEEvent) => void;
  loadConfig: () => Promise<void>;
  saveConfig: (config: ConfigData) => Promise<void>;
  switchWorkDir: (dirPath: string) => Promise<void>;
  clearDirectoryNotice: () => void;
  confirmDecision: (decision: 'allow' | 'always_allow' | 'block') => void;
  setScrolledAway: (away: boolean) => void;
  scrollToBottom: () => void;
  // 新增
  regenerateLastMessage: () => void;
  resolveExtensionUI: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
  queueMessage: (text: string, images?: { type: string; data: string; mimeType: string }[]) => void;
  processQueue: () => void;
}

let messageCounter = 0;
function nextId() {
  return `msg_${++messageCounter}_${Date.now()}`;
}

// ─── API 消息 → ChatMessage 转换 ──────────────────────

/** 从后端原始错误信息中提取人类可读原因（"400: {json}" → message 字段），与后端 extractErrorReason 语义一致 */
function extractReadableError(errorMessage: any): string {
  if (errorMessage === undefined || errorMessage === null) return '';
  let raw = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
  if (!raw) return '';
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
  return raw;
}

/** 从 content（可能是字符串或 content block 数组）中提取纯文本 */
function extractTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
  }
  return '';
}

/**
 * 将后端返回的原始 AgentMessage 数组转换为前端 ChatMessage[]。
 * 处理逻辑：
 * - UserMessage → user ChatMessage
 * - AssistantMessage + 后续 ToolResultMessage + 后续 AssistantMessage → 一个 assistant ChatMessage
 *   （提取 text → content，thinking → thinking，toolCall → toolCalls）
 * - 旧格式（content 为纯字符串）兼容
 */
/**
 * 从消息中的 subagent 工具调用重建子 Agent 列表。
 *
 * 场景：agents 是会话级内存状态（由 SSE 实时事件驱动），刷新页面或切换会话后会丢失，
 * 但 subagent 的调用记录留在消息的 toolCalls 里 —— 据此恢复「任务 / 状态 / 摘要」。
 * 注意：实时过程事件流（events）不随消息持久化，重建条目 events 为空且 eventsLost=true，
 * 详情页据此提示"过程未保留"，而非误显示成"没有过程"。
 */
/**
 * 剥离主代理传入 task 自带的「任务：」前缀。
 *
 * 详情弹窗模板自己会渲染一个「任务：」（AgentDetailModal），而模型给的 task 常自带一个，
 * 两者叠加会显示成「任务：任务：…」。在数据入口统一剥离，列表项文本 / title、详情、
 * 魔法飞行动画三处显示即保持一致。
 */
function stripTaskPrefix(text: string): string {
  return text.replace(/^\s*任务\s*[:：]\s*/, '');
}

/**
 * 后台会话的实时视图。
 *
 * 场景：A 正在流式输出，用户切到 B —— A 在后端照跑，事件持续到达前端。
 * 此前前端只有一份 messages：切走时被 B 的快照整体覆盖，A 的增量随即被
 * `if (last.isStreaming)` 挡掉而静默丢弃；切回 A 时后端又尚未落库正在生成的那条，
 * 于是界面「冻」在切换那一刻，看着像会话死了。
 *
 * 这里为仍在后台执行的会话保留内存视图：事件按 sessionId 累积进来，切回时优先
 * 用它恢复（含 isStreaming 标记）；该会话流结束后丢弃存档，回落到后端落库结果。
 */
interface LiveView {
  messages: ChatMessage[];
  agents: AgentInfo[];
}

const liveViews = new Map<string, LiveView>();

/**
 * 把「对消息数组的更新」路由到事件所属的会话。
 *
 * - 属于当前显示的会话 → 写 store
 * - 属于其他会话、且它正在后台跑（liveViews 有存档）→ 累积进存档
 * - 其余 → 丢弃并返回 false（防止把 A 的增量画到 B 上）
 *
 * 事件不带 sessionId 时按当前会话处理（向后兼容旧事件）。
 */
function withMessages(sid: unknown, fn: (msgs: ChatMessage[]) => ChatMessage[]): boolean {
  const { activeSessionId } = useChatStore.getState();
  const id = typeof sid === 'string' ? sid : null;
  if (id && activeSessionId && id !== activeSessionId) {
    const view = liveViews.get(id);
    if (!view) return false;
    view.messages = fn(view.messages);
    return true;
  }
  useChatStore.setState((s) => ({ messages: fn(s.messages) }));
  return true;
}

/** 子代理列表与 withMessages 同构：同样按会话归属路由 */
function withAgents(sid: unknown, fn: (agents: AgentInfo[]) => AgentInfo[]): boolean {
  const { activeSessionId } = useChatStore.getState();
  const id = typeof sid === 'string' ? sid : null;
  if (id && activeSessionId && id !== activeSessionId) {
    const view = liveViews.get(id);
    if (!view) return false;
    view.agents = fn(view.agents);
    return true;
  }
  useChatStore.setState((s) => ({ agents: fn(s.agents) }));
  return true;
}

/** 事件是否属于当前正在显示的会话（用于只对当前会话生效的附属状态，如 totalUsage/error） */
function isActiveSession(sid: unknown): boolean {
  const id = typeof sid === 'string' ? sid : null;
  const { activeSessionId } = useChatStore.getState();
  return !id || !activeSessionId || id === activeSessionId;
}

/**
 * 该会话本轮结束：丢弃后台存档，切回时改走「后端落库结果」。
 *
 * 存档只服务于「执行中切走再切回」的连续性；一旦收尾，后端已写入完整消息，
 * 再用存档反而可能停留在半截状态。当前显示的会话本就没有存档，调用无副作用。
 */
function endLiveView(sid: unknown): void {
  const id = typeof sid === 'string' ? sid : null;
  if (id) liveViews.delete(id);
}

// ─── 「执行中」状态的轮询兜底 ──────────────────────────

let runningSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 有会话处于执行中时，定期回后端核对状态。
 *
 * 为什么需要：实时事件是绑定在「发起那次请求」的 WS 连接上的（后端见 onSse/onDone），
 * 页面刷新或断线重连后前端是全新连接、旧连接的监听已随 close 移除 —— 后端正在跑的
 * 会话不会再推任何事件过来。此时若不核对，侧栏「执行中」边框会一直亮着不熄灭，
 * 与真实状态脱节。后端 listRunningSessionIds 才是权威，故以它为准。
 *
 * 只在确有执行中的会话时启用（间隔 3s），全部结束后自动停止。
 */
function startRunningSync(): void {
  if (runningSyncTimer) return;
  runningSyncTimer = setTimeout(async () => {
    runningSyncTimer = null;
    if (useChatStore.getState().runningSessions.length === 0) return;
    await useChatStore.getState().loadSessions();
    if (useChatStore.getState().runningSessions.length > 0) startRunningSync();
  }, 3000);
}

function rebuildAgentsFromMessages(messages: ChatMessage[]): AgentInfo[] {
  const agents: AgentInfo[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.toolName !== 'subagent') continue;
      const details = (tc.result as any)?.details;
      const task = stripTaskPrefix(
        typeof (tc.args as any)?.task === 'string' ? (tc.args as any).task : '',
      );
      // aborted 优先（用户主动停止）；completed 之外（error/running/pending）均视为未正常完成
      const status = details?.aborted
        ? 'aborted'
        : tc.status === 'completed'
          ? 'completed'
          : 'error';

      // 用 details.toolCalls 重建「工具调用 (N)」列表。
      // 实时过程流（events）不随消息持久化，这是唯一留存的调用记录 —— 但它是个精简版
      // （只有工具名 + 参数字符串，没有 id/结果），所以卡片只呈现「调用了什么」。
      const events: SubagentEvent[] = [];
      if (Array.isArray(details?.toolCalls)) {
        for (const c of details.toolCalls as any[]) {
          let args: unknown = c?.args;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* 非 JSON，原样展示 */ }
          }
          // 成对推入：buildEventView 用栈配对 start/end 成一张卡片
          events.push({ kind: 'tool_start', toolName: c?.name ?? '', args });
          events.push({ kind: 'tool_end', toolName: c?.name ?? '', isError: false });
        }
      }
      // 仅在正常完成时补结束标记（error/aborted 由 AgentDetailModal 按 status 另行呈现）
      if (events.length && status === 'completed') events.push({ kind: 'agent_end' });

      agents.push({
        id: tc.id,
        task,
        status,
        startedAt: tc.startTime ?? m.timestamp,
        endedAt: tc.endTime,
        events,
        summary: typeof details?.summary === 'string' ? details.summary : undefined,
        eventsLost: true,
      });
    }
  }
  return agents;
}

function apiMessagesToChatMessages(apiMessages: any[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let i = 0; i < apiMessages.length; i++) {
    const msg = apiMessages[i];

    if (msg.role === 'user') {
      result.push({
        id: nextId(),
        role: 'user',
        content: extractTextContent(msg.content),
        timestamp: msg.timestamp || Date.now(),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const chatMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        timestamp: msg.timestamp || Date.now(),
        toolCalls: [],
      };
      appendAssistantContent(msg, chatMsg);
      // LLM 失败消息（历史重载）：挂上可读原因，错误提示块仍显示（避免刷新后空白重现）
      if (msg.stopReason === 'error' && msg.errorMessage) {
        chatMsg.errorMessage = extractReadableError(msg.errorMessage);
      }

      // 收集同轮次后续的 toolResult 和 follow-up assistant 消息
      let j = i + 1;
      while (j < apiMessages.length && apiMessages[j].role !== 'user') {
        if (apiMessages[j].role === 'toolResult') {
          // 把结果合并回对应的 toolCall。
          // 此前这里是「直接跳过」，理由是「已通过 assistant 的 toolCall block 展示」——
          // 但 toolCall block 只带 id/name/arguments，结果根本不在里面，于是
          // toolCalls[i].result 永远 undefined：主界面工具卡片展开看不到结果，
          // 子 Agent 详情也取不到 details.summary（切回会话后只剩任务描述的主因之一）。
          const tr = apiMessages[j] as any;
          const target = chatMsg.toolCalls?.find((t) => t.id === tr.toolCallId);
          if (target) {
            // 与实时路径（tool_end 事件的 result）保持同一结构：{ content, details }
            target.status = tr.isError ? 'error' : 'completed';
            target.result = { content: tr.content, details: tr.details };
            target.endTime = tr.timestamp;
            if (tr.isError) target.errorMessage = extractTextContent(tr.content) || undefined;
          }
          j++;
        } else if (apiMessages[j].role === 'assistant') {
          appendAssistantContent(apiMessages[j], chatMsg);
          j++;
        } else {
          break;
        }
      }
      i = j - 1; // 跳过已处理的消息

      if (!chatMsg.thinking) delete chatMsg.thinking;
      if (!chatMsg.toolCalls?.length) delete chatMsg.toolCalls;
      result.push(chatMsg);
      continue;
    }

    // toolResult 兜底（没有前导 assistant 时）：以 tool 角色展示
    if (msg.role === 'toolResult') {
      const content = extractTextContent(msg.content);
      if (content) {
        result.push({
          id: nextId(),
          role: 'tool' as any,
          content,
          timestamp: msg.timestamp || Date.now(),
        });
      }
    }
  }

  return result;
}

function appendAssistantContent(msg: any, chatMsg: ChatMessage): void {
  const raw = msg.content;
  if (Array.isArray(raw)) {
    for (const block of raw) {
      if (block.type === 'text') {
        chatMsg.content += block.text;
      } else if (block.type === 'thinking') {
        chatMsg.thinking = (chatMsg.thinking || '') + block.thinking;
      } else if (block.type === 'toolCall') {
        chatMsg.toolCalls!.push({
          id: block.id,
          toolName: block.name || '',
          args: block.arguments || {},
          status: 'completed' as const,
          endTime: Date.now(),
        });
      }
    }
  } else if (typeof raw === 'string') {
    // 旧格式兼容
    chatMsg.content += raw;
  }

  // 同轮多条 assistant 消息（工具调用多次 LLM）的 usage 全量累加（与 message_end 口径一致），
  // 保证历史会话刷新后消息元信息显示整轮总量，与运行中显示一致
  if (msg.usage) {
    chatMsg.usage = {
      input: (chatMsg.usage?.input || 0) + (msg.usage.input || 0),
      output: (chatMsg.usage?.output || 0) + (msg.usage.output || 0),
      totalTokens: (chatMsg.usage?.totalTokens || 0) + (msg.usage.totalTokens || 0),
    };
  }
  chatMsg.llmCallCount = (chatMsg.llmCallCount || 0) + 1;
}

/**
 * 本地移除一条 assistant 消息及其对应的 user 消息。
 * 由 deleteMessagePair / editMessage 在删除成功后调用（前端视图更新）。
 */
function removePairLocally(s: ChatStore, assistantMsgId: string) {
  const idx = s.messages.findIndex((m) => m.id === assistantMsgId);
  if (idx <= 0 || s.messages[idx].role !== 'assistant') return s;
  let userIdx = idx - 1;
  while (userIdx >= 0 && s.messages[userIdx].role !== 'user') userIdx--;
  if (userIdx < 0) return s;
  const newMsgs = [...s.messages];
  newMsgs.splice(userIdx, idx - userIdx + 1);
  return { messages: newMsgs, needsRebuild: true };
}

let abortController: AbortController | null = null;

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  agents: [],
  flyRequest: null,
  isProcessing: false,
  runningSessions: [],
  mode: 'agent',
  planMode: false,
  planReady: null,
  error: null,
  config: null,
  pendingConfirmation: null,
  scrolledAway: false,
  scrollToBottomTrigger: 0,
  needsRebuild: false,
  directoryNotice: null,
  wsStatus: 'disconnected',
  engineStatus: null,
  extensionUI: null,
  messageQueue: [],
  steerQueueCount: 0,
  totalUsage: { input: 0, output: 0, total: 0 },
  pendingDropFiles: null,

  addDropFiles: (files) => set({ pendingDropFiles: files }),
  consumeDropFiles: () => {
    const files = get().pendingDropFiles;
    if (files) set({ pendingDropFiles: null });
    return files;
  },
  dragClearSignal: 0,
  signalDragClear: () => set((s) => ({ dragClearSignal: s.dragClearSignal + 1 })),

  clearError: () => set({ error: null }),
  /** 魔法飞行结束（MagicFly 组件动画完成后调用），清空触发请求 */
  clearFly: () => set({ flyRequest: null }),

  // 停止子代理：不在本地乐观改状态 —— 后端中止后 subagent 工具会以 tool_end 回流
  // （details.aborted=true），由 handleSSEEvent 统一把该 agent 标为 'aborted'。
  // 这样状态只有一个来源，避免本地猜测与后端不一致。
  stopSubAgent: async (agentId) => {
    const sid = get().activeSessionId;
    if (!sid) return;
    try {
      await api.abortSubAgent(sid, agentId);
    } catch (err: any) {
      set({ error: err?.message || '停止子代理失败' });
    }
  },

  stopAllSubAgents: async () => {
    const sid = get().activeSessionId;
    if (!sid) return;
    try {
      await api.abortAllSubAgents(sid);
    } catch (err: any) {
      set({ error: err?.message || '停止子代理失败' });
    }
  },
  setMode: (mode) => set({ mode }),
  setPlanMode: (on) => set({ planMode: on, planReady: null }),
  /** 「按此计划执行」：关闭规划并发送执行指令（计划文本随消息发给模型） */
  executePlan: async () => {
    const plan = get().planReady;
    set({ planMode: false, planReady: null });
    if (plan) await get().sendMessage(`请按以下计划执行：\n\n${plan}`);
  },
  loadConfig: async () => {
    try {
      // Electron 模式：配置在主进程本地（LLM 直连参数）
      if (isElectron()) {
        const raw = await window.myagent!.getAgentConfig();
        const config = raw as unknown as ConfigData;
        if (config && config.model) set({ config });
        else set({ config: null });
        return;
      }
      const config = await api.getConfig();
      set({ config });
    } catch { /* ignore */ }
  },
  saveConfig: async (config) => {
    // Electron 模式：保存到主进程并立即生效（新会话）
    if (isElectron()) {
      await window.myagent!.setAgentConfig(config);
      set({ config });
      return;
    }
    await api.updateConfig(config);
    set({ config });
  },
  switchWorkDir: async (dirPath) => {
    const { config } = get();
    if (!config) return;
    const newConfig = { ...config, work_dir: dirPath };
    try {
      if (isElectron()) {
        await window.myagent!.setAgentConfig(newConfig);
      } else {
        await api.updateConfig(newConfig);
      }
    } catch { /* ignore */ }
    set({ config: newConfig, directoryNotice: dirPath });
  },
  clearDirectoryNotice: () => set({ directoryNotice: null }),
  loadSessions: async () => {
    try {
      const data = await api.listSessions();
      const sessions: SessionInfo[] = data.sessions || [];
      // 顺带同步「执行中」集合：runningSessions 是内存态，刷新页面 / HMR 热重载后
      // 会整个丢失 —— 那时后端仍在跑，界面上却毫无标识。后端才是权威状态，故以它为准。
      // （loadSessions 只在初始化与 Electron/SSE 降级路径调用，不在 WS 高频路径上，
      //  不会与「消息刚发出、后端尚未开始执行」的瞬间竞争。）
      const serverRunning = sessions.filter((s) => s.running).map((s) => s.id);
      set({ sessions, runningSessions: serverRunning });
      if (serverRunning.length > 0) startRunningSync();
    } catch { /* ignore */ }
  },
  createNewSession: async () => {
    try {
      const { mode } = get();
      // 携带当前选中模型配置（getLlmOverrides 与 sendMessage 注入 modelOverrides 同源）：
      // 新会话创建时即应用当前默认模型，避免"建会话用 Qwen、发消息想用 DeepSeek 不生效"
      const llmOverrides = getLlmOverrides();
      const session = await api.createSession(undefined, mode, llmOverrides);
      // 必须重置会话级状态：isProcessing 若沿用上一个会话（它可能正在跑），
      // 新会话的输入框会错误显示「AI 正在回复…」；error 同理会把旧会话的报错带过来
      set((s) => ({
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        messages: [],
        agents: [],
        flyRequest: null,
        totalUsage: { input: 0, output: 0, total: 0 },
        isProcessing: false,
        error: null,
      }));
    } catch (err: any) {
      // 无任何模型配置（未选中预设且后端无全局默认）时后端返回 400
      // "未配置默认模型，请在设置→模型设置中选择模型"，展示给用户而非静默
      set({ error: err?.message || '创建会话失败' });
    }
  },
  switchSession: async (id) => {
    const { activeSessionId: prevId, messages: prevMessages, agents: prevAgents } = get();

    // 切走时留存：原会话若仍在执行，把它的消息/子代理视图存进 liveViews ——
    // 这样它后续到达的增量有处可去（见 withMessages），切回时也能原样恢复。
    if (prevId && prevId !== id && get().isProcessing) {
      liveViews.set(prevId, { messages: prevMessages, agents: prevAgents });
    }

    // 切回一个仍在后台执行的会话：直接用内存视图恢复。
    // 此刻后端尚未落库正在生成的那条消息，若走快照，界面会停在切换那一刻不再更新。
    const live = liveViews.get(id);
    if (live) {
      liveViews.delete(id);
      set({
        activeSessionId: id,
        messages: live.messages,
        agents: live.agents,
        isProcessing: true,
        scrolledAway: false,
        flyRequest: null,
        needsRebuild: false,
      });
      return;
    }

    try {
      const data = await api.getSession(id);
      set({
        activeSessionId: id,
        messages: apiMessagesToChatMessages(data.messages || []),
        mode: (data.mode as AgentMode) || 'agent',
        totalUsage: { input: 0, output: 0, total: 0 },
        needsRebuild: true,
        scrolledAway: false,
        agents: rebuildAgentsFromMessages(apiMessagesToChatMessages(data.messages || [])),
        flyRequest: null,
        // 切到并未在执行的会话：清掉处理中状态 —— 原先不重置，会让「停止」按钮
        // 跟着上一个会话的状态泄漏过来
        isProcessing: false,
      });
    } catch { set({ activeSessionId: id, messages: [], agents: [], flyRequest: null, totalUsage: { input: 0, output: 0, total: 0 }, scrolledAway: false, needsRebuild: true, isProcessing: false }); }
  },
  renameSession: async (id, name) => {
    try {
      await api.updateSession(id, { name });
      set((s) => ({ sessions: s.sessions.map((sess) => sess.id === id ? { ...sess, name } : sess) }));
    } catch { /* ignore */ }
  },
  deleteSession: async (id) => {
    try {
      const { activeSessionId } = get();
      const isActive = activeSessionId === id;

      // 先停后删：会话若仍在跑，删除后 SSE 事件会继续回流 —— tool_start 是「追加」语义
      // （agents: [...s.agents, newAgent]），会把刚清空的子 Agent 列表重新填回来，消息同理。
      // 只对确有执行中任务的会话发中止请求：不在后端内存里的历史会话（内存有 30 分钟清理）
      // 调 abort 一律 404，纯属噪音（allSettled 虽能吞掉异常，但浏览器网络面板照样记 404）。
      // 子代理运行必然伴随主代理运行，故以 runningSessions 判定即可覆盖。
      const isRunning = get().runningSessions.includes(id);
      if (isRunning) {
        if (isElectron()) window.myagent!.chatAbort(id).catch(() => {});
        await Promise.allSettled([api.abortAllSubAgents(id), api.abortSession(id)]);
        if (isActive) {
          if (abortController) { abortController.abort(); abortController = null; }
          getWSClient().send({ type: 'abort', sessionId: id });
        }
      }

      await api.deleteSession(id);
      // Electron 模式：释放主进程引擎会话
      if (isElectron()) window.myagent!.chatDispose(id).catch(() => {});
      set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
      // agents 必须一并清空：子 Agent 列表属于当前会话（刷新后由消息重建），
      // 会话没了消息也就没了，残留的 agents 会让侧栏「子Agent」tab 显示已删除会话的记录
      if (isActive) {
        set({ activeSessionId: null, messages: [], agents: [], isProcessing: false });
      }
    } catch { /* ignore */ }
  },
  deleteMessagePair: async (assistantMsgId) => {
    // 统一二次确认（全项目删除操作均确认）
    const confirmed = await confirmDialog.confirm({
      title: '删除回复',
      message: '删除这条回复及其提问？此操作不可恢复。',
      danger: true,
      confirmLabel: '删除',
    });
    if (confirmed !== 'confirm') return;
    const { messages, activeSessionId } = get();
    // Electron 模式：消息由主进程引擎管理，无服务端 API，保持本地删除
    if (isElectron()) {
      set((s) => removePairLocally(s, assistantMsgId));
      return;
    }
    // 计算该 assistant 回复对应的 user 消息序号（从 0 计数，与后端 API 语义一致）
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    let seq = 0;
    for (let i = 0; i < userIdx; i++) {
      if (messages[i].role === 'user') seq++;
    }
    if (!activeSessionId) {
      set({ error: '删除消息失败: 无活动会话' });
      return;
    }
    // 先删除后端（落库），成功后再本地移除；失败时保留原消息并提示
    try {
      await api.deleteMessages(activeSessionId, seq);
      set((s) => removePairLocally(s, assistantMsgId));
    } catch (err: any) {
      set({ error: err?.message || '删除消息失败' });
    }
  },

  compactSession: async (sessionId) => {
    try {
      return await api.compactSession(sessionId);
    } catch (err: any) {
      // 错误透传（修复前 404"会话不存在"被静默忽略）：Header 错误条展示后端 message，
      // rethrow 供 TokenBar 在压缩按钮旁红字提示
      set({ error: err?.message || '压缩失败' });
      throw err;
    }
  },

  editMessage: async (userMsgId, newText) => {
    const { messages } = get();
    if (!newText || !newText.trim()) return;
    const idx = messages.findIndex((m) => m.id === userMsgId);
    if (idx < 0 || messages[idx].role !== 'user') return;
    // 找到该用户消息之后的第一条 assistant 回复（若有），先删除该对（后端落库 + 本地移除）
    let assistantId: string | null = null;
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant') {
        assistantId = messages[i].id;
        break;
      }
    }
    if (assistantId) {
      await get().deleteMessagePair(assistantId);
    }
    // 作为新消息发送（沿用现有 sendMessage / steer 机制）
    await get().sendMessage(newText);
  },

  // ─── 重新生成 ────────────────────────

  regenerateLastMessage: () => {
    const { messages } = get();
    // 找到最后一条用户消息
    let lastUserMsg = '';
    let lastUserImages: ImageAttachment[] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMsg = messages[i].content;
        lastUserImages = messages[i].images;
        break;
      }
    }
    if (!lastUserMsg) return;
    // 移除最后一条用户消息及之后的所有 AI 回复
    const newMsgs = [...messages];
    while (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role !== 'user') {
      newMsgs.pop();
    }
    set({ messages: newMsgs, needsRebuild: true });
    // 重新发送
    setTimeout(() => get().sendMessage(lastUserMsg, lastUserImages), 50);
  },

  // ─── 消息队列 ──────────────────────

  queueMessage: (text, images) => {
    if (!text.trim() && (!images || images.length === 0)) return;
    // 纯文本通过 steer 注入当前 AI 上下文，让 AI 能立即看到
    if (text.trim()) {
      // Electron 模式：主进程引擎 steer
      if (isElectron()) {
        const sessionId = get().activeSessionId;
        if (sessionId) {
          window.myagent!.chatSteer(sessionId, text)
            .then((data) => {
              if (data.success) {
                set((s) => ({ steerQueueCount: s.steerQueueCount + 1 }));
              }
            })
            .catch(() => {});
        }
        // 加入队列（用于 QueueIndicator 显示）
        set((s) => ({ messageQueue: [...s.messageQueue, { text, images }] }));
        return;
      }
      const token = localStorage.getItem('myagent_token');
      fetch(apiUrl('/api/chat/steer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text, sessionId: get().activeSessionId }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            // steer 成功 → 增加已处理计数，QueueIndicator 即时更新
            set((s) => ({ steerQueueCount: s.steerQueueCount + 1 }));
          }
        })
        .catch(() => {});
    }
    // 加入队列（用于 QueueIndicator 显示 + 图片需要走 rebuild 发送）
    set((s) => ({ messageQueue: [...s.messageQueue, { text, images }] }));
  },

  processQueue: () => {
    const { messageQueue } = get();
    if (messageQueue.length === 0) return;

    // 检查是否有图片（steer 不支持图片，需要走完整发送路径）
    const hasImages = messageQueue.some((item) => item.images && item.images.length > 0);

    if (hasImages) {
      // 有图片：走 rebuild + sendMessage，确保图片能发送
      const [next, ...rest] = messageQueue;
      set({ messageQueue: rest, steerQueueCount: 0, needsRebuild: true });
      // force：此刻上一轮刚结束（done/agent_end 里已置 isProcessing=false），
      // 出队的消息必须真正发出，不能再被并发守卫挡回队列
      get().sendMessage(next.text, next.images, { force: true });
    } else {
      // 纯文本已通过 steer 处理，清理队列
      set({ messageQueue: [], steerQueueCount: 0 });
    }
  },

  // ─── 扩展 UI ────────────────────────

  resolveExtensionUI: (id, response) => {
    // Electron 模式：走 IPC（主进程扩展 UI 响应通道）
    if (isElectron()) {
      window.myagent!.sendExtensionUIResponse({ id, ...response }).catch(() => {});
      set({ extensionUI: null });
      return;
    }
    const ws = getWSClient();
    ws.send({ type: 'extension_ui_response', id, ...response });
    set({ extensionUI: null });
  },

  // ─── 发送消息 ────────────────────────

  sendMessage: async (text, images, opts) => {
    /**
     * 并发守卫：本轮尚未结束时不再并行发起第二次 processMessage。
     *
     * 后端每收到一次 chat_message 都会 `session.events.on('sse', onSse)` 注册转发监听，
     * 同一会话并发会让 message_delta 发两遍、前端内容重复累积（如"你好你好"）。
     * 运行中追加消息的正道是 queueMessage —— 纯文本走 steer 注入当前上下文、
     * 带图则入队等待本轮结束（见 processQueue）。
     *
     * 原先这条纪律只靠 InputBar 的 UI 状态维持（输入框切到"排队"模式），
     * 任何绕过 UI 的新入口都可能破坏它，故在此兜底。
     */
    if (get().isProcessing && !opts?.force) {
      get().queueMessage(text, images);
      return;
    }

    const { activeSessionId, mode, wsStatus } = get();

    const userMsg: ChatMessage = {
      id: nextId(), role: 'user', content: text, timestamp: Date.now(),
      images: images as ImageAttachment[],
    };

    set((s) => ({ messages: [...s.messages, userMsg], isProcessing: true, error: null }));
    // 会话开始执行：侧栏给它显示动态边框（切走后也一直亮着，直到 done/error/aborted）
    if (activeSessionId) get().setSessionRunning(activeSessionId, true);

    // Electron 模式：发送到主进程 Agent 引擎（事件通过 onAgentEvent 推送）
    if (isElectron()) {
      const token = localStorage.getItem('myagent_token') || undefined;
      const { needsRebuild } = get();
      const payload: Record<string, unknown> = {
        token,
        message: text,
        sessionId: activeSessionId || undefined,
        mode,
      };
      if (images?.length) payload.images = images;
      if (needsRebuild) {
        payload.rebuild = true;
        payload.history = get().messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      }
      const llmOverrides = getLlmOverrides();
      if (llmOverrides.id || llmOverrides.baseUrl || llmOverrides.apiKey) {
        payload.modelOverrides = llmOverrides;
      }
      try {
        const result = await window.myagent!.chatSend(payload);
        if (!result.ok) {
          set({ error: result.error || '发送失败', isProcessing: false });
        }
      } catch (err: any) {
        set({ error: err?.message || '发送失败', isProcessing: false });
      }
      set({ needsRebuild: false });
      get().loadSessions();
      return;
    }

    abortController = new AbortController();

    // 尝试通过 WebSocket 发送
    if (wsStatus === 'connected') {
      const ws = getWSClient();
      const { needsRebuild } = get();
      const payload: Record<string, unknown> = {
        type: 'chat_message',
        message: text,
        sessionId: activeSessionId || undefined,
        mode,
      };
      if (images?.length) payload.images = images;
      if (needsRebuild) {
        payload.rebuild = true;
        payload.history = get().messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      }
      const llmOverrides = getLlmOverrides();
      if (llmOverrides.id || llmOverrides.baseUrl || llmOverrides.apiKey) {
        payload.modelOverrides = llmOverrides;
      }
      ws.send(payload);
      set({ needsRebuild: false });
      return;
    }

    // SSE 降级路径
    try {
      const { needsRebuild } = get();
      const body: Record<string, unknown> = {
        message: text,
        sessionId: activeSessionId || undefined,
        mode,
        // 规划模式：仅 SSE 路径支持（后端工具面热切换；Electron/WS 路径不生效）
        plan: get().planMode === true,
      };
      if (images?.length) body.images = images;
      if (needsRebuild) {
        body.rebuild = true;
        body.history = get().messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      }
      const llmOverrides = getLlmOverrides();
      if (llmOverrides.id || llmOverrides.baseUrl || llmOverrides.apiKey) {
        body.modelOverrides = llmOverrides;
      }
      await fetchSSE('/api/chat', body,
        (event) => get().handleSSEEvent(event as SSEEvent),
        abortController.signal,
      );
      set({ needsRebuild: false });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        set({ isProcessing: false });
      } else if (err instanceof StreamInterruptedError) {
        // 流中断（服务端 run 继续执行、结果已落库）：不重发，恢复视图拉取完整消息
        set({ error: '连接中断，正在恢复…', isProcessing: false });
        const sid = get().activeSessionId;
        if (sid) await get().recoverSessionAfterInterrupt(sid);
      } else {
        set({ error: err.message, isProcessing: false });
      }
    } finally {
      abortController = null;
      get().loadSessions();
    }
  },

  /** 断线恢复：服务端 run 中断不中止（res close 仅记日志），轮询拉取完整消息至稳定 */
  recoverSessionAfterInterrupt: async (sessionId: string) => {
    let lastLen = -1;
    let stableCount = 0;
    for (let i = 0; i < 6; i++) {
      try {
        const data = await api.getSession(sessionId);
        const msgs = apiMessagesToChatMessages(data.messages || []);
        set({ messages: msgs });
        if (msgs.length === lastLen) {
          stableCount++;
          if (stableCount >= 1) break; // 连续两次相同 = 生成完成
        } else {
          stableCount = 0;
          lastLen = msgs.length;
        }
      } catch {
        /* 服务端短暂不可用时继续等一轮 */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    set({ error: null });
    const hasTail = !!(get().messages.at(-1)?.role === 'assistant');
    if (!hasTail) set({ error: '连接已恢复，但最后一条回复可能未完整，可点击重新生成或稍后刷新会话' });
  },

  stopGeneration: () => {
    const { activeSessionId } = get();
    // Electron 模式：主进程引擎 abort
    if (isElectron()) {
      if (activeSessionId) window.myagent!.chatAbort(activeSessionId).catch(() => {});
      set({ isProcessing: false });
      return;
    }
    if (activeSessionId) api.abortSession(activeSessionId).catch(() => {});
    if (abortController) { abortController.abort(); abortController = null; }
    // 也通过 WS 发送中断
    const ws = getWSClient();
    ws.send({ type: 'abort', sessionId: activeSessionId });
    set({ isProcessing: false });
  },

  confirmDecision: async (decision) => {
    const { pendingConfirmation } = get();
    if (!pendingConfirmation) return;
    // Electron 模式：主进程 pendingConfirmationManager 解挂
    if (isElectron()) {
      window.myagent!.confirmDecision(pendingConfirmation.sessionId, decision).catch(() => {});
      set({ pendingConfirmation: null });
      return;
    }
    try { await api.sendConfirmationDecision(pendingConfirmation.sessionId, decision); } catch { /* ignore */ }
    set({ pendingConfirmation: null });
  },

  setScrolledAway: (away) => set({ scrolledAway: away }),
  scrollToBottom: () => set((s) => ({ scrollToBottomTrigger: s.scrollToBottomTrigger + 1 })),

  /** 标记某会话开始/结束执行（幂等；结束由 done/error/aborted 驱动） */
  setSessionRunning: (id, running) => {
    set((s) => ({
      runningSessions: running
        ? (s.runningSessions.includes(id) ? s.runningSessions : [...s.runningSessions, id])
        : s.runningSessions.filter((x) => x !== id),
    }));
    // 开始执行：启用轮询兜底，以防这条连接收不到后续的 done（刷新/重连后的常见情形）
    if (running) startRunningSync();
  },

  // ─── 事件处理（SSE 和 WS 共用） ──────

  handleWSEvent: (event) => get().handleSSEEvent(event),

  handleSSEEvent: (event) => {
    switch (event.type) {
      case 'session_created': {
        set({ activeSessionId: event.sessionId as string });
        break;
      }

      case 'session_updated': {
        const { sessionId, name } = event;
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, name } : sess
          ),
        }));
        break;
      }

      case 'agent_start': {
        withMessages(event.sessionId, (msgs) => [...msgs, {
          id: nextId(), role: 'assistant', content: '', thinking: '',
          timestamp: Date.now(), isStreaming: true,
        }]);
        break;
      }

      case 'message_delta': {
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const last = next[next.length - 1];
          if (last && last.isStreaming) {
            const delta = event.delta as string;
            if (event.thinking) {
              next[next.length - 1] = { ...last, thinking: (last.thinking || '') + delta };
            } else {
              next[next.length - 1] = { ...last, content: last.content + delta };
            }
          }
          return next;
        });
        break;
      }

      case 'message_end': {
        const u = (event as any).usage;
        const errMsg = (event as any).errorMessage as string | undefined;
        if ((u && typeof u.input === 'number') || errMsg) {
          withMessages(event.sessionId, (msgs) => {
            const next = [...msgs];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              const updated: ChatMessage = { ...last };
              if (u && typeof u.input === 'number') {
                // 一轮回复可能多次调用 LLM（工具调用），每次 message_end 的 usage 是单次调用值；
                // 消息级 usage 累加（与 llmCallCount 同口径，pi-mono SessionStats：Σ 各消息全字段）。
                // totalTokens 为后端单次调用总 token（含 cacheRead），累加即整轮总量。
                updated.usage = {
                  input: (last.usage?.input || 0) + (u.input || 0),
                  output: (last.usage?.output || 0) + (u.output || 0),
                  totalTokens: (last.usage?.totalTokens || 0) + (u.totalTokens || 0),
                };
                updated.llmCallCount = (last.llmCallCount || 0) + 1;
              }
              // LLM 调用失败：挂上可读原因，消息内展示错误提示块（绝不空白）
              if (errMsg) updated.errorMessage = errMsg;
              next[next.length - 1] = updated;
            }
            return next;
          });
          // totalUsage 是当前会话的展示指标，只对当前会话累积（后台会话切回时会重新拉取）
          if (u && typeof u.input === 'number' && isActiveSession(event.sessionId)) {
            set((s) => ({
              totalUsage: {
                input: s.totalUsage.input + u.input,
                output: s.totalUsage.output + (u.output || 0),
                total: s.totalUsage.total + (u.totalTokens || 0),
              },
            }));
          }
        }
        break;
      }

      case 'tool_start': {
        const tc: ToolCallInfo = {
          id: event.toolCallId as string,
          toolName: event.toolName as string,
          args: event.args,
          status: 'running',
          startTime: Date.now(),
        };
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const lastIdx = next.length - 1;
          if (lastIdx >= 0) {
            const last = { ...next[lastIdx] };
            last.toolCalls = [...(last.toolCalls || []), tc];
            next[lastIdx] = last;
          }
          return next;
        });
        // 干活的 Agent：subagent 工具开始执行 → 创建列表项（会话级，切会话清空）
        if (event.toolName === 'subagent') {
          const rawTask = (event.args as any)?.task;
          const task = stripTaskPrefix(
            typeof rawTask === 'string' ? rawTask : JSON.stringify(rawTask ?? ''),
          );
          const toolCallId = event.toolCallId as string;
          withAgents(event.sessionId, (agents) => [
            ...agents,
            {
              id: toolCallId,
              task,
              status: 'running',
              startedAt: Date.now(),
              events: [],
            },
          ]);
          // 动画只对当前显示的会话触发：新调用覆盖旧请求（MagicFly 监听 id 变化）
          if (isActiveSession(event.sessionId)) {
            set({ flyRequest: { id: toolCallId, task, ts: Date.now() } });
          }
        }
        break;
      }

      case 'tool_update': {
        // 流式输出更新（仅更新状态，不累积输出内容）
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const lastIdx = next.length - 1;
          if (lastIdx >= 0) {
            const last = { ...next[lastIdx] };
            last.toolCalls = (last.toolCalls || []).map((t) =>
              t.id === event.toolCallId
                ? { ...t, status: 'streaming' as const }
                : t
            );
            next[lastIdx] = last;
          }
          return next;
        });
        // 干活的 Agent：subagent 工具实时推送子代理内部事件（tool_update.partialResult.details.subagentEvent）
        const subEvt = (event as any).partialResult?.details?.subagentEvent as SubagentEvent | undefined;
        if (subEvt) {
          withAgents(event.sessionId, (agents) =>
            agents.map((a) =>
              a.id === event.toolCallId
                ? { ...a, events: [...a.events, subEvt] }
                : a
            )
          );
        }
        break;
      }

      case 'tool_end': {
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const lastIdx = next.length - 1;
          if (lastIdx >= 0) {
            const last = { ...next[lastIdx] };
            last.toolCalls = (last.toolCalls || []).map((t) =>
              t.id === event.toolCallId
                ? {
                    ...t,
                    status: event.isError ? ('error' as const) : ('completed' as const),
                    result: event.result,
                    endTime: Date.now(),
                    errorMessage: event.isError ? (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)) : undefined,
                  }
                : t
            );
            next[lastIdx] = last;
          }
          return next;
        });
        // 干活的 Agent：subagent 工具结束 → 状态完成/失败/已中止 + 结束时间 + 最终摘要
        if (event.toolName === 'subagent') {
          const resultDetails = (event.result as any)?.details;
          withAgents(event.sessionId, (agents) =>
            agents.map((a) =>
              a.id === event.toolCallId
                ? {
                    ...a,
                    // 用户主动停止优先于 isError 判定：属预期操作，界面显示「已中止」而非「失败」
                    status: resultDetails?.aborted
                      ? ('aborted' as const)
                      : event.isError
                        ? ('error' as const)
                        : ('completed' as const),
                    endedAt: Date.now(),
                    summary:
                      typeof resultDetails?.summary === 'string'
                        ? resultDetails.summary
                        : a.summary,
                  }
                : a
            )
          );
        }
        break;
      }

      case 'agent_end': {
        // LLM 失败轮次：错误信息在 agent_end.messages 里（assistant 消息的 errorMessage），
        // 兜底提取并挂到当前 assistant 消息（error 事件已提前挂过则不覆盖）
        const e = event as { errorMessage?: string; messages?: any[] };
        let errMsg: string | undefined;
        if (e.errorMessage) {
          errMsg = e.errorMessage;
        } else if (Array.isArray(e.messages)) {
          for (let i = e.messages.length - 1; i >= 0; i--) {
            const m = e.messages[i];
            if (m?.role === 'assistant' && m.errorMessage) {
              errMsg = extractReadableError(m.errorMessage);
              break;
            }
          }
        }
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const last = next[next.length - 1];
          if (last && last.isStreaming) {
            const elapsed = Math.round((Date.now() - last.timestamp) / 1000);
            const updated: ChatMessage = { ...last, isStreaming: false, duration: elapsed };
            if (errMsg && !updated.errorMessage) updated.errorMessage = errMsg;
            next[next.length - 1] = updated;
          }
          return next;
        });
        // 该轮收尾：丢弃后台存档，切回改用后端落库结果
        endLiveView(event.sessionId);
        // 以下副作用只对当前显示的会话执行（后台会话不弹计划卡片、不处理队列）
        if (isActiveSession(event.sessionId)) {
          set({ isProcessing: false });
          // 规划模式：plan 轮完成 → 展示计划卡片（PlanCard 渲染 + 「执行」按钮）
          if (get().planMode) {
            const last = get().messages[get().messages.length - 1];
            if (last?.role === 'assistant') set({ planReady: last.content });
          }
          // 自动处理队列中的消息
          get().processQueue();
        }
        break;
      }

      case 'done': {
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const last = next[next.length - 1];
          if (last && last.isStreaming) {
            const elapsed = Math.round((Date.now() - last.timestamp) / 1000);
            next[next.length - 1] = { ...last, isStreaming: false, duration: elapsed };
          }
          return next;
        });
        endLiveView(event.sessionId);
        // done 是「该会话彻底跑完」的可靠信号：无论它是不是当前显示的会话，
        // 都要熄掉侧栏的动态边框
        if (typeof event.sessionId === 'string') get().setSessionRunning(event.sessionId, false);
        if (isActiveSession(event.sessionId)) {
          set({ isProcessing: false });
          // 自动处理队列中的消息
          get().processQueue();
        }
        break;
      }

      case 'error': {
        const msg = event.message as string;
        // 关键：把错误挂到当前 assistant 消息上，MessageBubble 渲染错误提示块（绝不空白）
        withMessages(event.sessionId, (msgs) => {
          const next = [...msgs];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, errorMessage: msg };
          }
          return next;
        });
        if (isActiveSession(event.sessionId)) set({ error: msg, isProcessing: false });
        break;
      }

      case 'aborted': {
        endLiveView(event.sessionId);
        if (isActiveSession(event.sessionId)) set({ isProcessing: false });
        break;
      }

      case 'confirmation_required': {
        set({
          pendingConfirmation: {
            sessionId: event.sessionId as string,
            command: event.command as string,
            reason: event.reason as string,
          },
        });
        break;
      }

      // 新增：扩展 UI 交互
      case 'extension_ui_select': {
        const e = event as { id: string; title: string; options: string[] };
        set({ extensionUI: { id: e.id, method: 'select', title: e.title, options: e.options } });
        break;
      }
      case 'extension_ui_confirm': {
        const e = event as { id: string; title: string; message: string };
        set({ extensionUI: { id: e.id, method: 'confirm', title: e.title, message: e.message } });
        break;
      }
      case 'extension_ui_input': {
        const e = event as { id: string; title: string; placeholder?: string };
        set({ extensionUI: { id: e.id, method: 'input', title: e.title, placeholder: e.placeholder } });
        break;
      }
      case 'extension_ui_notify': {
        const e = event as { id: string; message: string; notifyType?: 'info' | 'warning' | 'error' };
        set({ extensionUI: { id: e.id, method: 'notify', title: '', message: e.message, notifyType: e.notifyType } });
        setTimeout(() => set({ extensionUI: null }), 3000);
        break;
      }

      // 限流终止 agent
      case 'rate_limit_abort': {
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.isStreaming) {
            msgs[msgs.length - 1] = { ...last, isStreaming: false };
          }
          return {
            messages: [...msgs, {
              id: nextId(),
              role: 'system' as const,
              content: event.message as string,
              timestamp: Date.now(),
            }],
            isProcessing: false,
          };
        });
        break;
      }

      // LLM 超时
      case 'llm_timeout': {
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.isStreaming) {
            msgs[msgs.length - 1] = { ...last, isStreaming: false };
          }
          return {
            messages: [...msgs, {
              id: nextId(),
              role: 'system' as const,
              content: event.message as string,
              timestamp: Date.now(),
            }],
            isProcessing: false,
          };
        });
        break;
      }

      // 速率限制警告
      case 'rate_limit_warning': {
        console.warn(`[RateLimit] ${event.message} (剩余: ${event.remaining}, 重置: ${event.resetIn}s)`);
        break;
      }

      // 自动上下文压缩：以 system 消息提示用户
      case 'auto_compact': {
        const e = event as { message?: string };
        set((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            role: 'system' as const,
            content: e.message || '对话已自动压缩',
            timestamp: Date.now(),
          }],
        }));
        break;
      }
    }
  },
}));
