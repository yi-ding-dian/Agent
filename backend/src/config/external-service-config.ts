/**
 * 外部服务配置（可自定义的查询链接列表）
 *
 * 数据持久化到 data/external-service-config.json（config.dataDir，部署时可挂载外部卷），
 * 读写模式仿 advanced-config.ts / tool-permission-config.ts，启动自动创建默认文件。
 *
 * 模型：services 条目列表，每条含 id/title/url/description：
 * - id='kb'（知识库查询）与 id='filesys'（文件管理系统）为内置条目，
 *   MCP 工具经 /api/agent-config/kb-link、/api/agent-config/filesys-link 按 id 读取其 url；
 * - 自定义条目 id 为 uuid（前端新增时由后端分配），仅用于界面展示与通用可达性测试；
 * - url 空串 = 未配置（内置条目合法，MCP 工具报"未配置"）；自定义条目 url 必填。
 * - 校验策略：加载（load）时非法值回退默认（容错）；保存（save）时非法则拒绝并返回中文错误
 *
 * 旧格式兼容：v1 的 { kbQueryUrl, filesysUrl } 在加载时自动迁移为两个内置条目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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

export interface ExternalServiceConfig {
  services: ExternalServiceEntry[];
}

/** 内置条目标题（前端新增时按标题匹配复用内置 id，保证 MCP 契约找到对应条目） */
export const BUILTIN_SERVICE_TITLES: Record<'kb' | 'filesys', string> = {
  kb: '知识库查询',
  filesys: '文件管理系统',
};

/** 默认值：两个内置条目（url 未配置） */
const DEFAULT_CONFIG: ExternalServiceConfig = {
  services: [
    { id: 'kb', title: BUILTIN_SERVICE_TITLES.kb, url: '', description: '外部知识库服务查询链接（需含 id 与 token）' },
    { id: 'filesys', title: BUILTIN_SERVICE_TITLES.filesys, url: '', description: '个人文件管理系统查询链接（地址与 API Token 合成一条）' },
  ],
};

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
 * 校验知识库查询链接（id=kb 条目）：空串合法（未配置/清除）；非空须为 http/https 且可解析
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
 * 校验文件管理系统查询链接（id=filesys 条目）：空串合法（未配置/清除）；非空须为 http/https 且含 token
 * （?token=sk-xxx 或路径段 /sk-xxx 形式，与 mcp fileQuery.parseFileSysUrl 一致）
 */
export function validateFileSysUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return '文件系统查询链接必须是字符串';
  const url = raw.trim();
  if (!url) return null; // 空串合法 = 清除配置
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '文件系统查询链接格式不正确，应为 http://host:port?token=sk-xxx 或 http://host:port/sk-xxx';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '文件系统查询链接必须以 http:// 或 https:// 开头';
  }
  if (!parsed.hostname) {
    return '文件系统查询链接缺少有效的主机名';
  }
  const hasQueryToken = !!parsed.searchParams.get('token') || !!parsed.searchParams.get('api_key');
  const seg = parsed.pathname.split('/').filter(Boolean);
  const hasPathToken = !!seg.length && seg[seg.length - 1]!.startsWith('sk-');
  if (!hasQueryToken && !hasPathToken) {
    return '文件系统查询链接缺少 token（应为 ?token=sk-xxx 或 http://host:port/sk-xxx）';
  }
  return null;
}

/**
 * 校验自定义条目链接：非空 http/https URL（无特殊协议要求，如 token 等由服务自定义）
 */
export function validateCustomServiceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return '自定义服务链接必须是字符串';
  const url = raw.trim();
  if (!url) return '自定义服务链接不能为空';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '自定义服务链接格式不正确（应为 http:// 或 https:// 开头的完整 URL）';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '自定义服务链接必须以 http:// 或 https:// 开头';
  }
  if (!parsed.hostname) {
    return '自定义服务链接缺少有效的主机名';
  }
  return null;
}

/**
 * 校验单个条目。返回 null（通过）或中文错误。
 * - title 必填；url 校验按 id 分支（内置空串合法；自定义必填）
 */
export function validateServiceEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return '外部服务条目格式不正确';
  const e = entry as Record<string, unknown>;
  const id = String(e.id ?? '');
  const title = typeof e.title === 'string' ? e.title.trim() : '';
  if (!title) return '外部服务标题不能为空';
  if (!id) return '外部服务缺少 id';
  let urlErr: string | null = null;
  if (id === 'kb') {
    urlErr = validateKbQueryUrl(e.url);
  } else if (id === 'filesys') {
    urlErr = validateFileSysUrl(e.url);
  } else {
    urlErr = validateCustomServiceUrl(e.url);
  }
  if (urlErr) return `${urlErr}（${title}）`;
  return null;
}

/**
 * 解析文件系统链接 → { base, token }（base 为 origin，token 为 sk-...）；
 * 格式不正确返回 null（校验通过的值都可解析）
 */
export function parseFilesysLink(raw: string): { base: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const token = url.searchParams.get('token') || url.searchParams.get('api_key') || '';
  if (!token) {
    const seg = url.pathname.split('/').filter(Boolean);
    const last = seg[seg.length - 1] || '';
    if (last.startsWith('sk-')) return { base: url.origin, token: last };
    return null;
  }
  return { base: url.origin, token };
}

