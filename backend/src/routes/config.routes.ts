import { Router } from 'express';
import type { Request, Response } from 'express';
import { config, getModelPresets } from '../config.js';
import { matchCapability } from '../agent/model-adapter.js';
import { getSessionManager } from '../services/session-manager.js';
import {
  loadRateLimitConfig,
  getRateLimitConfig,
  updateRateLimitConfig,
} from '../config/rate-limit-config.js';
import {
  loadToolPermissionConfig,
  getToolPermissionConfig,
  updateToolPermissionConfig,
} from '../config/tool-permission-config.js';
import {
  loadAdvancedConfig,
  getAdvancedConfig,
  updateAdvancedConfig,
} from '../config/advanced-config.js';
import { getGlobalModel, setGlobalModel } from '../config/global-model-config.js';

// 启动时从文件加载限流配置
loadRateLimitConfig();
// 启动时从文件加载工具权限配置（allow/ask/deny）
loadToolPermissionConfig();
// 启动时从文件加载高级配置（对话压缩/子代理/记忆/黑名单/搜索/摘要模型）
loadAdvancedConfig();
// 从文件同步 LLM 超时到全局 config（覆盖 env 默认值）
const rcLoaded = getRateLimitConfig();
(config as any).llmTimeoutMs = rcLoaded.llm_timeout_ms;

// 内存中的可运行时配置
// 注意：不再有"出厂默认模型"——chat/agent 不再隐式回退到 qwen 通用配置，未配置即为空。
export const runtimeConfig = {
  // 通用配置（来自 QWEN_* 环境变量或 Electron 运行时注入，未配置为空）
  base_url: config.qwenBaseUrl,
  api_key: config.qwenApiKey,
  model: config.qwenModel,
  system_prompt: config.defaultSystemPrompt,
  temperature: 0.7,
  max_tokens: config.defaultMaxTokens,
  thinking_level: config.thinkingLevel || 'medium',
  work_dir: config.workDir,
  // Chat 模式独立配置（CHAT_*，未配置为空）
  chat_base_url: config.chatBaseUrl,
  chat_api_key: config.chatApiKey,
  chat_model: config.chatModel,
  // Agent 模式独立配置（AGENT_*，未配置为空）
  agent_base_url: config.agentBaseUrl,
  agent_api_key: config.agentApiKey,
  agent_model: config.agentModel,
  // 思考模式（开关型模型）
  enable_thinking: config.enableThinking ?? true,
  thinking_budget: config.thinkingBudget || 1024,
  preserve_thinking: config.preserveThinking ?? false,
  // 限流配置（从文件读取）
  ...(() => {
    const rc = getRateLimitConfig();
    return {
      tool_rate_limit_per_minute: rc.tool_rate_limit_per_minute,
      agent_max_tool_calls_per_turn: rc.agent_max_tool_calls_per_turn,
      agent_max_consecutive_errors: rc.agent_max_consecutive_errors,
      agent_max_turns: rc.agent_max_turns,
      llm_timeout_ms: rc.llm_timeout_ms,
    };
  })(),
  // 工具权限配置（allow/ask/deny，从文件读取）
  tool_permissions: getToolPermissionConfig(),
  // 高级配置（对话压缩/子代理/记忆/黑名单/搜索/摘要模型，从文件读取）
  advanced: getAdvancedConfig(),
};

export const configRouter = Router();

// GET /api/config
configRouter.get('/config', (_req: Request, res: Response): void => {
  const capability = matchCapability(runtimeConfig.model);
  res.json({
    ...runtimeConfig,
    thinking_capability: capability,
    // 模型预设列表（默认 preset 与 env 配置一致；前端可自行在 localStorage 增删，后端不持久化）
    model_presets: getModelPresets(),
  });
});

