/**
 * Electron 主进程 IPC 注册表
 *
 * 渲染进程（前端）在 Electron 模式下通过这些通道与主进程的 Agent 引擎交互。
 * 通道分三类：
 *  - chat/confirm/steer: 会话执行控制
 *  - config: 本地 Agent 配置（LLM 直连参数）
 *  - fs/engine: 目录浏览与引擎状态
 */
import { ipcMain, type BrowserWindow } from 'electron';

/** 引擎最小接口（运行时来自 agent-engine.mjs） */
export interface EngineLike {
  init(cfg: unknown): Promise<{ initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] }>;
  getOrCreate(sessionId: string, opts: unknown): unknown;
  send(sessionId: string, message: string, images?: unknown[]): Promise<void>;
  steer(sessionId: string, message: string): void;
  abort(sessionId: string): void;
  resolveConfirmation(sessionId: string, decision: string): boolean;
  disposeSession(sessionId: string): void;
  getSessionMessages(sessionId: string): unknown[];
  get status(): { initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] };
  dispose(): void;
}

/** 本地 Agent 配置（userData/agent-config.json） */
export interface LocalAgentConfig {
  model: string;
  base_url: string;
  api_key: string;
  system_prompt: string;
  work_dir: string;
  thinking_level: string;
  enable_thinking: boolean;
  thinking_budget: number;
  preserve_thinking: boolean;
  llm_timeout_ms: number;
  max_tokens: number;
}

export interface IpcDeps {
  engine: EngineLike;
  /** 远程服务端地址，如 http://<server-host>:7980 */
  getServerUrl: () => string | null;
  getToken: () => string | null;
  setToken: (t: string | null) => void;
  getWindow: () => BrowserWindow | null;
  loadConfig: () => LocalAgentConfig;
  saveConfig: (cfg: LocalAgentConfig) => void;
}

/** 校验参数为字符串，非法则抛错 */
function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数无效: ${name}`);
  return v;
}

/**
 * 会话同步：将引擎内存消息 POST 到服务端持久化
 * 幂等覆盖写，失败仅告警（不阻断聊天）
 */
export async function syncSession(deps: IpcDeps, sessionId: string): Promise<void> {
  const serverUrl = deps.getServerUrl();
  const token = deps.getToken();
  if (!serverUrl || !token) {
    console.warn('[Ipc] sync skipped: 无服务端地址或 token');
    return;
  }
  try {
    const messages = deps.engine.getSessionMessages(sessionId);
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: 'agent', messages }),
    });
    if (!res.ok) {
      console.warn(`[Ipc] sync failed: HTTP ${res.status}`);
    } else {
      console.log(`[Ipc] session ${sessionId} synced (${messages.length} messages)`);
    }
  } catch (err) {
    console.warn('[Ipc] sync error:', err instanceof Error ? err.message : err);
  }
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { engine } = deps;

  // ── 会话执行 ─────────────────────────────────────────────

  ipcMain.handle('chat:send', async (_ev, payload: unknown) => {
    try {
      const p = payload as {
        token?: string;
        sessionId?: string;
        message?: string;
        images?: unknown[];
        mode?: 'chat' | 'agent';
        modelOverrides?: { id?: string; baseUrl?: string; apiKey?: string };
        history?: { role: string; content: string }[];
        rebuild?: boolean;
      };
      const sessionId = requireString(p?.sessionId, 'sessionId');
      const message = requireString(p?.message, 'message');
      const mode = p?.mode === 'agent' ? 'agent' : 'chat';

      // 缓存 token 供会话同步使用
      if (typeof p?.token === 'string' && p.token) deps.setToken(p.token);

      // rebuild: 销毁旧会话并用 history 重建
      if (p?.rebuild) {
        engine.disposeSession(sessionId);
      }
      const history = Array.isArray(p?.history) ? p.history : undefined;
      engine.getOrCreate(sessionId, {
        mode,
        modelOverrides: p?.modelOverrides,
        initialMessages: history,
      });

      // 异步执行，事件通过 agent:event 推送
      void engine.send(sessionId, message, p?.images);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:abort', (_ev, payload: unknown) => {
    const sessionId = (payload as { sessionId?: string })?.sessionId;
    if (typeof sessionId === 'string') engine.abort(sessionId);
    return { ok: true };
  });

  ipcMain.handle('chat:steer', (_ev, payload: unknown) => {
    const p = payload as { sessionId?: string; message?: string };
    try {
      const sessionId = requireString(p?.sessionId, 'sessionId');
      const message = requireString(p?.message, 'message');
      engine.steer(sessionId, message);
      return { success: true, queued: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('chat:dispose', (_ev, payload: unknown) => {
    const sessionId = (payload as { sessionId?: string })?.sessionId;
    if (typeof sessionId === 'string') {
      engine.disposeSession(sessionId);
    }
    return { ok: true };
  });

  ipcMain.handle('chat:extension-ui-response', () => {
    // 扩展 UI 交互暂不支持（服务端同样静默忽略），保持通道存在
    return { ok: true };
  });

  ipcMain.handle('confirm:decision', (_ev, payload: unknown) => {
    const p = payload as { sessionId?: string; decision?: string };
    try {
      const sessionId = requireString(p?.sessionId, 'sessionId');
      const decision = requireString(p?.decision, 'decision');
      const ok = engine.resolveConfirmation(sessionId, decision);
      return { ok };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── 本地配置 ─────────────────────────────────────────────

  ipcMain.handle('config:get', () => {
    return deps.loadConfig();
  });

  ipcMain.handle('config:set', (_ev, payload: unknown) => {
    const cfg = payload as LocalAgentConfig;
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: '配置无效' };
    deps.saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('config:test-llm', async (_ev, payload: unknown) => {
    const p = payload as { baseUrl?: string; apiKey?: string; model?: string };
    const baseUrl = (p?.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return { success: false, error: '缺少 baseUrl' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/models`, {
        signal: controller.signal,
        headers: p?.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      });
      clearTimeout(timer);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = (data.data || []).map((m) => m.id);
      const found = p?.model ? models.includes(p.model) : false;
      return { success: true, models, found };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── 目录浏览 / 引擎状态 ──────────────────────────────────

  ipcMain.handle('fs:listDirectory', (_ev, payload: unknown) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dirPath = (payload as { path?: string })?.path || deps.loadConfig().work_dir;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const directories = entries.filter((e: { isDirectory: () => boolean }) => e.isDirectory()).map((e: { name: string }) => e.name).sort();
      const files = entries.filter((e: { isDirectory: () => boolean }) => !e.isDirectory()).map((e: { name: string }) => e.name).sort();
      return { path: dirPath, parent: path.dirname(dirPath), directories, files };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('engine:get-status', () => {
    return engine.status;
  });
}
