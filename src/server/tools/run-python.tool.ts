import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { killProcessGroup, bindAbortToProcess } from '../utils/process.js';

const RunPythonParams = Type.Object({
  code: Type.String({ description: '要执行的 Python 代码' }),
  cwd: Type.Optional(Type.String({ description: '工作目录' })),
});

export type RunPythonParams = Static<typeof RunPythonParams>;

export function createRunPythonTool(workDir: string): AgentTool<typeof RunPythonParams> {
  return {
    name: 'run_python',
    label: 'Run Python Code',
    description: '执行指定的 Python 代码并返回执行结果',
    parameters: RunPythonParams,
    async execute(
      _toolCallId: string,
      params: RunPythonParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      onUpdate?.({
        content: [{ type: 'text', text: '正在准备 Python 执行环境...' }],
        details: { phase: 'preparing' },
      });

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-python-'));
      const tmpFile = path.join(tmpDir, 'script.py');

      try {
        await fs.writeFile(tmpFile, params.code, 'utf-8');
        const cwd = params.cwd ?? workDir;

        onUpdate?.({
          content: [{ type: 'text', text: '正在执行 Python 代码...' }],
          details: { phase: 'running', codeLength: params.code.length },
        });

        // 必须 await：若直接 return Promise，finally 会在它 settle **之前**执行，
        // 把 python3 正要读取的 script.py 连同临时目录一起删掉
        // （实测该写法 100% 报 "can't open file ... script.py"）。
        return await new Promise((resolve) => {
          let output = '';
          let settled = false;

          const proc = spawn('python3', [tmpFile], {
            cwd,
            // detached: 让 python3 自成进程组组长 —— 中止/超时时才能连带清理
            // 脚本自己拉起的子进程（直接 kill python3 会留下孤儿）。这里不 unref()。
            detached: true,
            env: { ...process.env },
          });

          // 超时兜底：防止脚本卡死后 Promise 永远不 resolve。
          // 不再用 spawn 的 timeout 选项 —— 它只给 python3 发信号，漏掉其子进程。
          const timeoutHandle = setTimeout(() => {
            if (settled) return;
            settled = true;
            killProcessGroup(proc, 'SIGKILL');
            resolve({
              content: [{ type: 'text', text: output || 'Python 执行超时（60秒）' }],
              details: { exitCode: -1, timedOut: true },
            });
          }, 60000);

          // 连接 AbortSignal：用户点停止时杀掉 python3 及其整条进程链
          if (signal?.aborted) {
            clearTimeout(timeoutHandle);
            killProcessGroup(proc, 'SIGKILL');
            resolve({
              content: [{ type: 'text', text: '操作已中止' }],
              details: { exitCode: -1 },
            });
            return;
          }
          bindAbortToProcess(proc, signal, () => settled);

          proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            output += text;
            onUpdate?.({
              content: [{ type: 'text', text: output.slice(-2000) }],
              details: { phase: 'running', outputLength: output.length },
            });
          });

          proc.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            output += `[stderr] ${text}`;
          });

          proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            const resultOutput = output || '代码执行完成（无输出）';
            resolve({
              content: [{ type: 'text', text: resultOutput }],
              details: { exitCode: code ?? -1 },
            });
          });

          proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            resolve({
              content: [{ type: 'text', text: `Python 执行失败: ${err.message}` }],
              details: { exitCode: -1, error: err.message },
            });
          });
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
