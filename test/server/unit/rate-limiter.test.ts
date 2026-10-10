/**
 * 限流执行器（AgentRateLimiter）单元测试
 * 覆盖 4 项判定：每分钟滑动窗口 / 单轮工具调用 / 连续错误 / 总轮数
 * 全部注入固定 limits（不读 rate-limit-config 文件，测试隔离），
 * 时间用显式 now 参数模拟窗口滑动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRateLimiter, type RateLimitLimits } from '../../../src/server/agent/rate-limiter.js';

function makeLimits(partial: Partial<RateLimitLimits> = {}): RateLimitLimits {
  return {
    toolRateLimitPerMinute: 20,
    maxToolCallsPerTurn: 10,
    maxConsecutiveErrors: 5,
    maxTurns: 20,
    ...partial,
  };
}

// ─── 每分钟工具调用（滑动窗口 60s）────────────────────────

test('每分钟滑动窗口：窗口内超限拒绝，窗口滑出后恢复', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ toolRateLimitPerMinute: 2 }));
  const t0 = 1_000_000;

  // 窗口内 2 次放行
  assert.equal(limiter.tryRecordToolExecution(t0).allowed, true);
  assert.equal(limiter.tryRecordToolExecution(t0 + 10_000).allowed, true);
  // 第 3 次（仍在 60s 窗口内）拒绝
  const third = limiter.tryRecordToolExecution(t0 + 20_000);
  assert.equal(third.allowed, false);
  assert.match(third.reason ?? '', /每分钟2次/);

  // 61 秒后最早的记录滑出窗口 → 恢复放行
  assert.equal(limiter.tryRecordToolExecution(t0 + 61_000).allowed, true);
});

test('每分钟窗口按时间滑出：窗口内次数随时间回落', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ toolRateLimitPerMinute: 3 }));
  const t0 = 5_000_000;
  limiter.tryRecordToolExecution(t0);
  limiter.tryRecordToolExecution(t0 + 10_000);
  limiter.tryRecordToolExecution(t0 + 20_000);
  // 满 3 次，第 4 次拒绝
  assert.equal(limiter.tryRecordToolExecution(t0 + 30_000).allowed, false);
  // 第 1 条滑出（>60s）后剩 2 条 → 恢复放行
  assert.equal(limiter.tryRecordToolExecution(t0 + 61_000).allowed, true);
});

// ─── 单轮工具调用计数 ────────────────────────────────────

test('单轮工具调用：轮内超限拒绝，turn_end 后重置', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ maxToolCallsPerTurn: 2 }));
  const t0 = 2_000_000;

  assert.equal(limiter.tryRecordToolExecution(t0).allowed, true);
  assert.equal(limiter.tryRecordToolExecution(t0 + 100).allowed, true);
  // 第 3 次（同一轮）拒绝，即使分钟窗口未满
  const third = limiter.tryRecordToolExecution(t0 + 200);
  assert.equal(third.allowed, false);
  assert.match(third.reason ?? '', /单轮工具调用超限\(2次\)/);

  // turn_end 结束本轮 → 单轮计数清零 → 新轮第 1 次放行
  assert.equal(limiter.onTurnEnd('stop').allowed, true);
  assert.equal(limiter.tryRecordToolExecution(t0 + 1000).allowed, true);
});

// ─── 连续错误 ────────────────────────────────────────────

test('连续错误：达到上限时中止，成功轮清零后重新计数', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ maxConsecutiveErrors: 3 }));

  // 3 次连续 error 轮，第 3 次触发中止
  assert.equal(limiter.onTurnEnd('error').allowed, true);
  assert.equal(limiter.onTurnEnd('error').allowed, true);
  const third = limiter.onTurnEnd('error');
  assert.equal(third.allowed, false);
  assert.match(third.reason ?? '', /连续错误过多\(3次\)/);
  assert.equal(limiter.isAborted(), true);

  // 中止后幂等：不再产生新决策（放行 no-op，事件只发一次）
  const after = limiter.onTurnEnd('error');
  assert.equal(after.allowed, true);

  // 新实例：中间插一个成功轮 → 计数清零，再来 2 次 error 不触发
  const limiter2 = new AgentRateLimiter(() => makeLimits({ maxConsecutiveErrors: 3 }));
  assert.equal(limiter2.onTurnEnd('error').allowed, true);
  assert.equal(limiter2.onTurnEnd('stop').allowed, true);
  assert.equal(limiter2.onTurnEnd('error').allowed, true);
  assert.equal(limiter2.onTurnEnd('error').allowed, true);
});

// ─── 总轮数 ──────────────────────────────────────────────

test('总轮数：达到上限时中止，aborted 收尾轮不计入', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ maxTurns: 2 }));

  assert.equal(limiter.onTurnEnd('stop').allowed, true); // 第 1 轮
  const second = limiter.onTurnEnd('stop'); // 第 2 轮达上限
  assert.equal(second.allowed, false);
  assert.match(second.reason ?? '', /已达到最大轮数限制\(2轮\)/);

  // 限流 abort 后 loop 发的 aborted 收尾轮不再影响计数（幂等 no-op）
  assert.equal(limiter.onTurnEnd('aborted').allowed, true);
});

test('新 run 开始（agent_start）：重置中止标志，计数按会话级保留', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ maxTurns: 2, toolRateLimitPerMinute: 2 }));
  const t0 = 3_000_000;

  // 第 1 轮 + 第 2 轮（达轮数上限）→ abort
  assert.equal(limiter.onTurnEnd('stop').allowed, true);
  const second = limiter.onTurnEnd('stop');
  assert.equal(second.allowed, false);
  assert.equal(limiter.isAborted(), true);

  // 收尾轮 no-op
  assert.equal(limiter.onTurnEnd('aborted').allowed, true);

  // 新 run 开始：标志重置，但轮数计数保留（下一轮立刻再达上限）
  limiter.onRunStart();
  assert.equal(limiter.isAborted(), false);
  const next = limiter.onTurnEnd('stop');
  assert.equal(next.allowed, false);
  assert.match(next.reason ?? '', /最大轮数限制/);

  // 分钟窗口计数同样跨 run 保留：新 run 中第 3 次工具调用被拒
  const limiter2 = new AgentRateLimiter(() => makeLimits({ toolRateLimitPerMinute: 2 }));
  assert.equal(limiter2.tryRecordToolExecution(t0).allowed, true);
  assert.equal(limiter2.tryRecordToolExecution(t0 + 100).allowed, true);
  assert.equal(limiter2.tryRecordToolExecution(t0 + 200).allowed, false);
  limiter2.onRunStart(); // 模拟新 run
  assert.equal(limiter2.tryRecordToolExecution(t0 + 300).allowed, false);
  // 窗口滑出后恢复
  assert.equal(limiter2.tryRecordToolExecution(t0 + 61_000).allowed, true);
});

test('aborted 收尾轮不计数：仅 abort 导致的一轮不计，之后正常计数', () => {
  const limiter = new AgentRateLimiter(() => makeLimits({ maxTurns: 3 }));

  // 模拟：用户/超时 abort 的收尾轮
  assert.equal(limiter.onTurnEnd('aborted').allowed, true);
  assert.equal(limiter.onTurnEnd('stop').allowed, true);
  assert.equal(limiter.onTurnEnd('stop').allowed, true);
  // 已达 2 轮，第 3 轮触发上限
  const third = limiter.onTurnEnd('stop');
  assert.equal(third.allowed, false);
  assert.match(third.reason ?? '', /最大轮数限制/);
});