// POST /api/config
configRouter.post('/config', (req: Request, res: Response): void => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.base_url === 'string') runtimeConfig.base_url = body.base_url;
  if (typeof body.api_key === 'string') runtimeConfig.api_key = body.api_key;
  if (typeof body.model === 'string') runtimeConfig.model = body.model;
  if (typeof body.system_prompt === 'string') runtimeConfig.system_prompt = body.system_prompt;
  if (typeof body.temperature === 'number') runtimeConfig.temperature = body.temperature;
  if (typeof body.max_tokens === 'number') { runtimeConfig.max_tokens = body.max_tokens; (config as any).defaultMaxTokens = body.max_tokens; }
  if (typeof body.thinking_level === 'string') {
    runtimeConfig.thinking_level = body.thinking_level;
    (config as any).thinkingLevel = body.thinking_level;
  }
  if (typeof body.enable_thinking === 'boolean') {
    runtimeConfig.enable_thinking = body.enable_thinking;
    (config as any).enableThinking = body.enable_thinking;
    // switch 模式（Qwen3）：enable_thinking 映射为 thinkingLevel
    const cap = matchCapability(runtimeConfig.model);
    if (cap.mode === 'switch') {
      const newLevel = body.enable_thinking ? 'medium' : 'off';
      runtimeConfig.thinking_level = newLevel;
      (config as any).thinkingLevel = newLevel;
      // 同步更新所有活跃 Agent
      const mgr = getSessionManager();
      for (const id of mgr.listSessionIds()) {
        mgr.getSession(id)?.setThinkingLevel(newLevel);
      }
    }
  }
  if (typeof body.thinking_budget === 'number') {
    runtimeConfig.thinking_budget = body.thinking_budget;
    (config as any).thinkingBudget = body.thinking_budget;
  }
  if (typeof body.preserve_thinking === 'boolean') {
    runtimeConfig.preserve_thinking = body.preserve_thinking;
    (config as any).preserveThinking = body.preserve_thinking;
  }
  
  // 检测 work_dir 是否变化
  const oldWorkDir = runtimeConfig.work_dir;
  const newWorkDir = typeof body.work_dir === 'string' ? body.work_dir : undefined;
  
  if (newWorkDir !== undefined) {
    runtimeConfig.work_dir = newWorkDir;
  }
  
  // Chat 配置
  if (typeof body.chat_base_url === 'string') runtimeConfig.chat_base_url = body.chat_base_url;
  if (typeof body.chat_api_key === 'string') runtimeConfig.chat_api_key = body.chat_api_key;
  if (typeof body.chat_model === 'string') runtimeConfig.chat_model = body.chat_model;
  // Agent 配置
  if (typeof body.agent_base_url === 'string') runtimeConfig.agent_base_url = body.agent_base_url;
  if (typeof body.agent_api_key === 'string') runtimeConfig.agent_api_key = body.agent_api_key;
  if (typeof body.agent_model === 'string') runtimeConfig.agent_model = body.agent_model;

  // 同步更新全局 config（用于新会话）
  (config as any).qwenBaseUrl = runtimeConfig.base_url;
  (config as any).qwenApiKey = runtimeConfig.api_key;
  (config as any).qwenModel = runtimeConfig.model;
  (config as any).defaultSystemPrompt = runtimeConfig.system_prompt;
  (config as any).workDir = runtimeConfig.work_dir;
  (config as any).chatBaseUrl = runtimeConfig.chat_base_url;
  (config as any).chatApiKey = runtimeConfig.chat_api_key;
  (config as any).chatModel = runtimeConfig.chat_model;
  // 修复：原代码引用不存在的 runtimeConfig.agentBaseUrl 等（恒为 undefined），
  // 导致 POST /api/config 设置的 agent_base_url/agent_api_key/agent_model 不会同步到全局 config，新 agent 会话仍用旧值
  // （不再回退 qwen 通用配置：chat/agent 配置独立，未配置即为空）
  (config as any).agentBaseUrl = runtimeConfig.agent_base_url;
  (config as any).agentApiKey = runtimeConfig.agent_api_key;
  (config as any).agentModel = runtimeConfig.agent_model;

  // 限流配置（保存到文件）
  if (typeof body.tool_rate_limit_per_minute === 'number') {
    runtimeConfig.tool_rate_limit_per_minute = body.tool_rate_limit_per_minute;
  }
  if (typeof body.agent_max_tool_calls_per_turn === 'number') {
    runtimeConfig.agent_max_tool_calls_per_turn = body.agent_max_tool_calls_per_turn;
  }
  if (typeof body.agent_max_consecutive_errors === 'number') {
    runtimeConfig.agent_max_consecutive_errors = body.agent_max_consecutive_errors;
  }
  if (typeof body.agent_max_turns === 'number') {
    runtimeConfig.agent_max_turns = body.agent_max_turns;
  }
  if (typeof body.llm_timeout_ms === 'number') {
    runtimeConfig.llm_timeout_ms = body.llm_timeout_ms;
    (config as any).llmTimeoutMs = body.llm_timeout_ms;
  }
  updateRateLimitConfig({
    tool_rate_limit_per_minute: runtimeConfig.tool_rate_limit_per_minute,
    agent_max_tool_calls_per_turn: runtimeConfig.agent_max_tool_calls_per_turn,
    agent_max_consecutive_errors: runtimeConfig.agent_max_consecutive_errors,
    agent_max_turns: runtimeConfig.agent_max_turns,
    llm_timeout_ms: runtimeConfig.llm_timeout_ms,
  });

  // 工具权限配置（allow/ask/deny，保存到文件，beforeToolCall 实时生效）
  if (body.tool_permissions && typeof body.tool_permissions === 'object' && !Array.isArray(body.tool_permissions)) {
    runtimeConfig.tool_permissions = updateToolPermissionConfig(body.tool_permissions as Record<string, unknown>);
  }

  // 高级配置（部分更新，校验类型与范围；失败返回 400 与错误信息，不落盘）
  if (body.advanced !== undefined) {
    if (typeof body.advanced !== 'object' || body.advanced === null || Array.isArray(body.advanced)) {
      res.status(400).json({ status: 'error', message: 'advanced 必须是对象' });
      return;
    }
    const { config: advConfig, errors } = updateAdvancedConfig(body.advanced as Record<string, unknown>);
    if (errors.length > 0) {
      res.status(400).json({ status: 'error', message: `高级配置校验失败：${errors.join('；')}` });
      return;
    }
    runtimeConfig.advanced = advConfig;
  }

  // 如果 work_dir 发生变化，重建所有 agent 模式的 session
  if (newWorkDir !== undefined && oldWorkDir !== newWorkDir) {
    console.log(`[ConfigRoute] Work directory changed from "${oldWorkDir}" to "${newWorkDir}", rebuilding agent sessions`);
    const mgr = getSessionManager();
    for (const sessionId of mgr.listSessionIds()) {
      const session = mgr.getSession(sessionId);
      if (session && session.mode === 'agent') {
        console.log(`[ConfigRoute] Rebuilding agent session: ${sessionId}`);
        // 保存当前会话的消息历史
        const messages = [...session.messages];
        // 销毁旧 session
        mgr.deleteSession(sessionId);
        // 重新创建（使用新的 work_dir）
        const newSessionId = mgr.createSession(
          1, // userId，实际应该从请求中获取
          'agent',
          undefined,
          undefined,
          // AgentMessage 联合类型中 BashExecutionMessage 等无 content 字段，先做 in 收窄再取值
          messages.map(m => ({ role: m.role, content: 'content' in m && typeof m.content === 'string' ? m.content : '' })),
        );
        console.log(`[ConfigRoute] Rebuilt session ${sessionId} -> ${newSessionId}`);
      }
    }
  }

  res.json({ status: 'success' });
});

