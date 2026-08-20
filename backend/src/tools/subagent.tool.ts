/**
 * subagent 子代理工具
 *
 * 主 Agent 调用 subagent(task, tools?) 时，后端创建一个独立的子 Agent 执行该任务，
 * 子代理的最终回复作为工具结果返回给主 Agent。主 Agent 可多次调用 subagent 分解并行任务。
 *
 * 设计决策（与 agent-factory.ts 的关系）：
 * - 不复用 createAgent：其 beforeToolCall 绑定用户确认流程（ask → awaitToolConfirmation
 *   等待用户弹窗），子代理在后台执行、无确认 UI，ask 会挂起直至超时。
 *   因此参考 createAgent 的核心组装方式（thinking compat + streamFn 超时/API key +
 *   convertToLlm + 权限拦截）新建轻量子代理，提示词换成子代理专用。
 * - 轮数限制：pi-mono Agent 构造参数无 maxTurns → 用 subscribe 监听 turn_end 计数，
 *   达到上限（默认 8）调用 agent.abort()。abort 后 loop 以 aborted 轮收尾并正常发
 *   agent_end，事件流完整结束。
 * - 超时：整体 setTimeout(120s) → agent.abort()；单次 LLM 调用另有 streamFn 内的
 *   llmTimeoutMs 超时（与主代理一致）。主代理 run 的 abort signal 也会链到子代理。
 * - 并发锁：工具按会话实例化（SessionManager.createSession 每次 createCustomTools
 *   生成新工具实例），用实例闭包变量 busy 即天然按会话隔离；同会话并发调用抛错。
 * - 错误传播：子代理内部错误不吞掉——结果 details 带 isError/error 标记，content 文本
 *   同时包含错误信息；锁冲突直接抛异常（agent-loop 自动转为 isError 的 toolResult）。
 */

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentMessage,
  AgentEvent,
} from '@earendil-works/pi-agent-core';
import type { Model, Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { Type, type Static } from 'typebox';
import { config } from '../config.js';
import { getAdvancedConfig } from '../config/advanced-config.js';
import { createQwenModel } from '../agent/llm-config.js';
import { getAgentModelConfig } from '../agent/agent-config.js';
import { buildThinkingCompat, buildOnPayload } from '../agent/model-adapter.js';
import { decideToolGate, summarizeArgs } from '../agent/agent-factory.js';
import { createCustomTools } from './index.js';

// ─── 参数 Schema（TypeBox，与现有工具一致）──────────────────────

const SubagentParams = Type.Object({
  task: Type.String({ description: '子代理要完成的任务描述（会写入子代理系统提示词）' }),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: '允许子代理使用的工具名列表，默认使用全部工具' }),
  ),
});

export type SubagentParams = Static<typeof SubagentParams>;

// ─── 返回结构 ─────────────────────────────────────────────────

/** 子代理执行过的工具调用记录（名称 + 参数摘要） */
export interface SubagentToolCallRecord {
  name: string;
  args: string;
}

/** subagent 工具结果 details */
export interface SubagentDetails {
  /** 子代理最终回复文本 */
  summary?: string;
  /** 子代理执行过的工具调用列表（名称 + 参数摘要，截断防刷屏） */
  toolCalls?: SubagentToolCallRecord[];
  /** 子代理轮数（LLM 调用次数） */
  turns?: number;
  /** 是否因轮数上限截断 */
  truncated?: boolean;
  /** 是否因整体超时中止 */
  timedOut?: boolean;
  /** 子代理执行是否出错（错误不吞掉） */
  isError?: boolean;
  /** 错误信息（isError 时存在） */
  error?: string;
  /**
   * 实时汇报事件（onUpdate 推送时专用，final result 中不存在）：
   * 子代理内部过程（工具调用、文本增量、结束标记），前端按此渲染 Agent 详情弹窗。
   */
  subagentEvent?: SubagentEvent;
}

/**
 * 子代理实时事件（通过工具 onUpdate → SSE tool_update.partialResult.details.subagentEvent 推送）。
 * 字段风格与前端 ToolCallInfo 对齐：toolName/args/result/isError。
 */
