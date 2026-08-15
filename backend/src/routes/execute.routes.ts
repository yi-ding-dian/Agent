import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';
import { sendSSEEvent, type SSEEvent } from '../utils/sse.js';
import { runInputHooks } from '../services/extension-loader.js';
import { config } from '../config.js';

const EXECUTE_SYSTEM_PROMPT = '你是一个代码执行助手。请根据用户的指令，使用可用的工具执行代码、读取或写入文件等操作。请始终使用中文与用户交流。';

export const executeRouter = Router();

executeRouter.post('/execute', async (req: Request, res: Response): Promise<void> => {
  // 瘦服务端模式：服务端不执行 Agent，由桌面客户端执行
  if (!config.webAgentEnabled) {
    res.status(503).json({ error: '服务端 Agent 已禁用，请使用桌面客户端' });
    return;
  }
  const userId = req.user!.id;
  const { instruction, sessionId, modelOverrides } = req.body as {
    instruction?: string;
    sessionId?: string;
    modelOverrides?: { id?: string; baseUrl?: string; apiKey?: string };
  };

  if (!instruction || typeof instruction !== 'string') {
    res.status(400).json({ error: '缺少必填参数: instruction' });
    return;
  }

  // 扩展 input 钩子：指令发送前可转换（钩子异常不影响发送）
  const effectiveInstruction = await runInputHooks(instruction, sessionId);

  const mgr = getSessionManager();

  // 获取或创建会话（固定为 agent 模式）
  let session = sessionId ? mgr.getSession(sessionId) : undefined;
  if (session && sessionId && !mgr.sessionBelongsToUser(sessionId, userId)) {
    session = undefined;
  }
  if (!session) {
    const newId = mgr.createSession(userId, 'agent', EXECUTE_SYSTEM_PROMPT, undefined, undefined, modelOverrides);
    session = mgr.getSession(newId);
  }

  if (!session) {
    res.status(500).json({ error: '无法创建会话' });
    return;
  }

  // 根治语义：会话模型跟随最近一次请求的 modelOverrides（与 chat 路由一致）——
  // 会话已存在且请求带 modelOverrides 时，模型不同则重建会话（保留全部历史）切到目标模型。
  if (session && modelOverrides) {
    const rebuilt = mgr.applyModelOverrides(session.sessionId, modelOverrides);
    if (rebuilt) {
      console.log(`[ExecuteRoute] Session ${session.sessionId} rebuilt to target model per modelOverrides`);
      session = mgr.getSession(session.sessionId)!;
    }
  }

  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  req.socket?.setNoDelay(true);

  let ended = false;

  function endResponse() {
    if (ended) return;
    ended = true;
    try {
      mgr.persistSession(session!.sessionId);
      sendSSEEvent(res, 'done', { type: 'done' });
      res.end();
    } catch {}
  }

  const onSse = (event: unknown): void => {
    try {
      sendSSEEvent(res, 'data', event as SSEEvent);
    } catch (err) {
      console.error(`[ExecuteRoute] SSE send error:`, err);
    }
  };

  const onDone = (): void => {
    console.log(`[ExecuteRoute] onDone`);
    endResponse();
  };

  session.events.on('sse', onSse);
  session.events.on('done', onDone);

  req.on('close', () => {});

  res.on('close', () => {
    session!.events.removeListener('sse', onSse);
    session!.events.removeListener('done', onDone);
    mgr.persistSession(session!.sessionId);
  });

  // 异步执行（经 input 钩子转换后的指令）
  session.processMessage(effectiveInstruction).catch((err: unknown) => {
    console.error('[ExecuteRoute] processMessage error:', err);
  });
});
