/**
 * Token 追踪器 + 对话压缩（2026 业界最佳实践版）
 *
 * 能力清单：
 * 1. 结构化摘要模板（<context_summary> 包裹 + END OF CONTEXT SUMMARY 标记 + 前置说明注入）
 * 2. 迭代合并摘要（上次 <context_summary> 作为输入让 LLM 更新，而非从零重写）
 * 3. 确定性预剪枝（零 LLM 成本：toolResult 一行化、连续重复去重、超长截断保头尾、image 占位）
 * 4. 头尾保护（头部前 N 条消息，首次 2 条后衰减为 1 条；尾部按 token 预算 20% 且至少 4 轮，
 *    最后 user 与最后 assistant 回复必在保护区；边界对齐不拆散工具组）
 * 5. 工具调用完整性清理（孤儿 toolResult 删除、缺结果的 tool_call 补 stub）
 * 6. 触发优化（80% 阈值、60s 冷却、防抖动 <10% 收益跳过；手动 force 不受限）
 * 7. 辅助模型摘要（DeepSeek 优先 → 主模型回退 → 确定性截断兜底，20s 超时）
 * 8. 脱敏（sk-xxx / Bearer xxx → [REDACTED]）
 * 9. 接口兼容（getTokenUsage / compactMessages 签名兼容现有调用方，auto_compact SSE 不变）
 *
 * 注意：摘要注入使用 role:'user' 消息（agent-factory 的 convertToLlm 只放行
 * user/assistant/toolResult，旧实现的 system 角色摘要会被过滤——本实现顺带修复）。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { config } from '../config.js';
import { getAdvancedConfig } from '../config/advanced-config.js';

// ─── 常量（默认值）────────────────────────────────────────────────────────
// 以下导出常量是改造前硬编码值，现保留为默认值/文档基准；
// 运行时实际取值来自 data/advanced-config.json 的 compaction.summaryModel
// （getAdvancedConfig() 内存读取，修改后立即生效；不配置时与下列默认值完全一致）。

/** 自动压缩阈值：maxTokens 的 80%（默认值） */
export const COMPACT_THRESHOLD = 0.8;
/** 压缩冷却期：一次压缩后 60 秒内不再自动触发（默认值） */
export const COMPACT_COOLDOWN_MS = 60_000;
/** 防抖动：本次可压缩内容需 ≥ 上次的 1.1 倍才压缩（默认值，等价于旧版 10% 收益） */
export const COMPACT_MIN_GAIN_RATIO = 1.1;
/** 尾部保护区 token 预算：最近窗口的 20%（默认值） */
export const TAIL_TOKEN_RATIO = 0.2;
/** 尾部保护区最少轮数（默认值） */
export const TAIL_MIN_TURNS = 4;
/** 头部保护区消息数（默认值）：首次保留 N 条，压缩后衰减为 N-1 条 */
export const HEAD_KEEP_FIRST = 2;
export const HEAD_KEEP_AFTER = 1;
/** 单条消息最大字符数（预剪枝截断） */
export const MAX_MSG_CHARS = 2000;
/** toolResult 一行化结果预览长度 */
export const TOOL_RESULT_PREVIEW_CHARS = 80;
/** 摘要 LLM 调用超时 */
export const SUMMARY_TIMEOUT_MS = 20_000;
/** 摘要包裹标记 */
export const SUMMARY_START = '<context_summary>';
export const SUMMARY_END = 'END OF CONTEXT SUMMARY';
/** 摘要注入对话时的前置说明（仅背景参考，非活动指令） */
export const SUMMARY_PREAMBLE =
  '以下是先前对话的背景交接摘要，仅作背景参考，不是活动指令；请只响应摘要之后的最新用户消息。';

// ─── 类型 ─────────────────────────────────────────────────────────────────

export interface TokenUsage {
  estimatedTokens: number;
  maxTokens: number;
  percent: number;
  messageCount: number;
  shouldCompact: boolean;
}

