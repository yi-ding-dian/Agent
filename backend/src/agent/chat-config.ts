import { config } from '../config.js';
import { createSearchWebTool } from '../tools/search-web.tool.js';
import { createEditFileTool } from '../tools/edit-file.tool.js';
import { createGrepSearchTool } from '../tools/grep-search.tool.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

/** Chat 模式的系统提示词 — 轻量对话，仅附带少量文件处理能力 */
export const CHAT_SYSTEM_PROMPT = '你是一个友好的对话助手。请根据用户的指令提供帮助，使用中文回复。';

/**
 * Chat 模式工具。
 *
 * 工具面取舍（避免过度膨胀，保持对话轻量）：
 * - 启用 grep_search：只读搜索，聊天中用户问"这个功能/这段代码在哪"时可直接定位，成本低价值高
 * - 启用 edit_file：聊天中常出现"帮我改一下某处"的需求，edit_file 为小范围精准替换，
 *   比 write_file 整文件覆盖更安全（失败整体回滚），能提升聊天中的文件处理能力
 * - 不启用 list_files：与 grep_search 功能重叠（grep 即可定位文件），完整目录树属于
 *   agent 模式的自主探索场景；chat 模式保持工具面精简
 */
export function createChatTools(): AgentTool<any>[] {
  return [createSearchWebTool(), createGrepSearchTool(config.workDir), createEditFileTool(config.workDir)];
}

/**
 * Chat 模式的模型配置（来自环境变量 CHAT_*，不再回退到通用 qwen 配置 —— 没有出厂默认模型）。
 * 会话主模型解析见 session-manager.createSession（modelOverrides → 用户全局默认 → 无则报错）。
 */
export function getChatModelConfig(): { id: string; baseUrl: string; apiKey: string } {
  return {
    id: config.chatModel,
    baseUrl: config.chatBaseUrl,
    apiKey: config.chatApiKey,
  };
}
