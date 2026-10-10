import { AgentSessionService, type AgentRunMode } from './agent-service.js';
import { createQwenModel, type ModelOverrides } from '../agent/llm-config.js';
import { createCustomTools, ensureRequiredKey } from '../tools/index.js';
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
    // maxTokens：模型预设级（overrides）优先，未设回落全局默认（global.maxTokens，可能 undefined → createQwenModel 兜底 65535）
    maxTokens: overrides?.maxTokens ?? global?.maxTokens,
    // thinkingLevel：模型预设级（overrides）优先，未设回落全局默认（global.thinkingLevel）；
    // 两者都无则 undefined → agent-factory 回落全局 config.thinkingLevel（跟随全局）
    thinkingLevel: overrides?.thinkingLevel || global?.thinkingLevel,
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
  /**
   * 会话显式选择的工作目录；null = 跟随全局默认（config.workDir）。
   *
   * 必须与「选了某个目录」区分开：NULL 表示"没选过"，这样全局默认变更时能
   * 连带更新这些会话，而显式选过的会话免疫 —— 反之若建会话时把全局值快照进来，
   * 之后改全局默认对它们就永远失效了。
   */
  workDir: string | null;
}

/** createSession 的入参。改用对象是为了不再往 7 个位置参数后面继续追加 ——
 *  这个函数已经因为位置参数丢过一次 initialMessages（见调用点的 undefined 占位）。 */
export interface CreateSessionOptions {
  mode?: AgentRunMode;
  systemPrompt?: string;
  name?: string;
  initialMessages?: { role: string; content: string }[];
  modelOverrides?: ModelOverrides;
  forceId?: string;
  /** 显式工作目录（绝对路径）；不传/null = 跟随全局默认 config.workDir */
  workDir?: string | null;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private sessionStore: SessionStore;

  constructor() {
    this.sessionStore = new SessionStore();
  }

  createSession(userId: number, opts: CreateSessionOptions = {}): string {
    const {
      mode = 'chat',
      systemPrompt,
      name,
      initialMessages,
      modelOverrides,
      forceId,
      workDir = null,
    } = opts;
    const id = forceId || generateId();

    // 模型解析链：modelOverrides → 用户全局默认 → 无则 createQwenModel 抛 NoDefaultModelError
    // （在创建前拦截，绝不悄悄回落任何写死的默认模型）
    const modelCfg = resolveSessionModel(userId, modelOverrides);
    const model = createQwenModel(modelCfg);

    // 系统提示词按模式选择
    const effectivePrompt =
      systemPrompt ||
      (mode === 'agent' ? buildAgentSystemPrompt(getSkills()) : CHAT_SYSTEM_PROMPT);

    let effectivePromptFinal = effectivePrompt;
    // 跨会话记忆注入：data/memory.md 有内容时，把记忆段追加到 system prompt 末尾
    // （agent 与 chat 模式都注入；改动单点，无需分别处理两分支）
    // 注意：Electron 客户端引擎（backend/src/agent-engine）不走 createSession，
    // 其会话不注入记忆 —— 客户端引擎有自己的 skillsDir 机制（配置独立），
    // 如客户端也需要记忆，可自行在传入的 systemPrompt 中拼入记忆内容。
    const memorySection = buildMemoryPromptSection();
    if (memorySection) {
      effectivePromptFinal += memorySection;
    }

    // 工具集：模式基础工具 + 扩展注册工具 + MCP 工具。
    // 唯一构造点 —— 此前上面两个分支各建一份再被这里整份覆盖，属死代码，已删。
    // sessionId 透传给 subagent 工具，供「停止该会话下全部子代理」按会话定位
    const tools = this.buildTools(mode, model, workDir, id);

    const sessionName = name || `对话 ${this.sessions.size + 1}`;
    console.log(`[SessionManager] Creating session id=${id} userId=${userId} mode=${mode} name=${sessionName} workDir=${workDir ?? '(跟随全局默认)'}`);
    const service = new AgentSessionService(
      id,
      effectivePromptFinal,
      mode,
      model,
      tools,
      initialMessages,
      modelCfg.thinkingLevel,
    );
    this.sessions.set(id, {
      id,
      service,
      name: sessionName,
      userId,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      metadata: { mode },
      systemPrompt: effectivePromptFinal,
      workDir,
    });

    // 持久化到数据库
    this.sessionStore.saveSession({
      id,
      userId,
      name: sessionName,
      mode,
      messages: [],
      workDir,
    });

    console.log(`[SessionManager] Session ${id} created, total=${this.sessions.size}`);
    return id;
  }

  /**
   * 生效工作目录：会话显式选择的优先，否则跟随全局默认。
   *
   * 全局 config.workDir 自此降级为「默认值」—— 只影响未显式选过目录的会话，
   * 这正是本次会话级改造的目的。
   */
  private resolveWorkDir(explicit: string | null): string {
    return explicit || config.workDir;
  }

