import path from 'node:path';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initDatabase } from './db/database.js';
import { initSessionManager, getSessionManager } from './services/session-manager.js';
import { initExtensionLoader, runInputHooks } from './services/extension-loader.js';
import { initMcpBridge } from './services/mcp-bridge.js';
import { initSkillsLoader } from './services/skills-loader.js';
import { UserRepository } from './db/user-repository.js';
import { WSServer } from './ws/ws-server.js';

// 全局未处理 Promise 拒绝兜底
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error.stack);
});

// 全局引用，供其他模块使用
let wsServer: WSServer;

export function getWSServer(): WSServer {
  return wsServer;
}

async function main() {
  // 初始化数据目录和数据库
  const dataDir = path.resolve(config.dataDir);
  console.log(`[Server] Data directory: ${dataDir}`);

  await initDatabase(dataDir);

  // 确保默认管理员存在
  const userRepo = new UserRepository();
  userRepo.ensureAdmin(config.adminAccount, config.adminPassword);

  // 初始化会话管理器
  initSessionManager();

  // 初始化扩展加载器（扫描 extensions/ 目录加载 Pi 扩展）
  const extensionsDir = path.resolve(config.dataDir, '..', 'extensions');
  await initExtensionLoader(extensionsDir);

  // 初始化技能加载器（扫描 .pi/skills/ 目录）
  const projectRoot = path.resolve(config.dataDir, '..');
  initSkillsLoader(projectRoot);

  // 初始化 MCP 桥接（启动 MCP server 子进程，发现工具）
  const mcpDir = path.resolve(config.dataDir, '..', 'mcp');
  await initMcpBridge(mcpDir).catch((err) => {
    console.warn(`[Server] MCP 桥接初始化失败（跳过）:`, err.message);
  });

  // 前端静态文件路径
  const frontendDir = path.resolve(config.frontendDir);

  // 创建 Express 应用
  const app = createApp(frontendDir);

  // 创建 HTTP 服务器
  const httpServer = createServer(app);

  // 初始化 WebSocket 服务器
  wsServer = new WSServer(httpServer);

  // 注册 WS 消息处理器
  wsServer.on('chat_message', async (socket, msg) => {
    // 瘦服务端模式：服务端不执行 Agent，由桌面客户端执行
    if (!config.webAgentEnabled) {
      wsServer.sendToConnection(socket.ws, { type: 'error', message: '服务端 Agent 已禁用，请使用桌面客户端' });
      return;
    }
    const mgr = getSessionManager();
    const message = msg.message as string;
    const sessionId = msg.sessionId as string | undefined;
    const mode = (msg.mode as 'chat' | 'agent') || 'chat';
    const modelOverrides = msg.modelOverrides as { id?: string; baseUrl?: string; apiKey?: string; maxTokens?: number } | undefined;
    const rebuild = msg.rebuild as boolean | undefined;
    let history = msg.history as { role: string; content: string }[] | undefined;
    const images = msg.images as { type: string; data: string; mimeType: string }[] | undefined;

    if (!message || typeof message !== 'string') {
      wsServer.sendToConnection(socket.ws, { type: 'error', message: '缺少必填参数: message' });
      return;
    }

    // 扩展 input 钩子：用户消息发送前可转换（与 chat/execute 路由同一挂点；钩子异常不影响发送）
    const effectiveMessage = await runInputHooks(message, sessionId);

    let session = sessionId ? mgr.getSession(sessionId) : undefined;
    let isNewSession = false;
    let rebuildSessionId: string | undefined;

    if (session && sessionId && !mgr.sessionBelongsToUser(sessionId, socket.userId)) {
      session = undefined;
    }

    // rebuild: 不管 session 是否存在，都要用 history 重建
    if (rebuild && history && history.length > 0) {
      console.log(`[WS] Rebuild requested, history=${history.length}, sessionInMem=${!!session}`);
      if (session) {
        mgr.deleteSession(sessionId!);
      } else if (sessionId) {
        mgr.deleteSession(sessionId);
      }
      session = undefined;
      rebuildSessionId = sessionId;
    } else if (session && session.mode !== mode) {
      // 模式切换：保留消息历史，用相同 sessionId 重建新模式的会话
      const oldHistory = session.messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content :
          Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : String(m.content || ''),
        timestamp: m.timestamp || Date.now(),
      }));
      mgr.deleteSession(sessionId!);
      session = undefined;
      history = oldHistory;
      rebuildSessionId = sessionId;
    }

    if (!session) {
      const newId = mgr.createSession(socket.userId, mode, undefined, undefined, history, modelOverrides, rebuildSessionId);
      session = mgr.getSession(newId);
      isNewSession = true;
    }

    if (!session) {
      wsServer.sendToConnection(socket.ws, { type: 'error', message: '无法创建会话' });
      return;
    }

    // 根治语义：会话模型跟随最近一次请求的 modelOverrides（与 chat/execute 路由一致）——
    // 会话已存在且请求带 modelOverrides 时，模型不同则重建会话（保留全部历史）切到目标模型。
    if (session && modelOverrides) {
      const rebuilt = mgr.applyModelOverrides(session.sessionId, modelOverrides);
      if (rebuilt) {
        console.log(`[WS] Session ${session.sessionId} rebuilt to target model per modelOverrides`);
        session = mgr.getSession(session.sessionId)!;
      }
    }

    const finalSessionId = session.sessionId;

    // 首次发消息时，如果会话名还是默认的"对话 N"，用消息前10个字符替换
    if (session.messages.length === 0 && !rebuildSessionId) {
      const info = mgr.getSessionInfo(finalSessionId);
      if (info && info.name.startsWith('对话 ')) {
        const autoName = effectiveMessage.trim().slice(0, 10);
        mgr.updateSession(finalSessionId, { name: autoName });
        wsServer.sendToConnection(socket.ws, {
          type: 'session_updated', sessionId: finalSessionId, name: autoName,
        });
      }
    }

    // 新会话通知
    if (isNewSession) {
      const info = mgr.getSessionInfo(finalSessionId);
      wsServer.sendToConnection(socket.ws, {
        type: 'session_created', sessionId: finalSessionId, name: info?.name,
      });
    }

    // 转发 Agent 事件到 WS 客户端
    const onSse = (event: unknown) => {
      wsServer.sendToConnection(socket.ws, event as Record<string, unknown>);
    };
    const onDone = () => {
      session!.events.removeListener('sse', onSse);
      session!.events.removeListener('done', onDone);
      mgr.persistSession(finalSessionId);
      wsServer.sendToConnection(socket.ws, { type: 'done' });
    };

    session.events.on('sse', onSse);
    session.events.on('done', onDone);

    // 处理客户端断开
    socket.ws.on('close', () => {
      session?.events.removeListener('sse', onSse);
      session?.events.removeListener('done', onDone);
      mgr.persistSession(finalSessionId);
    });

    // 执行（经 input 钩子转换后的文本）
    session.processMessage(effectiveMessage, images as any).catch((err: unknown) => {
      console.error('[WS chat_message] processMessage error:', err);
      wsServer.sendToConnection(socket.ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  });

  wsServer.on('abort', async (socket, msg) => {
    const sessionId = msg.sessionId as string;
    if (!sessionId) return;
    const mgr = getSessionManager();
    const session = mgr.getSession(sessionId);
    if (session && mgr.sessionBelongsToUser(sessionId, socket.userId)) {
      session.abort();
    }
  });

  wsServer.on('ping', (socket) => {
    wsServer.sendToConnection(socket.ws, { type: 'pong' });
  });

  // 启动服务
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[Server] MyAgent server running on http://0.0.0.0:${config.port}`);
    console.log(`[Server] WebSocket server running on ws://0.0.0.0:${config.port}/ws`);
    console.log(`[Server] LLM: ${config.qwenBaseUrl || '未配置'} / ${config.qwenModel || '未配置'}`);
    console.log(`[Server] Frontend: ${frontendDir}`);
    console.log(`[Server] Admin page: http://0.0.0.0:${config.port}/admin`);
  });
}

main().catch((err) => {
  console.error('[FATAL] Startup failed:', err);
  process.exit(1);
});