/** v1 旧配置 → 内置条目；missing fields 处理为未配置 */
function migrateV1(src: Record<string, unknown>): ExternalServiceConfig {
  const kbUrl = typeof src.kbQueryUrl === 'string' ? src.kbQueryUrl.trim() : '';
  const fsUrl = typeof src.filesysUrl === 'string' ? src.filesysUrl.trim() : '';
  const services: ExternalServiceEntry[] = [
    { id: 'kb', title: BUILTIN_SERVICE_TITLES.kb, url: kbUrl, description: '外部知识库服务查询链接（需含 id 与 token）' },
    { id: 'filesys', title: BUILTIN_SERVICE_TITLES.filesys, url: fsUrl, description: '个人文件管理系统查询链接（地址与 API Token 合成一条）' },
  ];
  return { services };
}

/**
 * 从文件加载配置（缺失时创建默认文件；文件损坏/旧版本时迁移回退）。
 * 加载对非法条目容错：单个条目非法则丢弃该条目，整体仍可用。
 */
export function loadExternalServiceConfig(): ExternalServiceConfig {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      const src = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;

      if (Array.isArray(src.services)) {
        const services: ExternalServiceEntry[] = [];
        for (const raw of src.services) {
          if (validateServiceEntry(raw) !== null) continue; // 非法条目丢弃，不阻断整体加载
          const e = raw as Record<string, unknown>;
          services.push({
            id: String(e.id),
            title: String(e.title).trim(),
            url: String(e.url ?? '').trim(),
            description: typeof e.description === 'string' ? e.description : '',
          });
        }
        currentConfig = { services };
      } else if (typeof src.kbQueryUrl === 'string' || typeof src.filesysUrl === 'string') {
        // v1 旧格式迁移
        currentConfig = migrateV1(src);
        saveToFile(currentConfig);
        console.log(`[ExternalServiceConfig] 已迁移 v1 配置: ${filePath}`);
      } else {
        currentConfig = { ...DEFAULT_CONFIG };
        saveToFile(currentConfig);
        console.log(`[ExternalServiceConfig] 使用默认值并重写: ${filePath}`);
      }
      console.log(`[ExternalServiceConfig] 已加载: ${filePath}（${currentConfig.services.length} 个服务）`);
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
  return { ...currentConfig, services: currentConfig.services.map((s) => ({ ...s })) };
}

/**
 * 保存外部服务配置（body: { services: [...] } 全量替换；兼容旧版 { kbQueryUrl, filesysUrl }）。
 * 新条目（id 为空/自定义）按标题匹配内置标题 → 复用内置 id（如删除知识库条目后
 * 再新增"知识库查询"标题的条目，kb_query 仍能找到）；其余分配 uuid。
 * - 校验通过：全部合法则更新内存并落盘（立即生效），返回新配置
 * - 校验失败：不落盘，errors 返回中文错误（由路由以 400 返回给前端提示）
 */
export function saveExternalServiceConfig(partial: Record<string, unknown>): {
  config: ExternalServiceConfig;
  errors: string[];
} {
  const errors: string[] = [];
  let rawServices: unknown = partial.services;
  if (!Array.isArray(rawServices)) {
    // 兼容旧版 body（kbQueryUrl / filesysUrl 单字段）
    if (typeof partial.kbQueryUrl === 'string' || typeof partial.filesysUrl === 'string') {
      rawServices = migrateV1(partial).services;
    } else {
      return { config: { ...currentConfig }, errors: ['services 必须是数组'] };
    }
  }

  const services: ExternalServiceEntry[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawServices as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push('外部服务条目格式不正确');
      continue;
    }
    const e = raw as Record<string, unknown>;
    let id = String(e.id ?? '').trim();
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!id) {
      // 无 id 的新条目：标题匹配内置标题则复用内置 id（保证 MCP 契约可找到），否则分配 uuid
      id = title === BUILTIN_SERVICE_TITLES.kb ? 'kb'
        : title === BUILTIN_SERVICE_TITLES.filesys ? 'filesys'
        : crypto.randomUUID();
    }
    const entry: ExternalServiceEntry = {
      id,
      title,
      url: typeof e.url === 'string' ? e.url.trim() : '',
      description: typeof e.description === 'string' ? e.description.trim() : '',
    };
    if (seenIds.has(id)) {
      errors.push(`外部服务 id 重复: ${id}`);
      continue;
    }
    seenIds.add(id);
    const err = validateServiceEntry(entry);
    if (err) {
      errors.push(err);
      continue;
    }
    services.push(entry);
  }
  if (errors.length > 0) {
    return { config: { ...currentConfig }, errors };
  }

  // 校验通过：整体替换并落盘
  currentConfig = { services };
  saveToFile(currentConfig);
  return { config: { ...currentConfig }, errors: [] };
}

/** 按 id 取单个条目（不存在返回 undefined） */
export function getServiceEntryById(id: string): ExternalServiceEntry | undefined {
  return currentConfig.services.find((s) => s.id === id);
}
