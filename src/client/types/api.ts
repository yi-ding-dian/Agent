// ─── 前后端共享类型：定义在 src/shared/types.ts（单一事实源） ───
//
// 2026-10 架构改造：以下类型原在前后端各有一份（本文件 + 后端各配置文件），
// 两个包相互独立、TS 跨包不做检查，漂移无法在编译期暴露 —— McpServerConfig 即已实际漂移
// （后端有 cwd 字段、前端缺失）。现统一由 src/shared/types.ts 提供。
//
// 先 import 到本地作用域（下方 ConfigData 用到了其中两个），再原样透传出去，
// 使 client 侧既有 import 路径（'../../types/api'）全部保持可用。
import type {
  ToolPermissionValue,
  AdvancedConfig,
  CompactionConfig,
  SubagentConfig,
  MemoryConfig,
  SearchConfig,
  McpServerConfig,
  McpServersConfig,
  ExtensionInfo,
  ExtensionCommandInfo,
  ExtensionSource,
  ExternalServiceEntry,
  ExternalServiceConfig,
  RateLimitConfig,
  ThinkingMode,
  ThinkingLevelItem,
  ThinkingCapability,
} from '../../shared/types.js';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  mode?: 'chat' | 'agent';
  systemPrompt?: string;
}

// ThinkingCapability / RateLimitConfig 的定义同样在 shared（见上方 import 与下方 re-export）。
// 注：shared 版 RateLimitConfig 比原先此处那份多 llm_timeout_ms（后端字段，前端原版缺失）。

// ─── 以下类型的定义已迁移至 src/shared/types.ts，此处仅透传（保持既有引用路径不变）───

export type {
  ToolPermissionValue,
  AdvancedConfig,
  CompactionConfig,
  SubagentConfig,
  MemoryConfig,
  SearchConfig,
  McpServerConfig,
  McpServersConfig,
  ExtensionInfo,
  ExtensionCommandInfo,
  ExtensionSource,
  ExternalServiceEntry,
  ExternalServiceConfig,
  RateLimitConfig,
  ThinkingMode,
  ThinkingLevelItem,
  ThinkingCapability,
};

export interface ConfigData {
  // 通用
  base_url: string;
  api_key: string;
  model: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  thinking_level: string;
  work_dir: string;
  // 思考模式（开关型模型用）
  enable_thinking: boolean;
  thinking_budget: number;
  preserve_thinking: boolean;
  // 模型能力（只读，来自后端）
  thinking_capability?: ThinkingCapability;
  // Chat 模式独立
  chat_base_url: string;
  chat_api_key: string;
  chat_model: string;
  // Agent 模式独立
  agent_base_url: string;
  agent_api_key: string;
  agent_model: string;
  // 限流配置
  tool_rate_limit_per_minute: number;
  agent_max_tool_calls_per_turn: number;
  agent_max_consecutive_errors: number;
  agent_max_turns: number;
  // LLM 超时（毫秒）
  llm_timeout_ms: number;
  // 工具权限（allow/ask/deny，服务端 data/tool-permissions.json）
  tool_permissions?: Record<string, ToolPermissionValue>;
  // 高级配置（服务端 data/advanced-config.json，压缩/子代理/记忆/黑名单/搜索）
  advanced?: AdvancedConfig;
}
