import { spawn } from 'node:child_process';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { getAdvancedConfig } from '../config/advanced-config.js';

/**
 * 最底线内置黑名单（不可被配置移除，始终生效）：
 * 配置里的危险命令黑名单（data/advanced-config.json 的 commandBlacklist，可运行时调整）
 * 只增不减 —— 判定时取内置与配置的并集。
 */
const BUILTIN_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^sudo\b/, reason: '禁止使用 sudo 提权' },
  { pattern: /^mkfs\./, reason: '禁止格式化磁盘' },
  { pattern: /^dd\b/, reason: '禁止直接操作磁盘' },
];

/** 配置条目转正则：按"命令前缀 + 词边界"匹配（如 "rm -rf /" 匹配 "rm -rf /etc"），
 * 不引入用户输入的正则注入（全部转义）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 构建判定黑名单 = 内置 ∪ 配置（每次判定实时读取，配置修改后立即生效） */
function buildBlockedPatterns(): Array<{ pattern: RegExp; reason: string }> {
  const fromConfig = getAdvancedConfig().commandBlacklist
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({
      pattern: new RegExp(`^${escapeRegExp(item)}\\b`),
      reason: `危险命令（自定义黑名单: ${item}）`,
    }));
  return [...BUILTIN_BLOCKED, ...fromConfig];
}

const MAX_COMMAND_LENGTH = 10000;

const ExecuteCommandParams = Type.Object({
  command: Type.String({ description: '要执行的 shell 命令' }),
  cwd: Type.Optional(Type.String({ description: '工作目录（默认为项目根目录）' })),
});

export type ExecuteCommandParams = Static<typeof ExecuteCommandParams>;

function validateCommand(command: string): string | null {
  const trimmed = command.trim();
  for (const { pattern, reason } of buildBlockedPatterns()) {
    if (pattern.test(trimmed)) {
      return `⛔ 命令被阻止: ${reason}`;
    }
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return `命令过长（${command.length} 字符），最大允许 ${MAX_COMMAND_LENGTH} 字符`;
  }
  return null;
}

export function createExecuteCommandTool(workDir: string): AgentTool<typeof ExecuteCommandParams> {
  return {
    name: 'execute_command',
    label: 'Execute Command',
    description: '在 shell 中执行指定的命令，包含安全检查',
    parameters: ExecuteCommandParams,
    async execute(
      _toolCallId: string,
      params: ExecuteCommandParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const validationError = validateCommand(params.command);
      if (validationError) {
        return {
          content: [{ type: 'text', text: validationError }],
          details: { command: params.command, blocked: true },
        };
      }

      onUpdate?.({
        content: [{ type: 'text', text: `执行命令: ${params.command.slice(0, 200)}` }],
        details: { phase: 'starting', command: params.command },
      });

      const cwd = params.cwd ?? workDir;

      return new Promise((resolve) => {
        let output = '';
        let settled = false;

        const proc = spawn('sh', ['-c', params.command], {
          cwd,
          timeout: 60000,
          env: { ...process.env },
        });

        // 兜底超时：防止子进程卡死后 Promise 永远不 resolve
        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (!proc.killed) proc.kill('SIGKILL');
          resolve({
            content: [{ type: 'text', text: output || '命令执行超时（60秒）' }],
            details: { command: params.command, exitCode: -1, timedOut: true },
          });
        }, 65000);

        // 连接 AbortSignal：用户点击停止时杀死子进程
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timeoutHandle);
            if (!proc.killed) proc.kill('SIGKILL');
            resolve({
              content: [{ type: 'text', text: '操作已中止' }],
              details: { command: params.command, exitCode: -1 },
            });
            return;
          }
          signal.addEventListener('abort', () => {
            if (settled) return;
            if (!proc.killed) proc.kill('SIGTERM');
            // 如果 SIGTERM 无效，2 秒后强杀
            setTimeout(() => {
              if (!proc.killed) proc.kill('SIGKILL');
            }, 2000).unref();
          }, { once: true });
        }

        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          output += text;
          onUpdate?.({
            content: [{ type: 'text', text: output.slice(-2000) }],
            details: { phase: 'running', command: params.command, outputLength: output.length },
          });
        });
        proc.stdout.on('error', () => { /* 防止流错误冒泡 */ });

        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          output += `[stderr] ${text}`;
          onUpdate?.({
            content: [{ type: 'text', text: output.slice(-2000) }],
            details: { phase: 'running', command: params.command, outputLength: output.length },
          });
        });
        proc.stderr.on('error', () => { /* 防止流错误冒泡 */ });

        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          const resultOutput = output || '命令执行完成（无输出）';
          resolve({
            content: [{ type: 'text', text: resultOutput }],
            details: { command: params.command, exitCode: code ?? -1 },
          });
        });

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          resolve({
            content: [{ type: 'text', text: `命令执行失败: ${err.message}` }],
            details: { command: params.command, exitCode: -1, error: err.message },
          });
        });
      });
    },
  };
}
