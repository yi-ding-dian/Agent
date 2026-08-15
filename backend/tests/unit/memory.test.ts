/**
 * memory-service 单元测试
 * - 通过改写 config.dataDir 指向临时目录实现隔离（config 为普通对象，属性可写）
 * - 测完恢复原 dataDir 并清理临时目录
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config.js';
import {
  ensureMemoryFile,
  getMemory,
  appendMemory,
  setMemory,
  clearMemory,
  parseMemoryEntries,
  buildMemoryPromptSection,
  distillMemory,
  shouldAutoDistill,
  setLastDistillAt,
  resetDistillState,
  setAutoDistillDelayMs,
  setDistillLlmCallImpl,
  AUTO_DISTILL_COOLDOWN_MS,
  MEMORY_FILE_TEMPLATE,
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_FILE_LENGTH,
} from '../../src/services/memory-service.js';

let tmpDir: string;
let originalDataDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-memory-test-'));
  originalDataDir = config.dataDir;
  config.dataDir = tmpDir;
  // 重置蒸馏状态（定时器/冷却/注入），并屏蔽自动蒸馏的真实 LLM 调用（失败仅日志，不影响断言）
  resetDistillState();
  setDistillLlmCallImpl(async () => null);
});

afterEach(() => {
  config.dataDir = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('文件不存在时 getMemory 返回空字符串', () => {
  assert.equal(getMemory(), '');
});

test('ensureMemoryFile 创建含模板头的文件', () => {
  ensureMemoryFile();
  assert.equal(getMemory(), MEMORY_FILE_TEMPLATE);
  const filePath = path.join(tmpDir, 'memory.md');
  assert.ok(fs.existsSync(filePath), 'memory.md 应已创建');
});

test('appendMemory 追加条目并写入文件', () => {
  // 注：appendMemory 接收完整条目（"- [日期] 内容" 前缀由 remember 工具组装）
  const r = appendMemory('- [2026-08-11] 用户偏好使用 TypeScript');
  assert.deepEqual(r, { appended: true, total: 1 });
  const content = getMemory();
  assert.ok(content.includes('- [2026-08-11] 用户偏好使用 TypeScript'));
  assert.ok(content.startsWith('# Agent 记忆'), '模板头应保留在文件顶部');
});

test('appendMemory 完全重复条目去重（appended=false，文件不变）', () => {
  appendMemory('重复内容');
  const before = getMemory();
  const r = appendMemory('重复内容');
  assert.equal(r.appended, false);
  assert.equal(r.total, 1);
  assert.equal(getMemory(), before, '重复追加后文件内容不应变化');
});

test('appendMemory 超 500 条上限时截断最旧条目', () => {
  for (let i = 0; i < MEMORY_MAX_ENTRIES + 5; i++) {
    appendMemory(`item-${i}`);
  }
  const content = getMemory();
  // 保留模板头 + 500 条，最旧的 5 条被截断
  const entries = parseMemoryEntries(content);
  assert.equal(entries.length, MEMORY_MAX_ENTRIES);
  assert.ok(!content.includes('item-0'), '最旧条目应被截断');
  assert.ok(content.includes('item-4'), '第 5 条（item-4）仍应存在');
  assert.ok(content.includes(`item-${MEMORY_MAX_ENTRIES + 4}`), '最新条目应保留');
  assert.ok(content.startsWith('# Agent 记忆'), '截断后模板头不应丢失');
});

test('setMemory 整文件覆盖生效', () => {
  appendMemory('旧内容');
  setMemory('# 自定义标题\n\n- [2026-08-11] 手动写入');
  assert.equal(getMemory(), '# 自定义标题\n\n- [2026-08-11] 手动写入');
});

test('setMemory 空内容视为清空（重置为模板头）', () => {
  appendMemory('将被清空');
  setMemory('   ');
  assert.equal(getMemory(), MEMORY_FILE_TEMPLATE);
});

test('setMemory 超过 500000 字符上限时抛错', () => {
  assert.throws(() => setMemory('x'.repeat(MEMORY_MAX_FILE_LENGTH + 1)), /超过长度上限/);
});

test('clearMemory 重置为模板头', () => {
  appendMemory('a');
  clearMemory();
  assert.equal(getMemory(), MEMORY_FILE_TEMPLATE);
});

test('parseMemoryEntries 剥离模板头（标题/注释/空行）', () => {
  const content = `${MEMORY_FILE_TEMPLATE}\n- [2026-08-11] 条目一\n\n## 用户偏好\n- [2026-08-11] 条目二\n`;
  const entries = parseMemoryEntries(content);
  assert.deepEqual(entries, ['- [2026-08-11] 条目一', '## 用户偏好', '- [2026-08-11] 条目二']);
  assert.ok(!entries.some((e) => e.includes('# Agent 记忆') || e.includes('<!--')));
});

test('buildMemoryPromptSection 记忆为空时返回空字符串', () => {
  assert.equal(buildMemoryPromptSection(), '');
});

test('buildMemoryPromptSection 非空时只注入条目段，不含模板头', () => {
  appendMemory('偏好内容A');
  const section = buildMemoryPromptSection();
  assert.ok(section.includes('## 跨会话记忆'));
  assert.ok(section.includes('偏好内容A'));
  assert.ok(!section.includes('# Agent 记忆'), '模板头不应注入 prompt');
  assert.ok(!section.includes('<!--'), '注释不应注入 prompt');
});

// ─── 记忆蒸馏（distillMemory / 自动触发） ───

test('distillMemory 正常合并：替换原条目并保留模板头', async () => {
  appendMemory('- [2026-08-01] 用户偏好 TypeScript');
  appendMemory('- [2026-08-02] 用户偏好使用 pnpm');
  appendMemory('- [2026-08-03] 项目约定：提交信息用中文');
  const mock = async (_sys: string, user: string) => {
    assert.ok(user.includes('3 条记忆条目'), '输入应包含条数说明');
    return '- [2026-08-03] 用户偏好 TypeScript 与 pnpm\n- [2026-08-03] 项目约定：提交信息用中文';
  };
  const r = await distillMemory(mock);
  assert.equal(r.success, true);
  assert.equal(r.distilled, 3, '原条目数');
  assert.equal(r.result, 2, '蒸馏后条数');
  const content = getMemory();
  assert.ok(content.startsWith('# Agent 记忆'), '模板头保留');
  assert.ok(content.includes('- [2026-08-03] 用户偏好 TypeScript 与 pnpm'), '合并条目写入');
  assert.ok(!content.includes('偏好 TypeScript\n') || content.includes('偏好 TypeScript 与 pnpm'), '原条目被合并替换');
  assert.ok(!content.includes('偏好使用 pnpm'), '原条目被替换');
});

test('distillMemory 失败（LLM 返回 null）不破坏原记忆', async () => {
  appendMemory('- [2026-08-01] 重要记忆A');
  const before = getMemory();
  const r = await distillMemory(async () => null);
  assert.equal(r.success, false);
  assert.ok(r.error && r.error.includes('失败'), '返回失败原因');
  assert.equal(getMemory(), before, '文件内容不变');
});

test('distillMemory LLM 输出格式非法时不破坏原记忆', async () => {
  appendMemory('- [2026-08-01] 重要记忆A');
  const before = getMemory();
  const r = await distillMemory(async () => '我不懂格式的输出');
  assert.equal(r.success, false);
  assert.ok(r.error && r.error.includes('格式'), '返回格式错误原因');
  assert.equal(getMemory(), before, '文件内容不变');
});

test('distillMemory 输入输出均脱敏（sk-xxx → [REDACTED]）', async () => {
  appendMemory('- [2026-08-01] 密钥是 sk-abcdef1234567890xyz');
  let capturedUser = '';
  const r = await distillMemory(async (_sys: string, user: string) => {
    capturedUser = user;
    return '- [2026-08-01] 密钥已处理 sk-abcdef1234567890xyz';
  });
  assert.equal(r.success, true);
  assert.ok(!capturedUser.includes('sk-abcdef1234567890xyz'), '输入已脱敏');
  assert.ok(!getMemory().includes('sk-abcdef1234567890xyz'), '输出已脱敏（不写回原密钥）');
});

test('shouldAutoDistill 触发条件：阈值与冷却期', () => {
  // 未达阈值（默认 maxEntries=500 × 0.8 = 400）
  assert.equal(shouldAutoDistill(399), false, '399 条不触发');
  assert.equal(shouldAutoDistill(400), true, '400 条且冷却已过触发');
  // 冷却期内不触发（上次蒸馏 10 分钟内）
  setLastDistillAt(Date.now());
  assert.equal(shouldAutoDistill(400), false, '冷却期内不触发');
  // 冷却期过后再触发
  setLastDistillAt(Date.now() - AUTO_DISTILL_COOLDOWN_MS - 1000);
  assert.equal(shouldAutoDistill(400), true, '冷却过期后触发');
});

test('appendMemory 达到阈值后自动触发蒸馏（mock llmCall）', async () => {
  resetDistillState();
  setAutoDistillDelayMs(0);
  let called = 0;
  setDistillLlmCallImpl(async () => {
    called++;
    return '- [2026-08-11] 自动蒸馏后的记忆';
  });
  // 400 条触发（maxEntries 默认 500 × 0.8）
  for (let i = 0; i < 400; i++) appendMemory(`item-${i}`);
  // 轮询等待异步蒸馏完成
  for (let i = 0; i < 50 && called === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(called >= 1, '自动蒸馏应被触发');
  const content = getMemory();
  assert.ok(content.includes('自动蒸馏后的记忆'), '蒸馏结果写入文件');
  assert.ok(!content.includes('item-0'), '原条目被替换');
});
