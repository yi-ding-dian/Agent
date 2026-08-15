import { AgentSessionService, type AgentRunMode } from './agent-service.js';
import { createQwenModel, type ModelOverrides } from '../agent/llm-config.js';
import { createCustomTools } from '../tools/index.js';
import type { AgentTool, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';
import { getGlobalModel } from '../config/global-model-config.js';
import { getExtensionTools } from './extension-loader.js';
import { getMcpBridge } from './mcp-bridge.js';
import { pendingConfirmationManager } from '../confirmation/manager.js';
import { CHAT_SYSTEM_PROMPT, createChatTools } from '../agent/chat-config.js';
import { AGENT_SYSTEM_PROMPT, createAgentTools, buildAgentSystemPrompt } from '../agent/agent-config.js';
import { getSkills } from './skills-loader.js';
import { SessionStore } from '../db/session-store.js';
import { buildMemoryPromptSection } from './memory-service.js';

function generateId(): string {
  return crypto.randomUUID();
}

function normalizeContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return String(content.text);
  }
  return String(content || '');
}

/**
 * 会话模型解析链（本系统没有"出厂默认模型"）：
 *   1. 请求携带的 modelOverrides（逐字段覆盖）
 *   2. 用户全局默认模型（data/global-default-model.json，前端「模型设置」选中并持久化）
 *   3. 都没有 / 不完整 → 由 createQwenModel 在创建前抛 NoDefaultModelError（路由层转 400）
 * 注意：不再回退到 env 里的 chat/agent/qwen 配置 —— 没有配置就是没有，明确报错。
 */
function resolveSessionModel(userId: number, overrides?: ModelOverrides): ModelOverrides {
  const global = getGlobalModel(userId);
  return {
    id: overrides?.id || global?.id,
    baseUrl: overrides?.baseUrl || global?.baseUrl,
    apiKey: overrides?.apiKey || global?.apiKey,
  };
}

interface SessionEntry {
  id: string;
  service: AgentSessionService;
  name: string;
  userId: number;
  createdAt: Date;
  lastActiveAt: Date;
  metadata: { mode: AgentRunMode };
  /** 实际生效的 systemPrompt（含记忆注入等，重建会话时原样复用，保证"只切模型、其余不动"） */
  systemPrompt: string;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private sessionStore: SessionStore;

  constructor() {
    this.sessionStore = new SessionStore();
  }

  createSession(
    userId: number,
    mode: AgentRunMode = 'chat',
    systemPrompt?: string,
    name?: string,
    initialMessages?: { role: string; content: string }[],
    modelOverrides?: { id?: string; baseUrl?: string; apiKey?: string },
    forceId?: string,
  ): string {
    const id = forceId || generateId();

    // 模型解析链：modelOverrides → 用户全局默认 → 无则 createQwenModel 抛 NoDefaultModelError
    // （在创建前拦截，绝不悄悄回落任何写死的默认模型）
    const modelCfg = resolveSessionModel(userId, modelOverrides);

    // 根据模式选择工具、提示词和模型配置
    let tools: AgentTool<any>[];
    let effectivePrompt: string;
    let model;

    if (mode === 'agent') {
      model = createQwenModel(modelCfg);
      // 注意：model 在工具创建之前已可用（含 modelOverrides 覆盖后的 id/baseUrl/apiKey）。
      // 必须把它透传给 subagent 工具（经 createAgentTools → createCustomTools），否则子代理
      // 会回落 agent 默认模型配置（本地 Qwen，可能未加载）→ 报 Failed to load model。
      tools = createAgentTools(config.workDir, { model });
      effectivePrompt = systemPrompt || buildAgentSystemPrompt(getSkills());
    } else {
      model = createQwenModel(modelCfg);
      tools = createChatTools();
      effectivePrompt = systemPrompt || CHAT_SYSTEM_PROMPT;
    }

    // 跨会话记忆注入：data/memory.md 有内容时，把记忆段追加到 system prompt 末尾
    // （agent 与 chat 模式都注入；改动单点，无需分别处理两分支）
    // 注意：Electron 客户端引擎（backend/src/agent-engine）不走 createSession，
    // 其会话不注入记忆 —— 客户端引擎有自己的 skillsDir 机制（配置独立），
    // 如客户端也需要记忆，可自行在传入的 systemPrompt 中拼入记忆内容。
    const memorySection = buildMemoryPromptSection();
    if (memorySection) {
      effectivePrompt += memorySection;
    }

    // 基础工具 + 扩展注册工具 + MCP 工具（createSession 与 applyModelOverrides 重建共用）
    tools = this.buildTools(mode, model);

    const sessionName = name || `对话 ${this.sessions.size + 1}`;
    console.log(`[SessionManager] Creating session id=${id} userId=${userId} mode=${mode} name=${sessionName}`);
    const service = new AgentSessionService(
      id,
      effectivePrompt,
      mode,
      model,
      tools,
      initialMessages,
    );
    this.sessions.set(id, {
      id,
      service,
      name: sessionName,
      userId,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      metadata: { mode },
      systemPrompt: effectivePrompt,
    });

    // 持久化到数据库
    this.sessionStore.saveSession({
      id,
      userId,
      name: sessionName,
      mode,
      messages: [],
    });

    console.log(`[SessionManager] Session ${id} created, total=${this.sessions.size}`);
    return id;
  }

