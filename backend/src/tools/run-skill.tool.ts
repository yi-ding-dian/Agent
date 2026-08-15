import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { findSkillByName, getSkills, readSkillContent } from '../services/skills-loader.js';

const RunSkillParams = Type.Object({
  skillName: Type.String({ description: '技能名称（如 code-review），即技能清单中的 <name>' }),
});

export type RunSkillParams = Static<typeof RunSkillParams>;

/**
 * run_skill 工具：把 .pi/skills 下某个技能的完整 SKILL.md 指令内容加载进对话上下文，
 * 相当于"执行"该技能 —— 模型按返回的指令逐步完成对应任务。
 */
export function createRunSkillTool(): AgentTool<typeof RunSkillParams> {
  return {
    name: 'run_skill',
    label: 'Run Skill',
    description:
      '加载并执行一个技能：读取该技能的完整 SKILL.md 指令内容并返回，按其中的步骤完成任务。找不到指定技能时返回可用技能列表',
    parameters: RunSkillParams,
    async execute(
      _toolCallId: string,
      params: RunSkillParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const skill = findSkillByName(params.skillName);

      if (!skill) {
        const available = getSkills().map((s) => s.name).join(', ') || '（无可用技能）';
        return {
          content: [
            {
              type: 'text',
              text: `错误：找不到技能 "${params.skillName}"。\n可用技能列表：${available}\n请使用正确的技能名称（skill 的 <name>）重新调用 run_skill。`,
            },
          ],
          details: { found: false, requestedName: params.skillName },
        };
      }

      try {
        const content = readSkillContent(skill);
        return {
          content: [
            {
              type: 'text',
              text: `<skill name="${skill.name}" location="${skill.filePath}">\n${content}\n</skill>`,
            },
          ],
          details: { found: true, name: skill.name, filePath: skill.filePath, chars: content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `错误：技能 "${params.skillName}" 文件读取失败：${msg}`,
            },
          ],
          details: { found: true, name: skill.name, filePath: skill.filePath, error: msg },
        };
      }
    },
  };
}
