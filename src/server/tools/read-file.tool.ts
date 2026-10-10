import fs from 'node:fs/promises';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { resolveSafePath } from '../utils/sanitize.js';

const ReadFileParams = Type.Object({
  path: Type.String({ description: '文件路径（相对于工作目录或绝对路径）' }),
  offset: Type.Optional(Type.Number({ description: '读取起始行号（从 0 开始）' })),
  limit: Type.Optional(Type.Number({ description: '最多读取行数' })),
});

export type ReadFileParams = Static<typeof ReadFileParams>;

export function createReadFileTool(workDir: string): AgentTool<typeof ReadFileParams> {
  return {
    name: 'read_file',
    label: 'Read File',
    description: '读取指定文件的内容，支持 offset 和 limit 参数',
    parameters: ReadFileParams,
    async execute(
      _toolCallId: string,
      params: ReadFileParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const safePath = resolveSafePath(params.path, workDir);
      const content = await fs.readFile(safePath, 'utf-8');

      const lines = content.split('\n');
      const offset = params.offset ?? 0;
      const limit = params.limit ?? lines.length;
      const selectedLines = lines.slice(offset, offset + limit);
      const result = selectedLines.join('\n');

      return {
        content: [{ type: 'text', text: result }],
        details: { totalLines: lines.length, offset, returnedLines: selectedLines.length },
      };
    },
  };
}
