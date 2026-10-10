/**
 * 高级运行时配置（对话压缩 / 子代理 / 记忆 / 危险命令黑名单 / 网络搜索 / 摘要模型）
 *
 * 数据持久化到 data/advanced-config.json，启动自动创建（完全仿 tool-permission-config 模式）。
 * - GET /api/config 返回 advanced 字段；POST /api/config 接收 advanced 部分更新并落盘（config.routes.ts）
 * - 各模块（token-tracker / subagent / memory / execute-command / search-web）执行时实时读取
 *   getAdvancedConfig()（纯内存副本，无 IO），修改后立即生效
 * - 校验策略：加载（load）时非法值回退默认（容错）；更新（update）时类型/范围非法则拒绝并返回错误信息
 *
 * 注意（Electron 兼容）：agent-engine（Electron 客户端模式）不强制读取本配置——getAdvancedConfig
 * 懒加载，首次访问时文件不存在仅按默认值工作（并顺带创建默认文件），不抛错不阻断；
 * 服务端会话（Web 端）由 config.routes.ts 启动时加载，服务端配置始终生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
// 类型与默认值均取自 src/shared/types.ts（前后端单一事实源）。
// 迁移缘由：这五个接口原先前端 client/types/api.ts 另写一份（且内联展开子类型），
// DEFAULTS 也与前端 SettingsModal 的 DEFAULT_ADVANCED 各存一份、靠注释维持一致。
import {
  DEFAULT_ADVANCED_CONFIG,
  type AdvancedConfig,
  type CompactionConfig,
  type SubagentConfig,
  type MemoryConfig,
  type SearchConfig,
} from '../../shared/types.js';

// re-export：保持既有引用路径（'../setting/advanced-config.js'）不变
export type { AdvancedConfig, CompactionConfig, SubagentConfig, MemoryConfig, SearchConfig };

/** 默认值：单一事实源在 shared，与前端「高级」设置面板共用同一份（不配置时行为不变） */
const DEFAULTS = DEFAULT_ADVANCED_CONFIG;

/** 各数字字段的合法范围（key → [min, max]） */
const BOUNDS: Record<string, [number, number]> = {
  threshold: [0.1, 0.95],
  tailRatio: [0.1, 0.5],
  cooldownMs: [1_000, 600_000],
  minGainRatio: [1.0, 5.0],
  minTurns: [1, 20],
  headMessages: [1, 20],
  maxTurns: [1, 1_000],
  timeoutMs: [1_000, 3_600_000],
  maxConcurrent: [1, 20],
  maxEntries: [50, 5_000],
  maxNoteLength: [100, 10_000],
  maxResults: [1, 20],
};

/** 深度克隆（纯 JSON 数据） */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getFilePath(): string {
  return path.resolve(config.dataDir, 'advanced-config.json');
}

