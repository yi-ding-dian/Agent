import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getAdvancedConfig } from '../config/advanced-config.js';
import { buildDeepSeekModel, completeText, redact } from './token-tracker.js';

/**
 * 跨会话记忆服务（data/memory.md）
 *
 * 文件结构（UTF-8 markdown）：
 *   # Agent 记忆                      ← 标题行（固定，系统维护）
 *                                     ← 空行
 *   <!-- 说明注释 ... -->              ← 注释（固定，系统维护）
 *                                     ← 空行
 *   - [2026-08-11] 用户偏好内容        ← 条目（remember 工具追加；管理面板可手动编辑）
 *   - [2026-08-11] 另一条
 *
 * 设计要点：
 * - 固定文件路径（config.dataDir/memory.md），无用户输入路径，不存在路径穿越问题
 * - 所有函数统一使用同步 fs API：createSession 是同步链路（见 session-manager），
 *   注入时不能引入 async；本地小文件同步 IO 开销可忽略
 * - 注入时剥离模板头部（标题/注释），只把条目段拼进 system prompt，避免 markdown 结构污染
 */

/** 记忆文件名（固定） */
export const MEMORY_FILE_NAME = 'memory.md';

/** 记忆条目上限默认值：防文件无限膨胀，超限时截断最旧条目。
 * 运行时实际取值来自 data/advanced-config.json 的 memory.maxEntries（getAdvancedConfig() 内存读取）。 */
export const MEMORY_MAX_ENTRIES = 500;

/** 单条 note 长度上限默认值（remember 工具参数校验用）。
 * 运行时实际取值来自 data/advanced-config.json 的 memory.maxNoteLength。 */
export const MEMORY_NOTE_MAX_LENGTH = 2000;

/** 整文件覆盖的最大字符数（管理面板保存的防护，防误操作写入超大内容） */
export const MEMORY_MAX_FILE_LENGTH = 500_000;

/** 文件模板：标题 + 说明注释（文件不存在或清空时写入） */
export const MEMORY_FILE_TEMPLATE = `# Agent 记忆

<!-- 此文件由系统自动维护：Agent 通过 remember 工具在此追加跨会话记忆条目；也可在设置 → 记忆管理中查看/修改/清空。请保留首行标题。 -->
`;

function memoryFilePath(): string {
  return path.join(config.dataDir, MEMORY_FILE_NAME);
}

/** 确保记忆文件存在（不存在时创建含标题与说明注释的模板） */
export function ensureMemoryFile(): void {
  const filePath = memoryFilePath();
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath, MEMORY_FILE_TEMPLATE, 'utf-8');
}

/** 读取记忆文件全文；文件不存在时返回空字符串 */
export function getMemory(): string {
  try {
    return fs.readFileSync(memoryFilePath(), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * 解析记忆条目：剥离模板头部（标题行 / HTML 注释 / 头部空行），返回条目行数组。
 * 用户手动编辑时新增的 markdown 段落（如 "## 用户偏好"）会原样保留（属于内容而非系统头部）。
 */
export function parseMemoryEntries(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === '# Agent 记忆') return false;
      if (t.startsWith('<!--') || t.startsWith('-->')) return false;
      return true;
    });
}

export interface AppendMemoryResult {
  /** 是否真正追加（与现有条目完全重复时为 false） */
  appended: boolean;
  /** 追加后条目总数 */
  total: number;
}

/** 追加一条记忆条目（格式 "- [YYYY-MM-DD] 内容"）；完全重复时跳过；超上限时截断最旧条目 */
export function appendMemory(entry: string): AppendMemoryResult {
  ensureMemoryFile();
  const entries = parseMemoryEntries(getMemory());
  const trimmed = entry.trim();
  // 去重：与现有任一条目完全一致（trim 后）则不追加
  if (entries.some((e) => e.trim() === trimmed)) {
    return { appended: false, total: entries.length };
  }
  const next = [...entries, trimmed];
  // 上限截断（advanced-config.memory.maxEntries，默认 500）：保留头部，删除最旧条目
  const maxEntries = getAdvancedConfig().memory.maxEntries;
  while (next.length > maxEntries) next.shift();
  const content = MEMORY_FILE_TEMPLATE + '\n' + next.join('\n') + '\n';
  fs.writeFileSync(memoryFilePath(), content, 'utf-8');
  // 自动蒸馏：条目数 ≥ maxEntries×0.8 且距上次蒸馏 >10 分钟时触发（异步不阻塞写入，失败仅日志）
  if (shouldAutoDistill(next.length)) {
    scheduleAutoDistill();
  }
  return { appended: true, total: next.length };
}

/** 清空记忆：重置为模板头（含标题与说明注释，保持文件结构完整） */
export function clearMemory(): void {
  ensureMemoryFile();
  fs.writeFileSync(memoryFilePath(), MEMORY_FILE_TEMPLATE, 'utf-8');
}

/**
 * 整文件覆盖保存。
 * 空内容视为清空（重置为模板头）；非空内容原样写入（管理面板整体编辑场景）。
 */
