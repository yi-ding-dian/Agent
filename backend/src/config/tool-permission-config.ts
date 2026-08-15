/**
 * 工具权限配置模块（allow / ask / deny）
 * 数据持久化到 data/tool-permissions.json（仿照 rate-limit-config.ts）
 * 判定时机：agent-factory.ts 的 beforeToolCall（工具执行前）
 * - allow: 直接执行
 * - ask:   走 confirmation/manager.ts 待确认队列（用户弹窗确认）
 * - deny:  工具被禁用，返回错误结果不执行
 * 未在配置中出现的工具名默认 allow（保持现状：除 execute_command 外全部直接执行）
 */
import fs from 'node:fs';
import path from 'node:path';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export type ToolPermissionsConfig = Record<string, ToolPermission>;

const DEFAULT_PERMISSIONS: ToolPermissionsConfig = {
  execute_command: 'ask', // 保持现状：危险命令需确认
  run_python: 'ask',
  read_file: 'allow',
  write_file: 'allow',
  edit_file: 'allow',
  search_web: 'allow',
  grep_search: 'allow',
  list_files: 'allow',
  run_skill: 'allow',
};

/** 未配置的工具默认放行（不改变现有行为） */
const FALLBACK_PERMISSION: ToolPermission = 'allow';

let config: ToolPermissionsConfig = { ...DEFAULT_PERMISSIONS };

function getFilePath(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), '..', 'data');
  return path.resolve(dataDir, 'tool-permissions.json');
}

/**
 * 从文件加载配置（缺失时创建默认文件）
 */
export function loadToolPermissionConfig(): ToolPermissionsConfig {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      config = { ...DEFAULT_PERMISSIONS };
      for (const [name, value] of Object.entries(parsed)) {
        if (value === 'allow' || value === 'ask' || value === 'deny') {
          config[name] = value;
        }
      }
      console.log(`[ToolPermissionConfig] 已加载: ${filePath}`);
    } else {
      config = { ...DEFAULT_PERMISSIONS };
      saveToFile();
      console.log(`[ToolPermissionConfig] 使用默认值并创建: ${filePath}`);
    }
  } catch (err) {
    console.error(`[ToolPermissionConfig] 加载失败，使用默认值: ${err}`);
    config = { ...DEFAULT_PERMISSIONS };
  }
  return { ...config };
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
    console.error(`[ToolPermissionConfig] 保存失败: ${err}`);
  }
}

/**
 * 获取当前完整权限配置（副本）
 */
export function getToolPermissionConfig(): ToolPermissionsConfig {
  return { ...config };
}

/**
 * 获取单个工具的权限（未配置时默认 allow）
 */
export function getToolPermission(toolName: string): ToolPermission {
  return config[toolName] ?? FALLBACK_PERMISSION;
}

/**
 * 获取单个工具的判定动作（带默认值回退，供 beforeToolCall 与测试使用）
 */
export function getToolPermissionAction(toolName: string): 'allow' | 'ask' | 'deny' {
  return getToolPermission(toolName);
}

/**
 * 更新权限配置（部分更新，校验枚举），保存到文件
 */
export function updateToolPermissionConfig(partial: Record<string, unknown>): ToolPermissionsConfig {
  for (const [name, value] of Object.entries(partial)) {
    if (value === 'allow' || value === 'ask' || value === 'deny') {
      config[name] = value;
    }
  }
  saveToFile();
  return { ...config };
}

/**
 * 重置为默认配置
 */
export function resetToolPermissionConfig(): ToolPermissionsConfig {
  config = { ...DEFAULT_PERMISSIONS };
  saveToFile();
  return { ...config };
}
