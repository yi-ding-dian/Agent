/**
 * 工具冒烟测试（edit_file / grep_search / list_files / remember）
 * + session-jsonl 纯函数测试（导出白名单清洗、导入宽容解析）
 * 全部使用临时目录，测完清理。
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config.js';
import { createEditFileTool } from '../../src/tools/edit-file.tool.js';
import { createGrepSearchTool } from '../../src/tools/grep-search.tool.js';
import { createListFilesTool } from '../../src/tools/list-files.tool.js';
import { createRememberTool } from '../../src/tools/remember.tool.js';
import {
  sanitizeMessageForExport,
  sanitizeMessageForImport,
  serializeSessionToJsonl,
  parseSessionJsonl,
} from '../../src/services/session-jsonl.js';

let tmpDir: string;
let originalDataDir: string;

// remember 工具写入条目时取当天日期（src/tools/remember.tool.ts 用 ISO 前 10 位），
// 测试断言日期不能硬编码（会随日期过期失败），动态生成保持一致。
const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-tools-test-'));
  originalDataDir = config.dataDir;
  config.dataDir = tmpDir; // remember 工具写入 memory.md 用
});

afterEach(() => {
  config.dataDir = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runTool(tool: { execute: (...args: any[]) => Promise<any> }, params: unknown) {
  return tool.execute('test-call-id', params);
}

// ─── edit_file ───────────────────────────────────────────────

test('edit_file: 多段替换成功且互不影响', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'demo.txt'), 'aaa bbb ccc', 'utf-8');

  const tool = createEditFileTool(workDir);
  const res = await runTool(tool, {
    filePath: 'demo.txt',
    edits: [
      { oldText: 'aaa', newText: 'AAA' },
      { oldText: 'ccc', newText: 'CCC' },
    ],
  });

  assert.equal(res.details.replacedCount, 2);
  assert.equal(fs.readFileSync(path.join(workDir, 'demo.txt'), 'utf-8'), 'AAA bbb CCC');
  assert.ok(res.content[0].text.includes('已成功替换 2 处'));
});

test('edit_file: 某段 oldText 未找到时整体报错且文件不变', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'demo.txt'), 'original content', 'utf-8');

  const tool = createEditFileTool(workDir);
  await assert.rejects(
    () =>
      runTool(tool, {
        filePath: 'demo.txt',
        edits: [
          { oldText: 'original', newText: 'changed' },
          { oldText: 'not-exists', newText: 'x' },
        ],
      }),
    /oldText 在文件中未找到/,
  );
  assert.equal(fs.readFileSync(path.join(workDir, 'demo.txt'), 'utf-8'), 'original content', '回滚后文件应保持不变');
});

test('edit_file: oldText 出现多次时报错', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'demo.txt'), 'dup dup dup', 'utf-8');

  const tool = createEditFileTool(workDir);
  await assert.rejects(
    () => runTool(tool, { filePath: 'demo.txt', edits: [{ oldText: 'dup', newText: 'x' }] }),
    /不唯一/,
  );
  assert.equal(fs.readFileSync(path.join(workDir, 'demo.txt'), 'utf-8'), 'dup dup dup');
});

test('edit_file: 编辑区间重叠时报错', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'demo.txt'), 'abcdef', 'utf-8');

  const tool = createEditFileTool(workDir);
  await assert.rejects(
    () =>
      runTool(tool, {
        filePath: 'demo.txt',
        edits: [
          { oldText: 'abcd', newText: 'X' },
          { oldText: 'bcde', newText: 'Y' },
        ],
      }),
    /重叠/,
  );
});

test('edit_file: 越界路径拒绝', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir);
  const tool = createEditFileTool(workDir);
  await assert.rejects(
    () => runTool(tool, { filePath: '../outside.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
    /路径访问被拒绝/,
  );
});

// ─── grep_search ─────────────────────────────────────────────

test('grep_search: 普通字符串匹配（rg 不可用时走内置 fallback）', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'src'));
  fs.writeFileSync(path.join(workDir, 'src', 'a.ts'), 'const hello = 1;\nconst world = 2;\n', 'utf-8');
  fs.writeFileSync(path.join(workDir, 'b.txt'), 'nothing here', 'utf-8');

  const tool = createGrepSearchTool(workDir);
  const res = await runTool(tool, { pattern: 'hello' });
  assert.equal(res.details.matchCount, 1);
  assert.ok(res.content[0].text.includes('src/a.ts:1'));
});

test('grep_search: 正则匹配与 filePattern 过滤', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'a.ts'), 'foo bar\nbaz qux', 'utf-8');
  fs.writeFileSync(path.join(workDir, 'a.md'), 'foo bar', 'utf-8');

  const tool = createGrepSearchTool(workDir);
  const res = await runTool(tool, { pattern: 'b.z', filePattern: '*.ts' });
  assert.equal(res.details.matchCount, 1);
  assert.ok(res.content[0].text.includes('a.ts'));
  assert.ok(!res.content[0].text.includes('a.md'));
});

test('grep_search: 目录越界拒绝', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const tool = createGrepSearchTool(workDir);
  await assert.rejects(() => runTool(tool, { pattern: 'x', directory: '../outside' }), /路径访问被拒绝/);
});

// ─── list_files ──────────────────────────────────────────────

test('list_files: depth 层级控制', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(path.join(workDir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'root.txt'), 'x', 'utf-8');
  fs.writeFileSync(path.join(workDir, 'sub', 'inner.txt'), 'x', 'utf-8');
  fs.writeFileSync(path.join(workDir, 'sub', 'deep', 'leaf.txt'), 'x', 'utf-8');

  const tool = createListFilesTool(workDir);

  const d1 = await runTool(tool, { depth: 1 });
  const names1 = d1.details.entries.map((e: any) => e.name);
  assert.ok(names1.includes('root.txt'));
  assert.ok(names1.includes('sub/'));
  assert.ok(!names1.includes('sub/inner.txt'), 'depth=1 不应列出子目录内容');

  const d2 = await runTool(tool, { depth: 2 });
  const names2 = d2.details.entries.map((e: any) => e.name);
  assert.ok(names2.includes('sub/inner.txt'));
  assert.ok(!names2.includes('sub/deep/leaf.txt'), 'depth=2 不应列出三级内容');

  const d3 = await runTool(tool, { depth: 3 });
  const names3 = d3.details.entries.map((e: any) => e.name);
  assert.ok(names3.includes('sub/deep/leaf.txt'));
  assert.equal(d3.details.depth, 3);
});

test('list_files: 越界路径拒绝', async () => {
  const workDir = path.join(tmpDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const tool = createListFilesTool(workDir);
  await assert.rejects(() => runTool(tool, { directory: '../../etc' }), /路径访问被拒绝/);
});

// ─── remember ────────────────────────────────────────────────

test('remember: 正常追加写入 memory.md', async () => {
  const tool = createRememberTool();
  const res = await runTool(tool, { note: '用户偏好使用 TypeScript' });
  assert.equal(res.details.ok, true);
  const memory = fs.readFileSync(path.join(tmpDir, 'memory.md'), 'utf-8');
  assert.ok(memory.includes('用户偏好使用 TypeScript'));
  assert.ok(memory.includes(`- [${TODAY}]`));
});

test('remember: 超过 2000 字符拒绝且不写入', async () => {
  const tool = createRememberTool();
  const res = await runTool(tool, { note: 'x'.repeat(2001) });
  assert.equal(res.details.ok, false);
  assert.ok(res.content[0].text.includes('长度限制'));
  assert.ok(!fs.existsSync(path.join(tmpDir, 'memory.md')), '不应创建记忆文件');
});

test('remember: 换行单行化（防 markdown 注入）', async () => {
  const tool = createRememberTool();
  await runTool(tool, { note: '第一行内容\n第二行内容' });
  const memory = fs.readFileSync(path.join(tmpDir, 'memory.md'), 'utf-8');
  assert.ok(memory.includes(`- [${TODAY}] 第一行内容。 第二行内容`), '换行应被单行化');
  // 条目应只有一行（文件中的非空行 = 标题 + 注释 + 1 条条目）
  const entryLines = memory.split('\n').filter((l) => l.trim().startsWith('- ['));
  assert.equal(entryLines.length, 1, '条目应被合并为单行');
  assert.equal(entryLines[0], `- [${TODAY}] 第一行内容。 第二行内容`);
});

test('remember: 行首 # 转义（防被解析为标题）', async () => {
  const tool = createRememberTool();
  await runTool(tool, { note: '# 重要约定' });
  const memory = fs.readFileSync(path.join(tmpDir, 'memory.md'), 'utf-8');
  assert.ok(memory.includes(`- [${TODAY}] \\# 重要约定`), '行首 # 应被反斜杠转义');
});

test('remember: 完全重复内容提示未重复添加', async () => {
  const tool = createRememberTool();
  await runTool(tool, { note: '重复内容' });
  const res2 = await runTool(tool, { note: '重复内容' });
  assert.equal(res2.details.ok, false);
  assert.ok(res2.content[0].text.includes('已存在'));
});

// ─── session-jsonl（导出白名单 / 导入宽容解析）────────────────

test('export: 白名单清洗 — id/isStreaming/duration 不导出', () => {
  const line = sanitizeMessageForExport({
    role: 'assistant',
    content: 'hi',
    id: 'internal-msg-1',
    isStreaming: true,
    duration: 1234,
    status: 'done',
    usage: { inputTokens: 10 },
    stopReason: 'end',
  } as any);
  assert.equal(line?.type, 'message');
  const raw = JSON.stringify(line);
  assert.ok(!raw.includes('isStreaming'));
  assert.ok(!raw.includes('"id"'));
  assert.ok(!raw.includes('duration'));
  assert.ok(!raw.includes('status'));
  assert.equal((line as any).usage.inputTokens, 10, 'assistant 白名单字段应保留');
  assert.equal((line as any).stopReason, 'end');
});

test('export: 非法 role 不导出', () => {
  assert.equal(sanitizeMessageForExport({ role: 'system', content: 'x' } as any), null);
  assert.equal(sanitizeMessageForExport({ role: 'unknown', content: 'x' } as any), null);
});

test('export: serializeSessionToJsonl 首行为 meta', () => {
  const jsonl = serializeSessionToJsonl(
    { id: 's1', name: '测试会话', mode: 'agent', createdAt: new Date('2026-08-11T00:00:00Z') },
    [{ role: 'user', content: '你好', timestamp: 123 } as any],
  );
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 2);
  const meta = JSON.parse(lines[0]);
  assert.equal(meta.type, 'meta');
  assert.equal(meta.sessionId, 's1');
  const msg = JSON.parse(lines[1]);
  assert.equal(msg.role, 'user');
});

test('import: 宽容解析 — 跳过空行与坏行，清洗未知字段', () => {
  const text = [
    '{"type":"meta","name":"导入会话","mode":"agent"}',
    'this is not json',
    '',
    '{"type":"message","role":"user","content":"你好","id":"x","isStreaming":true,"status":"pending"}',
    '{"type":"message","role":"assistant","content":"回复","usage":{"input":1}}',
    '{"type":"unknown","foo":"bar"}',
  ].join('\n');
  const { meta, messages } = parseSessionJsonl(text);
  assert.equal(meta?.name, '导入会话');
  assert.equal(messages.length, 2);
  const raw = JSON.stringify(messages[0]);
  assert.ok(!raw.includes('isStreaming'), '导入消息不应保留前端私有字段');
  assert.ok(!raw.includes('"id"'));
  assert.ok(!raw.includes('status'));
  assert.equal((messages[1] as any).usage.input, 1, 'assistant usage 应保留');
});

test('import: sanitizeMessageForImport 只保留白名单字段', () => {
  const msg = sanitizeMessageForImport({
    type: 'message',
    role: 'toolResult',
    content: 'ok',
    toolCallId: 'tc-1',
    toolName: 'read_file',
    isError: false,
    secret: 'leak',
  } as any);
  assert.equal(msg?.role, 'toolResult');
  const raw = JSON.stringify(msg);
  assert.ok(raw.includes('toolCallId'));
  assert.ok(raw.includes('toolName'));
  assert.ok(!raw.includes('secret'));
});