export function setMemory(content: string): void {
  if (content.trim() === '') {
    clearMemory();
    return;
  }
  if (content.length > MEMORY_MAX_FILE_LENGTH) {
    throw new Error(`记忆内容超过长度上限（${MEMORY_MAX_FILE_LENGTH} 字符）`);
  }
  ensureMemoryFile();
  fs.writeFileSync(memoryFilePath(), content, 'utf-8');
}

/**
 * 构建注入到 system prompt 的记忆段落；记忆为空时返回空字符串。
 * 只注入条目部分（剥离标题/注释），并附带遵循说明，引导模型在需要时调用 remember 工具。
 */
export function buildMemoryPromptSection(): string {
  const entries = parseMemoryEntries(getMemory());
  if (entries.length === 0) return '';
  return (
    '\n\n## 跨会话记忆（模型应遵循）\n' +
    entries.join('\n') +
    '\n\n这些是用户在历史对话中要求记住的偏好，务必遵循；需要新增记忆时调用 remember 工具。'
  );
}

// ═══ 记忆蒸馏（distill） ═════════════════════════════════════════════════

/** LLM 调用函数签名：接收 system prompt 与 user 文本，返回生成文本或 null（失败/不可用） */
export type DistillLlmCall = (systemPrompt: string, userText: string) => Promise<string | null>;

/** 自动蒸馏冷却期：一次蒸馏后 10 分钟内不再自动触发 */
export const AUTO_DISTILL_COOLDOWN_MS = 10 * 60 * 1000;
/** 自动蒸馏触发阈值：记忆条目数 ≥ maxEntries × 0.8 时触发 */
export const AUTO_DISTILL_THRESHOLD_RATIO = 0.8;
/** 蒸馏结果条数下限：M = max(10, 原条目数/3)（取整） */
export const DISTILL_MIN_RESULT = 10;
/** 蒸馏时单条记忆输入长度上限（截断保头尾，防超长 prompt） */
const DISTILL_MAX_ENTRY_CHARS = 400;

/** 蒸馏 system prompt（要求中文、格式严格、日期取最近） */
const DISTILL_SYSTEM_PROMPT = `你是一名记忆整理专家。请把下面提供的跨会话记忆条目提炼合并为更精炼的条目：
- 只保留关键事实、用户偏好、重要决策与长期有效的约定；同主题条目合并为一条
- 输出条数必须 ≤ 指定的目标条数
- 使用中文
- 输出格式严格为每行一条：- [YYYY-MM-DD] 内容（日期为合并条目中最近的日期，格式如 2026-08-11）
- 不要输出任何额外说明、代码块标记或空行`;

/**
 * 蒸馏真实 LLM 实现：复用辅助模型链中的 DeepSeek（process.env.DEEPSEEK_API_KEY → deepseek-chat）；
 * 无 key 或调用失败返回 null（自动蒸馏则本次跳过，手动触发返回错误信息，均不破坏原记忆）。
 */
export function buildDistillLlmCall(): DistillLlmCall {
  return async (systemPrompt: string, userText: string) => {
    const model = buildDeepSeekModel();
    if (!model) return null;
    return completeText(model, systemPrompt, userText);
  };
}

// 蒸馏状态（进程内）：
let lastDistillAt = 0;
/** 测试注入用的 llmCall（非空时优先于真实实现） */
let distillLlmCallImpl: DistillLlmCall | null = null;
/** 自动蒸馏延迟（测试可调为 0） */
let autoDistillDelayMs = 1_000;
let autoDistillTimer: NodeJS.Timeout | null = null;

/** 获取上次蒸馏时间（毫秒时间戳；0=从未蒸馏） */
export function getLastDistillAt(): number {
  return lastDistillAt;
}

/** 手动置位上次蒸馏时间（测试用；蒸馏成功内部也会自动更新） */
export function setLastDistillAt(t: number): void {
  lastDistillAt = t;
}

/** 注入自定义 llmCall（单元测试用；null 恢复真实实现） */
export function setDistillLlmCallImpl(fn: DistillLlmCall | null): void {
  distillLlmCallImpl = fn;
}

/** 调整自动蒸馏延迟（测试用，默认 1000ms） */
export function setAutoDistillDelayMs(ms: number): void {
  autoDistillDelayMs = ms;
}

/** 重置蒸馏相关状态（测试用：清定时器/冷却/注入） */
export function resetDistillState(): void {
  if (autoDistillTimer) {
    clearTimeout(autoDistillTimer);
    autoDistillTimer = null;
  }
  lastDistillAt = 0;
  distillLlmCallImpl = null;
  autoDistillDelayMs = 1_000;
}

/**
 * 自动蒸馏触发条件：条目数 ≥ maxEntries×0.8（advanced-config.memory.maxEntries）且距上次蒸馏 > 10 分钟。
 */
export function shouldAutoDistill(entryCount: number): boolean {
  const maxEntries = getAdvancedConfig().memory.maxEntries;
  const threshold = Math.ceil(maxEntries * AUTO_DISTILL_THRESHOLD_RATIO);
  return entryCount >= threshold && Date.now() - lastDistillAt > AUTO_DISTILL_COOLDOWN_MS;
}

