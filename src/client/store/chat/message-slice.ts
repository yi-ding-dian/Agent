/**
 * chat-store：消息域 slice
 *
 * 从 chat-store.ts 抽出（zustand slice 模式），纯搬运、实现体未改。
 * 跨 slice 调用一律通过 get()（如 get().sendMessage()），不复制 state。
 */
import type { StateCreator } from 'zustand';
import type { ChatMessage, ImageAttachment } from '../../types/chat';
import type { SSEEvent } from '../../types/events';
import * as api from '../../services/api';
import { isElectron, getLlmOverrides } from '../../services/api-config';
import { getWSClient } from '../../services/ws-client';
import { fetchSSE, StreamInterruptedError } from '../../services/sse-client';
import { confirmDialog } from '../confirm-dialog';
import {
  nextId,
  apiMessagesToChatMessages,
  removePairLocally,
  abortCurrentRun,
  setAbortController,
} from './helpers';
import type { ChatStore, MessageSlice } from './types';

export const createMessageSlice: StateCreator<ChatStore, [], [], MessageSlice> = (set, get) => ({
  messages: [],

  needsRebuild: false,

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

    const ac = new AbortController();
    setAbortController(ac);

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
        ac.signal,
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
      setAbortController(null);
      get().loadSessions();
    }
  },


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
    abortCurrentRun();
    // 也通过 WS 发送中断
    const ws = getWSClient();
    ws.send({ type: 'abort', sessionId: activeSessionId });
    set({ isProcessing: false });
  },
});
