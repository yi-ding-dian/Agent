import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool, AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model, Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { config } from '../config.js';
import { pendingConfirmationManager } from '../confirmation/manager.js';
import { getToolPermissionAction } from '../config/tool-permission-config.js';
import { runToolCallHooks, runBeforeProviderRequestHooks } from '../services/extension-loader.js';
import { AgentRateLimiter } from '../services/rate-limiter.js';
import type { SSEEvent } from '../utils/sse.js';
import { buildThinkingCompat, buildOnPayload } from './model-adapter.js';

interface SimpleMessage {
  role: string;
  content: string;
}

function toAgentMessages(messages: SimpleMessage[]): AgentMessage[] {
  return messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: [{ type: 'text', text: m.content }],
    timestamp: Date.now(),
  })) as AgentMessage[];
}

// 需要用户确认的危险操作模式（与 execute-command.tool.ts 同步）
const CONFIRMATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件或目录' },
  { pattern: /\bmv\b.*\/(etc|var|usr|bin|sbin|boot|dev|proc|sys)\//, reason: '移动系统目录文件' },
  // 排除 /dev/null：2>/dev/null 等 stderr 重定向不应触发"写入设备"确认
  { pattern: />\s*\/dev\/(?!null(\s|$|\/))/i, reason: '写入设备文件' },
  { pattern: /\bchmod\s+777\b/, reason: '设置危险的权限' },
  { pattern: /\bchown\b/, reason: '变更文件所有者' },
  { pattern: /\bgit\s+push\s+--force\b/, reason: '强制推送 git' },
  { pattern: /\bdocker\s+rm\b/, reason: '删除 Docker 容器' },
  { pattern: /\bdocker\s+rmi\b/, reason: '删除 Docker 镜像' },
];

// 只读命令前缀（cat/ls/tree/find 等无副作用命令，读取操作不需要用户确认）
const READONLY_PREFIX = /^(cat|ls|tree|find|head|tail|grep|sed|awk|uname|lscpu|free|df|du|pwd|whoami|date|ps|top|stat|file|wc|which|whereis|hostname|uptime|id|less|more|sort|uniq|tr|cut|diff|gzip -l|tar -t)\b/;
// 写入重定向（排除 stderr 重定向到 /dev/null 和 2>&1）
const WRITE_REDIRECT = /(>>|>)(?![&])\s*(?!\/dev\/null\b)/;
// 只读命令中带执行语义（find -exec / xargs 仍可能执行修改操作，不能放行）
const READONLY_EXEC = /-exec\b|-execdir\b|xargs\b/;

// ─── 工具权限门控（allow / ask / deny）──────────────────────────────

/**
 * 工具权限判定结果：
 * - 'deny'               → 工具被禁用，直接拒绝
 * - 'allow'              → 直接执行（含"始终允许"会话）
 * - 'ask'                → 通用确认流程（非 execute_command 工具）
 * - 'execute_command_ask' → execute_command 保持现状：仅危险命令走确认、只读命令放行
 */
export type ToolGateDecision = 'deny' | 'allow' | 'ask' | 'execute_command_ask';

export function decideToolGate(toolName: string, sessionId: string): ToolGateDecision {
  const action = getToolPermissionAction(toolName);
  if (action === 'deny') return 'deny';
  if (action === 'allow') return 'allow';
  // ask 语义
  if (pendingConfirmationManager.isAutoApproved(sessionId)) return 'allow';
  if (toolName === 'execute_command') return 'execute_command_ask';
  return 'ask';
}

/** 参数摘要（确认弹窗展示用，截断防刷屏） */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  if (!text || text === '{}') return '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * 通用确认流程：emit confirmation_required 事件 → 进入 pendingConfirmationManager 待确认队列 → 等待用户决策
 * 返回 { approved, reason }：approved=false 时 reason 为拒绝/失败原因
 */
