import { EventEmitter } from 'node:events';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model, ImageContent } from '@earendil-works/pi-ai';
import { createAgent } from '../agent/agent-factory.js';
import { adaptAgentEvent } from '../rpc/rpc-event-adapter.js';
import { getTokenUsage, compactMessages, estimateInputTokens } from './token-tracker.js';
import { runToolResultHooks } from './extension-loader.js';
import { config } from '../config.js';

export type AgentRunMode = 'chat' | 'agent';

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 修正 assistant 消息的 usage（可变入参，与 agent.state.messages 中的消息同引用，
 * 修正一次后 SSE message_end/agent_end、getSessionHistory、persistSession、
 * token 压缩判定等所有出口自动一致）：
 *
 * 背景：pi-ai 的 parseChunkUsage 把 usage.input 计为 prompt_tokens - cacheRead - cacheWrite，
 * DeepSeek v4 等 provider 在 prompt 缓存命中时只返回小的增量，导致 usage.input（TokenBar
 * 读取）远小于真实上下文（消息元信息 totalTokens 含 cacheRead 所以正常）—— 出现
 * "2.5K vs 33K" 的不一致。
 *
 * 修正口径：usage.input = max(usage.input, 该轮全部输入文本估算)，其中文本估算
 * （system prompt + 全部消息，4 字符/token）与压缩判定 calculateContextTokens 的
 * 文本侧共用 estimateTokensFromText / fallbackEstimateAll，保证三处口径统一；
 * 发生修正时 totalTokens 重算为 修正后input + output（原 totalTokens 含 cacheRead，
 * 修正后的 input 已包含全部输入，继续累加会重复计数）。
 */
function fixAssistantUsage(message: any, messages: AgentMessage[], systemPrompt: string): void {
  const usage = message?.usage;
  if (!usage || typeof usage.input !== 'number') return;
  const est = estimateInputTokens(systemPrompt, messages);
  if (usage.input >= est) return; // provider 报告值不低于文本估算，保持原样
  const output = typeof usage.output === 'number' ? usage.output : 0;
  usage.input = est;
  usage.totalTokens = est + output;
}

export class AgentSessionService {
  public events = new EventEmitter();
  /** 会话 ID（只读，外部可访问） */
  public readonly sessionId: string;
  /** 运行模式（chat / agent），外部可改 */
  public mode: AgentRunMode;
  /** 实际生效的 system prompt（usage 修正的文本估算需要） */
  private systemPrompt: string;
  private agent: Agent;
  private destroyed = false;

  /** 模型预设级思考模式（undefined = 跟随全局 thinking_level；applyModelOverrides 重建时用于比较） */
  readonly thinkingLevel?: string;

