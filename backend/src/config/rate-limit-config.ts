/**
 * 限流配置文件读写模块
 * 数据持久化到 data/rate-limit-config.json
 * Agent 工作期间实时读取此配置
 */
import fs from 'node:fs';
import path from 'node:path';

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

const DEFAULTS: RateLimitConfig = {
  tool_rate_limit_per_minute: 50,
  agent_max_tool_calls_per_turn: 100,
  agent_max_consecutive_errors: 5,
  agent_max_turns: 100,
  llm_timeout_ms: 300000,
};

let config: RateLimitConfig = { ...DEFAULTS };

function getFilePath(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), '..', 'data');
  return path.resolve(dataDir, 'rate-limit-config.json');
}

/**
 * 从文件加载配置
 */
export function loadRateLimitConfig(): RateLimitConfig {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULTS, ...parsed };
      console.log(`[RateLimitConfig] 已加载: ${filePath}`);
    } else {
      config = { ...DEFAULTS };
      saveToFile();
      console.log(`[RateLimitConfig] 使用默认值并创建: ${filePath}`);
    }
  } catch (err) {
    console.error(`[RateLimitConfig] 加载失败，使用默认值: ${err}`);
    config = { ...DEFAULTS };
  }
  return config;
}

function saveToFile(): void {
  try {
    const filePath = getFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[RateLimitConfig] 保存失败: ${err}`);
  }
}

/**
 * 获取当前限流配置
 */
export function getRateLimitConfig(): RateLimitConfig {
  return { ...config };
}

/**
 * 更新限流配置（部分更新），保存到文件
 */
export function updateRateLimitConfig(partial: Partial<RateLimitConfig>): RateLimitConfig {
  config = { ...config, ...partial };
  saveToFile();
  return { ...config };
}
