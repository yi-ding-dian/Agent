/**
 * AgentEngine — 客户端（Electron 主进程）Agent 执行引擎
 *
 * 将服务端可复用的 Agent 逻辑（agent-factory / agent-service / tools /
 * extension-loader / mcp-bridge / confirmation）收拢为与 Express/DB 无关的
 * 引擎，供 Electron 主进程加载（esbuild 打成 ESM 单文件后动态 import）。
 *
 * 与服务端运行时的区别：
 *  - 不持久化会话（由主进程在对话结束后 POST sync 到服务端）
 *  - 扩展加载使用 tsImport（tsx 官方程序化 API），支持 node_modules 下的 .ts
 *  - LLM 直连（不经过服务端）
 */
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { AgentSessionService, type AgentRunMode } from '../services/agent-service.js';
import { createQwenModel, type ModelOverrides } from '../agent/llm-config.js';
import { createAgentTools, buildAgentSystemPrompt } from '../agent/agent-config.js';
import { createChatTools, CHAT_SYSTEM_PROMPT } from '../agent/chat-config.js';
import { initExtensionLoader, getExtensionTools, type ExtensionModuleLoader } from '../services/extension-loader.js';
import { initMcpBridge, getMcpBridge } from '../services/mcp-bridge.js';
import { initSkillsLoader, getSkills } from '../services/skills-loader.js';
import { pendingConfirmationManager, type ConfirmationDecision } from '../confirmation/manager.js';
import { config } from '../config.js';

/** 引擎运行配置（由 Electron 主进程传入） */
export interface EngineConfig {
  workDir: string;
  mcpDir: string;
  extensionsDir: string;
  skillsDir: string;
  llm: {
    model: string;
    baseUrl: string;
    apiKey: string;
  };
  thinkingLevel: string;
  enableThinking: boolean;
  thinkingBudget: number;
  preserveThinking: boolean;
  llmTimeoutMs: number;
  maxTokens: number;
}

/** 引擎初始化结果 */
export interface EngineInitResult {
  initialized: boolean;
  mcpTools: number;
  extTools: string[];
  errors: string[];
}

/** 会话执行选项 */
export interface SessionOptions {
  mode: AgentRunMode;
  systemPrompt?: string;
  modelOverrides?: ModelOverrides;
  initialMessages?: { role: string; content: string }[];
}

/** 广播给主进程的引擎事件（含会话标识） */
export interface EngineEvent {
  sessionId: string;
  event: { type: string; [key: string]: unknown };
}

/**
 * 应用引擎配置到全局 config（agent-factory / llm-config / 工具共享该对象）
 */
function applyConfig(cfg: EngineConfig): void {
  config.workDir = cfg.workDir;
  config.qwenBaseUrl = cfg.llm.baseUrl;
  config.qwenApiKey = cfg.llm.apiKey;
  config.qwenModel = cfg.llm.model;
  (config as any).thinkingLevel = cfg.thinkingLevel;
  (config as any).enableThinking = cfg.enableThinking;
  (config as any).thinkingBudget = cfg.thinkingBudget;
  (config as any).preserveThinking = cfg.preserveThinking;
  (config as any).llmTimeoutMs = cfg.llmTimeoutMs;
  config.defaultMaxTokens = cfg.maxTokens;
}

export class AgentEngine {
  private initialized = false;
  private sessions = new Map<string, AgentSessionService>();
  /**
   * 按会话缓存工具集合（sessionId → tools 数组）。
   * 不按会话区分会导致：subagent 工具闭包绑定创建时的 model，跨会话复用后，
   * 后建会话的 modelOverrides（如 DeepSeek）对子代理不生效，恒回落 agent 默认
   * 模型（本地 Qwen）。改为按会话缓存后，每个会话的工具数组用该会话自己的
   * model 组装（createAgentTools(workDir, { model })），子代理继承主会话模型；
   * 会话销毁时对应缓存一并清理（防内存泄漏）。
   */
  private toolsBySession = new Map<string, AgentTool<any>[]>();
  private listeners = new Set<(ev: EngineEvent) => void>();
  private initErrors: string[] = [];
  private extToolNames: string[] = [];
  private mcpToolCount = 0;

