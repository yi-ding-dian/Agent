import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';
import { getTokenUsage, compactMessages } from '../services/token-tracker.js';
import { getGlobalModel } from '../config/global-model-config.js';
import { createQwenModel } from '../agent/llm-config.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export const tokenRouter = Router();

/** 从请求中获取当前用户 ID（由 auth 中间件设置） */
function getUserId(req: Request): number {
  return req.user!.id;
}

/**
 * 解析会话消息：优先内存会话（AgentMessage[] 结构完整），否则回退数据库。
 * 内存会话存在但消息为空（sync 只写 DB 的场景）时同样回退 DB，与
 * session-manager.getSessionHistory / session.routes DELETE messages 的回退策略一致。
 * 返回 null 仅当会话不存在（含 DB 中无该会话）——调用方已先经
 * sessionBelongsToUser（内存 + DB 回退）校验归属，故此处默认消息可读。
 */
function resolveSessionMessages(sessionId: string): AgentMessage[] | null {
  const mgr = getSessionManager();
  const session = mgr.getSession(sessionId);
  const messages =
    session && session.messages && session.messages.length > 0
      ? session.messages
      : mgr.loadSessionMessages(sessionId);
  return messages && messages.length > 0 ? (messages as AgentMessage[]) : [];
}

/**
 * 压缩摘要使用的模型：
 * - 内存会话：会话主模型（与创建/发消息一致）
 * - DB-only 会话（服务重启后 / Electron sync）：用户全局默认模型构造
 * - 都没有：返回 undefined → compactMessages 跳过 LLM 直接走确定性摘要兜底
 */
function resolveCompactModel(
  sessionId: string,
  userId: number,
): { model: any; source: 'session' | 'global' | 'none' } {
  const mgr = getSessionManager();
  const session = mgr.getSession(sessionId);
  if (session) return { model: session.model, source: 'session' };
  const global = getGlobalModel(userId);
  if (global && global.id && global.baseUrl) {
    return {
      model: createQwenModel({ id: global.id, baseUrl: global.baseUrl, apiKey: global.apiKey }),
      source: 'global',
    };
  }
  return { model: undefined, source: 'none' };
}

/** 获取会话 token 使用情况（支持 DB-only 持久化会话） */
tokenRouter.get('/sessions/:id/tokens', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const sessionId = String(req.params.id);
  const mgr = getSessionManager();

  // 鉴权：内存会话查 userId，DB-only 会话回退数据库 owner（sessionBelongsToUser 已有 DB 回退）
  if (!mgr.sessionBelongsToUser(sessionId, userId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }

  const messages = resolveSessionMessages(sessionId);
  if (!messages) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }

  res.json(getTokenUsage(messages));
});

/** 手动触发压缩（支持 DB-only 持久化会话） */
tokenRouter.post('/sessions/:id/compact', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const sessionId = String(req.params.id);
  const mgr = getSessionManager();

  // 鉴权：DB-only 会话同样校验归属（sessionBelongsToUser 已有 DB 回退）
  if (!mgr.sessionBelongsToUser(sessionId, userId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }

  const messages = resolveSessionMessages(sessionId);
  if (!messages) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }

  try {
    // 手动压缩：force=true（跳过阈值/冷却/防抖）
    const { model } = resolveCompactModel(sessionId, userId);
    const result = await compactMessages(messages, {
      model,
      sessionId,
      force: true,
    });

    if (result.compacted) {
      // 写回：内存会话 → replaceMessages + DB 持久化；DB-only 会话 → 直接更新数据库
      if (!mgr.persistMessages(sessionId, result.messages)) {
        res.status(500).json({ error: '消息持久化失败' });
        return;
      }
    }

    // 压缩后的消息数/占用：内存会话已替换则取内存，DB-only 取返回结果
    const afterMessages = mgr.getSession(sessionId)?.messages ?? result.messages;
    const usage = getTokenUsage(afterMessages);
    res.json({
      compacted: result.compacted,
      ...usage,
      savedTokens: result.savedTokens,
      summarySource: result.summarySource,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
