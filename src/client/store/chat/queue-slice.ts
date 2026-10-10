/**
 * chat-store：消息队列 slice
 *
 * 从 chat-store.ts 抽出（zustand slice 模式）。state 与其操作同处一个 slice；
 * 跨 slice 调用一律通过 get()（如 get().sendMessage()），不复制 state。
 * 组装见 chat-store.ts 的 create<ChatStore>(...)。
 */
import type { StateCreator } from 'zustand';
import * as api from '../../services/api';
import { apiUrl, isElectron } from '../../services/api-config';
import type { ChatStore, QueueSlice } from './types';

export const createQueueSlice: StateCreator<ChatStore, [], [], QueueSlice> = (set, get) => ({
  messageQueue: [],

  steerQueueCount: 0,

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

});