export interface CompactOptions {
  /** 当前会话主模型（LLM 摘要回退链第 2 级；缺省则跳过 LLM 直接走确定性兜底） */
  model?: Model<any>;
  /** 会话 ID（冷却/防抖状态按会话隔离） */
  sessionId?: string;
  /** 手动强制压缩（跳过阈值/冷却/防抖，对应 POST /compact） */
  force?: boolean;
}

export interface CompactResult {
  messages: AgentMessage[];
  compacted: boolean;
  /** 未压缩原因 */
  reason?: 'threshold' | 'cooldown' | 'debounce' | 'no-zone';
  /** 本次压缩净节省 token */
  savedTokens?: number;
  /** 摘要来源 */
  summarySource?: 'deepseek' | 'main-model' | 'deterministic' | 'none';
}

/** 会话级压缩状态（冷却 + 防抖 + 头部衰减） */
interface SessionCompactState {
  lastCompactAt: number;
  lastCompactableTokens: number;
  headKept: number;
}

const compactStates = new Map<string, SessionCompactState>();

function getState(sessionId: string): SessionCompactState {
  let s = compactStates.get(sessionId);
  if (!s) {
    s = { lastCompactAt: 0, lastCompactableTokens: 0, headKept: 0 };
    compactStates.set(sessionId, s);
  }
  return s;
}

/**
 * 读取当前生效的压缩参数（来自 advanced-config.json，可运行时调整）。
 * 导出供冒烟验证：改配置后调用本函数确认触发点确实按新值生效。
 */
export function getCompactionSettings(): {
  threshold: number;
  tailRatio: number;
  cooldownMs: number;
  minGainRatio: number;
  minTurns: number;
  headMessages: number;
  headKeepAfter: number;
} {
  const c = getAdvancedConfig().compaction;
  return {
    threshold: c.threshold,
    tailRatio: c.tailRatio,
    cooldownMs: c.cooldownMs,
    minGainRatio: c.minGainRatio,
    minTurns: c.minTurns,
    headMessages: c.headMessages,
    headKeepAfter: Math.max(1, c.headMessages - 1),
  };
}

// ─── Token 估算 ───────────────────────────────────────────────────────────

/**
 * 每 4 字符估算为 1 个 token。
 * 导出供 agent-service 修正 usage.input 复用（估算口径唯一来源，避免两处漂移）。
 */
export function estimateTokensFromText(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokensFromText(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part?.type === 'text' && part.text) total += estimateTokensFromText(part.text);
      else if (part?.type === 'thinking' && part.thinking) total += estimateTokensFromText(part.thinking);
      else if (part?.type === 'toolCall' && part.arguments) total += estimateTokensFromText(JSON.stringify(part.arguments));
      else if (part?.type === 'image') total += 100; // 图片按固定值估算
    }
    return total;
  }
  return 0;
}

function estimateMessageTokens(msg: AgentMessage): number {
  const m = msg as any;
  let total = estimateContentTokens(m.content);
  if (m.role === 'toolResult') {
    total += estimateTokensFromText(JSON.stringify(m.content ?? {}));
  }
  return total;
}

function fallbackEstimateAll(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

/**
 * 估算"该轮全部输入文本"的 token 数 = system prompt + 全部消息（4 字符/token）。
 * 与压缩判定 calculateContextTokens 的文本侧（fallbackEstimateAll）同一口径，
 * 用于把 provider 返回的 usage.input 兜底为不低估的上下文量（见 agent-service 的
 * fixAssistantUsage：DeepSeek v4 等缓存命中时 usage.input 被扣减，需文本估算兜底）。
 */
export function estimateInputTokens(systemPrompt: string, messages: AgentMessage[]): number {
  return estimateTokensFromText(systemPrompt) + fallbackEstimateAll(messages);
}

/**
 * 计算当前上下文 token 使用量：
 * 取 usage 估算与 4 字符文本估算的较大值。
 * - usage 侧：取所有 assistant 消息中 usage.input 最大的一条（反映 LLM 实际收到的最完整上下文；
 *   最后一条可能命中 prompt 缓存，DeepSeek 等只返回小的 input 增量，故取最大而非最后一条），
 *   并加上该消息之后所有消息的文本估算。
 * - 文本侧：全部消息按 4 字符/token 估算。
 * 两者取 max：usage 偏小时（provider 缓存/映射异常）文本估算兜住不低估；usage 正常时
 * （含 system prompt 的真实上下文）它比纯文本估算更准。
 */
function calculateContextTokens(messages: AgentMessage[]): number {
  let best: { total: number; idx: number } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any;
    if (msg.role === 'assistant' && msg.usage?.input) {
      const total = msg.usage.input + (msg.usage.output || 0);
      if (!best || total > best.total) best = { total, idx: i };
    }
  }
  const usageBased = best ? best.total + sumTokensAfter(messages, best.idx) : 0;
  const textBased = fallbackEstimateAll(messages);
  return Math.max(usageBased, textBased);
}

