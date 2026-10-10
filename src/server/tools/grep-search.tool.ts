import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { resolveSafePath } from '../utils/sanitize.js';

const MAX_RESULTS = 200;
const DEFAULT_MAX_RESULTS = 50;
const RG_TIMEOUT_MS = 10_000;
const MAX_LINE_LENGTH = 500;

// 递归遍历时跳过的目录
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__', '.venv', 'venv']);

const GrepSearchParams = Type.Object({
  pattern: Type.String({ description: '搜索模式，支持正则表达式；正则语法错误时按普通字符串匹配' }),
  directory: Type.Optional(Type.String({ description: '搜索目录（默认: 工作目录）' })),
  filePattern: Type.Optional(Type.String({ description: '按文件名过滤，如 "*.ts"、"*.tsx"（默认: 全部文件）' })),
  maxResults: Type.Optional(Type.Number({ description: '最多返回匹配行数（默认 50，上限 200）' })),
});

export type GrepSearchParams = Static<typeof GrepSearchParams>;

/** 检测 rg 是否可用 */
function isRipgrepAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], { timeout: 3000 }, (error) => {
      resolve(!error);
    });
  });
}

/** 把 filePattern（如 "*.ts"）转成全局参数用的简单正则 */
function filePatternToRegex(filePattern: string): RegExp {
  const escaped = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** 自研递归搜索 fallback：返回 [相对路径:行号:内容] 列表 */
async function searchWithNode(
  root: string,
  patternText: string,
  filePattern: string | undefined,
  maxResults: number,
): Promise<{ lines: string[]; matchCount: number; truncated: boolean }> {
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(patternText);
  } catch {
    regex = null; // 正则语法错误，按普通字符串匹配
  }
  const fileRegex = filePattern ? filePatternToRegex(filePattern) : null;
  const output: string[] = [];
  let matchCount = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (output.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限等场景静默跳过
    }
    for (const entry of entries) {
      if (output.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileRegex && !fileRegex.test(entry.name)) continue;
      try {
        const content = await fs.readFile(full, 'utf-8');
        const rel = path.relative(root, full).split(path.sep).join('/');
        const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const matched = regex ? regex.test(lines[i]) : lines[i].includes(patternText);
          if (!matched) continue;
          matchCount++;
          if (output.length >= maxResults) {
            truncated = true;
            return;
          }
          const text = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) + '…' : lines[i];
          output.push(`${rel}:${i + 1}: ${text}`);
        }
      } catch {
        // 二进制文件等读取失败时跳过
      }
    }
  };

  await visit(root);
  return { lines: output, matchCount, truncated };
}

/** 使用 rg 搜索 */
function searchWithRg(
  root: string,
  patternText: string,
  filePattern: string | undefined,
  maxResults: number,
  isRegex: boolean,
): Promise<{ lines: string[]; matchCount: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      '--line-number',
      '--no-heading',
      '--color=never',
      '--hidden',
      '-g', '!node_modules/**',
      '-g', '!.git/**',
      '-g', '!dist/**',
    ];
    if (filePattern) args.push('-g', filePattern);
    if (!isRegex) args.push('--fixed-strings');
    args.push('--', patternText, root);

    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, RG_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.split('\n').length > maxResults) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 rg: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1 && !killed) {
        reject(new Error(stderr.trim() || `rg 退出码 ${code}`));
        return;
      }
      const allLines = stdout.split('\n').filter((l) => l.trim().length > 0);
      const truncated = killed || allLines.length > maxResults;
      const lines = allLines.slice(0, maxResults).map((l) => {
        return l.length > MAX_LINE_LENGTH + 200 ? l.slice(0, MAX_LINE_LENGTH + 200) + '…' : l;
      });
      resolve({ lines, matchCount: lines.length, truncated });
    });
  });
}

export function createGrepSearchTool(workDir: string): AgentTool<typeof GrepSearchParams> {
  return {
    name: 'grep_search',
    label: 'Grep Search',
    description:
      '在指定目录内递归搜索文件内容，返回 文件路径:行号:匹配内容 列表。自动跳过 node_modules/.git/dist 等目录。优先使用 ripgrep，不可用时回退到内置递归搜索。',
    parameters: GrepSearchParams,
    async execute(
      _toolCallId: string,
      params: GrepSearchParams,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const safeDir = resolveSafePath(params.directory ?? '.', workDir);
      const maxResults = Math.min(Math.max(1, params.maxResults ?? DEFAULT_MAX_RESULTS), MAX_RESULTS);

      onUpdate?.({ content: [{ type: 'text', text: `正在搜索 "${params.pattern}" ...` }], details: { phase: 'searching' } });

      let isRegex = true;
      try {
        new RegExp(params.pattern);
      } catch {
        isRegex = false;
      }

      let result: { lines: string[]; matchCount: number; truncated: boolean };
      let usedRg = false;
      try {
        const rgAvailable = await isRipgrepAvailable();
        if (rgAvailable) {
          usedRg = true;
          result = await searchWithRg(safeDir, params.pattern, params.filePattern, maxResults, isRegex);
        } else {
          result = await searchWithNode(safeDir, params.pattern, params.filePattern, maxResults);
        }
      } catch (error: unknown) {
        // rg 失败时回退到自研搜索
        const msg = error instanceof Error ? error.message : String(error);
        result = await searchWithNode(safeDir, params.pattern, params.filePattern, maxResults);
        usedRg = false;
        if (result.lines.length === 0 && !isRegex) {
          // fallback 也未命中，附带说明
          return {
            content: [{ type: 'text', text: `未找到匹配 (自研搜索; rg 失败: ${msg})` }],
            details: { matchCount: 0, usedRg: false },
          };
        }
      }

      if (result.lines.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到匹配: ${params.pattern}` }],
          details: { matchCount: 0, usedRg },
        };
      }

      const engine = usedRg ? 'ripgrep' : '内置搜索';
      let text = result.lines.join('\n');
      if (result.truncated) {
        text += `\n\n[已达 ${maxResults} 条结果上限，如需更多请细化 pattern 或调整 filePattern]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: {
          matchCount: result.matchCount,
          truncated: result.truncated,
          maxResults,
          usedRg,
          engine,
        },
      };
    },
  };
}