export interface SubagentEvent {
  /** 事件类型：子代理调用工具 / 工具结束 / 回复文本增量 / 思考增量 / 子代理整体结束 */
  kind: 'tool_start' | 'tool_end' | 'text_delta' | 'thinking_delta' | 'agent_end';
  /** 事件发生时间（毫秒时间戳，pushEvent 时填 Date.now()，前端格式化 HH:MM:SS.mmm） */
  ts?: number;
  /** 对应外层主代理的工具调用 id（前端按 tool_update.toolCallId 匹配） */
  agentId?: string;
  /** 子代理调用的工具名（tool_start / tool_end） */
  toolName?: string;
  /** 工具参数摘要（tool_start，截断防刷屏） */
  args?: unknown;
  /** 工具结果摘要（tool_end，截断防刷屏） */
  result?: unknown;
  /** 回复文本增量（text_delta，节流推送）或思考增量（thinking_delta）或子代理最终摘要（agent_end 不带，取 tool_end 的 summary） */
  text?: string;
  /** 是否出错（tool_end / agent_end） */
  isError?: boolean;
}

// ─── 常量（默认值）────────────────────────────────────────────
// 运行时实际取值来自 data/advanced-config.json 的 subagent 段（getAdvancedConfig()
// 内存读取，修改后立即生效；以下常量仅作默认值，与配置默认值保持一致）。

const SUBAGENT_TOOL_NAME = 'subagent';
const DEFAULT_MAX_TURNS = 8; // 最大轮数（LLM 调用次数，默认值）
const DEFAULT_TIMEOUT_MS = 120_000; // 整体超时（默认值）
const ARGS_SUMMARY_MAX_LEN = 200;
const TEXT_DELTA_THROTTLE_MS = 100; // text_delta 节流间隔：只推累积文本，避免高频微 delta 刷屏（内容完整推送不截断）
const THINKING_DELTA_THROTTLE_MS = 100; // thinking_delta 节流间隔（同 text_delta，累积推送）
const RESULT_SUMMARY_MAX_LEN = 500; // tool_end 结果摘要截断长度

/** 工具结果摘要：优先取 content 文本，截断防刷屏 */
function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  let text = '';
  if (typeof result === 'object') {
    const r = result as { content?: unknown };
    if (Array.isArray(r.content)) {
      text = (r.content as any[])
        .filter((c: any) => c && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join(' ');
    } else if (typeof r.content === 'string') {
      text = r.content;
    }
  }
  if (!text) text = JSON.stringify(result);
  return text.length > RESULT_SUMMARY_MAX_LEN
    ? `${text.slice(0, RESULT_SUMMARY_MAX_LEN)}…`
    : text;
}

// 子代理专用系统提示词（任务要求原文，task 注入）
function buildSubagentSystemPrompt(task: string): string {
  return `你是一个子代理，负责完成父代理分配的任务：${task}

完成任务后给出简洁的最终结果。不要提及你是 AI 或要求确认。`;
}

// ─── 轻量子代理组装（参考 agent-factory.createAgent 的核心，去掉确认机制）───

interface CreateSubagentOptions {
  systemPrompt: string;
  model: Model<any>;
  tools: AgentTool<any>[];
  /** 轮数达到上限时回调（用于计数+截断） */
  onMaxTurnsReached?: () => void;
}