// ── 连通性判定辅助 ─────────────────────────────────────────────

/** 从错误消息中提取模型名：优先取引号包围的内容（如 LM Studio 的
 *  Failed to load model "xxx"），否则回退为请求的 model 名 */
function extractModelName(rawMsg: string, fallback: string): string {
  const m = rawMsg.match(/["']([^"']{1,128})["']/);
  return m ? m[1] : fallback;
}

/** 诊断辅助（仅信息用途，不参与判定）：chat 实测失败时短超时尝试 GET /models，
 *  成功说明服务本身在线（模型未加载或名称不符），返回附加说明；失败返回空串。
 *  注意：/models 只验证「模型已注册」，不能验证「能实际生成」，故不作为主验证。 */
async function diagModelsOnline(baseUrl: string, headers: Record<string, string>): Promise<string> {
  try {
    const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(3000) });
    if (r.ok) return '（服务在线，模型未加载或名称不符）';
  } catch { /* 忽略 */ }
  return '';
}

// POST /api/test-model-connection
// 测试任意模型配置的连通性（不要求来自后端预设，也不留任何状态）：
//   主验证：真实最小 chat 请求（POST {baseUrl}/chat/completions，max_tokens=1）。
//     —— 修复绿点误报：旧逻辑先 GET /models 命中即判 ok，但 /models 只验证「模型已注册」，
//        不验证「能实际生成」；LM Studio 场景模型注册未加载 → /models 命中但 chat 400
//        Failed to load model → 误报绿点。现在只有 chat 实测成功才给 ok:true。
//   GET /models 仅保留作错误诊断辅助（chat 失败时确认服务本身是否在线），不参与判定。
// 返回 { ok: true, latencyMs } 或 { ok: false, error }；超时 8 秒。
configRouter.post('/test-model-connection', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(body.model ?? '').trim();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!baseUrl || !model) {
    res.json({ ok: false, error: 'Base URL 和模型名不能为空' });
    return;
  }
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const start = Date.now();

  try {
    // 主验证：真实最小 chat 请求（能实际生成才算连通）
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - start;

    // 判定规则：HTTP 2xx 且响应含正常生成结构（choices 非空 + usage）→ 真实可用
    if (resp.ok) {
      let data: { choices?: unknown[]; usage?: unknown } | null = null;
      try {
        data = (await resp.json()) as { choices?: unknown[]; usage?: unknown };
      } catch { /* 2xx 但响应非 JSON：视作不可用 */ }
      if (data && Array.isArray(data.choices) && data.choices.length > 0 && data.usage) {
        res.json({ ok: true, latencyMs });
        return;
      }
      // 2xx 但结构异常（空 choices / 无 usage）：不能证明能生成，判不可用
      res.json({ ok: false, latencyMs, error: '模型服务返回 2xx 但响应缺少生成结果（choices/usage），请检查服务是否正常' });
      return;
    }

    // 非 2xx：提取可读错误信息
    let rawMsg = '';
    try {
      const data = (await resp.json()) as { error?: { message?: string } | string; message?: string };
      const err = data?.error;
      rawMsg = typeof err === 'object' ? (err?.message ?? '') : (typeof err === 'string' ? err : '');
      rawMsg = rawMsg || data?.message || '';
    } catch {
      rawMsg = await resp.text().catch(() => '');
    }

    // 模型「已注册但未加载」的典型错误（LM Studio: Failed to load model；其它服务: model not found）
    // → 明确提示「模型未加载或不存在」，并提取模型名；附 /models 诊断信息（服务在线与否）
    if (
      (resp.status === 400 || resp.status === 404) &&
      /Failed to load model|model not found/i.test(rawMsg)
    ) {
      const extracted = extractModelName(rawMsg, model);
      const diag = await diagModelsOnline(baseUrl, headers);
      res.json({ ok: false, latencyMs, error: `模型未加载或不存在：${extracted}${diag}` });
      return;
    }

    const statusMap: Record<number, string> = {
      400: '请求被拒绝（参数或模型名可能不正确）',
      401: '认证失败（API Key 无效或未提供）',
      403: '无访问权限（API Key 可能无效）',
      404: '模型不存在或接口路径不正确',
      429: '请求过于频繁（限流）',
      500: '模型服务内部错误',
    };
    const head = statusMap[resp.status]
      ? `${statusMap[resp.status]}（HTTP ${resp.status}）`
      : `模型服务返回 HTTP ${resp.status}`;
    res.json({ ok: false, latencyMs, error: rawMsg ? `${head}：${rawMsg.slice(0, 200)}` : head });
    return;
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      res.json({ ok: false, error: '连接超时（8 秒），请检查网络或服务地址' });
      return;
    }
    const msg = typeof e?.message === 'string' ? e.message : '连接失败';
    res.json({ ok: false, error: `无法连接到模型服务：${msg.slice(0, 200)}` });
  }
});

