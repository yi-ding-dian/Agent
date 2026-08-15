/**
 * WebSocket 客户端
 * 自动重连 + 心跳保活 + 认证首消息
 */
import { getApiBaseUrl } from './api-config';

export type WSStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WSMessage {
  type?: string;
  [key: string]: unknown;
}

type EventHandler = (msg: WSMessage) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private token = '';
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<EventHandler>();
  private _status: WSStatus = 'disconnected';
  private statusListeners = new Set<(status: WSStatus) => void>();
  private intentionalClose = false;

  get status(): WSStatus {
    return this._status;
  }

  private setStatus(status: WSStatus): void {
    this._status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  onStatusChange(fn: (status: WSStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onEvent(fn: EventHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  connect(token: string): void {
    this.token = token;
    this.intentionalClose = false;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, '用户断开');
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Cannot send, socket not open');
    }
  }

  // ─── 内部 ─────────────────────────────────

  private doConnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.setStatus('connecting');
    const base = getApiBaseUrl();
    const wsUrl = base.replace(/^http/, 'ws') + '/ws';
    console.log(`[WS] Connecting to ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[WS] Connected, sending auth');
      // 首条消息：认证
      this.ws!.send(JSON.stringify({ type: 'auth', token: this.token }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data as string);

        // 处理认证响应
        if (msg.type === 'auth_ok') {
          console.log('[WS] Authenticated');
          this.setStatus('connected');
          this.reconnectDelay = 1000; // 重置重连延迟
          this.startHeartbeat();
          return;
        }

        if (msg.type === 'error') {
          console.error('[WS] Server error:', msg.message);
          return;
        }

        // 分发给事件处理器
        for (const handler of this.handlers) {
          try {
            handler(msg);
          } catch (err) {
            console.error('[WS] Handler error:', err);
          }
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Closed: code=${event.code} reason=${event.reason}`);
      this.clearTimers();
      this.setStatus('disconnected');
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Connection error:', err);
      this.setStatus('error');
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// 单例
let instance: WSClient | null = null;

export function getWSClient(): WSClient {
  if (!instance) {
    instance = new WSClient();
  }
  return instance;
}