  /**
   * 初始化引擎：应用配置 → 加载扩展 → 连接 MCP → 加载 skills
   * 任何一步失败都降级继续，错误汇总返回，不抛出
   */
  async init(cfg: EngineConfig): Promise<EngineInitResult> {
    console.log('[AgentEngine] init started');
    applyConfig(cfg);

    // ① 扩展加载（tsImport 支持 node_modules 下的 .ts）
    const tsLoader: ExtensionModuleLoader = async (fileUrl) => {
      const { tsImport } = await import('tsx/esm/api');
      return tsImport(fileURLToPath(fileUrl), import.meta.url);
    };
    try {
      await initExtensionLoader(cfg.extensionsDir, tsLoader);
      this.extToolNames = getExtensionTools().map((t) => t.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.initErrors.push(`扩展加载失败: ${msg}`);
      console.error('[AgentEngine] extension load error:', err);
    }

    // ② MCP 桥接（spawn my-mcp-server 子进程）
    try {
      const bridge = await initMcpBridge(cfg.mcpDir);
      this.mcpToolCount = bridge.getCachedTools().length;
      console.log(`[AgentEngine] MCP connected, tools=${this.mcpToolCount}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.initErrors.push(`MCP 连接失败: ${msg}`);
      console.error('[AgentEngine] MCP init error:', err);
    }

    // ③ skills（只注入 system prompt）
    try {
      await initSkillsLoader(cfg.skillsDir);
      console.log(`[AgentEngine] skills loaded: ${getSkills().length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.initErrors.push(`skills 加载失败: ${msg}`);
      console.error('[AgentEngine] skills load error:', err);
    }

    this.initialized = true;
    console.log(`[AgentEngine] init done, mcpTools=${this.mcpToolCount} extTools=[${this.extToolNames.join(', ')}] errors=${this.initErrors.length}`);
    return {
      initialized: true,
      mcpTools: this.mcpToolCount,
      extTools: this.extToolNames,
      errors: [...this.initErrors],
    };
  }

  get status(): { initialized: boolean; mcpTools: number; extTools: string[]; errors: string[] } {
    return {
      initialized: this.initialized,
      mcpTools: this.mcpToolCount,
      extTools: this.extToolNames,
      errors: [...this.initErrors],
    };
  }

  /** 订阅引擎事件（agent 事件流 + done），返回取消订阅函数 */
  onEvent(cb: (ev: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(sessionId: string, event: { type: string; [key: string]: unknown }): void {
    const payload: EngineEvent = { sessionId, event };
    for (const cb of this.listeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[AgentEngine] listener error:', err);
      }
    }
  }

  /**
   * 获取会话工具集合（按会话缓存）。
   * 本地工具（createAgentTools 生成的 10 个，含 subagent）用该会话的 model
   * 组装 —— subagent 工具闭包捕获 model，会话间不能复用；扩展/MCP 工具为
   * 引擎级共享对象（无 model 闭包），继续复用同一批实例，仅合并进每会话数组。
   */
  private getTools(sessionId: string, model: Model<any>): AgentTool<any>[] {
    const cached = this.toolsBySession.get(sessionId);
    if (cached) return cached;

    let tools: AgentTool<any>[] = createAgentTools(config.workDir, { model });

    const extTools = getExtensionTools();
    if (extTools.length > 0) {
      tools = [...tools, ...extTools];
    }

    const bridge = getMcpBridge();
    if (bridge) {
      const mcpTools = bridge.getCachedTools();
      if (mcpTools.length > 0) {
        tools = [...tools, ...mcpTools];
      }
    }

    this.toolsBySession.set(sessionId, tools);
    console.log(`[AgentEngine] tools ready for session ${sessionId}: ${tools.length} (local + ext + mcp)`);
    return tools;
  }

  /** 获取或创建会话（不持久化，由主进程负责 sync） */
  getOrCreate(sessionId: string, opts: SessionOptions): AgentSessionService {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    let model;
    let tools: AgentTool<any>[];
    let effectivePrompt: string;

    // 客户端引擎的模型解析链：modelOverrides → applyConfig 注入的运行时 LLM 配置
    // （config.qwen*，由 Electron 主进程在 init 时写入 EngineConfig.llm —— 用户在前端
    // 「模型设置」选择的模型）。无配置 → createQwenModel 抛 NoDefaultModelError。
    const cfg = { id: config.qwenModel, baseUrl: config.qwenBaseUrl, apiKey: config.qwenApiKey };
    const modelCfg: ModelOverrides = {
      id: opts.modelOverrides?.id || cfg.id,
      baseUrl: opts.modelOverrides?.baseUrl || cfg.baseUrl,
      apiKey: opts.modelOverrides?.apiKey || cfg.apiKey,
    };

    if (opts.mode === 'agent') {
      model = createQwenModel(modelCfg);
      // model 必须在工具创建前就绪：subagent 工具闭包捕获该 model，
      // 子代理继承主会话模型（含 modelOverrides 覆盖，如 DeepSeek）。
      tools = this.getTools(sessionId, model);
      effectivePrompt = opts.systemPrompt || buildAgentSystemPrompt(getSkills());
    } else {
      model = createQwenModel(modelCfg);
      tools = createChatTools();
      effectivePrompt = opts.systemPrompt || CHAT_SYSTEM_PROMPT;
    }

    // 跨会话记忆（data/memory.md）说明：
    // 本引擎为 Electron 主进程客户端引擎，不注入服务端的跨会话记忆 ——
    // 客户端引擎配置独立（EngineConfig.skillsDir 等由主进程传入，走自己的技能机制），
    // 且 dataDir 路径属于服务端环境。如客户端也需要记忆能力，
    // 可由主进程读取 memory 文件后拼入传入的 opts.systemPrompt 中。

    const service = new AgentSessionService(
      sessionId,
      effectivePrompt,
      opts.mode,
      model,
      tools,
      opts.initialMessages,
    );

    // 转发会话事件到引擎广播
    service.events.on('sse', (event: { type: string; [key: string]: unknown }) => {
      this.emit(sessionId, event);
    });
    service.events.on('done', () => {
      this.emit(sessionId, { type: 'done' });
    });

    this.sessions.set(sessionId, service);
    return service;
  }

  async send(sessionId: string, message: string, images?: unknown[]): Promise<void> {
    const service = this.sessions.get(sessionId);
    if (!service) throw new Error(`会话不存在: ${sessionId}`);
    await service.processMessage(message, images as any);
  }

  steer(sessionId: string, message: string): void {
    const service = this.sessions.get(sessionId);
    if (!service) throw new Error(`会话不存在: ${sessionId}`);
    service.steer(message);
  }

  abort(sessionId: string): void {
    const service = this.sessions.get(sessionId);
    if (!service) return;
    service.abort();
  }

  resolveConfirmation(sessionId: string, decision: ConfirmationDecision): boolean {
    return pendingConfirmationManager.resolve(sessionId, decision);
  }

  /** 销毁会话（重建/删除时调用） */
  disposeSession(sessionId: string): void {
    const service = this.sessions.get(sessionId);
    if (!service) return;
    service.destroy();
    pendingConfirmationManager.cleanupSession(sessionId);
    this.sessions.delete(sessionId);
    // 清理该会话的工具缓存（subagent 闭包持有 model 引用，释放防泄漏）
    this.toolsBySession.delete(sessionId);
  }

  /** 活跃会话 ID 列表（退出时主进程逐个 sync） */
  get activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getSessionMessages(sessionId: string): { role: string; content: unknown; timestamp: number }[] {
    const service = this.sessions.get(sessionId);
    if (!service) return [];
    return service.messages.map((m: any) => {
      const base: any = {
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || Date.now(),
      };
      if (m.role === 'assistant') {
        if (m.usage) base.usage = m.usage;
        if (m.stopReason) base.stopReason = m.stopReason;
        if (m.errorMessage) base.errorMessage = m.errorMessage;
      }
      if (m.role === 'toolResult') {
        if (m.toolCallId) base.toolCallId = m.toolCallId;
        if (m.toolName) base.toolName = m.toolName;
        if (m.isError !== undefined) base.isError = m.isError;
      }
      return base;
    });
  }

  /** 全部销毁（退出时调用） */
  dispose(): void {
    for (const id of this.sessions.keys()) {
      this.sessions.get(id)?.destroy();
    }
    this.sessions.clear();
    this.toolsBySession.clear();
  }
}

/** 全局单例 */
export const agentEngine = new AgentEngine();