export interface DistillOptions {
  /** 目标条数上限 M；默认 max(10, ceil(原条目数/3)) */
  maxResult?: number;
}

export interface DistillResult {
  success: boolean;
  /** 蒸馏前原条目数 */
  distilled: number;
  /** 蒸馏后条目数 */
  result: number;
  /** 蒸馏后的新条目全文（成功时） */
  summary?: string;
  /** 失败原因（LLM 不可用等） */
  error?: string;
}

/** 从 LLM 输出中提取合法条目行（格式 "- [YYYY-MM-DD] 内容"，剥离代码块标记） */
function parseDistillOutput(raw: string, max: number): string[] {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('```') && l.startsWith('- ['));
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= max) break;
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
    if (!m) continue;
    const date = m[1];
    // 日期合法性校验（防 LLM 输出 2026-13-99 之类）
    if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) continue;
    const content = m[2].trim();
    if (!content) continue;
    // 注入防护：单条内容内的换行已由逐行解析消除；行首 # 转义
    out.push(`- [${date}] ${content.startsWith('#') ? '\\' + content : content}`);
  }
  return out;
}

/**
 * 记忆蒸馏：把全部记忆条目交给 LLM 提炼合并为 ≤M 条精炼条目（M = max(10, 原条数/3) 取整），
 * 保留关键事实/偏好/决策，同主题合并，输出格式仍为 "- [YYYY-MM-DD] 内容"（日期取合并条目的最近日期）。
 *
 * - 输入与输出均经脱敏（复用 token-tracker 的 redact）
 * - 蒸馏失败（LLM 不可用/调用出错）→ 返回 { success: false, error }，不修改原记忆
 * - 成功 → 替换原条目（保留模板头），返回 { success, distilled, result, summary }，并刷新蒸馏冷却计时
 */
export async function distillMemory(
  llmCall: DistillLlmCall,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const entries = parseMemoryEntries(getMemory());
  if (entries.length === 0) {
    lastDistillAt = Date.now();
    return { success: true, distilled: 0, result: 0, summary: '' };
  }

  const maxResult = opts.maxResult ?? Math.max(DISTILL_MIN_RESULT, Math.ceil(entries.length / 3));
  const inputText = entries
    .map((e) => e.slice(0, DISTILL_MAX_ENTRY_CHARS))
    .join('\n');

  const userPrompt =
    `以下是 ${entries.length} 条记忆条目（敏感信息已脱敏）：\n\n${redact(inputText)}\n\n` +
    `请把它们提炼合并为不超过 ${maxResult} 条精炼条目，按格式 - [YYYY-MM-DD] 内容输出。`;

  let raw: string | null = null;
  try {
    raw = await llmCall(DISTILL_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    console.error('[Memory] 记忆蒸馏 LLM 调用异常:', err instanceof Error ? err.message : err);
    raw = null;
  }
  if (!raw) {
    return {
      success: false,
      distilled: entries.length,
      result: 0,
      error: '记忆蒸馏失败：LLM 不可用或调用出错（可检查 DEEPSEEK_API_KEY 后重试）',
    };
  }

  const distilled = parseDistillOutput(redact(raw), maxResult);
  if (distilled.length === 0) {
    return {
      success: false,
      distilled: entries.length,
      result: 0,
      error: '记忆蒸馏失败：LLM 输出格式不正确（未能解析出有效条目）',
    };
  }

  // 替换原条目（保留模板头），蒸馏结果中的敏感信息已脱敏
  const content = MEMORY_FILE_TEMPLATE + '\n' + distilled.join('\n') + '\n';
  fs.writeFileSync(memoryFilePath(), content, 'utf-8');
  lastDistillAt = Date.now();
  console.log(`[Memory] 蒸馏完成: ${entries.length} 条 → ${distilled.length} 条`);

  return {
    success: true,
    distilled: entries.length,
    result: distilled.length,
    summary: distilled.join('\n'),
  };
}

/** 当前生效的 llmCall（测试注入优先） */
function getDistillLlmCall(): DistillLlmCall {
  return distillLlmCallImpl ?? buildDistillLlmCall();
}

/** 延迟执行自动蒸馏（fire-and-forget，失败仅日志，绝不影响写入路径） */
function scheduleAutoDistill(): void {
  if (autoDistillTimer) return;
  autoDistillTimer = setTimeout(() => {
    autoDistillTimer = null;
    void runAutoDistill();
  }, autoDistillDelayMs);
}

async function runAutoDistill(): Promise<void> {
  try {
    const result = await distillMemory(getDistillLlmCall());
    if (result.success) {
      console.log(`[Memory] 自动蒸馏成功: ${result.distilled} 条 → ${result.result} 条`);
    } else {
      console.warn(`[Memory] 自动蒸馏跳过: ${result.error}`);
    }
  } catch (err) {
    console.warn('[Memory] 自动蒸馏异常:', err instanceof Error ? err.message : err);
  }
}