// GET /api/global-model — 获取当前用户的全局默认模型（未设置返回空对象）
configRouter.get('/global-model', (req: Request, res: Response): void => {
  const model = getGlobalModel(req.user!.id);
  res.json(model ?? {});
});

// POST /api/global-model — 保存当前用户的全局默认模型（前端「模型设置」选中时同步调用）
// body: { id: string; baseUrl: string; apiKey?: string }；id 或 baseUrl 为空 → 400
configRouter.post('/global-model', (req: Request, res: Response): void => {
  const body = (req.body ?? {}) as { id?: unknown; baseUrl?: unknown; apiKey?: unknown };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!id || !baseUrl) {
    res.status(400).json({ error: '模型配置不完整（id 与 baseUrl 不能为空）' });
    return;
  }
  setGlobalModel(req.user!.id, { id, baseUrl, apiKey });
  res.json({ success: true, model: getGlobalModel(req.user!.id) });
});

// POST /api/test-connection
configRouter.post('/test-connection', async (req: Request, res: Response): Promise<void> => {
  const { mode } = req.body as { mode?: string };
  const isAgent = mode === 'agent';
  const baseUrl = (isAgent ? runtimeConfig.agent_base_url : runtimeConfig.chat_base_url).replace(/\/+$/, '');
  const apiKey = isAgent ? runtimeConfig.agent_api_key : runtimeConfig.chat_api_key;
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      res.json({ success: true, message: '连接成功' });
    } else {
      const text = await response.text().catch(() => '');
      res.json({ success: false, error: `服务器返回 ${response.status}: ${text.slice(0, 200)}` });
    }
  } catch (e: any) {
    res.json({ success: false, error: e.message || '连接失败' });
  }
});
