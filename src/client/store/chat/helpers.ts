/**
 * chat-store 的模块级辅助（纯函数 + 共享的可变状态）
 *
 * 从 chat-store.ts（1471 行）抽出 —— 这些函数原先与 store 实现混在一个文件里。
 *
 * 三点需注意：
 *  1. liveViews / messageCounter / abortController 是**模块级可变状态**，与 store 实现共享；
 *  2. abortController 用 get/set/abort 函数封装而非直接导出 —— ESM 的 `export let` 是只读绑定，
 *     外部无法重新赋值，而它恰恰需要被反复重置（每次发送新建、结束/中止置 null）；
 *  3. 本模块与 chat-store.ts 构成**双向依赖**：这里读写 store 状态，store 实现里用这里的辅助。
 *     所有 useChatStore 使用点都在**函数体内**（调用时才求值），ESM 循环引用在此模式下安全
 *     —— 请勿把这些调用提到模块顶层。
 */
import type { AgentInfo, ChatMessage, SubagentEvent } from '../../types/chat';
import type { ChatStore } from '../chat-store';
import { useChatStore } from '../chat-store';
export let messageCounter = 0;
export function nextId() {
  return `msg_${++messageCounter}_${Date.now()}`;
}

// ─── API 消息 → ChatMessage 转换 ──────────────────────

/** 从后端原始错误信息中提取人类可读原因（"400: {json}" → message 字段），与后端 extractErrorReason 语义一致 */
export function extractReadableError(errorMessage: any): string {
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
export function extractTextContent(content: any): string {
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
export function stripTaskPrefix(text: string): string {
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
export interface LiveView {
  messages: ChatMessage[];
  agents: AgentInfo[];
}

export const liveViews = new Map<string, LiveView>();

/**
 * 把「对消息数组的更新」路由到事件所属的会话。
 *
 * - 属于当前显示的会话 → 写 store
 * - 属于其他会话、且它正在后台跑（liveViews 有存档）→ 累积进存档
 * - 其余 → 丢弃并返回 false（防止把 A 的增量画到 B 上）
 *
 * 事件不带 sessionId 时按当前会话处理（向后兼容旧事件）。
 */
export function withMessages(sid: unknown, fn: (msgs: ChatMessage[]) => ChatMessage[]): boolean {
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
export function withAgents(sid: unknown, fn: (agents: AgentInfo[]) => AgentInfo[]): boolean {
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
export function isActiveSession(sid: unknown): boolean {
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
export function endLiveView(sid: unknown): void {
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
export function startRunningSync(): void {
  if (runningSyncTimer) return;
  runningSyncTimer = setTimeout(async () => {
    runningSyncTimer = null;
    if (useChatStore.getState().runningSessions.length === 0) return;
    await useChatStore.getState().loadSessions();
    if (useChatStore.getState().runningSessions.length > 0) startRunningSync();
  }, 3000);
}

export function rebuildAgentsFromMessages(messages: ChatMessage[]): AgentInfo[] {
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

export function apiMessagesToChatMessages(apiMessages: any[]): ChatMessage[] {
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

export function appendAssistantContent(msg: any, chatMsg: ChatMessage): void {
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
export function removePairLocally(s: ChatStore, assistantMsgId: string) {
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

/** 当前运行的 AbortController（发送时新建、结束/中止时置 null） */
export function getAbortController(): AbortController | null {
  return abortController;
}

/** 设置当前 AbortController（未运行传 null） */
export function setAbortController(ac: AbortController | null): void {
  abortController = ac;
}

/** 中止当前运行（若有）并清空引用 */
export function abortCurrentRun(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}