  /**
   * 构建会话工具集：模式基础工具 + 扩展注册工具 + MCP 工具。
   * createSession / applyModelOverrides 重建 / 切目录重建 共用，保证三处工具面一致。
   *
   * workDir 是**会话级**的：工具以闭包捕获它（见 createCustomTools），
   * 所以换目录必须重建整个 service，改这个参数即完成换绑。
   */
  private buildTools(
    mode: AgentRunMode,
    model: Model<any>,
    workDir: string | null,
    sessionId?: string,
  ): AgentTool<any>[] {
    const dir = this.resolveWorkDir(workDir);
    let tools: AgentTool<any>[] =
      mode === 'agent'
        ? createAgentTools(dir, { model, sessionId })
        : createChatTools(dir);

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

    // 统一补齐 schema required（内置/扩展/MCP 全可选参数均会缺键，严格服务端拒收）
    for (const t of tools) {
      if (t?.parameters != null) ensureRequiredKey(t.parameters);
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
    overrides?: ModelOverrides,
  ): boolean {
    if (
      !overrides ||
      (overrides.id === undefined && overrides.baseUrl === undefined && overrides.apiKey === undefined &&
        overrides.maxTokens === undefined && overrides.thinkingLevel === undefined)
    ) {
      return false;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // 内存中无会话（Electron sync 只写 DB 的场景）：无法重建，保持现状
      console.log(`[SessionManager] applyModelOverrides session=${sessionId} not in memory (DB-only), skip`);
      return false;
    }

    const current = entry.service.model as { id: string; baseUrl: string; apiKey?: string; maxTokens?: number };
    const targetId = overrides.id ?? current.id;
    const targetBaseUrl = overrides.baseUrl ?? current.baseUrl;
    const targetApiKey = overrides.apiKey ?? current.apiKey;
    const targetMaxTokens = overrides.maxTokens ?? current.maxTokens;
    // thinkingLevel：overrides 优先，未设回落会话当前值（会话创建/上次重建时已解析 overrides→全局 链）
    const targetThinkingLevel = overrides.thinkingLevel ?? entry.service.thinkingLevel;

    // 防抖：目标模型与当前模型完全一致时不重建（maxTokens/thinkingLevel 变化也触发重建）
    if (
      current.id === targetId &&
      current.baseUrl === targetBaseUrl &&
      current.apiKey === targetApiKey &&
      current.maxTokens === targetMaxTokens &&
      entry.service.thinkingLevel === targetThinkingLevel
    ) {
      return false;
    }

    console.log(`[SessionManager] Rebuilding session ${sessionId} model=${targetId} (was ${current.id}) thinkingLevel=${targetThinkingLevel ?? '(跟随全局)'}`);

    this.rebuildService(entry, createQwenModel({
      id: targetId,
      baseUrl: targetBaseUrl,
      apiKey: targetApiKey,
      maxTokens: targetMaxTokens,
    }), targetThinkingLevel);

    console.log(`[SessionManager] Rebuilt session ${sessionId} model=${targetId} (was ${current.id})`);
    return true;
  }

  /**
   * 用新 model 重建会话 service，消息历史与 systemPrompt 原样保留。
   *
   * 三个触发点共用：换模型（applyModelOverrides）、切工作目录（updateSession）、
   * 全局默认目录变更（refreshInheritedWorkDirs）—— 三者都只改 service 的构造依赖
   * （model / 工具闭包捕获的 workDir），与对话内容无关，故必须原样继承 messages。
   *
   * 两个易错点：
   * 1. 读取旧 service 的状态必须在 destroy 之前（调用方取 thinkingLevel 也同理）；
   * 2. **就地改 `entry.service`** 而非 `sessions.set({...entry, service})` —— 后者每加一个
   *    SessionEntry 字段都是一次"漏了就丢"的赌注（workDir 一旦丢了，下次重建就退回全局默认）。
   */
  private rebuildService(entry: SessionEntry, model: Model<any>, thinkingLevel?: string): void {
    // AgentMessage 含 usage/stopReason/toolResult 等结构化字段，必须经 replaceMessages
    // 原样继承；不能走构造函数 initialMessages 路径 —— createAgent 会经 toAgentMessages
    // 把 content 包成 text block，破坏已是 block 数组的消息
    const existingMessages = entry.service.messages;

    const service = new AgentSessionService(
      entry.id,
      entry.systemPrompt,
      entry.metadata.mode,
      model,
      this.buildTools(entry.metadata.mode, model, entry.workDir, entry.id),
      undefined,
      thinkingLevel,
    );
    service.replaceMessages(existingMessages);

    // 释放旧 service（销毁 agent、事件监听）
    entry.service.destroy();
    entry.service = service;
    entry.lastActiveAt = new Date();

    // 消息未变但 service 引用已替换，重持久化一次保持 DB 一致
    this.persistSession(entry.id);
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
    // 内存会话：会话存在即返回（空会话 → []；此前"空消息数组跳过回退"的写法
    // 让新建的空会话 GET 详情/导出恒 404——修复：空 = 会话存在但无消息）
    const entry = this.sessions.get(id);
    if (entry) {
      return entry.service.messages.map((m: any) => {
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
          // 工具自定义细节必须一并返回：subagent 的「最终摘要 + 工具调用列表」就在这里，
          // 漏掉后切换会话回来只剩任务描述（过程事件流已不在内存）
          if (m.details !== undefined) base.details = m.details;
        }
        return base;
      });
    }
    // 内存中不存在（服务重启后），回退到数据库：getMessages null = 会话记录不存在
    const dbMessages = this.sessionStore.getMessages(id);
    if (dbMessages !== null) {
      // 会话存在（含空消息）→ 返回（[] 或解析出的消息）
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
        // 会话只在 DB 里（内存无 entry）时沿用原值，别把它清成 NULL
        workDir: dbSession.work_dir ?? null,
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
      workDir: entry.workDir,
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
          // 同 getSessionHistory：details 是 subagent 摘要与工具调用列表的唯一载体，必须落库
          if (m.details !== undefined) base.details = m.details;
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
      work_dir: e.workDir,
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

  /**
   * 更新会话（重命名 / 切换工作目录）。
   *
   * 切目录需要重建 service —— 工具是用闭包捕获 workDir 的（见 createCustomTools），
   * 换目录必须换一套工具。重建走 rebuildService：消息历史原样保留。
   *
   * 执行中的会话拒绝切目录：此刻工具正拿旧目录在跑，中途换掉会出现
   * 「文件写了一半、目录却变了」。返回 reason 由路由转 409。
   */
  updateSession(
    id: string,
    updates: { name?: string; workDir?: string | null },
  ): { ok: boolean; reason?: 'not_found' | 'running' } {
    const entry = this.sessions.get(id);

    // 不在内存（服务重启后 / Electron sync 只写 DB 的会话）：只能落库，无需重建。
    // 下次该会话被拉进内存时会自然读到新值。
    if (!entry) {
      const db = this.sessionStore.getSession(id);
      if (!db) return { ok: false, reason: 'not_found' };
      if (updates.name !== undefined) this.sessionStore.updateName(id, updates.name);
      if (updates.workDir !== undefined) this.sessionStore.updateWorkDir(id, updates.workDir);
      return { ok: true };
    }

    if (updates.workDir !== undefined && entry.service.isRunning()) {
      return { ok: false, reason: 'running' };
    }

    if (updates.name !== undefined) {
      entry.name = updates.name;
      entry.lastActiveAt = new Date();
      this.sessionStore.updateName(id, updates.name);
    }

    const nextWorkDir = updates.workDir ?? null;
    if (updates.workDir !== undefined && nextWorkDir !== entry.workDir) {
      entry.workDir = nextWorkDir;
      this.sessionStore.updateWorkDir(id, nextWorkDir);
      // thinkingLevel 必须在 rebuildService 之前读 —— 调用后 entry.service 已换人
      const thinkingLevel = entry.service.thinkingLevel;
      this.rebuildService(entry, entry.service.model, thinkingLevel);
      console.log(`[SessionManager] Session ${id} workDir -> ${nextWorkDir ?? '(跟随全局默认)'}, service rebuilt`);
    }

    return { ok: true };
  }

  /**
   * 读取会话的显式工作目录（null = 未显式选择；undefined = 会话不存在）。
   *
   * 供「先删后建」路径（chat/ws 的 rebuild 与模式切换）在 deleteSession **之前**
   * 捕获目录 —— 删完再读就只剩 NULL 了。
   */
  getSessionWorkDir(id: string): string | null | undefined {
    const entry = this.sessions.get(id);
    if (entry) return entry.workDir;
    const db = this.sessionStore.getSession(id);
    return db ? (db.work_dir ?? null) : undefined;
  }

  /**
   * 全局默认工作目录变更后调用：只重建「未显式选择目录」的会话。
   *
   * 显式选过目录的会话免疫 —— 这正是「全局配置降级为默认值」的语义。
   * 执行中的会话跳过（不打断在途任务），它们会保持旧目录直到下次重建触发。
   * 返回实际重建的会话数。
   */
  refreshInheritedWorkDirs(): number {
    let n = 0;
    for (const entry of this.sessions.values()) {
      if (entry.workDir) continue;              // 显式选过 → 免疫
      if (entry.service.isRunning()) continue;  // 执行中 → 不打断
      const thinkingLevel = entry.service.thinkingLevel;
      this.rebuildService(entry, entry.service.model, thinkingLevel);
      n++;
    }
    return n;
  }

  getSessionInfo(id: string) {
    const entry = this.sessions.get(id);
    if (entry) {
      return {
        id: entry.id,
        name: entry.name,
        mode: entry.metadata.mode,
        work_dir: entry.workDir,
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
        work_dir: dbSession.work_dir ?? null,
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

  /**
   * 列出正在执行一轮对话的会话 ID（可选按归属用户过滤）。
   *
   * 前端 runningSessions 是内存态，刷新页面/HMR 后会丢失，届时靠这里查回来，
   * 否则后端还在跑、界面上却没有任何「执行中」标识。
   */
  listRunningSessionIds(userId?: number): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.sessions) {
      if (!entry.service.isRunning()) continue;
      if (userId !== undefined && entry.userId !== userId) continue;
      ids.push(id);
    }
    return ids;
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
