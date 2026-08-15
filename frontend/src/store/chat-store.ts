import { create } from 'zustand';
import type { ChatMessage, ImageAttachment, AgentMode, SessionInfo, ToolCallInfo, ExtensionUIRequest, AgentInfo, SubagentEvent } from '../types/chat';
import type { SSEEvent } from '../types/events';
import type { ConfigData } from '../types/api';
import { fetchSSE } from '../services/sse-client';
import { getLlmOverrides, apiUrl, isElectron } from '../services/api-config';
import { getWSClient, type WSStatus } from '../services/ws-client';
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
  mode: AgentMode;
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
  sendMessage: (text: string, images?: { type: string; data: string; mimeType: string }[]) => Promise<void>;
  stopGeneration: () => void;
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
          // toolResult 已通过 assistant 的 toolCall block 展示，直接跳过
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
  mode: 'agent',
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
  setMode: (mode) => set({ mode }),
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
      set({ sessions: data.sessions || [] });
    } catch { /* ignore */ }
  },
  createNewSession: async () => {
    try {
      const { mode } = get();
      // 携带当前选中模型配置（getLlmOverrides 与 sendMessage 注入 modelOverrides 同源）：
      // 新会话创建时即应用当前默认模型，避免"建会话用 Qwen、发消息想用 DeepSeek 不生效"
      const llmOverrides = getLlmOverrides();
      const session = await api.createSession(undefined, mode, llmOverrides);
      set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id, messages: [], agents: [], flyRequest: null, totalUsage: { input: 0, output: 0, total: 0 } }));
    } catch (err: any) {
      // 无任何模型配置（未选中预设且后端无全局默认）时后端返回 400
      // "未配置默认模型，请在设置→模型设置中选择模型"，展示给用户而非静默
      set({ error: err?.message || '创建会话失败' });
    }
  },
  switchSession: async (id) => {
    try {
      const data = await api.getSession(id);
      set({
        activeSessionId: id,
        messages: apiMessagesToChatMessages(data.messages || []),
        mode: (data.mode as AgentMode) || 'agent',
        totalUsage: { input: 0, output: 0, total: 0 },
        needsRebuild: true,
        scrolledAway: false,
        agents: [],
        flyRequest: null,
      });
    } catch { set({ activeSessionId: id, messages: [], agents: [], flyRequest: null, totalUsage: { input: 0, output: 0, total: 0 }, scrolledAway: false }); }
  },
  renameSession: async (id, name) => {
    try {
      await api.updateSession(id, { name });
      set((s) => ({ sessions: s.sessions.map((sess) => sess.id === id ? { ...sess, name } : sess) }));
    } catch { /* ignore */ }
  },
  deleteSession: async (id) => {
    try {
      await api.deleteSession(id);
      // Electron 模式：释放主进程引擎会话
      if (isElectron()) window.myagent!.chatDispose(id).catch(() => {});
      const { activeSessionId } = get();
      set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
      if (activeSessionId === id) set({ activeSessionId: null, messages: [] });
    } catch { /* ignore */ }
  },
  deleteMessagePair: async (assistantMsgId) => {
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
      get().sendMessage(next.text, next.images);
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

  sendMessage: async (text, images) => {
    const { activeSessionId, mode, wsStatus } = get();

    const userMsg: ChatMessage = {
      id: nextId(), role: 'user', content: text, timestamp: Date.now(),
      images: images as ImageAttachment[],
    };

    set((s) => ({ messages: [...s.messages, userMsg], isProcessing: true, error: null }));

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
      } else {
        set({ error: err.message, isProcessing: false });
      }
    } finally {
      abortController = null;
      get().loadSessions();
    }
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
        set((s) => ({
          messages: [...s.messages, {
            id: nextId(), role: 'assistant', content: '', thinking: '',
            timestamp: Date.now(), isStreaming: true,
          }],
        }));
        break;
      }

      case 'message_delta': {
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.isStreaming) {
            const delta = event.delta as string;
            if (event.thinking) {
              msgs[msgs.length - 1] = { ...last, thinking: (last.thinking || '') + delta };
            } else {
              msgs[msgs.length - 1] = { ...last, content: last.content + delta };
            }
          }
          return { messages: msgs };
        });
        break;
      }

      case 'message_end': {
        const u = (event as any).usage;
        const errMsg = (event as any).errorMessage as string | undefined;
        if ((u && typeof u.input === 'number') || errMsg) {
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
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
              msgs[msgs.length - 1] = updated;
            }
            return {
              messages: msgs,
              totalUsage: u && typeof u.input === 'number'
                ? {
                    input: s.totalUsage.input + u.input,
                    output: s.totalUsage.output + (u.output || 0),
                    total: s.totalUsage.total + (u.totalTokens || 0),
                  }
                : s.totalUsage,
            };
          });
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
        set((s) => {
          const msgs = [...s.messages];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0) {
            const last = { ...msgs[lastIdx] };
            last.toolCalls = [...(last.toolCalls || []), tc];
            msgs[lastIdx] = last;
          }
          return { messages: msgs };
        });
        // 干活的 Agent：subagent 工具开始执行 → 创建列表项（会话级，切会话清空）+ 触发魔法飞行动画
        if (event.toolName === 'subagent') {
          const rawTask = (event.args as any)?.task;
          const task = typeof rawTask === 'string' ? rawTask : JSON.stringify(rawTask ?? '');
          const toolCallId = event.toolCallId as string;
          set((s) => ({
            agents: [
              ...s.agents,
              {
                id: toolCallId,
                task,
                status: 'running',
                startedAt: Date.now(),
                events: [],
              },
            ],
            // 动画触发：新调用覆盖旧请求（MagicFly 监听 id 变化）
            flyRequest: { id: toolCallId, task, ts: Date.now() },
          }));
        }
        break;
      }

      case 'tool_update': {
        // 流式输出更新（仅更新状态，不累积输出内容）
        set((s) => {
          const msgs = [...s.messages];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0) {
            const last = { ...msgs[lastIdx] };
            last.toolCalls = (last.toolCalls || []).map((t) =>
              t.id === event.toolCallId
                ? { ...t, status: 'streaming' as const }
                : t
            );
            msgs[lastIdx] = last;
          }
          return { messages: msgs };
        });
        // 干活的 Agent：subagent 工具实时推送子代理内部事件（tool_update.partialResult.details.subagentEvent）
        const subEvt = (event as any).partialResult?.details?.subagentEvent as SubagentEvent | undefined;
        if (subEvt) {
          set((s) => ({
            agents: s.agents.map((a) =>
              a.id === event.toolCallId
                ? { ...a, events: [...a.events, subEvt] }
                : a
            ),
          }));
        }
        break;
      }

      case 'tool_end': {
        set((s) => {
          const msgs = [...s.messages];
          const lastIdx = msgs.length - 1;
          if (lastIdx >= 0) {
            const last = { ...msgs[lastIdx] };
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
            msgs[lastIdx] = last;
          }
          return { messages: msgs };
        });
        // 干活的 Agent：subagent 工具结束 → 状态完成/失败 + 结束时间 + 最终摘要
        if (event.toolName === 'subagent') {
          const resultDetails = (event.result as any)?.details;
          set((s) => ({
            agents: s.agents.map((a) =>
              a.id === event.toolCallId
                ? {
                    ...a,
                    status: event.isError ? ('error' as const) : ('completed' as const),
                    endedAt: Date.now(),
                    summary:
                      typeof resultDetails?.summary === 'string'
                        ? resultDetails.summary
                        : a.summary,
                  }
                : a
            ),
          }));
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
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.isStreaming) {
            const elapsed = Math.round((Date.now() - last.timestamp) / 1000);
            const updated: ChatMessage = { ...last, isStreaming: false, duration: elapsed };
            if (errMsg && !updated.errorMessage) updated.errorMessage = errMsg;
            msgs[msgs.length - 1] = updated;
          }
          return { messages: msgs, isProcessing: false };
        });
        // 自动处理队列中的消息
        get().processQueue();
        break;
      }

      case 'done': {
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.isStreaming) {
            const elapsed = Math.round((Date.now() - last.timestamp) / 1000);
            msgs[msgs.length - 1] = { ...last, isStreaming: false, duration: elapsed };
          }
          return { messages: msgs, isProcessing: false };
        });
        // 自动处理队列中的消息
        get().processQueue();
        break;
      }

      case 'error': {
        const msg = event.message as string;
        // 关键：把错误挂到当前 assistant 消息上，MessageBubble 渲染错误提示块（绝不空白）
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, errorMessage: msg };
          }
          return { messages: msgs };
        });
        set({ error: msg, isProcessing: false });
        break;
      }

      case 'aborted': {
        set({ isProcessing: false });
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
