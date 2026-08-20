import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';
import { sendSSEEvent, type SSEEvent } from '../utils/sse.js';
import { runInputHooks } from '../services/extension-loader.js';
import { config } from '../config.js';

export const chatRouter = Router();

chatRouter.post('/chat', async (req: Request, res: Response): Promise<void> => {
  // 瘦服务端模式：服务端不执行 Agent，由桌面客户端执行
  if (!config.webAgentEnabled) {
    res.status(503).json({ error: '服务端 Agent 已禁用，请使用桌面客户端' });
    return;
  }
  const userId = req.user!.id;
  const { message, sessionId, mode, systemPrompt, name, rebuild, history, modelOverrides, images } = req.body as {
    message?: string;
    sessionId?: string;
    mode?: 'chat' | 'agent';
    systemPrompt?: string;
    name?: string;
    rebuild?: boolean;
    history?: { role: string; content: string }[];
    modelOverrides?: { id?: string; baseUrl?: string; apiKey?: string; thinkingLevel?: string; maxTokens?: number };
    images?: { type: string; data: string; mimeType: string }[];
  };

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: '缺少必填参数: message' });
    return;
  }

  // 扩展 input 钩子：用户消息发送前可转换（替换文本后进 agent；钩子异常不影响发送）
  const effectiveMessage = await runInputHooks(message, sessionId);

  const mgr = getSessionManager();

  // 获取或创建会话
  let session = sessionId ? mgr.getSession(sessionId) : undefined;
  let isNewSession = false;
  const effectiveMode = mode ?? 'chat';
  let effectiveName = name;
  let rebuildSessionId: string | undefined; // rebuild 时复用旧 ID

  // 检查会话所有权
  if (session && sessionId && !mgr.sessionBelongsToUser(sessionId, userId)) {
    session = undefined;
  }

  // rebuild: 不管 session 是否存在，都要用 history 重建
  if (rebuild && history && history.length > 0) {
    console.log(`[ChatRoute] Rebuild requested, history length=${history.length}, sessionInMem=${!!session}`);
    if (session) {
      mgr.deleteSession(sessionId!);
    } else if (sessionId) {
      // session 不在内存中（重启后），从 DB 清理并保存旧名称
      const oldInfo = mgr.getSessionInfo(sessionId);
      if (oldInfo) effectiveName = effectiveName || oldInfo.name;
      mgr.deleteSession(sessionId);
    }
    session = undefined;
    rebuildSessionId = sessionId; // 复用旧 ID
  } else if (session && session.mode !== effectiveMode) {
    console.log(`[ChatRoute] Mode mismatch, recreating session`);
    mgr.deleteSession(sessionId!);
    session = undefined;
  }

  if (!session) {
    const newId = mgr.createSession(userId, effectiveMode, systemPrompt, effectiveName, history, modelOverrides, rebuildSessionId);
    session = mgr.getSession(newId);
    isNewSession = true;
  }

  if (!session) {
    res.status(500).json({ error: '无法创建会话' });
    return;
  }

  // 根治语义：会话模型跟随最近一次请求的 modelOverrides —— 请求带 modelOverrides 且会话
  // 已存在时，比较会话当前模型与目标模型（id/baseUrl/apiKey），不同则重建会话（保留全部
  // 消息历史）切到目标模型继续处理。前端新旧版本均生效：旧前端/Electron 客户端建会话时
  // 不带 overrides（落到默认模型），发消息带上 overrides 即可即时切换，不再报
  // Failed to load model。（无 sessionId 的自动创建路径不变：createSession 已应用 overrides）
  if (session && modelOverrides) {
    const rebuilt = mgr.applyModelOverrides(session.sessionId, modelOverrides);
    if (rebuilt) {
      console.log(`[ChatRoute] Session ${session.sessionId} rebuilt to target model per modelOverrides`);
      session = mgr.getSession(session.sessionId)!;
    }
  }

  // 手动写 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  req.socket?.setNoDelay(true);

  let sseCount = 0;
  let clientConnected = true;
  let ended = false;

  function endResponse() {
    if (ended) return;
    ended = true;
    try {
      // 持久化会话
      mgr.persistSession(session!.sessionId);
      sendSSEEvent(res, 'done', { type: 'done' });
      res.end();
    } catch {}
  }

  const onSse = (event: unknown): void => {
    if (!clientConnected) return;
    try {
      sseCount++;
      sendSSEEvent(res, 'data', event as SSEEvent);
    } catch (err) {
      console.error(`[ChatRoute] SSE send error:`, err);
    }
  };

  const onDone = (): void => {
    console.log(`[ChatRoute] onDone, sent ${sseCount} events`);
    endResponse();
  };

  session.events.on('sse', onSse);
  session.events.on('done', onDone);

  req.on('close', () => {
    // 不在 close 时移除监听器
  });

  res.on('close', () => {
    clientConnected = false;
    console.log(`[ChatRoute] connection closed, sent ${sseCount} events`);
    session!.events.removeListener('sse', onSse);
    session!.events.removeListener('done', onDone);
    // 连接关闭时也持久化
    mgr.persistSession(session!.sessionId);
  });

  // 首次发消息时，如果会话名还是默认的"对话 N"，用消息前10个字符替换
  if (session.messages.length === 0 && !rebuildSessionId) {
    const info = mgr.getSessionInfo(session.sessionId);
    if (info && info.name.startsWith('对话 ')) {
      const autoName = effectiveMessage.trim().slice(0, 10);
      mgr.updateSession(session.sessionId, { name: autoName });
      if (clientConnected) {
        try {
          sendSSEEvent(res, 'data', { type: 'session_updated', sessionId: session.sessionId, name: autoName });
        } catch {}
      }
    }
  }

  // 新会话通知
  if (isNewSession) {
    const info = mgr.getSessionInfo(session.sessionId);
    if (clientConnected) {
      try {
        sendSSEEvent(res, 'data', { type: 'session_created', sessionId: session.sessionId, name: info?.name });
      } catch {}
    }
  }

  // 异步执行消息处理（经 input 钩子转换后的文本）
  session.processMessage(effectiveMessage, images as any).catch((err: unknown) => {
    console.error('[ChatRoute] processMessage error:', err);
  });
});
