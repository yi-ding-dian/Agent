/**
 * MCP 外部 server 配置（data/mcp-servers.json）
 *
 * 完全仿 advanced-config 模式：
 * - 数据持久化到 data/mcp-servers.json，启动自动创建（含默认内置服务一条，保持现有行为）
 * - 校验策略：加载（load）时非法条目剔除并容错（保留合法条目）；更新（add/update）时拒绝式校验，
 *   校验失败返回中文错误信息（由 /api/mcp-servers 以 400 返回给前端提示）
 * - 各字段校验：
 *   - name：唯一，且匹配 ^[a-zA-Z0-9_-]{1,32}$（防注入 + 用于工具名前缀）
 *   - command：非空，且匹配 ^[a-zA-Z0-9_./-]+$（仅允许常见可执行名，防注入）
 *   - args：数组，每项 ≤200 字符且不含换行
 *   - enabled / description：布尔 / 字符串
 *
 * 注意（内置服务识别）：默认"内置服务"（command=node, args[0]=mcp/src/index.js）由 mcp-bridge
 * 识别为内置服务，其工具保持原名不加前缀（兼容现有前端/对话）；其余外部 server 工具统一加
 * mcp__<serverName>__ 前缀防冲突。内置服务配置项可被用户删除（允许自由），重新加回即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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

/** 默认配置：内置工具服务（保持改造前行为：spawn node mcp/src/index.js，工具不加前缀） */
export const DEFAULT_MCP_SERVERS: McpServerConfig[] = [
  {
    name: '内置服务',
    command: 'node',
    args: ['mcp/src/index.js'],
    enabled: true,
    description: '内置工具服务',
  },
];

/** 服务名合法模式：字母/数字/下划线/连字符，1-32 位 */
export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
/** 命令合法模式：仅允许常见可执行名（含相对路径 ./、../ 与绝对路径 /），防 shell 注入 */
export const MCP_SERVER_COMMAND_PATTERN = /^[a-zA-Z0-9_./-]+$/;
/** cwd 合法模式：字母/数字/下划线/点/斜杠/连字符（允许空/相对/绝对路径），防注入 */
export const MCP_SERVER_CWD_PATTERN = /^[a-zA-Z0-9_./-]*$/;
/** 单个参数最大长度 */
export const MCP_SERVER_ARG_MAX_LENGTH = 200;
/** cwd 最大长度 */
export const MCP_SERVER_CWD_MAX_LENGTH = 200;

function getFilePath(): string {
  return path.resolve(config.dataDir, 'mcp-servers.json');
}

