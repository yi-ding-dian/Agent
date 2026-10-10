import { Router } from 'express';
import type { Request, Response } from 'express';
import { pendingConfirmationManager } from '../confirmation/manager.js';

export const confirmationRouter = Router();

// POST /api/confirm-decision
confirmationRouter.post('/confirm-decision', (req: Request, res: Response): void => {
  const { sessionId, decision } = req.body as { sessionId?: string; decision?: string };

  if (!sessionId || !decision) {
    res.status(400).json({ error: '缺少 sessionId 或 decision' });
    return;
  }

  if (!['allow', 'always_allow', 'block'].includes(decision)) {
    res.status(400).json({ error: 'decision 必须是 allow、always_allow 或 block' });
    return;
  }

  const ok = pendingConfirmationManager.resolve(sessionId, decision as any);
  if (!ok) {
    res.status(404).json({ error: '未找到待确认的操作，可能已超时' });
    return;
  }

  console.log(`[Confirmation] Session ${sessionId} decision=${decision}`);
  res.json({ status: 'ok', decision });
});