export async function awaitToolConfirmation(opts: {
  sessionId: string;
  command: string;
  reason: string;
  emitEvent?: (event: SSEEvent) => void;
  signal?: AbortSignal;
}): Promise<{ approved: boolean; reason: string }> {
  opts.emitEvent?.({
    type: 'confirmation_required',
    sessionId: opts.sessionId,
    command: opts.command,
    reason: opts.reason,
  } as any);

  try {
    const decision = await Promise.race([
      pendingConfirmationManager.create(opts.sessionId, opts.command),
      new Promise<never>((_, reject) => {
        if (opts.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
    if (decision === 'block') {
      return { approved: false, reason: `操作已取消: ${opts.reason}` };
    }
    return { approved: true, reason: '' };
  } catch (err) {
    pendingConfirmationManager.cleanupSession(opts.sessionId);
    const msg = err instanceof Error ? err.message : String(err);
    return { approved: false, reason: `操作确认失败: ${msg}` };
  }
}

export interface AgentFactoryOptions {
  systemPrompt: string;
  model: Model<any>;
  tools: AgentTool<any>[];
  sessionId: string;
  emitEvent?: (event: SSEEvent) => void;
  initialMessages?: SimpleMessage[];
  /** 模型预设级思考模式（undefined = 跟随全局 config.thinkingLevel） */
  thinkingLevel?: string;
}

export function createAgent(options: AgentFactoryOptions): Agent {
  const { systemPrompt, model, tools, sessionId, initialMessages } = options;

  const historyMsgs = initialMessages?.length ? toAgentMessages(initialMessages) : undefined;
  // 模型预设级思考模式优先（options.thinkingLevel），未设则跟随全局 config.thinkingLevel
  // 注意：?? 与 || 不能在同一表达式混合（TS5076），全局兜底先取到变量再 ?? 合并
  const globalThinkingLevel: string = (config as any).thinkingLevel || 'medium';
  const effectiveThinkingLevel = options.thinkingLevel ?? globalThinkingLevel;
  console.log(`[AgentFactory] Creating agent sessionId=${sessionId} model=${model.id} baseUrl=${model.baseUrl} thinkingLevel=${effectiveThinkingLevel} (preset=${options.thinkingLevel ?? 'none'}, global=${(config as any).thinkingLevel ?? 'medium'}) historyMsgs=${historyMsgs?.length ?? 0}`);

  // 合并模型适配层的 thinking compat（如 qwen 的 thinkingFormat）
  const thinkingCompat = buildThinkingCompat(model.id, effectiveThinkingLevel);
  model.compat ??= {};
  Object.assign(model.compat, thinkingCompat);
  const onPayload = buildOnPayload(model.id, effectiveThinkingLevel);

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: effectiveThinkingLevel as ThinkingLevel,
      tools,
      messages: historyMsgs,
    },
    streamFn: async (mdl, ctx, opts) => {
      console.log(`[AgentFactory] streamFn called model=${mdl.id} baseUrl=${mdl.baseUrl} messages=${ctx.messages.length}`);
      console.log(`[AgentFactory] streamFn: creating timeout signal (${config.llmTimeoutMs}ms)`);
      try {
        // 最终防线：发送前归一化 ctx.messages 中 assistant 消息的 usage。
        // 背景：历史会话加载 / 旧版本兜底之前产生的失败消息 usage 可能为
        // undefined，pi-ai 的 simple-options.js 在 streamSimple 内部先调
        // estimateContextTokens → getLastAssistantUsageInfo →
        // calculateContextTokens 读 usage.totalTokens 抛 TypeError（"Cannot
        // read properties of undefined (reading 'totalTokens')"）→ agent-loop
        // 上下文估算崩溃（可读化文案"上下文 token 估算异常"）。此处无论消息
        // 来自新产生、历史加载还是压缩产物，发送前保证 usage 存在（失败消息
        // 0 token 语义合理），从根上消除该崩溃。有 usage 且 input 为 number
        // 的消息完全不动（不重复创建对象）；与 agent-service 的 message_end
        // 兜底（新消息即时修正）互为双保险。
        for (const m of ctx.messages) {
          if (m.role === 'assistant' && (!m.usage || typeof m.usage.input !== 'number')) {
            (m as any).usage = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 };
          }
        }
        const timeoutSignal = AbortSignal.timeout(config.llmTimeoutMs);
        const combinedSignal = opts?.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        const wrappedOnPayload = (payload: unknown) => {
          const result = onPayload(payload);
          const p = (result ?? payload) as Record<string, unknown>;
          console.log(`[AgentFactory] onPayload: enable_thinking=${p.enable_thinking}, thinking_budget=${p.thinking_budget}, preserve_thinking=${p.preserve_thinking}`);
          return result;
        };
        const enhancedOpts = {
          ...opts,
          signal: combinedSignal,
          // 关键修复：pi-ai 的 openai-completions 实现只认 options.apiKey（getClientApiKey 不读 model.apiKey），
          // 而 agent-loop 不会把 Model 上的 apiKey 放进 options（AgentLoopConfig 无 apiKey 字段）。
          // 之前回退链是 opts.apiKey → config.qwenApiKey → 'sk-no-key-required'，导致通过 modelOverrides
          // 传入的云端 key（如 DeepSeek）被丢弃，请求用占位 key 发出 → 401 → 空消息无工具调用。
          // 现在把 mdl.apiKey（含 modelOverrides.apiKey）插入回退链。
          apiKey: opts?.apiKey || (mdl as { apiKey?: string }).apiKey || config.qwenApiKey || 'sk-no-key-required',
          // maxTokens 回退链：opts → mdl.maxTokens（createQwenModel 已按 modelOverrides.maxTokens
          // 模型预设级取值）→ config.defaultMaxTokens（65535 最终兜底）。原实现不读 mdl.maxTokens，
          // 链路在最后一环是断的（预设 maxTokens 不会真正发到 provider）。
          maxTokens: opts?.maxTokens ?? (mdl as { maxTokens?: number }).maxTokens ?? config.defaultMaxTokens,
          onPayload: wrappedOnPayload,
        };
        console.log(
          `[AgentFactory] streamFn: calling streamSimple, signal.aborted=${combinedSignal.aborted}, apiKey=${enhancedOpts.apiKey ? `${enhancedOpts.apiKey.slice(0, 6)}...` : '(none)'}, maxTokens=${enhancedOpts.maxTokens}`,
        );
        // 扩展 before_provider_request 钩子：LLM 请求发出前可修改参数
        // （handler 原地改或返回对象浅合并；异常已在分发处 try-catch，不中断请求）
        const hookedOpts = await runBeforeProviderRequestHooks(enhancedOpts as unknown as Record<string, unknown>, sessionId);
        const stream = streamSimple(mdl, ctx, hookedOpts as typeof enhancedOpts);
        console.log('[AgentFactory] streamFn: streamSimple returned successfully');
        // 包装流：透传事件并记录 error / 工具调用事件（诊断用）
        const wrapped = {
          [Symbol.asyncIterator]() {
            const it = stream[Symbol.asyncIterator]();
            return {
              async next() {
                const r = await it.next();
                if (!r.done && r.value?.type === 'error') {
                  const errorValue = (r.value as any).error;
                  const errorMessage = errorValue?.errorMessage ?? errorValue;
                  if (
                    typeof errorMessage === 'string' &&
                    errorMessage.includes('Cannot read properties')
                  ) {
                    // pi-mono 内部 bug：estimate.calculateContextTokens 对 usage undefined
                    // 抛 TypeError（"Cannot read properties of undefined (reading 'totalTokens')"）。
                    // 失败消息的 usage 已在 agent-service message_end 兜底补 0 值（同引用），
                    // 此处把暴露给上层的错误信息转换为可读文案；只改 errorMessage 字符串字段，
                    // 错误事件类型与结构保持不变（agent-loop 从 error 事件取同一对象引用）。
                    console.error(
                      `[AgentFactory] pi-mono estimate 内部错误（usage undefined → calculateContextTokens TypeError）: ${errorMessage}`,
                    );
                    if (errorValue && typeof errorValue === 'object') {
                      (errorValue as Record<string, unknown>).errorMessage =
                        '模型调用内部错误（上下文 token 估算异常），已自动补 0 usage，请重试';
                    }
                  } else {
                    console.error(
                      `[AgentFactory] LLM stream error: ${JSON.stringify(errorMessage)}`,
                    );
                  }
                } else if (!r.done && r.value?.type === 'toolcall_start') {
                  console.log(
                    `[AgentFactory] LLM toolcall_start: ${JSON.stringify((r.value as any).partial?.content)}`,
                  );
                } else if (!r.done && r.value?.type === 'toolcall_end') {
                  console.log(
                    `[AgentFactory] LLM toolcall_end: ${JSON.stringify((r.value as any).toolCall)}`,
                  );
                }
                return r;
              },
              return() {
                return it.return ? it.return() : Promise.resolve({ done: true } as any);
              },
              throw() {
                return it.throw ? it.throw(new Error()) : Promise.resolve({ done: true } as any);
              },
            };
          },
          result() {
            return stream.result();
          },
        };
        return wrapped as any;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AgentFactory] streamFn: streamSimple failed: ${msg}`);
        throw err;
      }
    },
    convertToLlm: (messages: AgentMessage[]): Message[] => {
      const filtered = messages.filter(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
      );
      console.log(`[AgentFactory] convertToLlm: ${messages.length} -> ${filtered.length} messages`);
      return filtered as Message[];
    },
    sessionId,
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const toolName = toolCall.name;

      // 扩展 tool_call 钩子：拦截优先于权限系统（block 即拒绝，不进确认流程）
      // 钩子异常已在分发处 try-catch，不中断主流程
      const hookResult = await runToolCallHooks(
        { toolName, toolCallId: (toolCall as { toolCallId?: string }).toolCallId, input: args },
        sessionId,
      );
      if (hookResult?.block) {
        console.log(`[AgentFactory] Tool blocked by extension hook: ${toolName}`);
        return { block: true, reason: hookResult.reason || `工具 ${toolName} 已被扩展拦截` };
      }

      const gate = decideToolGate(toolName, sessionId);

      // ① deny → 工具被禁用，直接拒绝（不执行）
      if (gate === 'deny') {
        console.log(`[AgentFactory] Tool denied by permission: ${toolName}`);
        return { block: true, reason: `工具 ${toolName} 已被禁用（权限: deny）` };
      }

      // ③ allow（含"始终允许"会话）→ 直接执行
      //    注意：execute_command 工具层的绝对黑名单（sudo/mkfs/dd，execute-command.tool.ts）
      //    在工具执行时仍会拦截，不因 allow 而绕过
      if (gate === 'allow') return undefined;

      // ② ask（通用工具）→ 走待确认队列（与 execute_command 危险命令一致的用户确认弹窗流程）
      if (gate === 'ask') {
        const command = `${toolName} ${summarizeArgs(args)}`.trim();
        const reason = `工具 ${toolName} 调用需要用户确认`;
        const result = await awaitToolConfirmation({ sessionId, command, reason, emitEvent: options.emitEvent, signal });
        if (!result.approved) {
          return { block: true, reason: result.reason };
        }
        return undefined;
      }

      // execute_command 保持现状：仅危险命令需要确认，只读命令直接放行
      const command: string = (args as any)?.command ?? '';
      if (!command) return undefined;

      for (const { pattern, reason } of CONFIRMATION_PATTERNS) {
        if (pattern.test(command.trim())) {
          // 只读命令（cat/ls/tree/find 等）且无写入重定向/无 exec 语义 → 直接放行
          if (
            READONLY_PREFIX.test(command.trim()) &&
            !READONLY_EXEC.test(command) &&
            !WRITE_REDIRECT.test(command)
          ) {
            console.log(`[AgentFactory] Readonly command, skip confirmation: ${command.slice(0, 100)}`);
            return undefined;
          }
          console.log(`[AgentFactory] Dangerous command: ${command}`);

          const result = await awaitToolConfirmation({ sessionId, command: command.trim(), reason, emitEvent: options.emitEvent, signal });
          if (!result.approved) {
            return { block: true, reason: result.reason };
          }
          return undefined;
        }
      }
      return undefined;
    },
  });

  // ─── 限流执行器接线（设置界面「Agent 限流」4 项配置真正生效）──────────
  // pi-mono Agent 类无 maxTurns 参数 → 用 subscribe 事件计数 + abort 模式
  // （与 subagent.tool.ts 轮数截断同模式）。每次判定实时读取 rate-limit-config
  // （内存值，设置界面修改后即时生效，无需重启）。超限 → agent.abort() + 发
  // rate_limit_abort 事件。abort 是优雅中止：当前轮正常收尾（消息正常
  // message_end），loop 以 aborted 轮收尾后正常发 agent_end，事件流完整结束。
  const rateLimiter = new AgentRateLimiter();
  const rateLimitAborted = (reason: string) => {
    console.warn(`[RateLimit] session=${sessionId} 触发限流中止: ${reason}`);
    options.emitEvent?.({
      type: 'rate_limit_abort',
      sessionId,
      message: `⏹ 已触发限流：${reason}`,
      reason,
    });
    agent.abort();
  };
  agent.subscribe((event: any) => {
    try {
      if (event.type === 'agent_start') {
        // 新一轮 run 开始：重置中止标志（abort 只作用于当前 run，计数按会话级保留）
        rateLimiter.onRunStart();
      } else if (event.type === 'turn_end') {
        const stopReason = (event.message as { stopReason?: string } | undefined)?.stopReason;
        const decision = rateLimiter.onTurnEnd(stopReason);
        if (!decision.allowed && decision.reason) {
          rateLimitAborted(decision.reason);
        }
      } else if (event.type === 'tool_execution_start') {
        const decision = rateLimiter.tryRecordToolExecution();
        if (!decision.allowed && decision.reason) {
          rateLimitAborted(decision.reason);
        }
      }
    } catch (err) {
      // 限流判定异常不得影响 Agent 主流程
      console.error(`[RateLimit] session=${sessionId} handler error:`, err);
    }
  });

  console.log('[AgentFactory] Agent created');
  return agent;
}
