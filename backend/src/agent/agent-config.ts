import { config } from '../config.js';
import { createCustomTools, type CreateCustomToolsOptions } from '../tools/index.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Skill } from '../services/skills-loader.js';
import { formatSkillsForPrompt } from '../services/skills-loader.js';

/** Agent 模式的系统提示词 — 自主 agent，拥有完整工具链 */
export const AGENT_SYSTEM_PROMPT = `你是一个自主 AI Agent，拥有完整的工具执行能力。你可以：
- 读取和写入文件
- 执行 Shell 命令
- 搜索网络信息

工作方式：
1. 分析用户需求，制定执行计划
2. 每次工作前和用户确认好，用户明确要求做在去做
2. 使用工具逐步执行，观察每步结果
3. 根据结果调整方案，继续执行
4. 完成所有步骤后总结结果

复杂任务可以分解：当任务规模较大或可并行时，调用 subagent 工具（子代理）派独立子代理执行子任务，它会自行调用工具并返回结果。用户说"派子Agent/子代理/派个助手去干"等即指此工具。子代理执行期间你仍可继续思考下一步。

重要规则：
- 主动使用工具，不要问用户"要不要执行"
- 遇到错误时分析原因并尝试修复
- 执行命令前确保安全
- 始终以中文回复用户`;

/** Agent 模式包含全部工具（opts.model 透传给 subagent 工具，使其继承主会话模型） */
export function createAgentTools(workDir: string, opts?: CreateCustomToolsOptions): AgentTool<any>[] {
  return createCustomTools(workDir, opts);
}

/**
 * Agent 模式的模型配置（来自环境变量 AGENT_*，不再回退到通用 qwen 配置 —— 没有出厂默认模型）。
 * 注意：本函数仅用于 subagent 工具的兜底取值；会话主模型解析见 session-manager.createSession
 * （modelOverrides → 用户全局默认 → 无则报错），此处配置缺失时由 createQwenModel 抛 NoDefaultModelError。
 */
export function getAgentModelConfig(): { id: string; baseUrl: string; apiKey: string } {
  return {
    id: config.agentModel,
    baseUrl: config.agentBaseUrl,
    apiKey: config.agentApiKey,
  };
}

/** 构建含 skills 的 agent system prompt */
export function buildAgentSystemPrompt(skills: Skill[]): string {
  return AGENT_SYSTEM_PROMPT + formatSkillsForPrompt(skills);
}
