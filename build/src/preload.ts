import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('myagent', {
  getServerUrl: (): Promise<string | null> => ipcRenderer.invoke('get-server-url'),
  setServerUrl: (url: string): Promise<void> => ipcRenderer.invoke('set-server-url', url),
  testConnection: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('test-connection', url),
  navigate: (url: string): void => {
    ipcRenderer.send('navigate', url);
  },
  /** 获取拖拽文件/目录的目标工作目录路径 */
  getDropDirPath: async (file: File): Promise<string> => {
    const filePath = webUtils.getPathForFile(file);
    return ipcRenderer.invoke('resolve-drop-path', filePath);
  },

  // ── Agent 引擎 IPC（Electron 模式） ──────────────────────

  /** 发送消息（主进程引擎执行） */
  chatSend: (payload: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:send', payload),
  chatAbort: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:abort', { sessionId }),
  chatSteer: (sessionId: string, message: string): Promise<{ success: boolean; queued?: boolean }> =>
    ipcRenderer.invoke('chat:steer', { sessionId, message }),
  chatDispose: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:dispose', { sessionId }),
  sendExtensionUIResponse: (resp: unknown): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:extension-ui-response', resp),
  confirmDecision: (sessionId: string, decision: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('confirm:decision', { sessionId, decision }),
  getAgentConfig: () => ipcRenderer.invoke('config:get'),
  setAgentConfig: (cfg: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:set', cfg),
  testLlmConnection: (p: unknown): Promise<{ success: boolean; models?: string[]; found?: boolean; error?: string }> =>
    ipcRenderer.invoke('config:test-llm', p),
  listDirectory: (p: unknown): Promise<unknown> => ipcRenderer.invoke('fs:listDirectory', p),
  getEngineStatus: () => ipcRenderer.invoke('engine:get-status'),

  /** 订阅 Agent 事件流（agent_start、message_delta、tool_start、done 等） */
  onAgentEvent: (cb: (event: unknown) => void): (() => void) => {
    const handler = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  /** 订阅引擎状态推送 */
  onEngineStatus: (cb: (status: unknown) => void): (() => void) => {
    const handler = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('agent:engine-status', handler);
    return () => ipcRenderer.removeListener('agent:engine-status', handler);
  },
});