function createSubagentAgent(opts: CreateSubagentOptions): Agent {
  const { systemPrompt, model, tools } = opts;

  // 与主代理一致：合并模型适配层的 thinking compat（如 qwen 的 thinkingFormat）
  const thinkingCompat = buildThinkingCompat(model.id);
  model.compat ??= {};
  Object.assign(model.compat, thinkingCompat);
  const onPayload = buildOnPayload(model.id);

  return new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: (config as any).thinkingLevel || 'medium',
      tools,
    },
    // 与 agent-factory 相同的 streamFn：单次 LLM 调用超时 + API key + maxTokens + thinking 注入
    streamFn: async (mdl, ctx, opts) => {
      const timeoutSignal = AbortSignal.timeout(config.llmTimeoutMs);
      const combinedSignal = opts?.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;
      const enhancedOpts = {
        ...opts,
        signal: combinedSignal,
        // 与 agent-factory 相同的回退链：pi-ai 的 openai-completions 实现只认
        // options.apiKey（getClientApiKey 不读 model.apiKey），而 agent-loop 不会把
        // Model 上的 apiKey 放进 options。必须把 mdl.apiKey（含 modelOverrides.apiKey）
        // 插入回退链，否则子代理会落到 config.qwenApiKey 或占位 key → 401。
        apiKey: opts?.apiKey || (mdl as { apiKey?: string }).apiKey || config.qwenApiKey || 'sk-no-key-required',
        // 与 agent-factory 相同的 maxTokens 回退链：opts → mdl.maxTokens（模型预设级）→ 全局默认
        maxTokens: opts?.maxTokens ?? (mdl as { maxTokens?: number }).maxTokens ?? config.defaultMaxTokens,
        onPayload: (payload: unknown) => {
          const result = onPayload(payload);
          return result ?? payload;
        },
      };
      return streamSimple(mdl, ctx, enhancedOpts);
    },
    // 与 agent-factory 相同：只保留 user/assistant/toolResult 消息
    convertToLlm: (messages: AgentMessage[]): Message[] => {
      const filtered = messages.filter(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
      );
      return filtered as Message[];
    },
    beforeToolCall: async ({ toolCall }) => {
      // 工具权限沿用主会话配置（复用 agent-factory 的 decideToolGate 判定）：
      // - deny → 拒绝（全局禁用的工具子代理同样不可用）
      // - allow / ask / execute_command_ask → 放行
      // 说明（最简可行实现）：子代理在后台运行，无法弹出用户确认框；父代理调用
      // subagent 本身已通过主会话的权限确认流程，因此子代理内部工具不再二次确认。
      // 若后续需要 ask 转发到前端，可在此接入 awaitToolConfirmation + emitEvent。
      const gate = decideToolGate(toolCall.name, '');
      if (gate === 'deny') {
        return { block: true, reason: `工具 ${toolCall.name} 已被禁用（权限: deny）` };
      }
      return undefined;
    },
  });
}

