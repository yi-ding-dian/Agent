/**
 * 子代理控制 API
 *
 * POST /api/sessions/:id/subagents/:agentId/abort   停止指定子代理
 * POST /api/sessions/:id/subagents/abort            停止该会话下全部子代理
 *
 * 背景：子代理是独立 agent 循环，已有 maxTurns（默认 8）与整体超时（默认 120s）两道硬闸，
 * 但用户需要「随时能停」—— 发现方向跑偏时立即中止，不必干等兜底触发。
 *
 * 语义：停的是**子代理自身**，主代理不受影响 —— 后者会收到 subagent 工具的返回
 * （内容为「[子代理已被用户中止] ...」）后继续自己的循环。
 * agentId = 外层 subagent 工具调用的 toolCallId，与前端 AgentInfo.id 一致。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';
import { abortSubAgent, abortSessionSubAgents } from '../tools/subagent.tool.js';

export const subagentRouter = Router();

/** 会话归属校验（与 abort.routes 同源），无权时已写响应并返回 false */
function ensureOwnership(req: Request, res: Response, sessionId: string): boolean {
  const userId = req.user!.id;
  if (!getSessionManager().sessionBelongsToUser(sessionId, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return false;
  }
  return true;
}

// 停止指定子代理
subagentRouter.post('/sessions/:id/subagents/:agentId/abort', (req: Request, res: Response): void => {
  const sessionId = String(req.params.id);
  const agentId = String(req.params.agentId);
  if (!ensureOwnership(req, res, sessionId)) return;
  // stopped=false 表示该子代理已结束或不存在（前端可忽略，属幂等场景）
  res.json({ success: true, stopped: abortSubAgent(agentId) });
});

// 停止该会话下所有运行中的子代理
subagentRouter.post('/sessions/:id/subagents/abort', (req: Request, res: Response): void => {
  const sessionId = String(req.params.id);
  if (!ensureOwnership(req, res, sessionId)) return;
  res.json({ success: true, stopped: abortSessionSubAgents(sessionId) });
});