function sumTokensAfter(messages: AgentMessage[], idx: number): number {
  let total = 0;
  for (let j = idx + 1; j < messages.length; j++) {
    total += estimateMessageTokens(messages[j]);
  }
  return total;
}

// ─── 文本工具 ─────────────────────────────────────────────────────────────

/** 提取消息正文文本（text / thinking / toolCall 内容） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p?.type === 'text') return p.text ?? '';
        if (p?.type === 'thinking') return p.thinking ?? '';
        if (p?.type === 'toolCall') return `[toolCall:${p.name} ${JSON.stringify(p.arguments ?? {})}]`;
        return '';
      })
      .join('\n');
  }
  return '';
}

/** 超长文本截断（保头尾） */
function truncateHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tailLen = max - head;
  return `${text.slice(0, head)}\n…[内容过长已截断 ${text.length - max} 字符]…\n${text.slice(-tailLen)}`;
}

// ─── 脱敏 ─────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+\b/g,
];

/** 摘要 prompt 输入输出前统一脱敏 */
export function redact(text: string): string {
  let t = text ?? '';
  for (const re of SECRET_PATTERNS) t = t.replace(re, '[REDACTED]');
  return t;
}

// ─── 确定性预剪枝（零 LLM 成本，只作用于摘要区） ────────────────────────

interface ToolCallRef {
  id: string;
  name: string;
  args: string;
}

function toolCallsOf(msg: AgentMessage): ToolCallRef[] {
  const content = (msg as any).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === 'toolCall')
    .map((c) => ({ id: c.id, name: c.name ?? 'unknown', args: JSON.stringify(c.arguments ?? {}) }));
}

function hasToolCalls(msg: AgentMessage): boolean {
  const content = (msg as any).content;
  return Array.isArray(content) && content.some((c) => c?.type === 'toolCall');
}

