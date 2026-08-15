import type { Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';

export interface ModelOverrides {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 未配置默认模型错误（路由层经 error-handler 转 400 中文提示）。
 * 触发条件：创建会话时 modelOverrides 与用户全局默认模型均未提供 / 不完整。
 */
export class NoDefaultModelError extends Error {
  /** 供 error-handler 直接用作 HTTP 状态码 */
  status = 400;

  constructor() {
    super('未配置默认模型，请在设置→模型设置中选择模型');
    this.name = 'NoDefaultModelError';
  }
}

/**
 * 构建会话模型。本系统不再有"出厂默认模型"：
 * id/baseUrl 必须由调用方显式传入（modelOverrides → 用户全局默认解析后的结果，
 * 或 Electron 主进程经 applyConfig 注入的运行时配置），任一为空即在创建前拦截报错，
 * 绝不悄悄回落到任何写死的默认值。
 */
export function createQwenModel(overrides?: ModelOverrides): Model<'openai-completions'> {
  const id = (overrides?.id ?? '').trim();
  const baseUrl = (overrides?.baseUrl ?? '').trim();
  const apiKey = (overrides?.apiKey ?? '').trim();

  if (!id || !baseUrl) {
    throw new NoDefaultModelError();
  }

  const model: Model<'openai-completions'> = {
    id,
    name: 'Qwen 3.6 (Local)',
    api: 'openai-completions',
    provider: 'lm-studio',
    baseUrl,
    input: ['text', 'image'],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: config.defaultMaxTokens,
    headers: {},
    compat: {
      maxTokensField: 'max_tokens',
    },
  };
  // pi-ai 的 Model 类型没有 apiKey 字段，但运行时需要（agent-factory 的 stream 回退链与
  // openai-completions 实现都读取 model.apiKey），这里以类型收窄方式挂上自定义字段
  (model as { apiKey?: string }).apiKey = apiKey;
  return model;
}