  /**
   * 构建会话工具集：模式基础工具 + 扩展注册工具 + MCP 工具。
   * createSession 与 applyModelOverrides 重建共用，保证重建后工具面与新建一致。
   */
  private buildTools(mode: AgentRunMode, model: Model<any>): AgentTool<any>[] {
    let tools: AgentTool<any>[] =
      mode === 'agent'
        ? createAgentTools(config.workDir, { model })
        : createChatTools();

    // 合并扩展注册的工具
    const extTools = getExtensionTools();
    if (extTools.length > 0) {
      tools = [...tools, ...extTools];
    }

    // 合并 MCP 工具
    const mcpBridge = getMcpBridge();
    if (mcpBridge) {
      const mcpTools = mcpBridge.getCachedTools();
      if (mcpTools.length > 0) {
        tools = [...tools, ...mcpTools];
      }
    }

    return tools;
  }

  /**
   * 会话模型即时切换（根治"建会话模型 ≠ 发消息模型"错配）。
   *
   * 语义：会话模型跟随最近一次请求的 modelOverrides。请求带 modelOverrides 且会话已存在时，
   * 用 createQwenModel 构造目标模型（overrides 缺省字段回落到当前值），与会话当前模型比较
   * id + baseUrl + apiKey 三者 —— 全等返回 false（防抖，不重建）；不同则以现有消息历史
   * （service.messages 原样）与现有 systemPrompt/mode，按 createSession 相同逻辑重建
   * AgentSessionService（新 model + 原消息 + 原 id/name/userId/createdAt/metadata），
   * 替换内存 entry 后返回 true。调用方需重新 getSession 获取新 service。
   *
   * 前端新旧版本均生效：旧前端/Electron 客户端建会话时不带 modelOverrides（落到默认模型），
   * 发消息时带上 overrides 即可即时切换到目标模型，不再报 Failed to load model。
   *
   * 注意：消息内容未变，DB 不需要额外改动；重建后重持久化一次仅保证 service 引用与 DB 一致。
   * Electron sync 的 DB-only 会话（内存无 service）不重建，返回 false 并记录日志。
   */
  applyModelOverrides(
    sessionId: string,
    overrides?: { id?: string; baseUrl?: string; apiKey?: string },
  ): boolean {
    if (
      !overrides ||
      (overrides.id === undefined && overrides.baseUrl === undefined && overrides.apiKey === undefined)
    ) {
      return false;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // 内存中无会话（Electron sync 只写 DB 的场景）：无法重建，保持现状
      console.log(`[SessionManager] applyModelOverrides session=${sessionId} not in memory (DB-only), skip`);
      return false;
    }

    const current = entry.service.model as { id: string; baseUrl: string; apiKey?: string };
    const targetId = overrides.id ?? current.id;
    const targetBaseUrl = overrides.baseUrl ?? current.baseUrl;
    const targetApiKey = overrides.apiKey ?? current.apiKey;

    // 防抖：目标模型与当前模型完全一致时不重建
    if (current.id === targetId && current.baseUrl === targetBaseUrl && current.apiKey === targetApiKey) {
      return false;
    }

    console.log(`[SessionManager] Rebuilding session ${sessionId} model=${targetId} (was ${current.id})`);

    // 保留现有消息历史：原样引用（AgentMessage 含 usage/stopReason/toolResult 等结构化字段，
    // 必须经 replaceMessages 原样继承；不能走构造函数 initialMessages 路径——createAgent 会经
    // toAgentMessages 把 content 包成 text block，破坏已是 block 数组的消息）
    const existingMessages = entry.service.messages;

    const model = createQwenModel({
      id: targetId,
      baseUrl: targetBaseUrl,
      apiKey: targetApiKey,
    });
    const service = new AgentSessionService(
      entry.id,
      entry.systemPrompt,
      entry.metadata.mode,
      model,
      this.buildTools(entry.metadata.mode, model),
    );
    service.replaceMessages(existingMessages);

    // 释放旧 service（销毁 agent、事件监听）
    entry.service.destroy();

    // 替换内存 entry：保留原 id/name/userId/createdAt/metadata，仅换 service（新模型 + 原消息）
    this.sessions.set(sessionId, {
      ...entry,
      service,
    });

    // 消息未变但 service 引用已替换，重持久化一次保持 DB 一致
    this.persistSession(sessionId);

    console.log(`[SessionManager] Rebuilt session ${sessionId} model=${targetId} (was ${current.id})`);
    return true;
  }

