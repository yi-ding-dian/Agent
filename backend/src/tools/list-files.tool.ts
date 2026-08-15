import fs from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { resolveSafePath } from '../utils/sanitize.js';

const MAX_DEPTH = 3;
const DEFAULT_DEPTH = 1;
const MAX_ENTRIES = 2000;

const ListFilesParams = Type.Object({
  directory: Type.Optional(Type.String({ description: '要浏览的目录（默认: 工作目录）' })),
  depth: Type.Optional(Type.Number({ description: '递归深度（默认 1，上限 3）' })),
});

export type ListFilesParams = Static<typeof ListFilesParams>;

interface FileEntry {
  name: string; // 相对根目录的路径（posix 风格），目录以 / 结尾
  type: 'file' | 'dir';
  size: number; // 文件字节数（目录为 0）
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createListFilesTool(workDir: string): AgentTool<typeof ListFilesParams> {
  return {
    name: 'list_files',
    label: 'List Files',
    description:
      '列出目录内容（含子目录层级），返回每个条目的名称、类型（file/dir）与大小。目录条目可继续用 list_files 深入浏览。',
    parameters: ListFilesParams,
    async execute(
      _toolCallId: string,
      params: ListFilesParams,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const safeDir = resolveSafePath(params.directory ?? '.', workDir);
      const depth = Math.min(Math.max(0, params.depth ?? DEFAULT_DEPTH), MAX_DEPTH);

      onUpdate?.({ content: [{ type: 'text', text: `正在浏览目录...` }], details: { phase: 'listing' } });

      let rootStat;
      try {
        rootStat = await fs.stat(safeDir);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`目录不存在或无法访问: ${params.directory ?? '.'} (${msg})`);
      }
      if (!rootStat.isDirectory()) {
        throw new Error(`不是目录: ${params.directory ?? '.'}`);
      }

      const entries: FileEntry[] = [];
      let entryLimitReached = false;

      // 递归列举；根目录条目 name 不包含自身
      const visit = async (dir: string, remainingDepth: number, relPrefix: string): Promise<void> => {
        if (entries.length >= MAX_ENTRIES) return;
        let names: string[];
        try {
          names = await fs.readdir(dir);
        } catch {
          return; // 无权限的子目录静默跳过
        }
        names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        for (const name of names) {
          if (entries.length >= MAX_ENTRIES) {
            entryLimitReached = true;
            return;
          }
          const full = path.join(dir, name);
          const rel = relPrefix ? `${relPrefix}/${name}` : name;
          let stat;
          try {
            stat = await fs.stat(full);
          } catch {
            continue; // 断链等无法 stat 的条目跳过
          }
          if (stat.isDirectory()) {
            entries.push({ name: `${rel}/`, type: 'dir', size: 0 });
            if (remainingDepth > 1) await visit(full, remainingDepth - 1, rel);
          } else if (stat.isFile()) {
            entries.push({ name: rel, type: 'file', size: stat.size });
          }
        }
      };

      await visit(safeDir, depth, '');

      // 文本输出：树状缩进展示（目录层级用两空格缩进表示）
      const textLines: string[] = [];
      for (const entry of entries) {
        const indent = '  '.repeat(Math.max(0, entry.name.split('/').length - 1));
        if (entry.type === 'dir') {
          textLines.push(`${indent}${entry.name.replace(/\/$/, '')}/`);
        } else {
          textLines.push(`${indent}${entry.name} (${formatSize(entry.size)})`);
        }
      }

      let text = textLines.join('\n');
      if (textLines.length === 0) text = '(空目录)';
      if (entryLimitReached) text += `\n\n[已达 ${MAX_ENTRIES} 条条目上限]`;

      return {
        content: [{ type: 'text', text }],
        details: {
          directory: params.directory ?? '.',
          depth,
          entryCount: entries.length,
          entryLimitReached,
          entries,
        },
      };
    },
  };
}
