import fs from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { resolveSafePath } from '../utils/sanitize.js';

const WriteFileParams = Type.Object({
  path: Type.String({ description: '文件路径（相对于工作目录或绝对路径）' }),
  content: Type.String({ description: '要写入的文件内容' }),
});

export type WriteFileParams = Static<typeof WriteFileParams>;

export function createWriteFileTool(workDir: string): AgentTool<typeof WriteFileParams> {
  return {
    name: 'write_file',
    label: 'Write File',
    description: '将内容写入指定文件，会自动创建中间目录',
    parameters: WriteFileParams,
    async execute(
      _toolCallId: string,
      params: WriteFileParams,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const safePath = resolveSafePath(params.path, workDir);
      const fileName = path.basename(params.path);

      // 发送进度：准备写入
      onUpdate?.({
        content: [{ type: 'text', text: `正在准备写入 ${fileName}...` }],
        details: { phase: 'preparing', path: params.path },
      });

      const dir = path.dirname(safePath);
      await fs.mkdir(dir, { recursive: true });

      // 发送进度：正在写入
      const sizeKB = (params.content.length / 1024).toFixed(1);
      onUpdate?.({
        content: [{ type: 'text', text: `正在写入 ${fileName} (${sizeKB} KB)...` }],
        details: { phase: 'writing', path: params.path, bytes: params.content.length },
      });

      await fs.writeFile(safePath, params.content, 'utf-8');

      // 发送进度：写入完成
      onUpdate?.({
        content: [{ type: 'text', text: `${fileName} 写入完成` }],
        details: { phase: 'done', path: params.path, bytes: params.content.length },
      });

      return {
        content: [{ type: 'text', text: `文件已成功写入: ${params.path} (${sizeKB} KB)` }],
        details: { path: params.path, size: params.content.length },
      };
    },
  };
}
