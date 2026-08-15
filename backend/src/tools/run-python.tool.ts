import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';

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
      _signal?: AbortSignal,
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

        return new Promise((resolve) => {
          let output = '';
          const proc = spawn('python3', [tmpFile], {
            cwd,
            timeout: 60000,
            env: { ...process.env },
          });

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
            const resultOutput = output || '代码执行完成（无输出）';
            resolve({
              content: [{ type: 'text', text: resultOutput }],
              details: { exitCode: code ?? -1 },
            });
          });

          proc.on('error', (err) => {
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