function saveToFile(value: AdvancedConfig): void {
  try {
    const filePath = getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[AdvancedConfig] 保存失败: ${err}`);
  }
}

function isValidNumber(raw: unknown, key: string): raw is number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return false;
  const [min, max] = BOUNDS[key] ?? [-Infinity, Infinity];
  return raw >= min && raw <= max;
}

/** 读取/构造单个嵌套对象（compaction/subagent/memory/search）：字段缺失/非法 → 用默认值 */
function readNested<T extends object>(raw: unknown, defaults: T): T {
  const out: Record<string, number> = { ...(defaults as Record<string, number>) };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, def] of Object.entries(defaults)) {
      const v = (raw as Record<string, unknown>)[key];
      if (isValidNumber(v, key)) out[key] = v;
    }
  }
  return out as T;
}

function sanitize(raw: unknown): AdvancedConfig {
  const src = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const compaction = readNested(src.compaction, DEFAULTS.compaction);
  const subagent = readNested(src.subagent, DEFAULTS.subagent);
  const memory = readNested(src.memory, DEFAULTS.memory);
  const search = readNested(src.search, DEFAULTS.search);

  // 黑名单：只接受字符串数组，逐条 trim 去空，上限 100 条（防超长配置拖慢正则构建）
  let commandBlacklist: string[] = [...DEFAULTS.commandBlacklist];
  if (Array.isArray(src.commandBlacklist)) {
    const cleaned: string[] = [];
    for (const item of src.commandBlacklist) {
      if (typeof item === 'string' && item.trim()) cleaned.push(item.trim());
    }
    if (cleaned.length <= 100) commandBlacklist = cleaned;
  }

  let summaryModel: 'auto' | 'main' = DEFAULTS.summaryModel;
  if (src.summaryModel === 'auto' || src.summaryModel === 'main') summaryModel = src.summaryModel;

  return { compaction, subagent, memory, commandBlacklist, search, summaryModel };
}

let currentConfig: AdvancedConfig | null = null;

/**
 * 从文件加载配置（缺失时创建默认文件）；文件损坏时回退默认值。
 */
export function loadAdvancedConfig(): AdvancedConfig {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      currentConfig = sanitize(parsed);
      console.log(`[AdvancedConfig] 已加载: ${filePath}`);
    } else {
      currentConfig = deepCopy(DEFAULTS);
      saveToFile(currentConfig);
      console.log(`[AdvancedConfig] 使用默认值并创建: ${filePath}`);
    }
  } catch (err) {
    console.error(`[AdvancedConfig] 加载失败，使用默认值: ${err}`);
    currentConfig = deepCopy(DEFAULTS);
  }
  return deepCopy(currentConfig);
}

/**
 * 获取当前完整高级配置（深拷贝，可直接修改返回值而不污染内部状态）。
 * 懒加载：首次访问时若文件不存在，仅按默认值工作（Electron/agent-engine 场景不强制预加载）。
 */
export function getAdvancedConfig(): AdvancedConfig {
  if (!currentConfig) return loadAdvancedConfig();
  return deepCopy(currentConfig);
}

/** 校验某个嵌套对象字段的值（用于 update 的拒绝式校验），返回错误信息或 null */
/** 毫秒类字段：报错时以秒为单位提示（界面输入为秒，避免 1000-600000 毫秒范围让用户困惑） */
const MS_DISPLAY_KEYS = new Set(['timeoutMs', 'cooldownMs']);

function validateNestedField(raw: unknown, key: string, label: string): string | null {
  if (!isValidNumber(raw, key)) {
    const [min, max] = BOUNDS[key] ?? [];
    if (MS_DISPLAY_KEYS.has(key)) {
      return `${label} 必须为 ${Math.round(min / 1000)}-${Math.round(max / 1000)} 秒之间的数字`;
    }
    return `${label} 必须为 ${min}-${max} 之间的数字`;
  }
  return null;
}

/**
 * 部分更新高级配置（校验类型与范围）。
 * - 校验通过：合并到内存并落盘，返回新配置
 * - 校验失败：不落盘，errors 返回全部错误信息（由 POST /api/config 以 400 返回给前端提示）
 */
export function updateAdvancedConfig(partial: Record<string, unknown>): {
  config: AdvancedConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const current = deepCopy(currentConfig ?? DEFAULTS);
  const next = deepCopy(current);

  if (partial.compaction !== undefined) {
    const raw = partial.compaction;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push('compaction 必须是对象');
    } else {
      const c = raw as Record<string, unknown>;
      const labels: Record<string, string> = {
        threshold: '压缩阈值',
        tailRatio: '尾部保留比例',
        cooldownMs: '压缩冷却时间',
        minGainRatio: '防抖增益倍数',
        minTurns: '最少保留轮数',
        headMessages: '头部保留条数',
      };
      for (const key of Object.keys(DEFAULTS.compaction)) {
        if (c[key] === undefined) continue;
        const err = validateNestedField(c[key], key, labels[key]);
        if (err) errors.push(err);
        else (next.compaction as unknown as Record<string, unknown>)[key] = c[key] as number;
      }
    }
  }

  if (partial.subagent !== undefined) {
    const raw = partial.subagent;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push('subagent 必须是对象');
    } else {
      const s = raw as Record<string, unknown>;
      if (s.maxTurns !== undefined) {
        const err = validateNestedField(s.maxTurns, 'maxTurns', '子代理最大轮数');
        if (err) errors.push(err);
        else next.subagent.maxTurns = s.maxTurns as number;
      }
      if (s.timeoutMs !== undefined) {
        const err = validateNestedField(s.timeoutMs, 'timeoutMs', '子代理超时时间');
        if (err) errors.push(err);
        else next.subagent.timeoutMs = s.timeoutMs as number;
      }
      if (s.maxConcurrent !== undefined) {
        const err = validateNestedField(s.maxConcurrent, 'maxConcurrent', '子代理最大并发数');
        if (err) errors.push(err);
        else next.subagent.maxConcurrent = s.maxConcurrent as number;
      }
    }
  }

  if (partial.memory !== undefined) {
    const raw = partial.memory;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push('memory 必须是对象');
    } else {
      const m = raw as Record<string, unknown>;
      if (m.maxEntries !== undefined) {
        const err = validateNestedField(m.maxEntries, 'maxEntries', '记忆最大条目数');
        if (err) errors.push(err);
        else next.memory.maxEntries = m.maxEntries as number;
      }
      if (m.maxNoteLength !== undefined) {
        const err = validateNestedField(m.maxNoteLength, 'maxNoteLength', '单条记忆长度上限');
        if (err) errors.push(err);
        else next.memory.maxNoteLength = m.maxNoteLength as number;
      }
    }
  }

  if (partial.commandBlacklist !== undefined) {
    const raw = partial.commandBlacklist;
    if (!Array.isArray(raw)) {
      errors.push('危险命令黑名单必须是字符串数组');
    } else if (raw.length > 100) {
      errors.push('危险命令黑名单最多 100 条');
    } else {
      const cleaned: string[] = [];
      for (const item of raw) {
        if (typeof item !== 'string') {
          errors.push('危险命令黑名单必须是字符串数组');
          break;
        }
        if (item.trim()) cleaned.push(item.trim());
      }
      if (errors.length === 0) next.commandBlacklist = cleaned;
    }
  }

  if (partial.search !== undefined) {
    const raw = partial.search;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push('search 必须是对象');
    } else {
      const se = raw as Record<string, unknown>;
      if (se.timeoutMs !== undefined) {
        const err = validateNestedField(se.timeoutMs, 'timeoutMs', '搜索超时时间');
        if (err) errors.push(err);
        else next.search.timeoutMs = se.timeoutMs as number;
      }
      if (se.maxResults !== undefined) {
        const err = validateNestedField(se.maxResults, 'maxResults', '搜索结果条数');
        if (err) errors.push(err);
        else next.search.maxResults = se.maxResults as number;
      }
    }
  }

  if (partial.summaryModel !== undefined) {
    if (partial.summaryModel === 'auto' || partial.summaryModel === 'main') {
      next.summaryModel = partial.summaryModel;
    } else {
      errors.push('摘要模型只能是 auto 或 main');
    }
  }

  if (errors.length === 0) {
    currentConfig = next;
    saveToFile(currentConfig);
  }
  return { config: deepCopy(currentConfig ?? current), errors };
}