/** toolResult 一行化：`[tool:<name>] <参数摘要> -> <结果前 80 字符/exit code>` */
function previewToolResult(tr: any, args: string): string {
  const name = tr.toolName ?? 'unknown';
  const argSummary = args.length > 80 ? `${args.slice(0, 80)}…` : args;
  const text = textOfContent(tr.content).replace(/\s+/g, ' ').trim();
  const exit = tr.details?.exitCode ?? tr.details?.exit_code;
  const body = typeof exit === 'number' && exit !== 0 ? `exit=${exit}: ${text}` : text;
  const preview = body.length > TOOL_RESULT_PREVIEW_CHARS
    ? `${body.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
    : body;
  return `[tool:${name}] ${argSummary} -> ${preview}`;
}

/**
 * 确定性预剪枝：
 * - toolResult → 一行化摘要；相同 toolName+相同参数摘要的连续 toolResult 只留第一个
 * - content 数组中的 image 块 → `[image]` 占位
 * - 单条文本 > 2000 字符 → 截断保头尾
 * 返回新数组，不修改入参。
 */
export function prePrune(messages: AgentMessage[]): AgentMessage[] {
  const callMap = new Map<string, ToolCallRef>();
  for (const m of messages) for (const tc of toolCallsOf(m)) callMap.set(tc.id, tc);

  const out: AgentMessage[] = [];
  let lastResultKey = '';
  for (const m of messages) {
    const role = m.role;
    if (role === 'toolResult') {
      const tr = m as any;
      const call = callMap.get(tr.toolCallId);
      const args = call ? call.args : '';
      const key = `${tr.toolName ?? ''}|${args}`;
      if (key === lastResultKey) continue; // 连续重复去重
      lastResultKey = key;
      out.push({ ...tr, content: [{ type: 'text', text: previewToolResult(tr, args) }] });
      continue;
    }
    lastResultKey = '';
    const c = m as any;
    let content = c.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (part?.type === 'image') return { type: 'text', text: '[image]' };
        if (part?.type === 'text') return { ...part, text: truncateHeadTail(part.text ?? '', MAX_MSG_CHARS) };
        return part; // toolCall / thinking 原样保留
      });
    } else if (typeof content === 'string') {
      content = truncateHeadTail(content, MAX_MSG_CHARS);
    }
    out.push({ ...c, content });
  }
  return out;
}

// ─── 头尾保护 + 边界对齐 ─────────────────────────────────────────────────

/** 工具组起点：从 idx 向前找到包含 idx 的组起点（最近的 user 消息，无则 0） */
function groupStartOf(messages: AgentMessage[], idx: number): number {
  let g = Math.max(0, Math.min(idx, messages.length - 1));
  while (g > 0 && messages[g].role !== 'user') g--;
  return g;
}

/**
 * 边界对齐：把切点（保留区起点）向左扩展，使 user→assistant(toolCalls)→toolResult 组
 * 要么全在摘要区要么全在保留区（绝不拆散）。
 */
function alignBoundary(messages: AgentMessage[], i: number): number {
  let cur = Math.max(0, Math.min(i, messages.length));
  while (cur > 0 && cur < messages.length) {
    const m = messages[cur] as any;
    if (m.role === 'toolResult') {
      cur = groupStartOf(messages, cur - 1);
      continue;
    }
    if (m.role === 'assistant' && hasToolCalls(m)) {
      cur = groupStartOf(messages, cur - 1);
      continue;
    }
    break; // user 或纯文本 assistant：合法切点
  }
  return cur;
}

/** 从末尾累计 N 轮对话的 token 数 */
function estimateTurnsTokens(messages: AgentMessage[], turns: number): number {
  let count = 0;
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += estimateMessageTokens(messages[i]);
    if (messages[i].role === 'user') {
      count++;
      if (count >= turns) break;
    }
  }
  return total;
}

/**
 * 计算尾部保护区起点：
 * - token 预算 = max(当前总 token 的 tailRatio, 至少 minTurns 轮对话的 token)（来自 advanced-config）
 * - 保证最后一条 user 消息与最后一条 assistant 回复始终在保护区（即使超预算）
 * - 边界对齐（工具组不拆散）
 */
function computeTailStart(messages: AgentMessage[], currentTokens: number): number {
  const { tailRatio, minTurns } = getAdvancedConfig().compaction;
  const budget = Math.max(currentTokens * tailRatio, estimateTurnsTokens(messages, minTurns));
  let t = messages.length;
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]);
    if (acc >= budget) {
      t = i;
      break;
    }
  }
  // 最后 user / assistant 必在保护区
  let lastUser = -1;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (lastUser < 0 && messages[i].role === 'user') lastUser = i;
    if (lastAssistant < 0 && messages[i].role === 'assistant') lastAssistant = i;
    if (lastUser >= 0 && lastAssistant >= 0) break;
  }
  const mustKeep = Math.min(
    lastUser >= 0 ? lastUser : t,
    lastAssistant >= 0 ? lastAssistant : t,
  );
  if (t > mustKeep) t = mustKeep;
  return alignBoundary(messages, t);
}

/** 头部保护区：前 N 条消息（首次 headMessages 条，压缩后衰减为 headMessages-1 条），对齐工具组 */
function computeHeadEnd(messages: AgentMessage[], state: SessionCompactState): number {
  const headMessages = getAdvancedConfig().compaction.headMessages;
  const keep = state.headKept > 0 ? state.headKept : headMessages;
  return alignBoundary(messages, Math.min(keep, messages.length));
}

// ─── 结构化摘要模板 ───────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `你是一名对话压缩专家。请把提供的对话历史压缩为结构化背景交接摘要，只保留对后续对话有长期价值的信息（目标、事实进展、决策、用户偏好、待办、关键文件、下一步）。输出必须严格按以下格式，不要添加任何额外说明或代码块标记：

<context_summary>
GOAL: <用户核心目标>
PROGRESS: <已完成事项，写成过去式事实，多条用分号分隔>
KEY_DECISIONS: <关键决策>
USER_PREFERENCES: <用户偏好>
PENDING_WORK: <待办>
KEY_FILES: <涉及的关键文件>
NEXT_STEPS: <下一步>
</context_summary>
END OF CONTEXT SUMMARY`;

/** 摘要消息注入时的固定前置说明（仅背景参考，非活动指令） */
function buildSummaryMessage(summaryText: string): AgentMessage {
  return {
    role: 'user',
    content: `${SUMMARY_PREAMBLE}\n\n${summaryText}`,
    timestamp: Date.now(),
  } as AgentMessage;
}

function isSummaryMessage(m: AgentMessage): boolean {
  const content = (m as any).content;
  if (typeof content === 'string') return content.includes(SUMMARY_START);
  if (Array.isArray(content)) return content.some((c) => typeof c?.text === 'string' && c.text.includes(SUMMARY_START));
  return false;
}

/** 提取上轮压缩的 <context_summary> 文本（迭代合并用） */
export function extractPreviousSummary(messages: AgentMessage[]): string | null {
  for (const m of messages) {
    if (!isSummaryMessage(m)) continue;
    const text = textOfContent((m as any).content);
    const s = text.indexOf(SUMMARY_START);
    const e = text.indexOf(SUMMARY_END);
    if (s >= 0 && e > s) return text.slice(s, e + SUMMARY_END.length);
  }
  return null;
}

/** 规范化 LLM 摘要输出：确保 <context_summary> 包裹 + END OF CONTEXT SUMMARY 标记 */
function normalizeSummaryText(raw: string): string {
  let t = raw.trim();
  if (!t.includes(SUMMARY_START)) t = `${SUMMARY_START}\n${t}`;
  if (!t.includes(SUMMARY_END)) t = `${t}\n${SUMMARY_END}`;
  const s = t.indexOf(SUMMARY_START);
  const e = t.indexOf(SUMMARY_END);
  return t.slice(s, e + SUMMARY_END.length);
}

/** 把预剪枝后的消息文本化（进摘要 prompt 前脱敏） */
function messagesToText(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role === 'toolResult') {
      lines.push(`[toolResult] ${textOfContent((m as any).content)}`);
    } else if (role === 'user') {
      lines.push(`[user] ${truncateHeadTail(textOfContent((m as any).content), 1000)}`);
    } else if (role === 'assistant') {
      const content = (m as any).content;
      const texts = Array.isArray(content)
        ? content.filter((c) => c?.type === 'text').map((c) => c.text)
        : [];
      const calls = Array.isArray(content)
        ? content
            .filter((c) => c?.type === 'toolCall')
            .map((c) => `${c.name}(${JSON.stringify(c.arguments ?? {})})`)
        : [];
      lines.push(`[assistant] ${texts.join(' ')}${calls.length ? ` 工具调用: ${calls.join('; ')}` : ''}`);
    }
  }
  return redact(lines.join('\n'));
}

/** 迭代合并：上次 <context_summary> + 新增对话 → 更新摘要（而非从零重写） */
function buildSummaryUserPrompt(pruned: AgentMessage[], previousSummary: string | null): string {
  const parts: string[] = [];
  if (previousSummary) {
    parts.push(
      `以下是上次生成的背景交接摘要，请基于它和下面的新增对话做增量更新（不要从零重写，保持格式一致）：\n${redact(previousSummary)}`,
    );
  }
  parts.push('以下是本次需要压缩吸收的对话片段（工具结果已一行化、图片已占位、敏感信息已脱敏）：');
  parts.push(messagesToText(pruned));
  return redact(parts.join('\n\n'));
}

/** 确定性兜底摘要（无 LLM 可用时）：规则生成，零 LLM 调用 */
function deterministicSummary(pruned: AgentMessage[], previousSummary: string | null): string {
  const parts: string[] = [];
  if (previousSummary) {
    parts.push(previousSummary.trim());
  } else {
    const userMsgs = pruned.filter((m) => m.role === 'user');
    const tools = new Set<string>();
    for (const m of pruned) {
      for (const tc of toolCallsOf(m)) tools.add(tc.name);
    }
    const files = new Set<string>();
    for (const m of pruned) {
      const t = textOfContent((m as any).content);
      for (const f of t.match(/\b[\w./~-]+\.(ts|js|json|md|py|txt|sh|css|html|sql|yaml|yml|toml)\b/g) ?? []) {
        files.add(f);
      }
    }
    parts.push('GOAL: 未明确（上下文过长已自动压缩）');
    parts.push(`PROGRESS: 已完成 ${userMsgs.length} 轮用户对话${tools.size ? `；调用过工具: ${[...tools].join(', ')}` : ''}`);
    // 预剪枝一行化产物直接并入摘要（保留工具执行信息）
    const toolLogs = pruned
      .filter((m) => m.role === 'toolResult')
      .map((m) => textOfContent((m as any).content));
    if (toolLogs.length > 0) {
      parts.push(`  工具执行记录: ${toolLogs.slice(0, 8).join(' | ')}`);
    }
    parts.push('KEY_DECISIONS: 详见对话记录（已截断）');
    parts.push('USER_PREFERENCES: 未提取到明确偏好');
    parts.push('PENDING_WORK: 未明确');
    parts.push(`KEY_FILES: ${[...files].slice(0, 8).join(', ') || '未提及'}`);
    parts.push('NEXT_STEPS: 等待用户下一步指示');
    // 前 10 + 后 3 条用户消息（含图片占位等预剪枝产物），去重
    const seen = new Set<string>();
    for (const um of userMsgs.slice(0, 10).concat(userMsgs.slice(-3))) {
      const t = textOfContent((um as any).content).slice(0, 120);
      if (t && !seen.has(t)) {
        seen.add(t);
        parts.push(`- 用户曾问: "${t}"`);
      }
    }
  }
  return `${SUMMARY_START}\n${parts.join('\n')}\n${SUMMARY_END}`;
}

// ─── LLM 摘要（辅助模型链） ──────────────────────────────────────────────

/** 运行时读取 DeepSeek 配置（勿硬编码 apiKey）；DEEPSEEK_API_KEY 未设置时返回 null */
export function buildDeepSeekModel(): Model<any> | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey,
    input: ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 4096,
    headers: {},
    compat: { maxTokensField: 'max_tokens' },
  } as Model<any>;
}

/** 单次摘要 LLM 调用：20s 超时 + 错误捕获，失败返回 null（绝不影响主对话）。
 * 导出供记忆蒸馏等复用（同一套辅助模型调用原语）。 */
export async function completeText(model: Model<any>, systemPrompt: string, userText: string): Promise<string | null> {
  try {
    const stream = streamSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: 'user', content: userText }],
      } as any,
      {
        // pi-ai Model 类型无 apiKey 字段，运行时模型对象上有（见 llm-config createQwenModel 注释）
        apiKey: (model as { apiKey?: string }).apiKey || undefined,
        maxTokens: 2048,
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      } as any,
    );
    let text = '';
    for await (const evt of stream as any) {
      // pi-ai 的 text_delta 事件文本在 delta 字段（非 text）
      if (evt?.type === 'text_delta' && typeof evt.delta === 'string') text += evt.delta;
    }
    return text.trim() || null;
  } catch (err) {
    console.error(`[Compact] LLM summary failed (${model.id}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 通用辅助模型回退链（对话压缩与记忆蒸馏共用，prompt 由调用方提供）：
 * - summaryModel=auto（默认）：DeepSeek → 主模型（有传时）→ null
 * - summaryModel=main：直接用主模型 → null
 * 统一脱敏由调用方完成（本函数返回原文）；20s 超时 + 错误捕获见 completeText。
 */
export async function callAuxiliaryModel(
  systemPrompt: string,
  userText: string,
  mainModel?: Model<any>,
): Promise<{ text: string; source: 'deepseek' | 'main-model' } | null> {
  const summaryModel = getAdvancedConfig().summaryModel;

  if (summaryModel === 'auto') {
    const ds = buildDeepSeekModel();
    if (ds) {
      const text = await completeText(ds, systemPrompt, userText);
      if (text) return { text, source: 'deepseek' };
      console.warn('[AuxModel] DeepSeek 摘要失败，回退主模型');
    } else {
      console.warn('[AuxModel] DEEPSEEK_API_KEY 未设置，使用主模型生成摘要');
    }
  } else {
    console.warn('[AuxModel] 摘要模型=main（使用当前主模型生成摘要）');
  }

  if (mainModel) {
    const text = await completeText(mainModel, systemPrompt, userText);
    if (text) return { text, source: 'main-model' };
    console.warn('[AuxModel] 主模型摘要失败，回退确定性方案');
  }

  return null;
}

/**
 * 摘要回退链（summaryModel 来自 advanced-config.json）：
 * - auto（默认）：DeepSeek → 主模型 → null（调用方走确定性兜底）
 * - main：直接用当前主模型 → null
 */
async function summarizeChain(
  pruned: AgentMessage[],
  previousSummary: string | null,
  mainModel?: Model<any>,
): Promise<{ text: string; source: 'deepseek' | 'main-model' } | null> {
  const userPrompt = buildSummaryUserPrompt(pruned, previousSummary);
  const chain = await callAuxiliaryModel(SUMMARY_SYSTEM_PROMPT, userPrompt, mainModel);
  return chain ? { text: redact(chain.text), source: chain.source } : null;
}

// ─── 工具调用完整性清理 ───────────────────────────────────────────────────

/**
 * 压缩后保证消息序列通过 LLM API 校验（不报
 * "No tool call found for function call output with call_id"）：
 * - 被移除的 assistant 上的 tool_call 若在保留区有对应 toolResult → 该 toolResult 是孤儿 → 删除
 * - 保留区 assistant 的 tool_call 若其 toolResult 落在摘要区被删 → 插入 stub toolResult
 */
export function cleanToolIntegrity(messages: AgentMessage[]): AgentMessage[] {
  // 1. 删除孤儿 toolResult：其 toolCallId 在现有消息中找不到对应 toolCall
  const callIds = new Set<string>();
  for (const m of messages) {
    for (const tc of toolCallsOf(m)) callIds.add(tc.id);
  }
  const noOrphan: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'toolResult') {
      const id = (m as any).toolCallId;
      if (id && callIds.has(id)) noOrphan.push(m);
      // 孤儿 → 删除
      continue;
    }
    noOrphan.push(m);
  }

  // 2. 保留区 assistant 的 tool_call 缺 toolResult → 插入 stub
  const resultIds = new Set<string>();
  for (const m of noOrphan) {
    if (m.role === 'toolResult') resultIds.add((m as any).toolCallId);
  }
  const final: AgentMessage[] = [];
  for (const m of noOrphan) {
    final.push(m);
    if (m.role === 'assistant') {
      const content = (m as any).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'toolCall' && !resultIds.has(c.id)) {
            final.push({
              role: 'toolResult',
              toolCallId: c.id,
              toolName: c.name ?? 'unknown',
              content: [{ type: 'text', text: '[摘要压缩: 结果已省略]' }],
              isError: false,
              timestamp: (m as any).timestamp ?? Date.now(),
            } as AgentMessage);
          }
        }
      }
    }
  }
  return final;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 执行对话压缩（2026 最佳实践版）
 *
 * 流程：阈值/冷却/防抖检查 → 保护区计算（头尾 + 边界对齐）→ 确定性预剪枝 →
 * LLM 摘要（DeepSeek→主模型→确定性兜底）→ 摘要注入（迭代合并）→ 工具完整性清理。
 */
