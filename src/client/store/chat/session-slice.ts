/**
 * chat-store：会话域 slice
 *
 * 从 chat-store.ts 抽出（zustand slice 模式），纯搬运、实现体未改。
 * 跨 slice 调用一律通过 get()（如 get().sendMessage()），不复制 state。
 */
import type { StateCreator } from 'zustand';
import type { AgentMode, SessionInfo } from '../../types/chat';
import type { ConfigData } from '../../types/api';
import * as api from '../../services/api';
import { isElectron, getLlmOverrides } from '../../services/api-config';
import { getWSClient } from '../../services/ws-client';
import { pushRecentWorkDir } from '../../services/recent-dirs';
import {
  liveViews,
  withMessages,
  apiMessagesToChatMessages,
  rebuildAgentsFromMessages,
  startRunningSync,
  abortCurrentRun,
} from './helpers';
import type { ChatStore, SessionSlice } from './types';

export const createSessionSlice: StateCreator<ChatStore, [], [], SessionSlice> = (set, get) => ({
  sessions: [],

  activeSessionId: null,

  config: null,

  directoryNotice: null,

  loadConfig: async () => {
    try {
      // Electron 模式：配置在主进程本地（LLM 直连参数）
      if (isElectron()) {
        const raw = await window.myagent!.getAgentConfig();
        const config = raw as unknown as ConfigData;
        if (config && config.model) set({ config });
        else set({ config: null });
        return;
      }
      const config = await api.getConfig();
      set({ config });
    } catch { /* ignore */ }
  },

  saveConfig: async (config) => {
    // Electron 模式：保存到主进程并立即生效（新会话）
    if (isElectron()) {
      await window.myagent!.setAgentConfig(config);
      set({ config });
      return;
    }
    await api.updateConfig(config);
    set({ config });
  },

  switchWorkDir: async (dirPath) => {
    const sid = get().activeSessionId;
    if (!sid) {
      // 空态（还没建会话）拖入/选中目录：新建一个挂在该目录下的会话
      await get().createNewSession({ workDir: dirPath, mode: 'agent' });
      pushRecentWorkDir(dirPath);
      return;
    }
    try {
      const info = await api.updateSession(sid, { workDir: dirPath });
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === sid ? { ...x, work_dir: info?.work_dir ?? dirPath } : x,
        ),
        directoryNotice: dirPath,
      }));
      pushRecentWorkDir(dirPath);
    } catch (err: any) {
      // 409「会话正在执行中，请先停止」/ 400「目录不存在」都由 updateSession 透传中文原因
      set({ error: err?.message || '切换工作目录失败' });
    }
  },

  clearDirectoryNotice: () => set({ directoryNotice: null }),

  loadSessions: async () => {
    try {
      const data = await api.listSessions();
      const sessions: SessionInfo[] = data.sessions || [];
      // 顺带同步「执行中」集合：runningSessions 是内存态，刷新页面 / HMR 热重载后
      // 会整个丢失 —— 那时后端仍在跑，界面上却毫无标识。后端才是权威状态，故以它为准。
      // （loadSessions 只在初始化与 Electron/SSE 降级路径调用，不在 WS 高频路径上，
      //  不会与「消息刚发出、后端尚未开始执行」的瞬间竞争。）
      const serverRunning = sessions.filter((s) => s.running).map((s) => s.id);
      set({ sessions, runningSessions: serverRunning });
      if (serverRunning.length > 0) startRunningSync();
    } catch { /* ignore */ }
  },

  createNewSession: async (opts) => {
    try {
      const mode = opts?.mode ?? get().mode;
      // 携带当前选中模型配置（getLlmOverrides 与 sendMessage 注入 modelOverrides 同源）：
      // 新会话创建时即应用当前默认模型，避免"建会话用 Qwen、发消息想用 DeepSeek 不生效"
      const llmOverrides = getLlmOverrides();
      const session = await api.createSession({
        mode,
        workDir: opts?.workDir,
        llmOverrides,
      });
      // 必须重置会话级状态：isProcessing 若沿用上一个会话（它可能正在跑），
      // 新会话的输入框会错误显示「AI 正在回复…」；error 同理会把旧会话的报错带过来
      set((s) => ({
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        messages: [],
        agents: [],
        flyRequest: null,
        totalUsage: { input: 0, output: 0, total: 0 },
        isProcessing: false,
        error: null,
      }));
    } catch (err: any) {
      // 无任何模型配置（未选中预设且后端无全局默认）时后端返回 400
      // "未配置默认模型，请在设置→模型设置中选择模型"，展示给用户而非静默
      set({ error: err?.message || '创建会话失败' });
    }
  },

  switchSession: async (id) => {
    const { activeSessionId: prevId, messages: prevMessages, agents: prevAgents } = get();

    // 切走时留存：原会话若仍在执行，把它的消息/子代理视图存进 liveViews ——
    // 这样它后续到达的增量有处可去（见 withMessages），切回时也能原样恢复。
    if (prevId && prevId !== id && get().isProcessing) {
      liveViews.set(prevId, { messages: prevMessages, agents: prevAgents });
    }

    // 切回一个仍在后台执行的会话：直接用内存视图恢复。
    // 此刻后端尚未落库正在生成的那条消息，若走快照，界面会停在切换那一刻不再更新。
    const live = liveViews.get(id);
    if (live) {
      liveViews.delete(id);
      set({
        activeSessionId: id,
        messages: live.messages,
        agents: live.agents,
        isProcessing: true,
        scrolledAway: false,
        flyRequest: null,
        needsRebuild: false,
        // 目录提示条属于「上一个会话刚切过目录」的瞬时反馈，切走即清，避免串台
        directoryNotice: null,
      });
      return;
    }

    try {
      const data = await api.getSession(id);
      set({
        activeSessionId: id,
        messages: apiMessagesToChatMessages(data.messages || []),
        mode: (data.mode as AgentMode) || 'agent',
        totalUsage: { input: 0, output: 0, total: 0 },
        needsRebuild: true,
        scrolledAway: false,
        agents: rebuildAgentsFromMessages(apiMessagesToChatMessages(data.messages || [])),
        flyRequest: null,
        directoryNotice: null,
        // 切到并未在执行的会话：清掉处理中状态 —— 原先不重置，会让「停止」按钮
        // 跟着上一个会话的状态泄漏过来
        isProcessing: false,
      });
    } catch { set({ activeSessionId: id, messages: [], agents: [], flyRequest: null, totalUsage: { input: 0, output: 0, total: 0 }, scrolledAway: false, needsRebuild: true, isProcessing: false }); }
  },

  renameSession: async (id, name) => {
    try {
      await api.updateSession(id, { name });
      set((s) => ({ sessions: s.sessions.map((sess) => sess.id === id ? { ...sess, name } : sess) }));
    } catch { /* ignore */ }
  },

  deleteSession: async (id) => {
    try {
      const { activeSessionId } = get();
      const isActive = activeSessionId === id;

      // 先停后删：会话若仍在跑，删除后 SSE 事件会继续回流 —— tool_start 是「追加」语义
      // （agents: [...s.agents, newAgent]），会把刚清空的子 Agent 列表重新填回来，消息同理。
      // 只对确有执行中任务的会话发中止请求：不在后端内存里的历史会话（内存有 30 分钟清理）
      // 调 abort 一律 404，纯属噪音（allSettled 虽能吞掉异常，但浏览器网络面板照样记 404）。
      // 子代理运行必然伴随主代理运行，故以 runningSessions 判定即可覆盖。
      const isRunning = get().runningSessions.includes(id);
      if (isRunning) {
        if (isElectron()) window.myagent!.chatAbort(id).catch(() => {});
        await Promise.allSettled([api.abortAllSubAgents(id), api.abortSession(id)]);
        if (isActive) {
          abortCurrentRun();
          getWSClient().send({ type: 'abort', sessionId: id });
        }
      }

      await api.deleteSession(id);
      // Electron 模式：释放主进程引擎会话
      if (isElectron()) window.myagent!.chatDispose(id).catch(() => {});
      set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
      // agents 必须一并清空：子 Agent 列表属于当前会话（刷新后由消息重建），
      // 会话没了消息也就没了，残留的 agents 会让侧栏「子Agent」tab 显示已删除会话的记录
      if (isActive) {
        set({ activeSessionId: null, messages: [], agents: [], isProcessing: false });
      }
    } catch { /* ignore */ }
  },
});
