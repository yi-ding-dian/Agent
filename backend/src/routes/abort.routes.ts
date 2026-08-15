import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';

export const abortRouter = Router();

// POST /api/sessions/:id/abort — 中断会话当前处理
abortRouter.post('/sessions/:id/abort', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const id = String(req.params.id);
  const mgr = getSessionManager();

  if (!mgr.sessionBelongsToUser(id, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return;
  }

  const session = mgr.getSession(id);
  if (!session) {
    res.status(404).json({ error: '会话未找到' });
    return;
  }
  session.abort();
  res.json({ success: true, id });
});
