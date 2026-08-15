export interface ChatRequest {
  message: string;
  sessionId?: string;
  mode?: 'chat' | 'agent';
  systemPrompt?: string;
}

export interface ThinkingCapability {
  mode: 'levels' | 'switch' | 'none';
  label: string;
  levels?: { value: string; label: string }[];
  switchConfig?: {
    supportsBudget: boolean;
    supportsPreserve: boolean;
    budgetMax: number;
    budgetDefault: number;
  };
}

export interface RateLimitConfig {
  tool_rate_limit_per_minute: number;
  agent_max_tool_calls_per_turn: number;
  agent_max_consecutive_errors: number;
  agent_max_turns: number;
}

/** 工具权限：allow=直接执行 / ask=弹窗确认 / deny=禁用 */
export type ToolPermissionValue = 'allow' | 'ask' | 'deny';

/** 高级配置（后端 data/advanced-config.json，服务端实时生效） */
export interface AdvancedConfig {
  compaction: {
    /** 自动压缩阈值（0.1-0.95，0.8=80%） */
    threshold: number;
    /** 尾部保留比例（0.1-0.5） */
    tailRatio: number;
    /** 压缩冷却时间毫秒 */
    cooldownMs: number;
    /** 防抖增益倍数 */
    minGainRatio: number;
    /** 尾部最少保留轮数 */
    minTurns: number;
    /** 头部保留消息数 */
    headMessages: number;
  };
  subagent: {
    /** 子代理最大轮数 */
    maxTurns: number;
    /** 子代理整体超时毫秒 */
    timeoutMs: number;
  };
  memory: {
    /** 记忆最大条目数 */
    maxEntries: number;
    /** 单条记忆长度上限 */
    maxNoteLength: number;
  };
  /** 危险命令黑名单（一行一个，与内置底线并集） */
  commandBlacklist: string[];
  search: {
    /** 搜索超时毫秒 */
    timeoutMs: number;
    /** 搜索最大结果数 */
    maxResults: number;
  };
  /** 摘要辅助模型：auto=优先 DeepSeek / main=当前主模型 */
  summaryModel: 'auto' | 'main';
}

/** MCP 外部 server 配置（服务端 data/mcp-servers.json） */
export interface McpServerConfig {
  /** 服务名：唯一，仅字母/数字/下划线/连字符（默认内置服务为中文名特例） */
  name: string;
  /** 可执行命令 */
  command: string;
  /** 命令参数数组 */
  args: string[];
  /** 是否启用 */
  enabled: boolean;
  /** 描述 */
  description: string;
}

export interface McpServersConfig {
  servers: McpServerConfig[];
}

/** 扩展元信息（GET /api/extensions，含发现但未启用的扩展） */
export interface ExtensionInfo {
  /** 扩展名（唯一） */
  name: string;
  description: string;
  /** 来源：npm=extensions/node_modules 包；dir=.pi/extensions 目录扩展 */
  source: 'npm' | 'dir';
  enabled: boolean;
  toolCount: number;
  commandCount: number;
}

/** 扩展命令元信息（GET /api/extensions/commands） */
export interface ExtensionCommandInfo {
  name: string;
  description: string;
  /** 所属扩展名 */
  extension: string;
}

/** 外部服务配置（服务端 data/external-service-config.json，保存后即时生效） */
export interface ExternalServiceConfig {
  /** 知识库查询链接（空串 = 未配置），示例 http://host:port/ext-query/<id>?token=xxx */
  kbQueryUrl: string;
}

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
