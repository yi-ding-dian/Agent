import fs from 'node:fs/promises';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { resolveSafePath } from '../utils/sanitize.js';

const EditOperation = Type.Object({
  oldText: Type.String({
    description: '要替换的原文片段，必须在文件中精确匹配且唯一（与其他 oldText 不重叠）',
  }),
  newText: Type.String({ description: '替换后的新文本' }),
});

const EditFileParams = Type.Object({
  filePath: Type.String({ description: '要编辑的文件路径（相对于工作目录或绝对路径）' }),
  edits: Type.Array(EditOperation, {
    description: '一次可包含多段精准替换；所有片段均按原始文件内容匹配，互不重叠',
  }),
});

export type EditFileParams = Static<typeof EditFileParams>;

interface PendingEdit {
  oldText: string;
  newText: string;
  index: number; // 在原始内容中的起始位置
}

/**
 * 计算文本在第 1 行开始的行号（index 为字符偏移）
 */
function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * 生成每处编辑的简洁 diff 摘要（- 原内容 / + 新内容）
 */
function buildDiffSummary(content: string, pending: PendingEdit[]): string {
  const lines: string[] = [];
  for (const edit of pending) {
    const startLine = lineNumberAt(content, edit.index);
    const oldLines = edit.oldText.split('\n');
    const newLines = edit.newText.split('\n');
    lines.push(`第 ${startLine} 行起 (${edit.oldText.length} 字符 → ${edit.newText.length} 字符):`);
    for (const line of oldLines) lines.push(`  - ${line}`);
    for (const line of newLines) lines.push(`  + ${line}`);
  }
  return lines.join('\n');
}

export function createEditFileTool(workDir: string): AgentTool<typeof EditFileParams> {
  return {
    name: 'edit_file',
    label: 'Edit File',
    description:
      '对文件做精准文本替换编辑。一次调用可包含多段 edits（oldText → newText），每段 oldText 必须在原文件中精确匹配且唯一、互不重叠。任一旧片段匹配失败时整个操作回滚（不写入任何改动）。适合小范围修改，大改动请用 write_file。',
    parameters: EditFileParams,
    async execute(
      _toolCallId: string,
      params: EditFileParams,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const safePath = resolveSafePath(params.filePath, workDir);

      if (!Array.isArray(params.edits) || params.edits.length === 0) {
        throw new Error('edits 至少需要包含一个 { oldText, newText } 编辑操作');
      }

      onUpdate?.({ content: [{ type: 'text', text: `正在读取 ${params.filePath}...` }], details: { phase: 'reading' } });

      let rawContent: string;
      try {
        rawContent = await fs.readFile(safePath, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`无法读取文件 ${params.filePath}: ${msg}`);
      }

      // 处理 BOM：匹配时剥离（模型不会把不可见 BOM 写进 oldText），写回时恢复
      const hadBom = rawContent.startsWith('﻿');
      const content = hadBom ? rawContent.slice(1) : rawContent;

      // 阶段 1：逐段校验（存在、唯一、互不重叠）。任一失败即整体报错，不写入
      const pending: PendingEdit[] = [];
      for (const [i, edit] of params.edits.entries()) {
        const first = content.indexOf(edit.oldText);
        const last = content.lastIndexOf(edit.oldText);
        if (first === -1) {
          throw new Error(`第 ${i + 1} 段编辑失败: oldText 在文件中未找到 → ${JSON.stringify(edit.oldText.slice(0, 80))}`);
        }
        if (first !== last) {
          throw new Error(`第 ${i + 1} 段编辑失败: oldText 在文件中出现多次，不唯一 → ${JSON.stringify(edit.oldText.slice(0, 80))}`);
        }
        const overlapping = pending.some(
          (p) => first < p.index + p.oldText.length && p.index < first + edit.oldText.length,
        );
        if (overlapping) {
          throw new Error(`第 ${i + 1} 段编辑失败: oldText 与之前的编辑区间重叠 → ${JSON.stringify(edit.oldText.slice(0, 80))}`);
        }
        pending.push({ oldText: edit.oldText, newText: edit.newText, index: first });
      }

      // 阶段 2：从后往前应用，避免前面替换导致后续偏移
      pending.sort((a, b) => b.index - a.index);
      let newContent = content;
      for (const edit of pending) {
        newContent = newContent.slice(0, edit.index) + edit.newText + newContent.slice(edit.index + edit.oldText.length);
      }

      onUpdate?.({ content: [{ type: 'text', text: `已校验 ${pending.length} 段编辑，正在写回...` }], details: { phase: 'writing' } });

      await fs.writeFile(safePath, (hadBom ? '﻿' : '') + newContent, 'utf-8');

      // 摘要按原文顺序排列（恢复未排序前的顺序，便于对照）
      const ordered = [...pending].sort((a, b) => a.index - b.index);
      const diffSummary = buildDiffSummary(content, ordered);

      return {
        content: [
          { type: 'text', text: `已成功替换 ${pending.length} 处，文件: ${params.filePath}\n${diffSummary}` },
        ],
        details: {
          path: params.filePath,
          replacedCount: pending.length,
          edits: ordered.map((e) => ({
            startLine: lineNumberAt(content, e.index),
            oldLength: e.oldText.length,
            newLength: e.newText.length,
          })),
          size: newContent.length,
        },
      };
    },
  };
}
