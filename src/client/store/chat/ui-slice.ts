/**
 * chat-store：界面状态 slice
 *
 * 从 chat-store.ts 抽出（zustand slice 模式）。state 与其操作同处一个 slice；
 * 跨 slice 调用一律通过 get()（如 get().sendMessage()），不复制 state。
 * 组装见 chat-store.ts 的 create<ChatStore>(...)。
 */
import type { StateCreator } from 'zustand';
import * as api from '../../services/api';
import { isElectron } from '../../services/api-config';
import { getWSClient } from '../../services/ws-client';
import type { ChatStore, UiSlice } from './types';

export const createUiSlice: StateCreator<ChatStore, [], [], UiSlice> = (set, get) => ({
  mode: 'agent',

  planMode: false,

  planReady: null,

  error: null,

  pendingConfirmation: null,

  scrolledAway: false,

  scrollToBottomTrigger: 0,

  extensionUI: null,

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

  setMode: (mode) => set({ mode }),

  setPlanMode: (on) => set({ planMode: on, planReady: null }),

  executePlan: async () => {
    const plan = get().planReady;
    set({ planMode: false, planReady: null });
    if (plan) await get().sendMessage(`请按以下计划执行：\n\n${plan}`);
  },

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

});
