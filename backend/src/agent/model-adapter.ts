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

const LEVELS_FULL: ThinkingLevelItem[] = [
  { value: 'off', label: '关闭' },
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
  // DeepSeek V4 — 多级（high + max）
  {
    match: /deepseek/i,
    capability: {
      mode: 'levels',
      label: '推理深度',
      levels: [
        { value: 'off', label: '关闭' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中等' },
        { value: 'high', label: '高' },
        { value: 'max', label: '最高' },
      ],
    },
  },
  // Grok 4+ — 多级
  {
    match: /grok/i,
    capability: {
      mode: 'levels',
      label: '推理深度',
      levels: [
        { value: 'off', label: '关闭' },
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
  // Gemini 3+ — 多级
  {
    match: /gemini/i,
    capability: {
      mode: 'levels',
      label: '思考级别',
      levels: [
        { value: 'off', label: '关闭' },
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

/** 获取当前运行时配置 */
export function getRuntimeThinkingConfig(): RuntimeThinkingConfig {
  return {
    thinkingLevel: (config as any).thinkingLevel || 'medium',
    enableThinking: (config as any).enableThinking ?? true,
    thinkingBudget: (config as any).thinkingBudget || 1024,
    preserveThinking: (config as any).preserveThinking ?? false,
  };
}

/** 构建模型的 compat 配置 */
export function buildThinkingCompat(modelId: string): Record<string, unknown> {
  const cap = matchCapability(modelId);
  const compat: Record<string, unknown> = {};
  if (cap.thinkingFormat) {
    compat.thinkingFormat = cap.thinkingFormat;
  }
  return compat;
}

/** 构建 onPayload 回调，注入模型特定思考参数 */
export function buildOnPayload(modelId: string): (payload: unknown) => unknown {
  const cap = matchCapability(modelId);

  return (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (!p) return payload;

    if (cap.mode === 'switch') {
      // 每次请求时动态读取最新配置，确保关闭思考后立即生效
      const cfg = getRuntimeThinkingConfig();
      p.enable_thinking = cfg.enableThinking;
      if (cfg.enableThinking && cfg.thinkingBudget > 0 && cap.switchConfig?.supportsBudget) {
        p.thinking_budget = cfg.thinkingBudget;
      }
      if (cfg.preserveThinking && cap.switchConfig?.supportsPreserve) {
        p.preserve_thinking = true;
      }
    }
    // levels 模式：pi-mono 已通过 reasoning_effort 处理，无需额外注入
    return payload;
  };
}
