/* Vite 支持 `?inline` 后缀：将资源内容作为字符串默认导出（tsconfig types: []，需手动声明） */
declare module '*?inline' {
  const src: string;
  export default src;
}

interface Window {
  myagent?: {
    getServerUrl: () => Promise<string | null>;
    setServerUrl: (url: string) => Promise<void>;
    testConnection: (url: string) => Promise<{ ok: boolean; error?: string }>;
    navigate: (url: string) => void;
    getDropDirPath: (file: File) => Promise<string>;

    // Agent 引擎 IPC（Electron 模式）
    chatSend: (payload: unknown) => Promise<{ ok: boolean; error?: string }>;
    chatAbort: (sessionId: string) => Promise<{ ok: boolean }>;
    chatSteer: (sessionId: string, message: string) => Promise<{ success: boolean; queued?: boolean }>;
    chatDispose: (sessionId: string) => Promise<{ ok: boolean }>;
    sendExtensionUIResponse: (resp: unknown) => Promise<{ ok: boolean }>;
    confirmDecision: (sessionId: string, decision: string) => Promise<{ ok: boolean }>;
    getAgentConfig: () => Promise<Record<string, unknown>>;
    setAgentConfig: (cfg: unknown) => Promise<{ ok: boolean; error?: string }>;
    testLlmConnection: (p: unknown) => Promise<{ success: boolean; models?: string[]; found?: boolean; error?: string }>;
    listDirectory: (p: unknown) => Promise<unknown>;
    getEngineStatus: () => Promise<{ initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] }>;
    onAgentEvent: (cb: (event: unknown) => void) => () => void;
    onEngineStatus: (cb: (status: unknown) => void) => () => void;
    onDropDirectory: (cb: (dir: string) => void) => () => void | undefined;
  };
}
