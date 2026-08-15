/**
 * 全局默认模型配置（按用户持久化）
 *
 * 数据持久化到 data/global-default-model.json，结构：
 *   { [userId: string]: { id: string; baseUrl: string; apiKey: string } }
 *
 * - 前端「模型设置」中选中的模型（localStorage 已有）会同步 POST /api/global-model 落盘，
 *   后端创建会话时的模型解析链：请求携带的 modelOverrides → 用户全局默认 → 都没有则明确报错。
 * - 懒加载（纯内存副本，无 IO）；首次访问时文件不存在按空表工作（不强制创建文件）。
 * - 校验：加载时仅接受 id/baseUrl 均非空的条目（无效条目丢弃）；写入时同样校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface GlobalModelConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
}

/** userId → 全局默认模型 */
type GlobalModelMap = Record<string, GlobalModelConfig>;

let cache: GlobalModelMap | null = null;

function getFilePath(): string {
  return path.resolve(config.dataDir, 'global-default-model.json');
}

function sanitize(raw: unknown): GlobalModelMap {
  const out: GlobalModelMap = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [userId, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id.trim() : '';
      const baseUrl = typeof e.baseUrl === 'string' ? e.baseUrl.trim() : '';
      const apiKey = typeof e.apiKey === 'string' ? e.apiKey.trim() : '';
      // 无效条目（id/baseUrl 不完整）直接丢弃：不能以残缺配置充当"默认模型"
      if (id && baseUrl) out[userId] = { id, baseUrl, apiKey };
    }
  }
  return out;
}

function load(): GlobalModelMap {
  if (cache) return cache;
  try {
    const filePath = getFilePath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      cache = sanitize(parsed);
      console.log(`[GlobalModelConfig] 已加载: ${filePath}`);
    } else {
      cache = {};
    }
  } catch (err) {
    console.error(`[GlobalModelConfig] 加载失败，按空配置处理: ${err}`);
    cache = {};
  }
  return cache;
}

function saveToFile(map: GlobalModelMap): void {
  try {
    const filePath = getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[GlobalModelConfig] 保存失败: ${err}`);
  }
}

/**
 * 获取用户的全局默认模型（无则返回 null）。
 * 返回深拷贝，修改返回值不影响内部状态。
 */
export function getGlobalModel(userId: number): GlobalModelConfig | null {
  const entry = load()[String(userId)];
  return entry ? { ...entry } : null;
}

/**
 * 设置用户的全局默认模型（id/baseUrl 非空校验，apiKey 允许为空）。
 * 校验失败抛错（由路由层转 400），不落盘。
 */
export function setGlobalModel(userId: number, model: GlobalModelConfig): void {
  const id = (model.id ?? '').trim();
  const baseUrl = (model.baseUrl ?? '').trim();
  const apiKey = (model.apiKey ?? '').trim();
  if (!id || !baseUrl) {
    throw new Error('模型配置不完整（id 与 baseUrl 不能为空）');
  }
  const map = load();
  map[String(userId)] = { id, baseUrl, apiKey };
  saveToFile(map);
}
