/**
 * 模型 Thinking 能力适配层
 *
 * 每个模型的思考模式不同：
 * - 多级模型（GPT-5, Claude 4+, Gemini 3+）：reasoning_effort 多级调节
 * - 开关模型（Qwen3）：enable_thinking 布尔开关 + thinking_budget
 * - 不支持（老模型）：无思考模式
 *
 * 加新模型只需在这里登记，前端自动适配 UI。
 */

import { config } from '../config.js';

// ── 类型 ──

export type ThinkingMode = 'levels' | 'switch' | 'none';

export interface ThinkingLevelItem {
  value: string;
  label: string;
}

export interface ThinkingCapability {
  mode: ThinkingMode;
  label: string;
  levels?: ThinkingLevelItem[];
  switchConfig?: {
    supportsBudget: boolean;
    supportsPreserve: boolean;
    budgetMax: number;
    budgetDefault: number;
  };
  /** pi-mono compat.thinkingFormat */
  thinkingFormat?: string;
}

export interface RuntimeThinkingConfig {
  thinkingLevel: string;
  enableThinking: boolean;
  thinkingBudget: number;
  preserveThinking: boolean;
}

// ── 模型登记表（按 ID 前缀匹配）──

// 注意：levels 数组不再包含 off 档 —— "关闭"统一由「开启思考」开关（enable_thinking）控制，
// 滑杆只负责强度等级。旧数据 thinking_level='off' 由兼容逻辑归一化/关闭处理。
const LEVELS_FULL: ThinkingLevelItem[] = [
  { value: 'minimal', label: '极少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中等' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

const CAPABILITIES: Array<{ match: RegExp; capability: ThinkingCapability }> = [
  // Qwen3 系列 — 布尔开关模式
  {
    match: /qwen[\s.]*3/i,
    capability: {
      mode: 'switch',
      label: '思考模式',
      thinkingFormat: 'qwen',
      switchConfig: {
        supportsBudget: true,
        supportsPreserve: true,
        budgetMax: 8192,
        budgetDefault: 1024,
      },
    },
  },
  // DeepSeek V4 — 官方三级（low / high / max）。off 已移出档位，关闭由「开启思考」开关控制
  {
    match: /deepseek/i,
    capability: {
      mode: 'levels',
      label: '推理深度',
      levels: [
        { value: 'low', label: '低' },
        { value: 'high', label: '高' },
        { value: 'max', label: '最高' },
      ],
    },
  },
  // Grok 4+ — 多级（off 由「开启思考」开关控制）
  {
    match: /grok/i,
    capability: {
      mode: 'levels',
      label: '推理深度',
      levels: [
        { value: 'low', label: '低' },
        { value: 'medium', label: '中等' },
        { value: 'high', label: '高' },
      ],
    },
  },
  // OpenAI GPT-5 / o-series — 多级
  {
    match: /gpt-5|^o[34]/i,
    capability: {
      mode: 'levels',
      label: '推理深度',
      levels: LEVELS_FULL,
    },
  },
  // Claude — 多级
  {
    match: /claude/i,
    capability: {
      mode: 'levels',
      label: '思考强度',
      levels: LEVELS_FULL,
    },
  },
  // Gemini 3+ — 多级（off 由「开启思考」开关控制）
  {
    match: /gemini/i,
    capability: {
      mode: 'levels',
      label: '思考级别',
      levels: [
        { value: 'minimal', label: '极少' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中等' },
        { value: 'high', label: '高' },
      ],
    },
  },
];

const NONE_CAPABILITY: ThinkingCapability = {
  mode: 'none',
  label: '',
};

// ── API ──

/** 根据模型 ID 匹配能力 */
export function matchCapability(modelId: string): ThinkingCapability {
  for (const { match, capability } of CAPABILITIES) {
    if (match.test(modelId)) return capability;
  }
  return NONE_CAPABILITY;
}

/**
 * 获取当前运行时配置。
 * @param thinkingLevelOverride 模型预设级思考模式（undefined = 跟随全局 config.thinkingLevel）
 */
export function getRuntimeThinkingConfig(thinkingLevelOverride?: string): RuntimeThinkingConfig {
  return {
    // 模型预设级优先，未设则跟随全局；全局缺省为 'high'（默认思考强度：高）
    thinkingLevel: thinkingLevelOverride || (config as any).thinkingLevel || 'high',
    enableThinking: (config as any).enableThinking ?? true,
    thinkingBudget: (config as any).thinkingBudget || 1024,
    preserveThinking: (config as any).preserveThinking ?? false,
  };
}

/** 构建模型的 compat 配置（thinkingLevel 参数保留：模型预设级思考模式传入，供各能力组装使用） */
export function buildThinkingCompat(modelId: string, _thinkingLevel?: string): Record<string, unknown> {
  const cap = matchCapability(modelId);
  const compat: Record<string, unknown> = {};
  if (cap.thinkingFormat) {
    compat.thinkingFormat = cap.thinkingFormat;
  }
  return compat;
}

/**
 * 构建 onPayload 回调，注入模型特定思考参数。
 * @param thinkingLevel 模型预设级思考模式（undefined = 跟随全局）
 */
export function buildOnPayload(modelId: string, thinkingLevel?: string): (payload: unknown) => unknown {
  const cap = matchCapability(modelId);

  return (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (!p) return payload;

    if (cap.mode === 'switch') {
      // 每次请求时动态读取最新配置，确保关闭思考后立即生效
      const cfg = getRuntimeThinkingConfig(thinkingLevel);
      // 模型预设级 thinkingLevel='off' 时强制关闭思考（与全局滑杆 off 语义一致）
      const enabled = cfg.thinkingLevel !== 'off' && cfg.enableThinking;
      p.enable_thinking = enabled;
      if (enabled && cfg.thinkingBudget > 0 && cap.switchConfig?.supportsBudget) {
        p.thinking_budget = cfg.thinkingBudget;
      }
      if (cfg.preserveThinking && cap.switchConfig?.supportsPreserve) {
        p.preserve_thinking = true;
      }
    }
    if (cap.mode === 'levels' && /deepseek/i.test(modelId)) {
      // DeepSeek V4 思考参数规范（官方）：
      //   thinking.type: 'enabled' | 'disabled'（开关，放请求体）
      //   reasoning_effort: 'low' | 'high' | 'max'（开启思考时的思考深度）
      // 映射自 thinkingLevel：minimal/low→low；medium→high（日常）；high/xhigh→high；max→max
      // 关闭由 enableThinking 开关统一控制；`level !== 'off'` 仅为兼容旧配置 thinking_level='off' 的残留值
      const cfg = getRuntimeThinkingConfig(thinkingLevel);
      const level = cfg.thinkingLevel;
      const enabled = level !== 'off' && cfg.enableThinking;
      p.thinking = { type: enabled ? 'enabled' : 'disabled' };
      if (enabled) {
        const effortMap: Record<string, string> = {
          minimal: 'low',
          low: 'low',
          medium: 'high',
          high: 'high',
          xhigh: 'max',
          max: 'max',
        };
        p.reasoning_effort = effortMap[level] || 'high';
      } else {
        delete p.reasoning_effort;
      }
      return payload;
    }
    // 其他 levels 模式：pi-mono 已通过 reasoning_effort 处理，无需额外注入
    return payload;
  };
}
