/**
 * 工具权限配置（tool-permission-config）与 decideToolGate 判定测试
 * - DATA_DIR 指向临时目录，避免污染真实 data/tool-permissions.json
 * - 模块内 config 为单例，测试间用 resetToolPermissionConfig 兜底
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadToolPermissionConfig,
  getToolPermission,
  getToolPermissionAction,
  updateToolPermissionConfig,
  resetToolPermissionConfig,
} from '../../src/config/tool-permission-config.js';
import { decideToolGate } from '../../src/agent/agent-factory.js';

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-perm-test-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  resetToolPermissionConfig();
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('默认配置：execute_command 与 run_python 为 ask', () => {
  const cfg = loadToolPermissionConfig();
  assert.equal(cfg.execute_command, 'ask');
  assert.equal(cfg.run_python, 'ask');
  assert.equal(cfg.edit_file, 'allow');
  assert.equal(cfg.grep_search, 'allow');
});

test('未配置的工具默认 allow（remember / subagent 不在默认表内）', () => {
  loadToolPermissionConfig();
  assert.equal(getToolPermission('remember'), 'allow');
  assert.equal(getToolPermission('subagent'), 'allow');
  assert.equal(getToolPermissionAction('some_new_tool'), 'allow');
});

test('updateToolPermissionConfig 更新内存并落盘，重新加载后仍生效', () => {
  loadToolPermissionConfig();
  updateToolPermissionConfig({ remember: 'deny', edit_file: 'ask' });

  // 内存生效
  assert.equal(getToolPermission('remember'), 'deny');
  assert.equal(getToolPermission('edit_file'), 'ask');

  // 落盘生效
  const filePath = path.join(tmpDir, 'tool-permissions.json');
  assert.ok(fs.existsSync(filePath), '配置文件应写入临时目录');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(onDisk.remember, 'deny');

  // 重新加载（模拟重启）后仍生效
  const reloaded = loadToolPermissionConfig();
  assert.equal(reloaded.remember, 'deny');
  assert.equal(reloaded.edit_file, 'ask');
});

test('updateToolPermissionConfig 忽略非法值', () => {
  loadToolPermissionConfig();
  updateToolPermissionConfig({ edit_file: 'execute', read_file: 'allow', run_python: 'run' as any });
  assert.equal(getToolPermission('edit_file'), 'allow', '非法值应被忽略，保持原值');
  assert.equal(getToolPermission('run_python'), 'ask', '非法值不应覆盖默认 ask');
  assert.equal(getToolPermission('read_file'), 'allow');
});

test('resetToolPermissionConfig 恢复默认', () => {
  loadToolPermissionConfig();
  updateToolPermissionConfig({ remember: 'deny' });
  const cfg = resetToolPermissionConfig();
  assert.equal(cfg.remember, undefined, '默认表之外的工具应回到未配置状态');
  assert.equal(getToolPermission('remember'), 'allow');
  assert.equal(cfg.execute_command, 'ask');
});

test('decideToolGate: 未配置工具默认 allow', () => {
  loadToolPermissionConfig();
  assert.equal(decideToolGate('remember', 's1'), 'allow');
  assert.equal(decideToolGate('read_file', 's1'), 'allow');
});

test('decideToolGate: deny 的工具直接拒绝', () => {
  loadToolPermissionConfig();
  updateToolPermissionConfig({ remember: 'deny' });
  assert.equal(decideToolGate('remember', 's1'), 'deny');
});

test('decideToolGate: execute_command 的 ask 语义保持现状（execute_command_ask）', () => {
  loadToolPermissionConfig();
  assert.equal(decideToolGate('execute_command', 's1'), 'execute_command_ask');
});

test('decideToolGate: 通用工具 ask 语义', () => {
  loadToolPermissionConfig();
  updateToolPermissionConfig({ edit_file: 'ask' });
  assert.equal(decideToolGate('edit_file', 's1'), 'ask');
});
