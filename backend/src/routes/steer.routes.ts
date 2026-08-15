import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';

export const steerRouter = Router();

/**
 * 队列插入消息
 * AI 正在处理时，用户输入的消息通过此端点排队
 * 使用 Agent 的 steer 机制在下次 LLM 调用前注入
 */
steerRouter.post('/chat/steer', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const { message, sessionId } = req.body as {
    message?: string;
    sessionId?: string;
  };

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: '缺少必填参数: message' });
    return;
  }

  const mgr = getSessionManager();
  const session = sessionId ? mgr.getSession(sessionId) : undefined;

  if (!session || !mgr.sessionBelongsToUser(sessionId!, userId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }

  try {
    session.steer(message);
    console.log(`[Steer] 消息已入队 session=${sessionId}: "${message.slice(0, 50)}"`);
    res.json({ success: true, queued: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message, queued: false });
  }
});
