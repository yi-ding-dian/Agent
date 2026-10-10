/**
 * Agent 限流执行器（工具限流执行器方案 A）
 *
 * 让设置界面「Agent 限流」的 4 项配置真正生效（data/rate-limit-config.json）：
 * - tool_rate_limit_per_minute      每分钟工具调用（滑动窗口 60s）
 * - agent_max_tool_calls_per_turn   单轮最大工具调用
 * - agent_max_consecutive_errors    连续错误上限（连续 turn 的 stopReason==='error'）
 * - agent_max_turns                 最大对话轮数
 *
 * 设计：
 * - 每次判定时实时调用 getRateLimitConfig()（内存值，设置界面 updateRateLimitConfig
 *   修改后立即生效，无需重启；文件仅启动时加载一次）。
 * - 纯类、无副作用，不依赖 Agent 实例，可单测（构造时注入 limits getter）。
 * - 与 pi-mono 的关系：Agent 类无 maxTurns 参数，由 agent-factory 通过
 *   subscribe 监听 turn_end / tool_execution_start，把事件喂给本类判定；
 *   超限时由调用方（agent-factory）agent.abort() + 发 rate_limit_abort 事件。
 *   该模式与 subagent.tool.ts 的轮数截断一致：abort 是优雅中止，当前轮
 *   正常收尾（消息正常 message_end），loop 以 aborted 轮收尾后正常发 agent_end。
 */

import { getRateLimitConfig } from '../config/rate-limit-config.js';

/** 限流判定输入（由调用方从 Agent 事件提取） */
export interface RateLimitDecision {
  /** 是否放行（tryRecordToolExecution）或是否需要中止（onTurnEnd） */
  allowed: boolean;
  /** 超限原因（人类可读中文，含当前上限值，如"工具调用过于频繁(每分钟20次)"） */
  reason?: string;
}

/** 判定所需的上限值（默认从 rate-limit-config 读取，测试可注入固定值） */
export interface RateLimitLimits {
  /** 每分钟最多工具调用次数（滑动窗口 60s） */
  toolRateLimitPerMinute: number;
  /** 每轮（一次 LLM 调用到 turn_end 之间）最多工具调用次数 */
  maxToolCallsPerTurn: number;
  /** 连续错误轮数阈值（stopReason==='error'） */
  maxConsecutiveErrors: number;
  /** 最大对话轮数（turn_end 计数） */
  maxTurns: number;
}

/** 滑动窗口长度（毫秒）：1 分钟 */
const WINDOW_MS = 60_000;

function defaultLimits(): RateLimitLimits {
  const c = getRateLimitConfig();
  return {
    toolRateLimitPerMinute: c.tool_rate_limit_per_minute,
    maxToolCallsPerTurn: c.agent_max_tool_calls_per_turn,
    maxConsecutiveErrors: c.agent_max_consecutive_errors,
    maxTurns: c.agent_max_turns,
  };
}

export class AgentRateLimiter {
  /** 每分钟窗口内的工具执行时间戳（毫秒，按时间序） */
  private toolTimestamps: number[] = [];
  /** 当前轮（本 turn 内）已执行的工具调用数 */
  private toolCallsThisTurn = 0;
  /** 连续 stopReason==='error' 的轮数 */
  private consecutiveErrors = 0;
  /** 已完成的总轮数（stopReason==='aborted' 的收尾轮不计） */
  private totalTurns = 0;
  /** 已触发中止（防重复 abort / 重复发事件） */
  private aborted = false;
  /** 上限值读取函数（默认读 rate-limit-config，测试可注入固定值） */
  private getLimits: () => RateLimitLimits;

  constructor(getLimits: () => RateLimitLimits = defaultLimits) {
    this.getLimits = getLimits;
  }

