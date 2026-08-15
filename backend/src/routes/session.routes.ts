import { Router, text as expressText } from 'express';
import type { Request, Response } from 'express';
import { getSessionManager } from '../services/session-manager.js';
import { serializeSessionToJsonl, parseSessionJsonl } from '../services/session-jsonl.js';

export const sessionRouter = Router();

/** 从请求中获取当前用户 ID（由 auth 中间件设置） */
function getUserId(req: Request): number {
  return req.user!.id;
}

// GET /api/sessions — 获取当前用户的会话列表（含持久化的）
sessionRouter.get('/sessions', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  const mgr = getSessionManager();

  // 合并内存会话和持久化会话
  const memSessions = mgr.listSessions(userId);
  const dbSessions = mgr.loadUserSessions(userId);

  // 以数据库记录为主，内存中的覆盖
  const sessionMap = new Map<string, { id: string; name: string; mode: string; createdAt: string; lastActiveAt: string }>();
  for (const s of dbSessions) {
    sessionMap.set(s.id, {
      id: s.id,
      name: s.name,
      mode: s.mode,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    });
  }
  for (const s of memSessions) {
    sessionMap.set(s.id, {
      id: s.id,
      name: s.name,
      mode: s.mode,
      createdAt: (s as any).createdAt instanceof Date ? (s as any).createdAt.toISOString() : String((s as any).createdAt),
      lastActiveAt: (s as any).lastActiveAt instanceof Date ? (s as any).lastActiveAt.toISOString() : String((s as any).lastActiveAt),
    });
  }

  const sessions = Array.from(sessionMap.values()).sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
  );

  res.json({ sessions });
});

// POST /api/sessions — 创建会话
sessionRouter.post('/sessions', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  const { name, mode, systemPrompt, modelOverrides } = req.body as {
    name?: string;
    mode?: 'chat' | 'agent';
    systemPrompt?: string;
    modelOverrides?: { id?: string; baseUrl?: string; apiKey?: string };
  };
  const mgr = getSessionManager();
  // 透传 modelOverrides：新会话创建时即应用前端当前选中的默认模型配置。
  // 否则会出现"建会话用 Qwen、发消息想用 DeepSeek"的错配——agent-factory 会用默认
  // 配置加载模型（本地 Qwen 未加载）→ Failed to load model。initialMessages 传
  // undefined 保持 createSession 参数位置对齐（第 6 参为 modelOverrides）。
  const id = mgr.createSession(userId, mode ?? 'chat', systemPrompt, name, undefined, modelOverrides);
  const info = mgr.getSessionInfo(id);
  res.status(201).json(info);
});

// GET /api/sessions/:id — 会话详情（含消息）
sessionRouter.get('/sessions/:id', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const id = String(req.params.id);
  const mgr = getSessionManager();

  // 检查会话是否属于当前用户
  if (!mgr.sessionBelongsToUser(id, userId)) {
    // 可能是持久化的旧会话，检查数据库
    const dbMessages = mgr.loadSessionMessages(id);
    if (dbMessages) {
      res.json({ id, messages: dbMessages });
      return;
    }
    res.status(404).json({ error: '会话未找到' });
    return;
  }

  const messages = mgr.getSessionHistory(id);
  if (!messages) {
    res.status(404).json({ error: '会话未找到' });
    return;
  }
  const info = mgr.getSessionInfo(id);
  res.json({ ...info, messages });
});

// GET /api/sessions/:id/export — 导出会话为 JSONL 文件（每行一条消息）
sessionRouter.get('/sessions/:id/export', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const id = String(req.params.id);
  const mgr = getSessionManager();

  if (!mgr.sessionBelongsToUser(id, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return;
  }

  const info = mgr.getSessionInfo(id);
  const messages = mgr.getSessionHistory(id);
  if (!info || !messages) {
    res.status(404).json({ error: '会话未找到' });
    return;
  }

  const jsonl = serializeSessionToJsonl(info, messages as Record<string, unknown>[]);
  const filename = `session-${id}.jsonl`;
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(jsonl);
});

