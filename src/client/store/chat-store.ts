/**
 * chat-store 组装入口（2026-10 架构改造后）
 *
 * 原先 1471 行的单文件 store，现按业务域拆为 6 个 slice + 一组模块级辅助：
 *
 *   chat/types.ts          ChatStore 接口（6 个 slice 接口的交叉类型）
 *   chat/helpers.ts        模块级辅助函数与共享可变状态（liveViews / abortController …）
 *   chat/ui-slice.ts       界面状态（模式 / 计划 / 滚动 / 拖拽 / 确认 / 扩展 UI）
 *   chat/queue-slice.ts    消息队列（AI 处理中入队与 steer）
 *   chat/subagent-slice.ts 子代理域（列表 / 详情 / 飞行动画）
 *   chat/session-slice.ts  会话域（CRUD + 工作目录 + 服务端配置）
 *   chat/message-slice.ts  消息域（发送 / 停止 / 编辑删除 / 压缩 / 断线恢复）
 *   chat/stream-slice.ts   事件编排（SSE / WS 分发 + 运行状态 + token 统计）
 *
 * 本文件只做组装：各 slice 用 zustand 的 StateCreator 签名，`(...a)` 原样转发
 * （set / get / api），因此 slice 之间的 `get().xxx()` 跨域调用天然可用。
 * 所有 slice 的实现体均为**从原文件逐字节搬运**，未改一行逻辑。
 *
 * 新增状态的归属：按业务域放进对应 slice；若被多个 slice 需要，
 * 提升到 helpers.ts（值）或重构成单一来源（不要跨 slice 复制 state）。
 */
import { create } from 'zustand';
// 注意：必须 import 到本地作用域（供下方 create<ChatStore> 使用）——
// `export type { X } from '...'` 只转发、不引入作用域，若只写 re-export
// 会让 create<ChatStore> 解析不到类型，useChatStore 退化为 any。
import type { ChatStore, ConfirmationRequest } from './chat/types';
import { createUiSlice } from './chat/ui-slice';
import { createQueueSlice } from './chat/queue-slice';
import { createSubagentSlice } from './chat/subagent-slice';
import { createSessionSlice } from './chat/session-slice';
import { createMessageSlice } from './chat/message-slice';
import { createStreamSlice } from './chat/stream-slice';

// 类型定义在 chat/types.ts，此处 re-export 以保持既有引用路径
// （`import { useChatStore, type ChatStore } from '../store/chat-store'`）不变。
export type { ChatStore, ConfirmationRequest };

export const useChatStore = create<ChatStore>()((...a) => ({
  ...createUiSlice(...a),
  ...createQueueSlice(...a),
  ...createSubagentSlice(...a),
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createStreamSlice(...a),
}));