  /**
   * 工具执行前判定（agent 的 tool_execution_start 事件时调用）：
   * 1) 单轮工具调用计数未达上限
   * 2) 每分钟滑动窗口未满（60s 内调用次数 < 上限）
   *
   * 允许时记录本次调用（时间戳 + 单轮计数）；拒绝时不记录（窗口滑出后自动恢复）。
   * 已被中止的 agent 不再放行（防御：abort 后 loop 不应再发起工具执行）。
   */
  tryRecordToolExecution(now: number = Date.now()): RateLimitDecision {
    // 已中止：不再判定（abort 决策只产生一次，后续一切为收尾轮）
    if (this.aborted) {
      return { allowed: true };
    }
    const limits = this.getLimits();

    // ① 单轮工具调用上限
    if (limits.maxToolCallsPerTurn > 0 && this.toolCallsThisTurn >= limits.maxToolCallsPerTurn) {
      return {
        allowed: false,
        reason: `单轮工具调用超限(${limits.maxToolCallsPerTurn}次)`,
      };
    }

    // ② 每分钟滑动窗口：先修剪过期时间戳，再判断窗口是否已满
    const windowStart = now - WINDOW_MS;
    if (this.toolTimestamps.length > 0 && this.toolTimestamps[0] < windowStart) {
      this.toolTimestamps = this.toolTimestamps.filter((ts) => ts >= windowStart);
    }
    if (limits.toolRateLimitPerMinute > 0 && this.toolTimestamps.length >= limits.toolRateLimitPerMinute) {
      return {
        allowed: false,
        reason: `工具调用过于频繁(每分钟${limits.toolRateLimitPerMinute}次)`,
      };
    }

    // ③ 放行：记录本次调用
    this.toolTimestamps.push(now);
    this.toolCallsThisTurn += 1;
    return { allowed: true };
  }

  /**
   * turn_end 事件时调用：
   * - 单轮工具计数清零（新轮开始）
   * - stopReason==='aborted' 的收尾轮不计数（限流 abort / 用户中止后的收尾轮）
   * - 总轮数 +1，达上限 → 中止
   * - stopReason==='error' 连续计数，达上限 → 中止；否则清零
   *
   * 返回 { allowed: false, reason } 表示应中止（调用方执行 agent.abort()）。
   * 中止决策只产生一次（内部置 aborted 标志，后续调用幂等）。
   */
  onTurnEnd(stopReason: string | undefined): RateLimitDecision {
    // 已中止：不再判定（abort 决策只产生一次，后续收尾轮不再触发事件）
    if (this.aborted) {
      return { allowed: true };
    }
    // 新轮开始：重置单轮工具计数
    this.toolCallsThisTurn = 0;
    // 收尾轮不计（限流中止/用户中止后 loop 发的最后一轮）
    if (stopReason === 'aborted') {
      return { allowed: true };
    }

    const limits = this.getLimits();

    // ① 总轮数
    this.totalTurns += 1;
    if (limits.maxTurns > 0 && this.totalTurns >= limits.maxTurns) {
      this.aborted = true;
      return { allowed: false, reason: `已达到最大轮数限制(${limits.maxTurns}轮)` };
    }

    // ② 连续错误
    if (stopReason === 'error') {
      this.consecutiveErrors += 1;
    } else {
      this.consecutiveErrors = 0;
    }
    if (limits.maxConsecutiveErrors > 0 && this.consecutiveErrors >= limits.maxConsecutiveErrors) {
      this.aborted = true;
      return { allowed: false, reason: `连续错误过多(${limits.maxConsecutiveErrors}次)` };
    }

    return { allowed: true };
  }

  /** 是否已触发过中止（调试/幂等使用） */
  isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Agent 新一轮 run 开始（agent_start 事件）时调用：重置中止标志。
   *
   * 背景：pi-mono 的 abort 只作用于当前一次 run（prompt 调用），abort 后
   * 收尾的 agent_end 事件流结束后，同一个 Agent 可以再次 prompt 开始新 run
   * （会话复用同一 Agent 实例）。若中止标志永久置位，后续所有判定都会变成
   * no-op（幂等分支），限流配置将永久失效。因此每个 run 开始时重置标志，
   * 但计数（总轮数/连续错误/分钟窗口）按会话级累计保留——这正是"最大对话
   * 轮数/连续错误"的配置语义（会话生命周期内生效）。
   */
  onRunStart(): void {
    this.aborted = false;
  }
}
