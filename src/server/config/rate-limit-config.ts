/**
 * 限流配置文件读写模块
 * 数据持久化到 data/rate-limit-config.json
 * Agent 工作期间实时读取此配置
 */
import fs from 'node:fs';
import path from 'node:path';
// 别名导入：本模块内的 `config` 是限流配置本身，故应用配置用 appConfig
import { config as appConfig } from '../config.js';
import type { RateLimitConfig } from '../../shared/types.js';

// 类型定义已迁至 src/shared/types.ts（前后端单一事实源），此处 re-export 保持既有引用不变。
// 迁移缘由：前端曾另写一份且缺 llm_timeout_ms（漂移）。
export type { RateLimitConfig };

const DEFAULTS: RateLimitConfig = {
  tool_rate_limit_per_minute: 50,
  agent_max_tool_calls_per_turn: 100,
  agent_max_consecutive_errors: 5,
  agent_max_turns: 100,
  llm_timeout_ms: 300000,
};

let config: RateLimitConfig = { ...DEFAULTS };

function getFilePath(): string {
  // DATA_DIR 环境变量优先（须运行时读取：测试与部署脚本会在启动前改写它）；
  // 兜底走统一的应用配置，避免此处重复推导项目路径
  const dataDir = process.env.DATA_DIR || appConfig.dataDir;
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
