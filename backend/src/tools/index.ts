/**
 * 自定义工具清单（单一注册点）
 *
 * 新增工具请按此清单步骤操作（详见 README「开发指南 · 新增工具」）：
 *   1. 在 backend/src/tools/ 新建 <name>.tool.ts，导出 createXxxTool（AgentTool + TypeBox schema）
 *   2. 在本文件 import 并加入 createCustomTools 返回数组
 *   3. 在 backend/src/config/tool-permission-config.ts 评估默认权限（allow/ask/deny），
 *      并同步前端 SettingsModal 的 DEFAULT_PERMISSIONS 初始值
 *   4. 前端 TOOL_LABELS 添加中文名（frontend/src/components/ 下工具展示处）
 *   5. 在 backend/tests/unit/ 补充单元测试
 *   6. 更新 README「工具系统」表
 *
 * 注意：工具按会话实例化 —— createSession 时经 agent-config/createAgentTools
 * 或 chat-config/createChatTools 调用本函数，createXxxTool(workDir) 闭包捕获
 * 会话的工作目录，勿在模块级缓存会话相关状态。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { createReadFileTool } from './read-file.tool.js';
import { createWriteFileTool } from './write-file.tool.js';
import { createExecuteCommandTool } from './execute-command.tool.js';
import { createSearchWebTool } from './search-web.tool.js';
import { createRunPythonTool } from './run-python.tool.js';
import { createEditFileTool } from './edit-file.tool.js';
import { createGrepSearchTool } from './grep-search.tool.js';
import { createListFilesTool } from './list-files.tool.js';
import { createRunSkillTool } from './run-skill.tool.js';
import { createRememberTool } from './remember.tool.js';
import { createSubagentTool } from './subagent.tool.js';

/** createCustomTools 的可选参数（透传给 subagent 工具等需要会话级配置的工具） */
export interface CreateCustomToolsOptions {
  /** subagent 子代理使用的模型（默认与主代理一致），不传时保持原有默认行为（agent 默认模型配置） */
  model?: Model<any>;
  /** 所属会话 id：透传给 subagent 工具，用于「停止该会话下全部子代理」 */
  sessionId?: string;
}

/**
 * 归一化工具参数 schema：TypeBox / MCP SDK 对全可选对象不输出 `required` 键
 * （如 list_files 的 directory/depth、get_time 的 timestamp/format 均可选），
 * 严格校验的服务端把它读成 null 报
 * "Invalid schema for function '<name>': null is not of type array" 并拒收整条请求。
 * 统一补 `required`（无必填字段时为空数组），JSON Schema 语义不变，服务端兼容。
 *
 * 应用位置：内置工具（createCustomTools）、以及合并扩展/MCP 工具的最终组装点
 * （session-manager.buildTools / agent-engine.getTools）——合并后的工具数组
 * 统一过一遍，保证发到模型侧的所有工具 schema 都带 required。
 */
export function ensureRequiredKey<T>(schema: T): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as {
    type?: string;
    required?: unknown;
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
  };
  if (s.type === 'object') {
    if (!Array.isArray(s.required)) s.required = [];
    for (const v of Object.values(s.properties ?? {})) ensureRequiredKey(v);
  } else if (s.items) {
    ensureRequiredKey(s.items);
  } else if (Array.isArray(s.anyOf)) {
    for (const v of s.anyOf) ensureRequiredKey(v);
  }
}

export function createCustomTools(
  workDir: string,
  opts?: CreateCustomToolsOptions,
): AgentTool<any>[] {
  const tools = [
    createReadFileTool(workDir),
    createWriteFileTool(workDir),
    createEditFileTool(workDir),
    createGrepSearchTool(workDir),
    createListFilesTool(workDir),
    createExecuteCommandTool(workDir),
    createSearchWebTool(),
    createRunPythonTool(workDir),
    createRunSkillTool(),
    createRememberTool(),
    createSubagentTool(workDir, { model: opts?.model, sessionId: opts?.sessionId }),
  ];
  // 工具按会话实例化，每次返回全新对象，原地补 required 无跨会话污染
  for (const t of tools) ensureRequiredKey(t.parameters);
  return tools;
}