  constructor(
    sessionId: string,
    systemPrompt: string,
    mode: AgentRunMode = 'chat',
    model: Model<any>,
    tools: AgentTool<any>[],
    initialMessages?: { role: string; content: string }[],
    thinkingLevel?: string,
  ) {
    // erasableSyntaxOnly：不直接用构造函数参数属性，显式赋值
    this.sessionId = sessionId;
    this.mode = mode;
    this.systemPrompt = systemPrompt;
    this.thinkingLevel = thinkingLevel;
    console.log(`[AgentSession] Creating session ${sessionId} mode=${mode} thinkingLevel=${thinkingLevel ?? '(跟随全局)'} initialMsgs=${initialMessages?.length ?? 0}`);

    const emitEvent = (event: ClientEvent) => {
      if (!this.destroyed) {
        this.events.emit('sse', event);
      }
    };

    this.agent = createAgent({
      systemPrompt,
      model,
      tools,
      sessionId,
      emitEvent,
      initialMessages,
      thinkingLevel,
    });

    // 注意：pi-agent-core 的 subscribe 会按注册顺序 await listener（含本回调的 await 点），
    // 因此 tool_result 钩子的 await 不会导致事件顺序错乱（后续 turn_end 等事件会等本回调完成）。
    this.agent.subscribe(async (event: any) => {
      try {
        if (this.destroyed) return;

        // 扩展 tool_result 钩子：工具执行结果回传处可 patch（content / isError）。
        // patch 写回事件对象（SSE tool_end 展示）并同步写回 state.messages 中对应
        // toolResult 消息（影响后续 LLM 上下文与持久化）；钩子异常已 try-catch，不中断流程。
        if (event.type === 'tool_execution_end') {
          const patch = await runToolResultHooks(
            { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError },
            this.sessionId,
          );
          if (patch) {
            if (patch.content !== undefined) event.result = patch.content;
            if (patch.isError !== undefined) event.isError = patch.isError;
            try {
              const msg = this.agent.state.messages.find(
                (m: any) => m.role === 'toolResult' && m.toolCallId === event.toolCallId,
              ) as any;
              if (msg) {
                if (patch.content !== undefined) {
                  const content = patch.content as unknown;
                  msg.content = Array.isArray(content)
                    ? content
                    : [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }];
                }
                if (patch.isError !== undefined) msg.isError = patch.isError;
              }
            } catch (err) {
              console.warn(`[AgentSession] tool_result patch 写回 state 失败:`, err);
            }
          }
        }

        // 统一口径修正：message_end 时 agent.state.messages 已 push 该消息（pi-agent-core
        // 先落 state 再广播 listener），event.message 与 state 中的消息同引用。
        // 修正 usage.input 为 max(usage.input, 该轮全部输入文本估算)（DeepSeek 缓存扣减
        // 兜底），修正一次后所有出口（SSE、历史、持久化、TokenBar、压缩判定）口径一致。
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          fixAssistantUsage(event.message, this.agent.state.messages, this.systemPrompt);
          // 兜底：LLM 调用失败时 agent-loop 会把无 usage 的失败消息放进
          // agent.state.messages（event.message 与 state 中的消息同引用）。
          // pi-mono 的 estimate.calculateContextTokens（packages/ai/src/utils/estimate.ts）
          // 对 usage undefined 会抛 TypeError（usage.totalTokens），导致后续请求遍历
          // 消息做 token 估算时整个 agent-loop 崩溃（"Cannot read properties of
          // undefined (reading 'totalTokens')"）。此处为失败消息补 0 值 usage，
          // 从根上消除该崩溃；失败消息 0 token 语义合理（未产出任何 token）。
          // 正常消息（usage 存在且 input 为 number）不做任何改动。
          const usage = event.message.usage;
          if (!usage || typeof usage.input !== 'number') {
            event.message.usage = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 };
          }
        }

        if (event.type !== 'message_update') {
          console.log(`[AgentSession] Event: ${event.type}`);
        }

        const clientEvents = adaptAgentEvent(event);
        if (clientEvents) {
          const events = Array.isArray(clientEvents) ? clientEvents : [clientEvents];
          for (const evt of events) {
            if (!this.destroyed) {
              this.events.emit('sse', evt);
            }
          }
        }
      } catch (err) {
        console.error(`[AgentSession] Error processing event ${event?.type}:`, err);
      }
    });

    // 自动上下文压缩：每轮结束（turn_end）时检查 token 用量，超过阈值自动压缩。
    // turn_end 是轮次间隙（assistant 输出与 toolResult 均已写入 state.messages，
    // 且 agent 循环使用独立快照，替换 state.messages 不会影响进行中的循环），
    // 压缩后状态仅对后续 prompt 生效，避免在流式输出中途压缩。
    this.agent.subscribe(async (event: any) => {
      if (this.destroyed || event.type !== 'turn_end') return;
      try {
        const usage = getTokenUsage(this.agent.state.messages);
        if (!usage.shouldCompact) return;
        const result = await compactMessages(this.agent.state.messages, {
          model: this.agent.state.model,
          sessionId: this.sessionId,
        });
        if (result.compacted) {
          this.events.emit('sse', {
            type: 'auto_compact',
            sessionId: this.sessionId,
            message: '对话已自动压缩（上下文过长，早期消息已生成摘要）',
            percent: usage.percent,
          });
          this.replaceMessages(result.messages);
        }
      } catch (err) {
        console.error(`[AgentSession] auto compact failed for ${this.sessionId}:`, err);
      }
    });

    // 监听 agent_end 和 agent_settled 发送 done 事件
    this.agent.subscribe((event: any) => {
      try {
        if (event.type === 'agent_end') {
          console.log(`[AgentSession] agent_end for ${sessionId}, willRetry=${event.willRetry}`);
          if (!event.willRetry) {
            this.events.emit('done');
          }
        }
        if (event.type === 'agent_settled') {
          console.log(`[AgentSession] agent_settled for ${sessionId}`);
          this.events.emit('done');
        }
      } catch (err) {
        console.error(`[AgentSession] Error in lifecycle handler:`, err);
      }
    });

    console.log(`[AgentSession] Session ${sessionId} created`);
  }

  async processMessage(message: string, images?: ImageContent[]): Promise<void> {
    const imgInfo = images?.length ? ` images=${images.length}` : '';
    console.log(`[AgentSession] processMessage session=${this.sessionId} message="${message.slice(0, 100)}"${imgInfo}`);
    try {
      await this.agent.prompt(message, images);
      console.log(`[AgentSession] processMessage completed for ${this.sessionId}`);
    } catch (error: unknown) {
      console.error(`[AgentSession] processMessage error for ${this.sessionId}:`, error);
      if (!this.destroyed) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.events.emit('sse', { type: 'error', message: errMsg });
        this.events.emit('done');
      }
    }
  }

  /**
   * 队列插入消息（AI 处理中时使用 steer 机制）
   * 消息会在下一次 LLM 调用前被注入
   */
  steer(message: string): void {
    console.log(`[AgentSession] steer session=${this.sessionId} message="${message.slice(0, 50)}"`);
    this.agent.steer({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    } as any);
    // 通知前端消息已入队
    this.events.emit('sse', { type: 'message_queued', message });
  }

  /**
   * 替换会话消息（用于压缩后更新）
   */
  replaceMessages(newMessages: AgentMessage[]): void {
    this.agent.state.messages.length = 0;
    this.agent.state.messages.push(...newMessages);
    console.log(`[AgentSession] replaceMessages session=${this.sessionId} count=${newMessages.length}`);
  }

  setThinkingLevel(level: string): void {
    console.log(`[AgentSession] setThinkingLevel session=${this.sessionId} level=${level}`);
    this.agent.state.thinkingLevel = level as any;
  }

  abort(): void {
    console.log(`[AgentSession] abort session=${this.sessionId}`);
    this.agent.abort();
    this.events.emit('sse', { type: 'aborted' });
    this.events.emit('done');
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** 当前会话主模型（供手动压缩回退链使用） */
  get model(): Model<any> {
    return this.agent.state.model;
  }

  destroy(): void {
    console.log(`[AgentSession] destroy session=${this.sessionId}`);
    this.destroyed = true;
    this.agent.abort();
    this.events.removeAllListeners();
  }
}