  getSession(id: string): AgentSessionService | undefined {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.lastActiveAt = new Date();
      return entry.service;
    }
    return undefined;
  }

  getSessionHistory(id: string) {
    const messages = this.getSession(id)?.messages;
    // 注意：空数组也是 truthy。内存会话存在但消息为空（如 sync 只写 DB 的场景）
    // 时不能挡在 DB 回退前面，否则 DB 里已持久化的消息永远读不到。
    if (messages && messages.length > 0) {
      return messages.map((m: any) => {
        const base: any = {
          role: m.role,
          content: m.content, // 保留原始 content
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
    // 内存中不存在（服务重启后），回退到数据库
    const dbMessages = this.sessionStore.getMessages(id);
    if (dbMessages && dbMessages.length > 0) {
      return dbMessages as { role: string; content: string; timestamp: number }[];
    }
    return undefined;
  }

  /**
   * 将修改后的消息写回会话（内存会话替换 + 数据库持久化）。
   * 内存中无会话（服务重启后仅数据库存在）时直接更新数据库。
   */
  persistMessages(sessionId: string, messages: unknown[]): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.service.replaceMessages(messages as AgentMessage[]);
      this.persistSession(sessionId);
      return true;
    }
    const dbSession = this.sessionStore.getSession(sessionId);
    if (dbSession) {
      this.sessionStore.saveSession({
        id: sessionId,
        userId: dbSession.user_id,
        name: dbSession.name,
        mode: dbSession.mode,
        messages,
      });
      return true;
    }
    return false;
  }

  /** 持久化会话消息到数据库（保存完整消息结构） */
  persistSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const messages = entry.service.messages;
    this.sessionStore.saveSession({
      id: sessionId,
      userId: entry.userId,
      name: entry.name,
      mode: entry.metadata.mode,
      messages: messages.map((m: any) => {
        const base: any = {
          role: m.role,
          content: m.content, // 保留原始 content（可能为字符串或 content block 数组）
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
      }),
    });
  }

  deleteSession(id: string): boolean {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.service.destroy();
      this.sessions.delete(id);
      pendingConfirmationManager.cleanupSession(id);
      this.sessionStore.deleteSession(id);
      return true;
    }
    // 不在内存中，直接从数据库删除（持久化会话未加载到内存的情况）
    const ownerId = this.sessionStore.getSessionOwner(id);
    if (ownerId !== null) {
      this.sessionStore.deleteSession(id);
      return true;
    }
    return false;
  }

  /** 获取指定用户的会话列表 */
  listSessions(userId?: number) {
    let entries = Array.from(this.sessions.values());
    if (userId !== undefined) {
      entries = entries.filter((e) => e.userId === userId);
    }
    return entries.map((e) => ({
      id: e.id,
      name: e.name,
      mode: e.metadata.mode,
      createdAt: e.createdAt,
      lastActiveAt: e.lastActiveAt,
    }));
  }

  /** 从数据库加载用户的持久化会话列表 */
  loadUserSessions(userId: number) {
    return this.sessionStore.listByUser(userId);
  }

  /** 从数据库加载会话消息 */
  loadSessionMessages(sessionId: string) {
    return this.sessionStore.getMessages(sessionId);
  }

  updateSession(id: string, updates: { name?: string }): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    if (updates.name !== undefined) {
      entry.name = updates.name;
      entry.lastActiveAt = new Date();
      this.sessionStore.updateName(id, updates.name);
    }
    return true;
  }

  getSessionInfo(id: string) {
    const entry = this.sessions.get(id);
    if (entry) {
      return {
        id: entry.id,
        name: entry.name,
        mode: entry.metadata.mode,
        createdAt: entry.createdAt,
        lastActiveAt: entry.lastActiveAt,
      };
    }
    // 内存中不存在（服务重启后），回退到数据库
    const dbSession = this.sessionStore.getSession(id);
    if (dbSession) {
      return {
        id: dbSession.id,
        name: dbSession.name,
        mode: dbSession.mode,
        createdAt: new Date(dbSession.created_at),
        lastActiveAt: new Date(dbSession.last_active_at),
      };
    }
    return undefined;
  }

  /** 获取会话所属用户 ID */
  getSessionOwner(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.userId;
  }

  /** 检查会话是否属于指定用户（内存 + 数据库回退） */
  sessionBelongsToUser(sessionId: string, userId: number): boolean {
    const memSession = this.sessions.get(sessionId);
    if (memSession) return memSession.userId === userId;
    // 不在内存中，回退到数据库
    const ownerId = this.sessionStore.getSessionOwner(sessionId);
    return ownerId === userId;
  }

  /** 列出所有内存中活跃会话的 ID */
  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  cleanupStale(maxAgeMs = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActiveAt.getTime() > maxAgeMs) {
        // 先持久化再清理
        this.persistSession(id);
        this.deleteSession(id);
      }
    }
  }
}

// 单例，延迟初始化（在 index.ts 中初始化 dataDir）
let _instance: SessionManager | null = null;

export function initSessionManager(): SessionManager {
  _instance = new SessionManager();
  return _instance;
}

export function getSessionManager(): SessionManager {
  if (!_instance) {
    throw new Error('SessionManager 未初始化，请先调用 initSessionManager()');
  }
  return _instance;
}

// 向后兼容：直接导出的 sessionManager（延迟初始化后可用）
export const sessionManager = new Proxy({} as SessionManager, {
  get(_target, prop) {
    const mgr = getSessionManager();
    return (mgr as any)[prop]?.bind?.(mgr) ?? (mgr as any)[prop];
  },
});