export async function compactMessages(
  messages: AgentMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const sessionId = opts.sessionId ?? 'default';
  const maxTokens = config.defaultMaxTokens;
  const currentTokens = calculateContextTokens(messages);
  const state = getState(sessionId);
  const comp = getCompactionSettings();

  // 阈值（advanced-config.compaction.threshold，默认 80%）
  if (!opts.force && currentTokens < maxTokens * comp.threshold) {
    return { messages, compacted: false, reason: 'threshold' };
  }

  // 冷却：一次压缩后 cooldownMs 内不再自动触发（默认 60 秒）
  if (
    !opts.force &&
    state.lastCompactAt > 0 &&
    Date.now() - state.lastCompactAt < comp.cooldownMs
  ) {
    return { messages, compacted: false, reason: 'cooldown' };
  }

  // 保护区（头尾 + 边界对齐）
  const headEnd = computeHeadEnd(messages, state);
  const tailStart = computeTailStart(messages, currentTokens);
  if (tailStart <= headEnd) {
    return { messages, compacted: false, reason: 'no-zone' };
  }

  // 本次可压缩内容 token（防抖依据）
  const compactableTokens = messages
    .slice(headEnd, tailStart)
    .reduce((acc, m) => acc + estimateMessageTokens(m), 0);

  // 防抖动：本次可压缩内容需 ≥ 上次的 minGainRatio 倍才压缩（默认 1.1，避免无限压）
  if (
    !opts.force &&
    state.lastCompactableTokens > 0 &&
    compactableTokens < state.lastCompactableTokens * comp.minGainRatio
  ) {
    return { messages, compacted: false, reason: 'debounce' };
  }

  // ① 确定性预剪枝（只作用于摘要区，尾部保留区不动）
  const pruned = prePrune(messages.slice(headEnd, tailStart));

  // ② 迭代合并：取上次 <context_summary> 作为 LLM 输入
  const previousSummary = extractPreviousSummary(messages);

  // ③ LLM 摘要（DeepSeek → 主模型 → 确定性兜底）
  const chain = await summarizeChain(pruned, previousSummary, opts.model);
  const summarySource: CompactResult['summarySource'] = chain?.source ?? 'deterministic';
  // 统一脱敏：LLM 路径与确定性兜底路径都不允许敏感信息进入对话上下文
  const summaryText = normalizeSummaryText(redact(chain ? chain.text : deterministicSummary(pruned, previousSummary)));

  // ④ 组装：头部（去掉旧摘要消息）+ 新摘要消息 + 尾部
  const summaryMsg = buildSummaryMessage(summaryText);
  let finalMessages: AgentMessage[] = [
    ...messages.slice(0, headEnd).filter((m) => !isSummaryMessage(m)),
    summaryMsg,
    ...messages.slice(tailStart),
  ];

  // ⑤ 工具调用完整性清理（孤儿 toolResult 删除 + 缺结果 stub）
  finalMessages = cleanToolIntegrity(finalMessages);

  const afterTokens = calculateContextTokens(finalMessages);
  const savedTokens = Math.max(0, currentTokens - afterTokens);

  // 更新会话状态：冷却计时 + 防抖基线 + 头部衰减（headMessages-1，至少 1 条）
  state.lastCompactAt = Date.now();
  state.lastCompactableTokens = compactableTokens;
  state.headKept = comp.headKeepAfter;

  const pct = currentTokens > 0 ? Math.round((1 - afterTokens / currentTokens) * 100) : 0;
  console.log(
    `[Compact] session=${sessionId} ${messages.length} 条 → ${finalMessages.length} 条, ` +
      `token ${currentTokens} → ${afterTokens} (减少 ${pct}%), 摘要来源=${summarySource}`,
  );

  return { messages: finalMessages, compacted: true, savedTokens, summarySource };
}

/**
 * 获取会话的 token 使用情况（签名与旧版一致，前端 TokenBar 直接使用）
 */
export function getTokenUsage(messages: AgentMessage[]): TokenUsage {
  const estimatedTokens = calculateContextTokens(messages);
  const maxTokens = config.defaultMaxTokens;
  const threshold = getCompactionSettings().threshold;

  return {
    estimatedTokens,
    maxTokens,
    percent: Math.min(100, Math.round((estimatedTokens / maxTokens) * 100)),
    messageCount: messages.length,
    shouldCompact: estimatedTokens > maxTokens * threshold,
  };
}
