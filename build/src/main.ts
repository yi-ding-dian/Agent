import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { pathToFileURL } from 'url';
import { registerIpcHandlers, syncSession, type LocalAgentConfig } from './agent/ipc';

let mainWindow: BrowserWindow | null = null;

const SERVER_URL_FILE = 'server-url.json';
const AGENT_CONFIG_FILE = 'agent-config.json';

// ─── 引擎引用（懒加载） ─────────────────────────────────────
let engine: any = null;
let engineInitialized = false;
let syncToken: string | null = null;

function getServerUrlPath(): string {
  return path.join(app.getPath('userData'), SERVER_URL_FILE);
}

function getSavedServerUrl(): string | null {
  try {
    const p = getServerUrlPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.url || null;
    }
  } catch {}
  return null;
}

function setSavedServerUrl(url: string): void {
  const p = getServerUrlPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ url }), 'utf-8');
}

// ─── 本地 Agent 配置（LLM 直连参数） ────────────────────────

const DEFAULT_AGENT_CONFIG: LocalAgentConfig = {
  model: 'qwen3.6-35b-a3b-apex-quality',
  base_url: 'http://localhost:1234/v1',
  api_key: '',
  system_prompt: '',
  work_dir: '',
  thinking_level: 'medium',
  enable_thinking: true,
  thinking_budget: 1024,
  preserve_thinking: false,
  llm_timeout_ms: 120000,
  max_tokens: 65535,
};

/** 默认服务端地址（可在登录页「服务器设置」面板修改） */
const DEFAULT_SERVER_URL = 'http://localhost:7980';

/** 确保 server-url.json 存在（无连接页后由主进程维护默认值） */
function ensureServerUrl(): string {
  const saved = getSavedServerUrl();
  if (saved) return saved;
  setSavedServerUrl(DEFAULT_SERVER_URL);
  console.log('[ServerUrl] 使用默认服务端地址:', DEFAULT_SERVER_URL);
  return DEFAULT_SERVER_URL;
}

function getAgentConfigPath(): string {
  return path.join(app.getPath('userData'), AGENT_CONFIG_FILE);
}

function loadLocalConfig(): LocalAgentConfig {
  try {
    const p = getAgentConfigPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { ...DEFAULT_AGENT_CONFIG, ...data };
    }
  } catch (err) {
    console.warn('[Config] 读取本地配置失败:', err);
  }
  return { ...DEFAULT_AGENT_CONFIG };
}

function saveLocalConfig(cfg: LocalAgentConfig): void {
  const p = getAgentConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
  console.log('[Config] 本地配置已保存:', p);
}

// ─── Agent 引擎初始化 ───────────────────────────────────────

async function initAgentEngine(): Promise<void> {
  if (engineInitialized) return;
  try {
    // agent-engine.mjs 是 esbuild 打的 ESM 单文件，主进程用动态 import 加载。
    // 注意：tsc 编译 CJS 会把 import() 转成 require（不支持 file:// URL），
    // 因此用 Function 构造保留原生 dynamic import。
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
    const mod = await dynamicImport(pathToFileURL(path.join(__dirname, 'agent-engine.mjs')).href);
    engine = mod.agentEngine;

    const appPath = app.getAppPath();
    const cfg = loadLocalConfig();
    const result = await engine.init({
      workDir: cfg.work_dir || app.getPath('home'),
      mcpDir: path.join(appPath, '..', 'mcp'),
      extensionsDir: path.join(appPath, '..', 'extensions'),
      // initSkillsLoader 内部会拼接 .pi/skills，这里传项目根目录
      skillsDir: path.join(appPath, '..'),
      llm: { model: cfg.model, baseUrl: cfg.base_url, apiKey: cfg.api_key },
      thinkingLevel: cfg.thinking_level,
      enableThinking: cfg.enable_thinking,
      thinkingBudget: cfg.thinking_budget,
      preserveThinking: cfg.preserve_thinking,
      llmTimeoutMs: cfg.llm_timeout_ms,
      maxTokens: cfg.max_tokens,
    });
    engineInitialized = result.initialized;
    ipcDeps.engine = engine;
    console.log('[Engine] init result:', JSON.stringify(result));

    // 引擎事件 → 渲染进程（前端 handleSSEEvent 直接消费）
    engine.onEvent(({ sessionId, event }: { sessionId: string; event: { type: string } }) => {
      if (event.type === 'done') {
        // 对话结束，同步会话到服务端（尽力而为）
        void syncSession(ipcDeps, sessionId);
      }
      mainWindow?.webContents.send('agent:event', event);
    });

    // 引擎状态推送给渲染进程（Header 徽标用）
    mainWindow?.webContents.send('agent:engine-status', engine.status);
  } catch (err) {
    engineInitialized = false;
    console.error('[Engine] 初始化失败:', err);
  }
}

