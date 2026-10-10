/**
 * 前后端共享类型与常量（单一事实源）
 *
 * 约定（对齐 svn-git 架构）：
 *  - 本目录**无环境依赖、无副作用**：不 import fs / path / DOM，server 与 client 均从此导入
 *  - 改这里一处、两端同时生效
 *
 * 设立缘由：以下接口此前在前后端各有一份定义，而两个包相互独立、TS 跨包不做检查，
 * 漂移不会被编译期发现 —— 其中 McpServerConfig 已实际漂移（后端有 cwd 字段、前端缺失）：
 *   AdvancedConfig        前端 client/types/api.ts   ↔  后端 server/config/advanced-config.ts
 *   McpServerConfig       前端 client/types/api.ts   ↔  后端 server/config/mcp-servers-config.ts
 *   ExtensionInfo         前端 client/types/api.ts   ↔  后端 server/services/extension-loader.ts
 *   ExternalServiceEntry  前端 client/types/api.ts   ↔  后端 server/config/external-service-config.ts
 * 另有 AdvancedConfig 的默认值也是两份（前端 SettingsModal.tsx 的 DEFAULT_ADVANCED
 * ↔ 后端 advanced-config.ts 的 DEFAULTS），靠注释维持一致，现一并收敛到本文件。
 *
 * 取值以**后端**为准：后端版本更完整（如 McpServerConfig.cwd）、且用具名子类型而非内联展开。
 */

// ─── 工具权限 ────────────────────────────────────────────────

/**
 * 工具执行权限。
 * 注：后端原名 ToolPermission、前端原名 ToolPermissionValue —— 语义完全相同，
 * 此处统一为 ToolPermissionValue，两端各自 re-export 旧名以保持既有引用不改。
 */
export type ToolPermissionValue = 'allow' | 'ask' | 'deny';

// ─── 高级运行时配置（data/advanced-config.json）────────────────

/** 对话压缩：上下文接近上限时自动摘要历史 */
export interface CompactionConfig {
  /** 自动压缩阈值：maxTokens 的百分比比例，范围 0.1-0.95 */
  threshold: number;
  /** 尾部保护区 token 预算：最近窗口的比例，范围 0.1-0.5 */
  tailRatio: number;
  /** 压缩冷却期（毫秒）：一次压缩后该时间内不再自动触发，范围 1000-600000 */
  cooldownMs: number;
  /** 防抖动乘数：本次可压缩内容需 ≥ 上次的该倍数才压缩，范围 1.0-5.0 */
  minGainRatio: number;
  /** 尾部保护区最少轮数，范围 1-20 */
  minTurns: number;
  /** 头部保护区消息数（首次保留 N 条，压缩后衰减为 N-1 条），范围 1-20 */
  headMessages: number;
}

/** 子代理（subagent 工具）运行参数 */
export interface SubagentConfig {
  /** 子代理最大轮数（LLM 调用次数），范围 1-1000 */
  maxTurns: number;
  /** 子代理整体超时（毫秒），范围 1000-600000 */
  timeoutMs: number;
  /**
   * 同一会话同时可运行的子代理数上限，范围 1-20。
   * 主代理在一个 turn 内并行调用多个 subagent 是正常用法（pi-agent-core 默认
   * toolExecution=parallel），本项只用于防止模型失控刷出大量子代理，而非禁止并行。
   */
  maxConcurrent: number;
}

/** 跨会话记忆容量限制 */
export interface MemoryConfig {
  /** 记忆条目上限（超限截断最旧条目），范围 50-5000 */
  maxEntries: number;
  /** 单条记忆 note 长度上限（remember 工具参数校验），范围 100-10000 */
  maxNoteLength: number;
}

/** 网络搜索参数 */
export interface SearchConfig {
  /** 网络搜索超时（毫秒），范围 1000-600000 */
  timeoutMs: number;
  /** 搜索结果最大条数，范围 1-20 */
  maxResults: number;
}

/** 高级运行时配置（data/advanced-config.json，服务端实时生效） */
export interface AdvancedConfig {
  compaction: CompactionConfig;
  subagent: SubagentConfig;
  memory: MemoryConfig;
  /** 危险命令黑名单（一行一个命令，与代码内置最底线黑名单取并集，配置只增不减） */
  commandBlacklist: string[];
  search: SearchConfig;
  /** 摘要辅助模型：auto=优先 DeepSeek（回退主模型）/ main=直接用当前主模型 */
  summaryModel: 'auto' | 'main';
}

/**
 * AdvancedConfig 默认值 —— 前后端共用的唯一一份。
 *
 * 后端：advanced-config.ts 文件缺失/字段非法时的回退值，也是首次创建的文件内容；
 * 前端：SettingsModal「高级」面板的初始表，以及 GET /api/config 未返回 advanced 时的兜底。
 * 双方必须完全一致，否则界面显示的"默认值"与后端实际生效值会不一致（这正是本文件要消除的问题）。
 */