/** 提取最后一条含文本的 assistant 消息文本 */
function extractAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = (m.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

// ─── 工具工厂 ─────────────────────────────────────────────────

export interface CreateSubagentToolOptions {
  /** 子代理模型，默认与主代理相同（agent 模式的模型配置） */
  model?: Model<any>;
  /** 工具池（默认 createCustomTools(workDir) 全量工具），按 tools 参数过滤 */
  toolsPool?: AgentTool<any>[];
  /** 最大轮数（默认 8） */
  maxTurns?: number;
  /** 整体超时毫秒数（默认 120000） */
  timeoutMs?: number;
}

export function createSubagentTool(
  workDir: string,
  options: CreateSubagentToolOptions = {},
): AgentTool<typeof SubagentParams, SubagentDetails> {

  // 并发锁：工具按会话实例化，实例闭包变量即按会话隔离；
  // 同一实例（同一会话）执行中再次调用会报错，不同会话互不影响。
  let busy = false;

  return {
    name: SUBAGENT_TOOL_NAME,
    label: '子代理',
    description:
      '派子代理(subagent)执行子任务：将复杂任务交给独立子代理完成，子代理可自行调用工具并返回结果摘要。' +
      '用户说"派子Agent/子代理/子任务/派个助手"时即使用本工具。' +
      '适合：任务可分解、需要独立执行、主对话需要并行/委派',
    parameters: SubagentParams,
    async execute(
      toolCallId: string,
      params: SubagentParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
    ): Promise<AgentToolResult<SubagentDetails>> {
      // 锁：同一会话同时只允许一个 subagent 执行
      if (busy) {
        throw new Error('已有子代理在执行，请等待完成');
      }
      busy = true;
      try {
        // ─── 实时汇报：通过工具 onUpdate → agent-loop tool_execution_update →
        // SSE/WS tool_update(partialResult.details.subagentEvent) 推送子代理内部过程。
        // agent-service / rpc-event-adapter 无需改动（链路天然存在）。
        const pushEvent = (subagentEvent: SubagentEvent) => {
          try {
            onUpdate?.({
              content: [
                { type: 'text', text: `[subagent ${toolCallId} ${subagentEvent.kind}]` },
              ],
              details: { subagentEvent },
            });
          } catch (err) {
            // 推送失败（如客户端断开）不影响子代理执行
            console.error(`[Subagent] push event failed: ${(err as Error)?.message ?? err}`);
          }
        };
        // text_delta 节流：100ms 累积推送一次（控制事件量），内容完整推送不截断
        // （弹窗要展示完整流式输出，500 字截断只发生在 tool_end 的 result 摘要上）
        let textBuffer = '';
        let lastTextPush = 0;
        let textTimer: ReturnType<typeof setTimeout> | null = null;
        const flushText = () => {
          if (!textBuffer) return;
          const text = textBuffer;
          textBuffer = '';
          lastTextPush = Date.now();
          pushEvent({ kind: 'text_delta', agentId: toolCallId, text, ts: Date.now() });
        };
        const pushTextDelta = (delta: string) => {
          if (!delta) return;
          textBuffer += delta;
          const now = Date.now();
          if (now - lastTextPush >= TEXT_DELTA_THROTTLE_MS) {
            flushText();
          } else if (!textTimer) {
            textTimer = setTimeout(() => {
              textTimer = null;
              flushText();
            }, TEXT_DELTA_THROTTLE_MS);
          }
        };
        // thinking_delta 节流：结构与 text_delta 相同，累积完整思考增量
        // （增量形态与主 Agent 一致：message_update.assistantMessageEvent.delta 为
        // 思考文本字符串增量，累积即可还原完整思考过程）
        let thinkingBuffer = '';
        let lastThinkingPush = 0;
        let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
        const flushThinking = () => {
          if (!thinkingBuffer) return;
          const thinking = thinkingBuffer;
          thinkingBuffer = '';
          lastThinkingPush = Date.now();
          pushEvent({ kind: 'thinking_delta', agentId: toolCallId, text: thinking, ts: Date.now() });
        };
        const pushThinkingDelta = (delta: string) => {
          if (!delta) return;
          thinkingBuffer += delta;
          const now = Date.now();
          if (now - lastThinkingPush >= THINKING_DELTA_THROTTLE_MS) {
            flushThinking();
          } else if (!thinkingTimer) {
            thinkingTimer = setTimeout(() => {
              thinkingTimer = null;
              flushThinking();
            }, THINKING_DELTA_THROTTLE_MS);
          }
        };
        // 每次执行时读取配置（advanced-config.json 的 subagent 段，可运行时调整），
        // options 显式传入时优先于配置，配置优先于内置默认常量
        const subagentCfg = getAdvancedConfig().subagent;
        const maxTurns = options.maxTurns ?? subagentCfg.maxTurns ?? DEFAULT_MAX_TURNS;
        const timeoutMs = options.timeoutMs ?? subagentCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // ① 模型：默认与主代理一致（agent 模式配置），可用 createSubagentTool 的 model 覆盖
        const model = options.model ?? createQwenModel(getAgentModelConfig());

        // ② 工具集：从项目工具池按 tools 参数过滤；子代理永远不包含 subagent 自身（防无限递归）
        const pool = options.toolsPool ?? createCustomTools(workDir);
        const allowedNames = params.tools
          ? new Set(params.tools)
          : new Set(pool.map((t) => t.name));
        const tools = pool.filter(
          (t) => t.name !== SUBAGENT_TOOL_NAME && allowedNames.has(t.name),
        );
        if (tools.length === 0) {
          throw new Error(
            '子代理没有可用工具（指定的工具不存在、已被过滤或只有 subagent 自身）',
          );
        }

        // ③ 创建子代理（提示词为子代理专用，task 注入）
        const subAgent = createSubagentAgent({
          systemPrompt: buildSubagentSystemPrompt(params.task),
          model,
          tools,
        });

        // ④ 轮数计数 + 工具调用收集 + 实时事件推送（订阅 Agent 生命周期事件）
        // 回调整体 try-catch：事件处理（含 pushEvent 链）异常不得影响子代理执行
        let turns = 0;
        let truncated = false;
        const toolCalls: SubagentToolCallRecord[] = [];
        const unsubscribe = subAgent.subscribe((event: AgentEvent) => {
          try {
            if (event.type === 'turn_end') {
              // 排除 abort 收尾产生的失败轮，只统计正常轮
              if ((event.message as { stopReason?: string }).stopReason !== 'aborted') {
                turns += 1;
                if (turns >= maxTurns) {
                  truncated = true;
                  subAgent.abort(); // 达到轮数上限，中止后续 LLM 调用
                }
              }
            } else if (event.type === 'tool_execution_start') {
              const args = summarizeArgs(event.args).slice(0, ARGS_SUMMARY_MAX_LEN);
              toolCalls.push({ name: event.toolName, args });
              // 实时推送：子代理开始调用工具（全量推）
              pushEvent({
                kind: 'tool_start',
                agentId: toolCallId,
                toolName: event.toolName,
                args,
                ts: Date.now(),
              });
            } else if (event.type === 'tool_execution_end') {
              // 实时推送：子代理工具执行结束（全量推，结果摘要截断防刷屏）
              pushEvent({
                kind: 'tool_end',
                agentId: toolCallId,
                toolName: event.toolName,
                result: summarizeToolResult(event.result),
                isError: Boolean(event.isError),
                ts: Date.now(),
              });
            } else if (event.type === 'message_update') {
              // 实时推送：子代理回复增量（节流）
              // - text_delta → 文本增量（完整推送，不截断）
              // - thinking_delta → 思考增量（与主 Agent 同一事件源，DeepSeek
              //   的 reasoning_content 经 openai-completions 映射为 thinking）
              const inner = (event as any).assistantMessageEvent as
                | { type?: string; delta?: string }
                | undefined;
              if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
                pushTextDelta(inner.delta);
              } else if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') {
                pushThinkingDelta(inner.delta);
              }
            } else if (event.type === 'agent_end') {
              // 实时推送：子代理整体结束（最终摘要随外层 tool_end 的 result.details.summary 返回）
              pushEvent({ kind: 'agent_end', agentId: toolCallId, ts: Date.now() });
            }
          } catch (err) {
            console.error(`[Subagent] event handler error: ${(err as Error)?.message ?? err}`);
          }
        });

        // ⑤ 整体超时 + 主代理 abort 链（用户中止主代理时子代理同步中止）
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          timedOut = true;
          subAgent.abort();
        }, timeoutMs);
        const onOuterAbort = () => subAgent.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });

        try {
          await subAgent.prompt({
            role: 'user',
            content: [{ type: 'text', text: '开始执行任务，完成后用简洁的最终结果回复。' }],
            timestamp: Date.now(),
          });
        } catch (err) {
          // 理论上 prompt 不会抛（runWithLifecycle 内部捕获），兜底防御
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `子代理执行失败：${msg}` }],
            details: {
              summary: '',
              toolCalls,
              turns,
              truncated,
              isError: true,
              error: msg,
            },
          };
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', onOuterAbort);
          // 收尾：清掉节流定时器并推送残留增量（文本 + 思考）
          if (textTimer) {
            clearTimeout(textTimer);
            textTimer = null;
          }
          flushText();
          if (thinkingTimer) {
            clearTimeout(thinkingTimer);
            thinkingTimer = null;
          }
          flushThinking();
          unsubscribe();
        }

        // ⑥ 收集结果：summary 取最后一条 assistant 文本；错误不吞掉（isError + error）
        const errorMsg = subAgent.state.errorMessage;
        const isError = Boolean(errorMsg) || timedOut;
        const summary =
          extractAssistantText(subAgent.state.messages) || errorMsg || '(子代理未产生输出)';
        const text = isError
          ? `[子代理出错${timedOut ? '（整体超时）' : ''}] ${errorMsg ?? ''}\n${summary}`
          : summary;

        return {
          content: [{ type: 'text', text }],
          details: {
            summary,
            toolCalls,
            turns,
            truncated,
            timedOut,
            isError,
            error: errorMsg ?? undefined,
          },
        };
      } finally {
        busy = false;
      }
    },
  };
}
