/**
 * WebSocket 服务器
 * HTTP upgrade、消息路由、心跳保活
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { validateToken } from '../auth/token-store.js';
import { UserRepository } from '../db/user-repository.js';

export interface WSMessage {
  type: string;
  payload?: unknown;
  [key: string]: unknown;
}

type MessageHandler = (socket: AuthedSocket, msg: WSMessage) => void | Promise<void>;

export interface AuthedSocket {
  ws: WebSocket;
  userId: number;
  username: string;
  authenticatedAt: number;
}

export class WSServer {
  private wss: WebSocketServer;
  private handlers = new Map<string, MessageHandler>();
  private authedSockets = new Map<WebSocket, AuthedSocket>();
  private userRepo = new UserRepository();
  private heartbeatInterval: ReturnType<typeof setInterval>;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.wss.clients) {
        // keep alive
      }
    }, 30000);

    console.log('[WSServer] WebSocket server initialized on /ws');
  }

  on(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  sendToUser(userId: number, msg: unknown): void {
    for (const [ws, socket] of this.authedSockets) {
      if (socket.userId === userId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }
  }

  sendToConnection(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  connectionCount(): number {
    return this.authedSockets.size;
  }

  close(): void {
    clearInterval(this.heartbeatInterval);
    this.wss.close();
    console.log('[WSServer] Closed');
  }

  // ─── 内部 ───────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let authed = false;
    const authTimeout = setTimeout(() => {
      if (!authed) {
        ws.send(JSON.stringify({ type: 'error', message: '认证超时，请在 10 秒内发送 {"type":"auth","token":"..."}' }));
        ws.close(4001, '认证超时');
      }
    }, 10000);

    ws.on('message', (raw: Buffer) => {
      try {
        const msg: WSMessage = JSON.parse(raw.toString());

        if (!authed) {
          if (msg.type === 'auth' && msg.token) {
            const userId = validateToken(msg.token as string);
            if (userId !== null) {
              const user = this.userRepo.findById(userId);
              if (user) {
                authed = true;
                clearTimeout(authTimeout);
                const socket: AuthedSocket = {
                  ws,
                  userId,
                  username: user.username,
                  authenticatedAt: Date.now(),
                };
                this.authedSockets.set(ws, socket);
                ws.send(JSON.stringify({ type: 'auth_ok', userId, username: user.username }));
                console.log(`[WS] User ${user.username} authenticated`);
                return;
              }
            }
          }
          ws.send(JSON.stringify({ type: 'error', message: '认证失败：Token 无效或已过期' }));
          ws.close(4002, '认证失败');
          return;
        }

        const socket = this.authedSockets.get(ws);
        if (!socket) return;

        const handler = this.handlers.get(msg.type);
        if (handler) {
          Promise.resolve(handler(socket, msg)).catch((err) => {
            console.error(`[WS] Handler error for ${msg.type}:`, err);
            this.sendToConnection(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
          });
        } else {
          console.warn(`[WS] Unknown message type: ${msg.type}`);
        }
      } catch {
        if (authed) {
          ws.send(JSON.stringify({ type: 'error', message: '消息格式无效' }));
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.authedSockets.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Connection error:`, err.message);
    });
  }
}
