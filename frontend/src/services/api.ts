import type { AdvancedConfig, ConfigData, ExternalServiceConfig, ExtensionCommandInfo, ExtensionInfo, McpServerConfig, McpServersConfig } from '../types/api';
import { apiUrl, isElectron } from './api-config';

/** 获取认证头 */
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('myagent_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function listSessions() {
  const res = await fetch(apiUrl('/api/sessions'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取会话列表失败');
  return res.json();
}

export async function createSession(
  name?: string,
  mode?: string,
  llmOverrides?: { id?: string; baseUrl?: string; apiKey?: string },
) {
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: name || null,
      mode,
      // 携带当前选中模型配置（与 sendMessage 注入的 modelOverrides 同源，来自 getLlmOverrides），
      // 使新会话创建时即应用当前默认模型；未选中任何模型时不带 overrides，
      // 由后端使用用户全局默认（data/global-default-model.json），两者皆无则后端返回 400
      // "未配置默认模型，请在设置→模型设置中选择模型"（错误信息透传展示给用户）。
      ...(llmOverrides && (llmOverrides.id || llmOverrides.baseUrl || llmOverrides.apiKey)
        ? { modelOverrides: llmOverrides }
        : {}),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `创建会话失败（HTTP ${res.status}）`);
  }
  return res.json();
}

/** 获取当前用户的全局默认模型（未设置时返回空对象） */
export async function getGlobalModel(): Promise<{ id?: string; baseUrl?: string; apiKey?: string }> {
  const res = await fetch(apiUrl('/api/global-model'), { headers: authHeaders() });
  if (!res.ok) return {};
  return res.json();
}

/** 保存当前用户的全局默认模型（前端「模型设置」选中预设 / 手动配置时同步调用） */
export async function saveGlobalModel(model: { id: string; baseUrl: string; apiKey?: string }): Promise<void> {
  const res = await fetch(apiUrl('/api/global-model'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(model),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `保存全局默认模型失败（HTTP ${res.status}）`);
  }
}

export async function getSession(id: string) {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取会话失败');
  return res.json();
}

export async function updateSession(id: string, data: { name?: string }) {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('更新会话失败');
  return res.json();
}

export async function deleteSession(id: string) {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('删除会话失败');
}

/** 删除会话中一轮对话（第 index 条 user 消息及其回复，index 从 0 开始） */
export async function deleteMessages(sessionId: string, index: number) {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}/messages`), {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ index }),
  });
  if (!res.ok) throw new Error('删除消息失败');
  return res.json();
}

export async function abortSession(id: string) {
  const res = await fetch(apiUrl(`/api/sessions/${id}/abort`), {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('中断失败');
}

/** 手动触发会话压缩；失败时透传后端中文错误（如"会话不存在"） */
export async function compactSession(sessionId: string) {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}/compact`), {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `压缩失败（HTTP ${res.status}）`);
  }
  return res.json();
}

export async function getConfig(): Promise<ConfigData> {
  const res = await fetch(apiUrl('/api/config'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取配置失败');
  return res.json();
}

export async function updateConfig(config: ConfigData) {
  const res = await fetch(apiUrl('/api/config'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('保存配置失败');
  return res.json();
}

/** 保存高级设置（只提交 advanced 字段，后端部分更新并校验；校验失败时抛出后端错误信息） */
export async function updateAdvancedConfig(advanced: AdvancedConfig) {
  const res = await fetch(apiUrl('/api/config'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ advanced }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message || data?.error || '保存高级设置失败');
  }
  return res.json();
}

/** 测试任意模型配置的连通性（后端代理，避开浏览器 CORS；无状态，超时 8 秒） */
export async function testModelConnection(
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  try {
    const res = await fetch(apiUrl('/api/test-model-connection'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ baseUrl, model, apiKey }),
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: '检测超时，请检查网络或服务地址' };
    }
    return { ok: false, error: e.message || '检测失败' };
  }
}

export async function testConnection(mode?: 'chat' | 'agent'): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(apiUrl('/api/test-connection'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(3000),
    });
    return res.json();
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { success: false, error: '连接超时（3 秒），请检查模型服务是否正常运行' };
    }
    return { success: false, error: e.message || '连接失败' };
  }
}