function saveToFile(value: McpServersConfig): void {
  try {
    const filePath = getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[McpServersConfig] 保存失败: ${err}`);
  }
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 单条 server 全字段校验（新增用），返回中文错误信息数组 */
export function validateMcpServerInput(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push('服务名称不能为空');
  // 特例：默认内置服务名"内置服务"为中文（默认配置即如此），仅此名允许
  // （内置服务工具不加前缀，中文名不进入工具名；外部 server 必须用 ASCII 名）
  else if (name !== DEFAULT_MCP_SERVERS[0].name && !MCP_SERVER_NAME_PATTERN.test(name)) {
    errors.push('服务名称只能包含字母/数字/下划线/连字符（1-32 位）');
  }

  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) errors.push('命令不能为空');
  else if (!MCP_SERVER_COMMAND_PATTERN.test(command)) {
    errors.push('命令仅允许常见可执行名（字母/数字/下划线/点/斜杠/连字符），禁止空格与特殊字符');
  }

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) {
      errors.push('参数必须是字符串数组');
    } else {
      for (let i = 0; i < raw.args.length; i++) {
        const a = raw.args[i];
        if (typeof a !== 'string') {
          errors.push(`参数第 ${i + 1} 项必须是字符串`);
          break;
        }
        if (a.length > MCP_SERVER_ARG_MAX_LENGTH) {
          errors.push(`参数第 ${i + 1} 项超过 ${MCP_SERVER_ARG_MAX_LENGTH} 字符上限`);
        }
        if (/[\n\r]/.test(a)) {
          errors.push(`参数第 ${i + 1} 项不能包含换行`);
        }
      }
    }
  }

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string') {
      errors.push('cwd 必须是字符串');
    } else if (raw.cwd.length > MCP_SERVER_CWD_MAX_LENGTH) {
      errors.push(`cwd 超过 ${MCP_SERVER_CWD_MAX_LENGTH} 字符上限`);
    } else if (!MCP_SERVER_CWD_PATTERN.test(raw.cwd)) {
      errors.push('cwd 仅允许字母/数字/下划线/点/斜杠/连字符（可留空/相对/绝对路径），禁止空格与特殊字符');
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled 必须是布尔值');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push('描述必须是字符串');
  }
  if (raw.name !== undefined && raw.name !== name) {
    // name 与 trim 后不一致（如纯空格）已在"不能为空"中覆盖；此处仅为冗余提示
    errors.push('服务名称不能包含首尾空白');
  }
  return errors;
}

/** 校验 name 是否与其他 server 冲突（excludeName 用于更新场景排除自身） */
function nameConflict(name: string, servers: McpServerConfig[], excludeName?: string): boolean {
  return servers.some((s) => s.name === name && s.name !== excludeName);
}

/**
 * 加载配置：文件不存在时创建默认文件（内置服务一条）；文件损坏时回退默认值；
 * 存在时逐条校验，非法条目剔除（容错），合法条目保留。
 */
export function loadMcpServersConfig(): McpServersConfig {
  const filePath = getFilePath();
  const fallback = () => {
    const cfg: McpServersConfig = { servers: deepCopy(DEFAULT_MCP_SERVERS) };
    currentConfig = cfg;
    saveToFile(cfg);
    return deepCopy(cfg);
  };
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`[McpServersConfig] 使用默认值并创建: ${filePath}`);
      return fallback();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    const src = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const servers: McpServerConfig[] = [];
    if (Array.isArray(src.servers)) {
      for (const item of src.servers) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        const errors = validateMcpServerInput(raw);
        if (errors.length > 0) {
          console.warn(`[McpServersConfig] 加载时剔除非法条目: ${errors.join('；')}`);
          continue;
        }
        const srv: McpServerConfig = {
          name: String(raw.name).trim(),
          command: String(raw.command).trim(),
          args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
          description: typeof raw.description === 'string' ? raw.description : '',
        };
        if (nameConflict(srv.name, servers)) {
          console.warn(`[McpServersConfig] 加载时剔除重复名称: ${srv.name}`);
          continue;
        }
        servers.push(srv);
      }
    }
    // 合法条目可能为空（用户自由删除了全部 server，包括内置服务）——允许，按文件内容生效
    const cfg: McpServersConfig = { servers };
    currentConfig = cfg;
    // 与文件不一致时回写（剔除非法条目后的结果），保持一致
    if (servers.length !== (src.servers as unknown[]).length) saveToFile(cfg);
    console.log(`[McpServersConfig] 已加载 ${servers.length} 个 server: ${filePath}`);
    return cfg;
  } catch (err) {
    console.error(`[McpServersConfig] 加载失败，使用默认值: ${err}`);
    return fallback();
  }
}

let currentConfig: McpServersConfig | null = null;

/** 获取当前 MCP server 配置（深拷贝）；懒加载：首次访问时若文件不存在仅按默认值工作 */
export function getMcpServersConfig(): McpServersConfig {
  if (!currentConfig) return loadMcpServersConfig();
  return deepCopy(currentConfig);
}

/** 当前配置数组副本（未加载时以默认值打底） */
function currentServers(): McpServerConfig[] {
  return currentConfig ? deepCopy(currentConfig.servers) : deepCopy(DEFAULT_MCP_SERVERS);
}

/** 新增 server（拒绝式校验：name 唯一 + 各字段合法），返回 { config, errors } */
export function addMcpServer(input: Record<string, unknown>): { config: McpServersConfig; errors: string[] } {
  const errors = validateMcpServerInput(input);
  const servers = currentServers();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name && nameConflict(name, servers)) {
    errors.push(`服务名称 "${name}" 已存在`);
  }
  if (errors.length > 0) {
    return { config: { servers: currentServers() }, errors };
  }
  const srv: McpServerConfig = {
    name,
    command: String(input.command).trim(),
    args: Array.isArray(input.args) ? input.args.map((a) => String(a)) : [],
    cwd: typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd.trim() : undefined,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    description: typeof input.description === 'string' ? input.description.trim() : '',
  };
  servers.push(srv);
  currentConfig = { servers };
  saveToFile(currentConfig);
  return { config: deepCopy(currentConfig), errors };
}

/** 更新 server（按 name 定位；name 不可修改，enabled 开关/编辑 command/args/description），返回 { config, errors } */
export function updateMcpServer(
  name: string,
  patch: Record<string, unknown>,
): { config: McpServersConfig; errors: string[]; found: boolean } {
  const servers = currentServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) return { config: { servers }, errors: [], found: false };

  if (patch.name !== undefined && patch.name !== name) {
    return {
      config: { servers },
      errors: ['服务名称不可修改，如需改名请删除后重新添加'],
      found: true,
    };
  }

  const errors: string[] = [];
  // 构造合并后的完整对象做全字段校验（与新增一致的校验强度）
  const merged: Record<string, unknown> = { ...servers[idx] };
  for (const key of ['command', 'args', 'cwd', 'enabled', 'description'] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  errors.push(...validateMcpServerInput(merged));

  if (errors.length > 0) {
    return { config: { servers }, errors, found: true };
  }
  servers[idx] = {
    ...servers[idx],
    command: typeof merged.command === 'string' ? merged.command.trim() : servers[idx].command,
    args: Array.isArray(merged.args) ? merged.args.map((a) => String(a)) : servers[idx].args,
    cwd: typeof merged.cwd === 'string' && merged.cwd.trim() !== '' ? merged.cwd.trim() : undefined,
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : servers[idx].enabled,
    description: typeof merged.description === 'string' ? merged.description.trim() : servers[idx].description,
  };
  currentConfig = { servers };
  saveToFile(currentConfig);
  return { config: deepCopy(currentConfig), errors, found: true };
}

/** 删除 server（按 name 定位；内置服务也可删除，用户自由），返回 { config, found } */
export function deleteMcpServer(name: string): { config: McpServersConfig; found: boolean } {
  const servers = currentServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) return { config: { servers }, found: false };
  servers.splice(idx, 1);
  currentConfig = { servers };
  saveToFile(currentConfig);
  return { config: deepCopy(currentConfig), found: true };
}
