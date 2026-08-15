/**
 * 会话 JSONL 导入导出（纯函数，便于测试）
 *
 * 文件格式（每行一个 JSON 对象）：
 * 第 1 行（可选）：{ "type": "meta", "sessionId", "name", "mode", "createdAt" }
 * 后续行：        { "type": "message", "role", "content", "timestamp",
 *                    [assistant: "usage" | "stopReason" | "errorMessage"],
 *                    [toolResult: "toolCallId" | "toolName" | "isError"] }
 *
 * 清洗规则：
 * - 导出：白名单字段过滤，丢弃前端私有字段（id / isStreaming / duration 等）
 * - 导入：只保留可恢复字段（role / content / timestamp / assistant usage / toolResult 元数据），丢弃未知字段
 */

export type ExportRole = 'user' | 'assistant' | 'toolResult';

export interface JsonlMetaLine {
  type: 'meta';
  sessionId?: string;
  name?: string;
  mode?: 'chat' | 'agent' | string;
  createdAt?: string;
}

export interface JsonlMessageLine {
  type: 'message';
  role: string;
  content: unknown;
  timestamp?: number;
  // assistant 附加字段
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  // toolResult 附加字段
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface SessionJsonlMeta {
  sessionId?: string;
  name?: string;
  mode?: string;
  createdAt?: string;
}

export interface ImportedMessage {
  role: ExportRole;
  content: unknown;
  timestamp?: number;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

const VALID_ROLES = new Set<string>(['user', 'assistant', 'toolResult']);

/**
 * 导出清洗：后端消息 → JSONL 消息行（白名单过滤，丢弃前端私有字段）
 */
export function sanitizeMessageForExport(msg: Record<string, unknown>): JsonlMessageLine | null {
  const role = String(msg.role ?? '');
  if (!VALID_ROLES.has(role)) return null;

  const line: JsonlMessageLine = {
    type: 'message',
    role,
    content: msg.content ?? '',
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
  };
  if (role === 'assistant') {
    if (msg.usage !== undefined) line.usage = msg.usage;
    if (msg.stopReason !== undefined) line.stopReason = msg.stopReason;
    if (msg.errorMessage !== undefined) line.errorMessage = msg.errorMessage;
  }
  if (role === 'toolResult') {
    if (typeof msg.toolCallId === 'string') line.toolCallId = msg.toolCallId;
    if (typeof msg.toolName === 'string') line.toolName = msg.toolName;
    if (typeof msg.isError === 'boolean') line.isError = msg.isError;
  }
  return line;
}

/**
 * 序列化会话为 JSONL 文本（meta 行 + 消息行）
 */
export function serializeSessionToJsonl(
  info: { id: string; name: string; mode: string; createdAt: Date | string },
  messages: Record<string, unknown>[],
): string {
  const lines: string[] = [];

  const meta: JsonlMetaLine = {
    type: 'meta',
    sessionId: info.id,
    name: info.name,
    mode: info.mode,
    createdAt: info.createdAt instanceof Date ? info.createdAt.toISOString() : String(info.createdAt),
  };
  lines.push(JSON.stringify(meta));

  for (const msg of messages) {
    const line = sanitizeMessageForExport(msg);
    if (line) lines.push(JSON.stringify(line));
  }

  return lines.join('\n') + '\n';
}

/**
 * 解析单个 JSONL 行 → 元数据行或消息行（非法行返回 null）
 */
function parseLine(raw: string): JsonlMetaLine | JsonlMessageLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'meta') {
    return {
      type: 'meta',
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      mode: typeof obj.mode === 'string' ? obj.mode : undefined,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
    };
  }
  if (obj.type === 'message') {
    return obj as unknown as JsonlMessageLine;
  }
  return null;
}

/**
 * 导入清洗：JSONL 消息行 → 可恢复消息（只保留白名单字段，丢弃未知字段）
 */
export function sanitizeMessageForImport(line: JsonlMessageLine): ImportedMessage | null {
  const role = String(line.role ?? '');
  if (!VALID_ROLES.has(role)) return null;

  const msg: ImportedMessage = {
    role: role as ExportRole,
    content: line.content ?? '',
    timestamp: typeof line.timestamp === 'number' ? line.timestamp : Date.now(),
  };
  if (role === 'assistant') {
    if (line.usage !== undefined) msg.usage = line.usage;
    if (line.stopReason !== undefined) msg.stopReason = line.stopReason;
    if (line.errorMessage !== undefined) msg.errorMessage = line.errorMessage;
  }
  if (role === 'toolResult') {
    if (typeof line.toolCallId === 'string') msg.toolCallId = line.toolCallId;
    if (typeof line.toolName === 'string') msg.toolName = line.toolName;
    if (typeof line.isError === 'boolean') msg.isError = line.isError;
  }
  return msg;
}

/**
 * 解析 JSONL 文本 → { meta, messages }
 * - 宽容解析：跳过空行与非法行
 * - meta 取第一个 meta 行；message 行逐个清洗，丢弃不可恢复消息
 */
export function parseSessionJsonl(text: string): { meta: SessionJsonlMeta | null; messages: ImportedMessage[] } {
  const meta: SessionJsonlMeta = {};
  const messages: ImportedMessage[] = [];

  for (const rawLine of text.split('\n')) {
    const line = parseLine(rawLine);
    if (!line) continue;
    if (line.type === 'meta') {
      if (line.sessionId) meta.sessionId = line.sessionId;
      if (line.name) meta.name = line.name;
      if (line.mode) meta.mode = line.mode;
      if (line.createdAt) meta.createdAt = line.createdAt;
      continue;
    }
    const msg = sanitizeMessageForImport(line);
    if (msg) messages.push(msg);
  }

  return { meta: Object.keys(meta).length > 0 ? meta : null, messages };
}