// POST /api/sessions/import — 导入 JSONL 会话（raw body 为 JSONL 文本）→ 创建新会话
// 请求体示例：{"type":"meta","name":"...","mode":"agent"}\n{"type":"message","role":"user",...}
sessionRouter.post(
  '/sessions/import',
  expressText({ type: ['text/plain', 'application/jsonl', 'application/x-ndjson'], limit: '20mb' }),
  (req: Request, res: Response): void => {
    const userId = getUserId(req);
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!raw.trim()) {
      res.status(400).json({ error: '请求体不能为空' });
      return;
    }

    const { meta, messages } = parseSessionJsonl(raw);
    if (messages.length === 0) {
      res.status(400).json({ error: '没有可导入的消息（JSONL 中不存在合法的 message 行）' });
      return;
    }

    // mode 取 meta（校验合法值），否则默认 agent；name 取 meta 或默认名
    const mode = meta?.mode === 'chat' || meta?.mode === 'agent' ? meta.mode : 'agent';
    const name = meta?.name || '导入的会话';

    const mgr = getSessionManager();
    const id = mgr.createSession(userId, mode, undefined, name);
    const ok = mgr.persistMessages(id, messages);
    if (!ok) {
      mgr.deleteSession(id);
      res.status(500).json({ error: '消息写入失败' });
      return;
    }

    console.log(`[SessionImport] userId=${userId} name=${name} mode=${mode} imported=${messages.length}`);
    res.status(201).json({ id, name, mode, imported: messages.length });
  },
);

// PUT /api/sessions/:id — 更新会话（重命名等）
sessionRouter.put('/sessions/:id', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const id = String(req.params.id);
  const mgr = getSessionManager();

  if (!mgr.sessionBelongsToUser(id, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return;
  }

  const { name } = req.body as { name?: string };
  if (!name) {
    res.status(400).json({ error: '缺少必填参数: name' });
    return;
  }
  const ok = mgr.updateSession(id, { name });
  if (!ok) {
    res.status(404).json({ error: '会话未找到' });
    return;
  }
  res.json(mgr.getSessionInfo(id));
});

// DELETE /api/sessions/:id/messages — 删除一轮对话（用户提问 + 其 assistant/toolResult 回复）
// 请求体: { "index": number } — 第 index 条 user 消息（从 0 开始计数，仅统计 role === 'user' 的消息）
// 语义: 删除该 user 消息及其后连续的 assistant / toolResult 消息（直到下一条 user 消息之前），
//       即删除"一轮"完整对话；前端 ChatMessage 与后端数组结构不同（assistant 可能合并多条），
//       按 user 序号定位比按后端数组下标定位更可靠。
sessionRouter.delete('/sessions/:id/messages', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  const id = String(req.params.id);
  const { index } = req.body as { index?: unknown };

  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: '缺少必填参数: index（第 index 条 user 消息，从 0 开始）' });
    return;
  }

  const mgr = getSessionManager();
  if (!mgr.sessionBelongsToUser(id, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return;
  }

  // 优先使用内存会话消息，否则回退到数据库中的持久化消息。
  // 注意：内存会话存在但消息为空（sync 只写 DB 的场景）时同样回退 DB。
  const session = mgr.getSession(id);
  const messages: any[] =
    session && session.messages && session.messages.length > 0
      ? session.messages
      : ((mgr.loadSessionMessages(id) as any[]) ?? []);
  if (!messages || messages.length === 0) {
    res.status(404).json({ error: '会话未找到或没有消息' });
    return;
  }

  // 定位第 index 条 user 消息
  let userCount = 0;
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      if (userCount === index) {
        start = i;
        break;
      }
      userCount++;
    }
  }
  if (start === -1) {
    res.status(400).json({ error: `index 超出范围: 会话中共有 ${userCount} 条用户消息` });
    return;
  }

  // 删除范围: [start, end)，end 为下一条 user 消息的位置或数组末尾
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      end = i;
      break;
    }
  }
  const removedCount = end - start;
  const newMessages = messages.slice(0, start).concat(messages.slice(end));

  if (!mgr.persistMessages(id, newMessages)) {
    res.status(500).json({ error: '消息持久化失败' });
    return;
  }
  res.json({ success: true, removed: removedCount, messageCount: newMessages.length });
});

// DELETE /api/sessions/:id — 删除会话
sessionRouter.delete('/sessions/:id', (req: Request, res: Response): void => {
  const userId = getUserId(req);
  // Express 5 req.params 类型为 string | string[]，收窄为 string
  const id = String(req.params.id);
  const mgr = getSessionManager();

  if (!mgr.sessionBelongsToUser(id, userId)) {
    res.status(403).json({ error: '无权操作此会话' });
    return;
  }

  const deleted = mgr.deleteSession(id);
  if (!deleted) {
    res.status(404).json({ error: '会话未找到' });
    return;
  }
  res.json({ success: true, id });
});
