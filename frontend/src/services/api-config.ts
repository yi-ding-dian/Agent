const STORAGE_KEY = 'myagent_api_config';

interface ApiConfig {
  host: string; // 例如: "<server-host>"
  port: string; // 例如: "7980"
}

/** 在 Electron 环境中从 preload API 获取服务器地址并写入 localStorage */
export async function initApiConfig(): Promise<void> {
  if (window.myagent?.getServerUrl) {
    try {
      const url = await window.myagent.getServerUrl();
      if (url) {
        const urlObj = new URL(url);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          host: urlObj.hostname,
          port: urlObj.port || '7980',
        }));
      }
    } catch { /* ignore */ }
  }
}

/** 从 localStorage 读取 API 配置，没有则从当前页面 host 推断 */
export function getApiConfig(): ApiConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.host && parsed.port) return parsed;
    }
  } catch { /* ignore */ }

  return {
    host: window.location.hostname,
    port: window.location.port || '7980',
  };
}

/** 保存 API 配置 */
export function setApiConfig(config: ApiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** 获取 API base URL，例如 http://<server-host>:7980 */
export function getApiBaseUrl(): string {
  const cfg = getApiConfig();
  return `http://${cfg.host}:${cfg.port}`;
}

/** 获取完整 API 路径 */
export function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

/** 是否为 Electron 环境（window.myagent 由 preload 注入，浏览器中不存在） */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.myagent;
}

// ───── 客户端自定义 LLM 配置 ─────

const LLM_KEYS = {
  model: 'myagent_llm_model',
  baseUrl: 'myagent_llm_base_url',
  apiKey: 'myagent_llm_api_key',
} as const;

// ───── 模型预设（多 provider 支持） ─────

/** 模型预设：一组可直接切换的 LLM provider 配置 */
export interface ModelPreset {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** API 格式：默认 openai-completions，anthropic 预留 */
  apiFormat?: 'openai-completions' | 'anthropic';
}

const PRESETS_KEY = 'myagent_llm_presets';
const ACTIVE_PRESET_KEY = 'myagent_llm_active_preset';

/**
 * 默认预设：不再有"出厂默认模型"（去掉了写死的本地 Qwen 地址与模型名）——
 * 模型由用户自行添加，localStorage 中已有预设的用户不受影响。
 */
export function getDefaultModelPresets(): ModelPreset[] {
  return [];
}

/**
 * 读取预设列表（localStorage 优先，无则返回空数组 —— 没有配置就是没有，
 * 需在设置→模型设置中添加并选中）。
 */
export function getModelPresets(): ModelPreset[] {
  try {
    const stored = localStorage.getItem(PRESETS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ModelPreset[];
    }
  } catch { /* ignore */ }
  return getDefaultModelPresets();
}

/** 保存预设列表（仅前端 localStorage，不要求后端持久化） */
export function saveModelPresets(presets: ModelPreset[]): void {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

/** 获取当前选中的预设名称（无则返回 null） */
export function getActivePresetName(): string | null {
  return localStorage.getItem(ACTIVE_PRESET_KEY) || null;
}

/** 设置/清除选中的预设名称 */
export function setActivePresetName(name: string | null): void {
  if (name) localStorage.setItem(ACTIVE_PRESET_KEY, name);
  else localStorage.removeItem(ACTIVE_PRESET_KEY);
}

/** 解析当前选中的预设（未选中或名称不匹配时返回 undefined） */
export function getActiveModelPreset(): ModelPreset | undefined {
  const activeName = getActivePresetName();
  if (!activeName) return undefined;
  const normalized = activeName.trim().toLowerCase();
  return getModelPresets().find((p) => p.name.trim().toLowerCase() === normalized);
}

/**
 * 从 localStorage 读取自定义 LLM 覆盖配置。
 * 优先级：选中了模型预设 → 使用该预设的配置；否则使用三个独立手动 key（兼容旧行为）。
 */
export function getLlmOverrides(): { id?: string; baseUrl?: string; apiKey?: string } {
  const preset = getActiveModelPreset();
  if (preset) {
    return {
      id: preset.model?.trim() || undefined,
      baseUrl: preset.baseUrl?.trim() || undefined,
      apiKey: preset.apiKey?.trim() || undefined,
    };
  }
  const id = localStorage.getItem(LLM_KEYS.model) || undefined;
  const baseUrl = localStorage.getItem(LLM_KEYS.baseUrl) || undefined;
  const apiKey = localStorage.getItem(LLM_KEYS.apiKey) || undefined;
  if (!id && !baseUrl && !apiKey) return {};
  return { id, baseUrl, apiKey };
}

/** 保存自定义 LLM 覆盖配置 */
export function saveLlmOverrides(overrides: { id?: string; baseUrl?: string; apiKey?: string }): void {
  if (overrides.id) localStorage.setItem(LLM_KEYS.model, overrides.id);
  else localStorage.removeItem(LLM_KEYS.model);
  if (overrides.baseUrl) localStorage.setItem(LLM_KEYS.baseUrl, overrides.baseUrl);
  else localStorage.removeItem(LLM_KEYS.baseUrl);
  if (overrides.apiKey) localStorage.setItem(LLM_KEYS.apiKey, overrides.apiKey);
  else localStorage.removeItem(LLM_KEYS.apiKey);
}

/** 清除所有自定义 LLM 配置 */
export function clearLlmOverrides(): void {
  Object.values(LLM_KEYS).forEach(k => localStorage.removeItem(k));
}