// ─── IPC 依赖（供 ipc.ts 使用） ─────────────────────────────

const ipcDeps = {
  engine: null as any,
  getServerUrl: () => getSavedServerUrl(),
  getToken: () => syncToken,
  setToken: (t: string | null) => { syncToken = t; },
  getWindow: () => mainWindow,
  loadConfig: loadLocalConfig,
  saveConfig: saveLocalConfig,
};

// ─── IPC handlers（server-url 相关，原有逻辑） ─────────────

function registerServerUrlHandlers(): void {
  ipcMain.handle('get-server-url', () => getSavedServerUrl());
  ipcMain.handle('set-server-url', (_e, url: string) => {
    setSavedServerUrl(url);
  });
  ipcMain.handle('test-connection', async (_e, url: string) => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const req = http.get(url + '/health', { timeout: 5000 }, (res) => {
        resolve({ ok: res.statusCode === 200 });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: '连接超时' });
      });
    });
  });
  ipcMain.handle('resolve-drop-path', (_e, filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      return stat.isDirectory() ? filePath : path.dirname(filePath);
    } catch {
      return path.dirname(filePath);
    }
  });
  ipcMain.on('navigate', (_e, url: string) => {
    if (mainWindow) {
      mainWindow.loadURL(url);
    }
  });
}

// ─── 窗口 ───────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'MyAgent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 已取消连接页：直接加载前端页面（服务器地址由主进程配置提供，登录页设置面板可改）
  mainWindow.loadFile(path.join(__dirname, '../frontend-dist/index.html'));

  // ─── 拖放导航拦截：目录/文件拖到窗口时，Electron 默认导航到 file://<路径> ───
  // 渲染进程拿不到拖入目录的路径（Electron 33 移除 File.path、拖目录时 text/uri-list
  // 为空、webkitGetAsEntry 对目录返回 null），由这里拦截导航提取路径，
  // 推送给渲染进程切换工作目录。loadFile 与 http 导航不受影响。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) return;
    e.preventDefault(); // 阻止导航到 file://
    try {
      const filePath = decodeURIComponent(url.replace(/^file:\/\//, ''));
      const stat = fs.statSync(filePath);
      // 目录 URL 可能带尾部斜杠（file:///dir/），统一去掉
      const dir = (stat.isDirectory() ? filePath : path.dirname(filePath)).replace(/\/+$/, '');
      console.log('[Main] 拖放路径:', dir);
      mainWindow?.webContents.send('drop-directory', dir);
    } catch {
      // 忽略无法解析的路径
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── 生命周期 ───────────────────────────────────────────────

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ensureServerUrl();
  registerServerUrlHandlers();
  // 引擎初始化（失败不影响窗口打开，前端可看 engine:get-status）
  await initAgentEngine();
  // 注册 Agent 引擎 IPC
  registerIpcHandlers(ipcDeps);
  createWindow();
});

// 退出前：对每个活跃会话做最后一次同步
app.on('before-quit', () => {
  if (engine) {
    for (const sessionId of engine.activeSessionIds ?? []) {
      void syncSession(ipcDeps, sessionId);
    }
    engine.dispose();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
