import { Router } from 'express';
import type { Request, Response } from 'express';
import { SessionStore } from '../db/session-store.js';

/**
 * 客户端（Electron）会话同步路由
 *
 * 客户端 Agent 引擎在本地执行对话后，将完整消息历史 POST 到此接口，
 * 由服务端持久化。幂等覆盖写，不触碰 SessionManager 内存态
 * （与网页版内存会话互不干扰；GET /api/sessions/:id 的 DB 回退逻辑直接读得到）。
 */
const sessionStore = new SessionStore();

export const syncRouter = Router();

syncRouter.post('/sessions/:id/sync', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const sessionId = req.params.id;
  const { name, mode, messages } = req.body as {
    name?: string;
    mode?: 'chat' | 'agent';
    messages?: unknown[];
  };

  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: '会话 ID 无效' });
    return;
  }

  // 会话已存在且不属于当前用户 → 拒绝
  const owner = sessionStore.getSessionOwner(sessionId);
  if (owner !== null && owner !== userId) {
    res.status(403).json({ error: '无权同步该会话' });
    return;
  }

  if (messages !== undefined && !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages 必须是数组' });
    return;
  }

  sessionStore.saveSession({
    id: sessionId,
    userId,
    name: name || '对话',
    mode: mode || 'chat',
    messages: messages || [],
  });

  console.log(`[Sync] session ${sessionId} synced (${messages?.length ?? 0} messages)`);
  res.json({ success: true, id: sessionId });
});
