import { create } from 'zustand';
import { createUiSlice } from './chat/ui-slice';
import { createQueueSlice } from './chat/queue-slice';
import { createSubagentSlice } from './chat/subagent-slice';
import { createSessionSlice } from './chat/session-slice';
import { createMessageSlice } from './chat/message-slice';
import {
  liveViews,
  withMessages,
  withAgents,
  isActiveSession,
  endLiveView,
  startRunningSync,
  rebuildAgentsFromMessages,
  apiMessagesToChatMessages,
  removePairLocally,
  nextId,
  extractReadableError,
  stripTaskPrefix,
  getAbortController,
  setAbortController,
  abortCurrentRun,
} from './chat/helpers';

import type { ChatMessage, ImageAttachment, AgentMode, SessionInfo, ToolCallInfo, ExtensionUIRequest, AgentInfo, SubagentEvent } from '../types/chat';
import type { SSEEvent } from '../types/events';
import type { ConfigData } from '../types/api';
import { fetchSSE, StreamInterruptedError } from '../services/sse-client';
import { getLlmOverrides, apiUrl, isElectron } from '../services/api-config';
import { getWSClient, type WSStatus } from '../services/ws-client';
import { pushRecentWorkDir } from '../services/recent-dirs';
import { confirmDialog } from './confirm-dialog';
import * as api from '../services/api';

interface ConfirmationRequest {
  sessionId: string;
  command: string;
  reason: string;
}

export interface ChatStore {
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
  createNewSession: (opts?: { workDir?: string; mode?: AgentMode }) => Promise<void>;
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


export const useChatStore = create<ChatStore>()((...a) => {
  const [set, get] = a;
  return {
  // ─── 已拆出的 slice（见 chat/ 下各 *-slice.ts） ───
  ...createUiSlice(...a),
  ...createQueueSlice(...a),
  ...createSubagentSlice(...a),
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),

  isProcessing: false,
  runningSessions: [],
  wsStatus: 'disconnected',
  engineStatus: null,
  totalUsage: { input: 0, output: 0, total: 0 },
  /** 魔法飞行结束（MagicFly 组件动画完成后调用），清空触发请求 */
  // 停止子代理：不在本地乐观改状态 —— 后端中止后 subagent 工具会以 tool_end 回流
  // （details.aborted=true），由 handleSSEEvent 统一把该 agent 标为 'aborted'。
  // 这样状态只有一个来源，避免本地猜测与后端不一致。
  /** 「按此计划执行」：关闭规划并发送执行指令（计划文本随消息发给模型） */
  /**
   * 切换**当前会话**的工作目录（保留对话历史）。
   *
   * 与全局配置无关：全局 config.work_dir 自会话级改造后只是「新会话的默认值」。
   * 后端会因工具闭包捕获了 workDir 而重建该会话的 service（消息原样保留）；
   * 会话正在执行时后端返回 409，这里把原因透传出来，不静默失败。
   */
  // ─── 重新生成 ────────────────────────

  // ─── 消息队列 ──────────────────────

  // ─── 扩展 UI ────────────────────────

  // ─── 发送消息 ────────────────────────

  /** 断线恢复：服务端 run 中断不中止（res close 仅记日志），轮询拉取完整消息至稳定 */
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
  };
});
