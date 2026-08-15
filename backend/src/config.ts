import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

loadEnv();

const getStr = (key: string, fallback: string) => process.env[key] || fallback;
const getInt = (key: string, fallback: number) => parseInt(process.env[key] || String(fallback), 10);

export const config = {
  port: getInt('PORT', 7980),
  dataDir: getStr('DATA_DIR', path.resolve(process.cwd(), '..', 'data')),
  frontendDir: getStr('FRONTEND_DIR', path.resolve(process.cwd(), '..', 'frontend', 'dist')),
  adminAccount: getStr('ADMIN_ACCOUNT', 'admin'),
  adminPassword: getStr('ADMIN_PASSWORD', '123456'),
  // 注意：本系统不再有"出厂默认模型"。QWEN_BASE_URL / QWEN_MODEL 未配置即为空字符串，
  // 会话模型由用户在前端「模型设置」中选择并经全局默认（data/global-default-model.json）
  // 持久化；任何路径都解析不到模型配置时，创建会话明确报错（见 createQwenModel 校验）。
  // 该字段仅作为环境变量显式配置的入口（如 Electron 主进程经 applyConfig 注入运行时值）。
  qwenBaseUrl: getStr('QWEN_BASE_URL', ''),
  qwenModel: getStr('QWEN_MODEL', ''),
  qwenApiKey: getStr('QWEN_API_KEY', ''),
  defaultSystemPrompt: getStr('SYSTEM_PROMPT', '你是一个智能助手，请根据用户的指令提供帮助。你可以使用各种工具来完成任务，包括读取文件、写入文件、执行命令、搜索网络和运行 Python 代码。请始终以中文回答用户的问题。'),
  // Chat 模式独立配置
  chatBaseUrl: getStr('CHAT_BASE_URL', ''),
  chatModel: getStr('CHAT_MODEL', ''),
  chatApiKey: getStr('CHAT_API_KEY', ''),
  // Agent 模式独立配置
  agentBaseUrl: getStr('AGENT_BASE_URL', ''),
  agentModel: getStr('AGENT_MODEL', ''),
  agentApiKey: getStr('AGENT_API_KEY', ''),
  workDir: getStr('WORK_DIR', process.cwd()),
  sessionTimeoutMs: 30 * 60 * 1000,
  llmTimeoutMs: getInt('LLM_TIMEOUT_MS', 120000),
  defaultMaxTokens: 65535,
  // RPC 配置
  rpcCliPath: getStr('PI_CLI_PATH', ''),
  rpcMaxProcesses: getInt('RPC_MAX_PROCESSES', 4),
  rpcProcessIdleTimeoutMs: getInt('RPC_IDLE_TIMEOUT_MS', 300000),
  rpcHeartbeatMs: getInt('RPC_HEARTBEAT_MS', 30000),
  rpcMaxRestarts: getInt('RPC_MAX_RESTARTS', 5),
  // WebSocket 配置
  wsHeartbeatMs: getInt('WS_HEARTBEAT_MS', 30000),
  // 工具限速
  toolRateLimitPerMinute: getInt('TOOL_RATE_LIMIT_PER_MIN', 20),
  toolRateLimitMaxErrors: getInt('TOOL_RATE_LIMIT_MAX_ERRORS', 5),
  // Agent 迭代限制（新增）
  agentMaxTurns: getInt('AGENT_MAX_TURNS', 20),        // 最大对话轮数（LLM调用次数）
  agentMaxToolCallsPerTurn: getInt('AGENT_MAX_TOOL_CALLS_PER_TURN', 10), // 每轮最大工具调用次数
  agentMaxConsecutiveErrors: getInt('AGENT_MAX_CONSECUTIVE_ERRORS', 5),   // 连续错误阈值
  // 推理深度（运行时可修改，多级模型用）
  thinkingLevel: getStr('THINKING_LEVEL', 'medium'),
  // 思考模式开关（开关型模型用，如 Qwen）
  enableThinking: getStr('ENABLE_THINKING', 'true') === 'true',
  thinkingBudget: getInt('THINKING_BUDGET', 1024),
  preserveThinking: getStr('PRESERVE_THINKING', 'false') === 'true',
  // 网页版 Agent 执行开关（瘦服务端模式：false 时服务端不做 Agent/工具，由桌面客户端执行）
  webAgentEnabled: getStr('WEB_AGENT_ENABLED', 'true') === 'true',
};

// ─── 模型预设（多 provider 支持） ──────────────────────────────

/** 模型预设：一组可直接切换的 LLM provider 配置 */
export interface ModelPreset {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** API 格式：默认 openai-completions（当前后端仅实现此格式），anthropic 预留 */
  apiFormat?: 'openai-completions' | 'anthropic';
}

/**
 * 模型预设列表。不再有"出厂默认模型"：
 * - 本地 Qwen 预设仅当对应环境变量（CHAT_BASE_URL+CHAT_MODEL / AGENT_BASE_URL+AGENT_MODEL）
 *   都显式配置时才生成 —— 配置了才有，没配置就没有；
 * - DeepSeek 为云服务商固定地址（apiKey 从 DEEPSEEK_API_KEY 读取，未设置时为空白待填）。
 */
export const modelPresets: ModelPreset[] = [
  // 本地 Chat 预设（仅当 CHAT_BASE_URL 与 CHAT_MODEL 均配置时生成）
  ...(config.chatBaseUrl && config.chatModel
    ? [{
        name: '本地Qwen-chat',
        baseUrl: config.chatBaseUrl,
        model: config.chatModel,
        apiKey: config.chatApiKey,
        apiFormat: 'openai-completions' as const,
      }]
    : []),
  // 本地 Agent 预设（仅当 AGENT_BASE_URL 与 AGENT_MODEL 均配置时生成）
  ...(config.agentBaseUrl && config.agentModel
    ? [{
        name: '本地Qwen-agent',
        baseUrl: config.agentBaseUrl,
        model: config.agentModel,
        apiKey: config.agentApiKey,
        apiFormat: 'openai-completions' as const,
      }]
    : []),
  // DeepSeek 云端模型（OpenAI 兼容 API）。apiKey 不硬编码：
  // 从环境变量 DEEPSEEK_API_KEY 读取；未设置时前端「模型预设」中可自行填写（存 localStorage）。
  {
    name: 'DeepSeek-Chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    apiFormat: 'openai-completions',
  },
  {
    name: 'DeepSeek-Reasoner',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-reasoner',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    apiFormat: 'openai-completions',
  },
];

/** 返回模型预设列表副本（供 GET /api/config 等暴露） */
export function getModelPresets(): ModelPreset[] {
  return modelPresets.map((p) => ({ ...p }));
}

/** 按名称查找预设（大小写不敏感） */
export function resolveModelPresetByName(name: string): ModelPreset | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return modelPresets.find((p) => p.name.trim().toLowerCase() === normalized);
}
