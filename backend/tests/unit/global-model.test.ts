/**
 * 无出厂默认模型改造单测：
 * 1. createQwenModel 无 id/baseUrl → 抛 NoDefaultModelError（400 可读错误）
 * 2. global-model-config：按用户 set/get 并落盘 data/global-default-model.json
 * 3. createSession 解析链：无 overrides 且无全局默认 → 报错；有全局默认 → 使用它；overrides 优先
 * 全部使用临时 dataDir，测完清理。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config.js';
import { createQwenModel, NoDefaultModelError } from '../../src/agent/llm-config.js';
import { getGlobalModel, setGlobalModel } from '../../src/config/global-model-config.js';
import { initDatabase } from '../../src/db/database.js';
import { initSessionManager, getSessionManager } from '../../src/services/session-manager.js';

let tmpDir: string;
let originalDataDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-global-model-test-'));
  originalDataDir = config.dataDir;
  config.dataDir = tmpDir;
  await initDatabase(tmpDir);
  initSessionManager();
});

after(() => {
  config.dataDir = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── createQwenModel 空值校验 ─────────────────────────────

test('createQwenModel: 无 id/baseUrl 时抛 NoDefaultModelError（status=400 中文可读）', () => {
  assert.throws(() => createQwenModel(), NoDefaultModelError);
  assert.throws(() => createQwenModel({ id: 'm' }), NoDefaultModelError);
  assert.throws(() => createQwenModel({ baseUrl: 'http://x/v1' }), NoDefaultModelError);
  assert.throws(() => createQwenModel({ id: '', baseUrl: '' }), NoDefaultModelError);
  try {
    createQwenModel({ id: '  ', baseUrl: ' http://x/v1 ' });
    assert.fail('应抛出 NoDefaultModelError');
  } catch (e: any) {
    assert.equal(e.status, 400);
    assert.match(e.message, /未配置默认模型，请在设置→模型设置中选择模型/);
  }
});

test('createQwenModel: 完整配置正常构建', () => {
  const m = createQwenModel({ id: 'deepseek-chat', baseUrl: ' https://api.deepseek.com ', apiKey: 'k' });
  assert.equal(m.id, 'deepseek-chat');
  assert.equal(m.baseUrl, 'https://api.deepseek.com'); // trim 后
  assert.equal((m as { apiKey?: string }).apiKey, 'k');
});

// ─── global-model-config 持久化 ───────────────────────────

test('global-model-config: set/get 按用户隔离并落盘 data/global-default-model.json', () => {
  assert.equal(getGlobalModel(1), null, '初始无默认');
  setGlobalModel(1, { id: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: '' });
  const m = getGlobalModel(1);
  assert.equal(m?.id, 'deepseek-chat');
  assert.equal(m?.baseUrl, 'https://api.deepseek.com');
  assert.equal(getGlobalModel(2), null, '按用户隔离');

  const file = path.join(tmpDir, 'global-default-model.json');
  assert.ok(fs.existsSync(file), '已落盘');
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { id: string }>;
  assert.equal(raw['1'].id, 'deepseek-chat');
});

test('global-model-config: id/baseUrl 不完整时 setGlobalModel 抛错且不落盘', () => {
  assert.throws(() => setGlobalModel(1, { id: '', baseUrl: 'http://x' }), /模型配置不完整/);
  assert.throws(() => setGlobalModel(1, { id: 'm', baseUrl: '' }), /模型配置不完整/);
  // 失败不影响已有值
  assert.equal(getGlobalModel(1)?.id, 'deepseek-chat');
});

// ─── createSession 解析链 ─────────────────────────────────

test('createSession: 无 overrides 且无全局默认 → 抛 NoDefaultModelError（明确报错，不悄悄用任何模型）', () => {
  const mgr = getSessionManager();
  assert.throws(() => mgr.createSession(99, 'chat'), NoDefaultModelError);
  assert.throws(() => mgr.createSession(99, 'agent'), NoDefaultModelError);
});

test('createSession: 有全局默认 → 使用全局默认创建成功', () => {
  const mgr = getSessionManager();
  setGlobalModel(7, { id: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: '' });
  const id = mgr.createSession(7, 'chat');
  const session = mgr.getSession(id);
  const model = session?.model as { id: string; baseUrl: string };
  assert.equal(model.id, 'deepseek-chat');
  assert.equal(model.baseUrl, 'https://api.deepseek.com');
  mgr.deleteSession(id);
});

test('createSession: 请求携带的 overrides 优先于全局默认', () => {
  const mgr = getSessionManager();
  setGlobalModel(8, { id: 'global-model', baseUrl: 'http://global/v1', apiKey: '' });
  const id = mgr.createSession(8, 'chat', undefined, undefined, undefined, {
    id: 'override-model',
    baseUrl: 'http://override/v1',
  });
  const model = mgr.getSession(id)?.model as { id: string; baseUrl: string };
  assert.equal(model.id, 'override-model');
  assert.equal(model.baseUrl, 'http://override/v1');
  mgr.deleteSession(id);
});
