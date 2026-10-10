import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import {
  appendMemory,
  type AppendMemoryResult,
} from '../services/memory-service.js';
import { getAdvancedConfig } from '../config/advanced-config.js';

const RememberParams = Type.Object({
  note: Type.String({
    description: '要记住的内容，例如用户偏好或项目约定（单条最长 2000 字符）',
  }),
});

export type RememberParams = Static<typeof RememberParams>;

/**
 * remember 工具 — 跨会话记忆写入
 *
 * 模型在对话中判断用户表达了长期偏好（"以后……""记住……"）时调用，
 * 将内容写入 data/memory.md，之后每次新建会话都会自动注入到 system prompt。
 *
 * 安全设计：
 * - 长度限制：note 超过 memory.maxNoteLength（advanced-config，默认 2000）直接拒绝
 * - 注入防护：换行/多空白压缩为单个空格，单行存储，杜绝被 markdown 解析为
 *   新标题/新列表/新代码块等结构；行首 "#" 做反斜杠转义
 * - 去重：完全重复的条目由 appendMemory 跳过
 */
export function createRememberTool(): AgentTool<typeof RememberParams> {
  return {
    name: 'remember',
    label: '记住（跨会话记忆）',
    description:
      '将用户明确要求记住的偏好、约定或重要信息写入跨会话记忆（data/memory.md）。' +
      '记忆会在后续每次对话的 system prompt 中自动注入并要求遵循。' +
      '当用户说出"以后……""记住……"等长期偏好表达时调用；临时性、一次性内容无需调用。',
    parameters: RememberParams,
    async execute(
      _toolCallId: string,
      params: RememberParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const note = params.note ?? '';

      // 单条长度上限来自 advanced-config.memory.maxNoteLength（默认 2000），运行时实时读取
      const maxNoteLength = getAdvancedConfig().memory.maxNoteLength;
      if (note.length > maxNoteLength) {
        return {
          content: [
            {
              type: 'text',
              text: `记忆内容超过长度限制（${maxNoteLength} 字符，实际 ${note.length}），请精简后重试`,
            },
          ],
          details: { ok: false },
        };
      }

      // 注入防护 + 单行化：换行 → 句号+空格，其余连续空白 → 单个空格
      let cleaned = note
        .replace(/\n+/g, '。 ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (!cleaned) {
        return {
          content: [{ type: 'text', text: '记忆内容为空，未保存' }],
          details: { ok: false },
        };
      }
      // 行首 "#" 会被 markdown 解析为标题，反斜杠转义
      if (cleaned.startsWith('#')) cleaned = '\\' + cleaned;

      const entry = `- [${new Date().toISOString().slice(0, 10)}] ${cleaned}`;
      const result: AppendMemoryResult = appendMemory(entry);

      return {
        content: [
          {
            type: 'text',
            text: result.appended ? `已记住：${cleaned}` : '该内容已存在于记忆中，未重复添加',
          },
        ],
        details: { ok: result.appended, total: result.total },
      };
    },
  };
}
