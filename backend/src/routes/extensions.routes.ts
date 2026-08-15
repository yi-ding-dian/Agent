/**
 * 扩展管理路由（走 /api 统一鉴权，见 app.ts 挂载顺序）
 *
 * - GET  /api/extensions                已发现扩展列表（含发现但未启用的）
 * - GET  /api/extensions/commands       已启用扩展注册的命令（前端 / 命令列表合并）
 * - POST /api/extensions/:name/toggle   启停（落盘 data/extensions-state.json；
 *                                       新会话/命令列表/钩子分发即时生效，运行中会话不热更新）
 * - POST /api/extensions/:name/command  执行扩展命令（body: { args?, sessionId? }，返回 handler 文本结果）
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getExtensionRegistry,
  getExtensionCommands,
  setExtensionEnabled,
  runExtensionCommand,
} from '../services/extension-loader.js';

export const extensionsRouter = Router();

extensionsRouter.get('/extensions', (_req: Request, res: Response): void => {
  res.json({ extensions: getExtensionRegistry() });
});

extensionsRouter.get('/extensions/commands', (_req: Request, res: Response): void => {
  const commands = getExtensionCommands().map((c) => ({
    name: c.name,
    description: c.description || '',
    extension: c.extensionName,
  }));
  res.json({ commands });
});

extensionsRouter.post('/extensions/:name/toggle', (req: Request, res: Response): void => {
  const name = String(req.params.name || '').trim();
  if (!name) {
    res.status(400).json({ error: '缺少扩展名' });
    return;
  }
  const info = getExtensionRegistry().find((e) => e.name === name);
  if (!info) {
    res.status(404).json({ error: `扩展不存在: ${name}` });
    return;
  }
  const enabled = !info.enabled;
  setExtensionEnabled(name, enabled);
  res.json({ name, enabled });
});

extensionsRouter.post('/extensions/:name/command', async (req: Request, res: Response): Promise<void> => {
  const name = String(req.params.name || '').trim();
  const { args, sessionId } = (req.body ?? {}) as { args?: unknown; sessionId?: string };
  if (!name) {
    res.status(400).json({ error: '缺少扩展命令名' });
    return;
  }
  const argText = typeof args === 'string' ? args : '';
  const result = await runExtensionCommand(name, argText, typeof sessionId === 'string' ? sessionId : undefined);
  if (!result.ok) {
    res.status(404).json({ error: result.error || '扩展命令执行失败' });
    return;
  }
  res.json({ name, result: result.result ?? '' });
});
