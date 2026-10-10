/**
 * chat-store：子代理域 slice
 *
 * 从 chat-store.ts 抽出（zustand slice 模式）。state 与其操作同处一个 slice；
 * 跨 slice 调用一律通过 get()（如 get().sendMessage()），不复制 state。
 * 组装见 chat-store.ts 的 create<ChatStore>(...)。
 */
import type { StateCreator } from 'zustand';
import * as api from '../../services/api';
import type { ChatStore, SubagentSlice } from './types';

export const createSubagentSlice: StateCreator<ChatStore, [], [], SubagentSlice> = (set, get) => ({
  agents: [],

  flyRequest: null,

  clearFly: () => set({ flyRequest: null }),


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
});
