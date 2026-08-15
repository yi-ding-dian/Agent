/**
 * 外部服务配置（知识库查询链接）
 *
 * 数据持久化到 data/external-service-config.json（config.dataDir，部署时可挂载外部卷），
 * 读写模式仿 advanced-config.ts / tool-permission-config.ts，启动自动创建默认文件。
 * - kbQueryUrl：外部知识库查询链接，示例 http://host:port/ext-query/<id>?token=xxx
 *   空串表示未配置（合法）；非空时必须为合法 http/https URL（new URL() 校验）
 * - 保存后立即生效：模块内内存副本直接更新并落盘，无缓存
 * - 校验策略：加载（load）时非法值回退默认（容错）；保存（save）时非法则拒绝并返回中文错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface ExternalServiceConfig {
  /** 外部知识库查询链接（空串 = 未配置） */
  kbQueryUrl: string;
}

/** 默认值：未配置 */
const DEFAULT_CONFIG: ExternalServiceConfig = { kbQueryUrl: '' };

let currentConfig: ExternalServiceConfig = { ...DEFAULT_CONFIG };

function getFilePath(): string {
  return path.resolve(config.dataDir, 'external-service-config.json');
}

function saveToFile(value: ExternalServiceConfig): void {
  try {
    const filePath = getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[ExternalServiceConfig] 保存失败: ${err}`);
  }
}

/**
 * 校验知识库查询链接：空串合法（未配置/清除）；非空须为 http/https 且可解析，非法返回中文错误
 */
export function validateKbQueryUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return '知识库查询链接必须是字符串';
  const url = raw.trim();
  if (!url) return null; // 空串合法 = 清除配置
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '知识库查询链接格式不正确，应为 http://host/ext-query/<id>?token=xxx';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '知识库查询链接必须以 http:// 或 https:// 开头';
  }
  if (!parsed.hostname) {
    return '知识库查询链接缺少有效的主机名';
  }
  return null;
}

/**
 * 从文件加载配置（缺失时创建默认文件；文件损坏时回退默认值）。
 */
export function loadExternalServiceConfig(): ExternalServiceConfig {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      const src = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
      currentConfig = { kbQueryUrl: typeof src.kbQueryUrl === 'string' ? src.kbQueryUrl.trim() : '' };
      console.log(`[ExternalServiceConfig] 已加载: ${filePath}`);
    } else {
      currentConfig = { ...DEFAULT_CONFIG };
      saveToFile(currentConfig);
      console.log(`[ExternalServiceConfig] 使用默认值并创建: ${filePath}`);
    }
  } catch (err) {
    console.error(`[ExternalServiceConfig] 加载失败，使用默认值: ${err}`);
    currentConfig = { ...DEFAULT_CONFIG };
  }
  return { ...currentConfig };
}

/** 获取当前外部服务配置（副本） */
export function getExternalServiceConfig(): ExternalServiceConfig {
  return { ...currentConfig };
}

/**
 * 保存外部服务配置（部分更新，校验 kbQueryUrl）。
 * - 校验通过：更新内存并落盘（立即生效），返回新配置
 * - 校验失败：不落盘，errors 返回中文错误（由路由以 400 返回给前端提示）
 */
export function saveExternalServiceConfig(partial: Record<string, unknown>): {
  config: ExternalServiceConfig;
  errors: string[];
} {
  const errors: string[] = [];
  if (partial.kbQueryUrl !== undefined) {
    const err = validateKbQueryUrl(partial.kbQueryUrl);
    if (err) {
      errors.push(err);
    } else {
      currentConfig = { kbQueryUrl: typeof partial.kbQueryUrl === 'string' ? partial.kbQueryUrl.trim() : '' };
    }
  }
  if (errors.length === 0) saveToFile(currentConfig);
  return { config: { ...currentConfig }, errors };
}