export const DEFAULT_ADVANCED_CONFIG: AdvancedConfig = {
  compaction: {
    threshold: 0.8,
    tailRatio: 0.2,
    cooldownMs: 60_000,
    minGainRatio: 1.1,
    minTurns: 4,
    headMessages: 2,
  },
  // 轮数默认 50（1-1000），超时默认 1800 秒（1-3600）；并发默认 5
  subagent: { maxTurns: 50, timeoutMs: 1_800_000, maxConcurrent: 5 },
  memory: { maxEntries: 500, maxNoteLength: 2000 },
  commandBlacklist: ['sudo', 'mkfs', 'dd', 'rm -rf /', 'chmod 777', 'mkfs.ext4'],
  search: { timeoutMs: 15_000, maxResults: 8 },
  summaryModel: 'auto',
};

// ─── MCP 外部 server（data/mcp-servers.json）──────────────────

/** MCP 外部 server 配置 */
export interface McpServerConfig {
  /** 服务名：唯一，^[a-zA-Z0-9_-]{1,32}$，同时作为工具名前缀组成部分 */
  name: string;
  /** 可执行命令（仅允许常见可执行名，防注入） */
  command: string;
  /** 命令参数数组（每项 ≤200 字符且不含换行） */
  args: string[];
  /** 外部 server 的工作目录（可选）：相对路径基于后端进程 cwd 解析；不填默认项目根 */
  cwd?: string;
  /** 是否启用（停用的 server 不启动子进程、不暴露工具） */
  enabled: boolean;
  /** 描述（中文说明，展示在设置界面） */
  description: string;
}

export interface McpServersConfig {
  servers: McpServerConfig[];
}

// ─── Pi 扩展 ─────────────────────────────────────────────────

/** 扩展来源：npm=extensions/node_modules 包；dir=.pi/extensions 目录扩展 */
export type ExtensionSource = 'npm' | 'dir';

/** 扩展元信息（GET /api/extensions，含发现但未启用的扩展） */
export interface ExtensionInfo {
  /** 扩展名（唯一） */
  name: string;
  description: string;
  source: ExtensionSource;
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

// ─── 外部服务（data/external-service-config.json）─────────────

/** 外部服务条目（可自定义；id='kb'/'filesys' 为内置，MCP 工具以 fixed id 取链接） */
export interface ExternalServiceEntry {
  /** 'kb' / 'filesys'（内置）或 uuid（自定义） */
  id: string;
  /** 显示标题（必填） */
  title: string;
  /** 查询链接（内置条目空串 = 未配置；自定义条目必填） */
  url: string;
  /** 描述（可选） */
  description: string;
}

/** 外部服务配置（保存后即时生效） */
export interface ExternalServiceConfig {
  services: ExternalServiceEntry[];
}

// ─── 限流配置（data/rate-limit-config.json）──────────────────

/**
 * Agent 限流与迭代上限。
 * 注：合并时以后端为准 —— 前端原本的定义只有前 4 项、缺 llm_timeout_ms（且该前端类型
 * 在 client 侧无任何使用点，属死代码）；此处保留完整 5 项，前端消费方按需取用。
 */
export interface RateLimitConfig {
  /** 每分钟最多工具调用次数 */
  tool_rate_limit_per_minute: number;
  /** 每轮最多工具调用次数 */
  agent_max_tool_calls_per_turn: number;
  /** 连续错误阈值 */
  agent_max_consecutive_errors: number;
  /** 最大对话轮数 */
  agent_max_turns: number;
  /** LLM 超时时间（毫秒） */
  llm_timeout_ms: number;
}

// ─── 思考模式能力（后端按模型探测，前端按此渲染开关/滑杆）──────

export type ThinkingMode = 'levels' | 'switch' | 'none';

/** 强度档位（如 DeepSeek 的低/高/最高） */
export interface ThinkingLevelItem {
  value: string;
  label: string;
}

/**
 * 当前模型的思考能力描述（GET /api/config 的 thinking_capability 字段）。
 * 注：合并时以后端为准（多了 pi-mono compat.thinkingFormat）；前端原版把 mode 与 levels
 * 内联展开、且无 thinkingFormat。前端不消费 thinkingFormat，故其为可选字段无影响。
 */
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
  /** pi-mono compat.thinkingFormat（服务端模型适配用，前端不消费） */
  thinkingFormat?: string;
}

// ─── 子代理实时事件 ──────────────────────────────────────────

/**
 * 子代理实时事件（经 SSE 的 tool_update.partialResult.details.subagentEvent 推送）。
 * 字段风格与 ToolCallInfo 对齐：toolName/args/result/isError。
 * 前后端定义原为逐字段一致（仅注释措辞不同），现收敛至此。
 */
export interface SubagentEvent {
  /** 事件类型：子代理调用工具 / 工具结束 / 回复文本增量 / 思考增量 / 子代理整体结束 */
  kind: 'tool_start' | 'tool_end' | 'text_delta' | 'thinking_delta' | 'agent_end';
  /** 事件发生时间（毫秒时间戳，pushEvent 时填 Date.now()，前端格式化 HH:MM:SS.mmm） */
  ts?: number;
  /** 对应外层主代理的工具调用 id（前端按 tool_update.toolCallId 匹配） */
  agentId?: string;
  /** 子代理调用的工具名（tool_start / tool_end） */
  toolName?: string;
  /** 工具参数摘要（tool_start，截断防刷屏） */
  args?: unknown;
  /** 工具结果摘要（tool_end，截断防刷屏） */
  result?: unknown;
  /** 回复文本增量（text_delta，节流推送）/ 思考增量（thinking_delta） */
  text?: string;
  /** 是否出错（tool_end / agent_end） */
  isError?: boolean;
}