/** 导出会话为 JSONL 文件（浏览器下载） */
export async function exportSession(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${id}/export`), {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('导出会话失败');
  const blob = await res.blob();
  // 从 Content-Disposition 提取文件名，兜底用 session id
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match ? match[1] : `session-${id}.jsonl`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导入 JSONL 会话，返回新建的会话信息 */
export async function importSession(jsonlText: string): Promise<{ id: string; name: string; mode: string; imported: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/jsonl' };
  const token = localStorage.getItem('myagent_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(apiUrl('/api/sessions/import'), {
    method: 'POST',
    headers,
    body: jsonlText,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '导入会话失败');
  }
  return res.json();
}

export async function sendConfirmationDecision(sessionId: string, decision: 'allow' | 'always_allow' | 'block') {
  const res = await fetch(apiUrl('/api/confirm-decision'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sessionId, decision }),
  });
  if (!res.ok) throw new Error('发送确认决策失败');
  return res.json();
}

/** 获取跨会话记忆全文（data/memory.md；文件未创建时返回空内容） */
export async function getMemory(): Promise<{ content: string }> {
  const res = await fetch(apiUrl('/api/memory'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取记忆失败');
  return res.json();
}

/** 保存跨会话记忆（整文件覆盖；传空字符串即清空） */
export async function saveMemory(content: string): Promise<void> {
  const res = await fetch(apiUrl('/api/memory'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '保存记忆失败');
  }
}

/** 手动触发记忆蒸馏（LLM 提炼合并旧记忆；失败时后端返回 error 且不修改原记忆） */
export async function distillMemory(): Promise<{
  success: boolean;
  distilled: number;
  result: number;
  summary?: string;
  error?: string;
}> {
  const res = await fetch(apiUrl('/api/memory/distill'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '记忆蒸馏失败');
  }
  return res.json();
}

/** 获取 MCP 外部 server 列表（服务端 data/mcp-servers.json） */
export async function listMcpServers(): Promise<McpServersConfig> {
  const res = await fetch(apiUrl('/api/mcp-servers'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取 MCP 服务列表失败');
  return res.json();
}

/** 新增 MCP server（name/command/args/description），校验失败时抛出后端中文错误 */
export async function addMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  description?: string;
}): Promise<McpServersConfig> {
  const res = await fetch(apiUrl('/api/mcp-servers'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '新增 MCP 服务失败');
  }
  return res.json();
}

/** 更新 MCP server（enabled 开关/编辑 command/args/description；name 不可修改） */
export async function updateMcpServer(name: string, patch: { enabled?: boolean; command?: string; args?: string[]; description?: string }): Promise<McpServersConfig> {
  const res = await fetch(apiUrl(`/api/mcp-servers/${encodeURIComponent(name)}`), {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '更新 MCP 服务失败');
  }
  return res.json();
}

/** 删除 MCP server */
export async function deleteMcpServer(name: string): Promise<McpServersConfig> {
  const res = await fetch(apiUrl(`/api/mcp-servers/${encodeURIComponent(name)}`), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '删除 MCP 服务失败');
  }
  return res.json();
}

export async function listDirectory(path: string): Promise<{  path: string;
  parent: string | null;
  directories: string[];
  files: string[];
}> {
  // Electron 模式：目录浏览走主进程本地文件系统
  if (isElectron()) {
    const result = (await window.myagent!.listDirectory({ path })) as {
      path: string;
      parent: string;
      directories: string[];
      files: string[];
      error?: string;
    };
    if (result.error) throw new Error(result.error);
    return { ...result, parent: result.parent || null };
  }
  const res = await fetch(apiUrl(`/api/list-directory?path=${encodeURIComponent(path)}`), {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('读取目录失败');
  return res.json();
}

// ─── 外部服务配置（知识库查询链接，服务端 data/external-service-config.json） ───

/** 获取外部服务配置 */
export async function getExternalService(): Promise<ExternalServiceConfig> {
  const res = await fetch(apiUrl('/api/external-service'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取外部服务配置失败');
  return res.json();
}

/** 保存外部服务配置（空串=清除；校验失败时抛出后端中文错误） */
export async function saveExternalService(kbQueryUrl: string): Promise<ExternalServiceConfig> {
  const res = await fetch(apiUrl('/api/external-service'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ kbQueryUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '保存外部服务配置失败');
  }
  return res.json();
}

/** 获取扩展列表（含发现但未启用的；后端扫描 extensions/node_modules + .pi/extensions） */
export async function listExtensions(): Promise<ExtensionInfo[]> {
  const res = await fetch(apiUrl('/api/extensions'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取扩展列表失败');
  const data = await res.json();
  return data.extensions || [];
}

/** 切换扩展启停（后端落盘 extensions-state.json；新会话/命令生效，运行中会话不热更新） */
export async function toggleExtension(name: string): Promise<{ enabled: boolean }> {
  const res = await fetch(apiUrl(`/api/extensions/${encodeURIComponent(name)}/toggle`), {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '切换扩展状态失败');
  }
  return res.json();
}

/** 获取已启用扩展注册的命令（/ 命令列表合并用） */
export async function listExtensionCommands(): Promise<ExtensionCommandInfo[]> {
  const res = await fetch(apiUrl('/api/extensions/commands'), { headers: authHeaders() });
  if (!res.ok) throw new Error('获取扩展命令失败');
  const data = await res.json();
  return data.commands || [];
}

/** 执行扩展命令（返回 handler 文本结果） */
export async function runExtensionCommand(
  name: string,
  args?: string,
  sessionId?: string,
): Promise<{ result: string }> {
  const res = await fetch(apiUrl(`/api/extensions/${encodeURIComponent(name)}/command`), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ args: args || '', sessionId: sessionId || undefined }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '扩展命令执行失败');
  }
  return res.json();
}

/** 测试知识库查询链接连通性（后端代理，避开浏览器 CORS；无状态，超时 8 秒） */
export async function testExternalService(
  kbQueryUrl: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  try {
    const res = await fetch(apiUrl('/api/external-service/test'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kbQueryUrl }),
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: '检测超时，请检查网络或服务地址' };
    }
    return { ok: false, error: e.message || '检测失败' };
  }
}
