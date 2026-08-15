import { queryOne, queryAll, execute } from './database.js';

export interface SessionRecord {
  id: string;
  user_id: number;
  name: string;
  mode: string;
  messages: string;
  created_at: string;
  last_active_at: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  mode: string;
  createdAt: string;
  lastActiveAt: string;
}

export class SessionStore {
  /** 保存或更新会话 */
  saveSession(session: {
    id: string;
    userId: number;
    name: string;
    mode: string;
    messages: unknown[];
  }): void {
    execute(
      `INSERT INTO chat_sessions (id, user_id, name, mode, messages, last_active_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
       ON CONFLICT(id) DO UPDATE SET
         messages = excluded.messages,
         last_active_at = datetime('now', 'localtime'),
         name = excluded.name`,
      [session.id, session.userId, session.name, session.mode, JSON.stringify(session.messages)],
    );
  }

  /** 获取用户的会话列表 */
  listByUser(userId: number): SessionSummary[] {
    const rows = queryAll<SessionRecord>(
      'SELECT id, name, mode, created_at, last_active_at FROM chat_sessions WHERE user_id = ? ORDER BY last_active_at DESC',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mode: r.mode,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));
  }

  /** 获取单个会话的消息 */
  getMessages(sessionId: string): unknown[] | null {
    const row = queryOne<{ messages: string }>('SELECT messages FROM chat_sessions WHERE id = ?', [sessionId]);
    if (!row) return null;
    try {
      return JSON.parse(row.messages);
    } catch {
      return [];
    }
  }

  /** 获取会话详情 */
  getSession(sessionId: string): SessionRecord | undefined {
    return queryOne<SessionRecord>('SELECT * FROM chat_sessions WHERE id = ?', [sessionId]);
  }

  /** 更新会话名称 */
  updateName(sessionId: string, name: string): void {
    execute(
      "UPDATE chat_sessions SET name = ?, last_active_at = datetime('now', 'localtime') WHERE id = ?",
      [name, sessionId],
    );
  }

  /** 删除会话 */
  deleteSession(sessionId: string): void {
    execute('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
  }

  /** 删除用户的所有会话 */
  deleteByUser(userId: number): void {
    execute('DELETE FROM chat_sessions WHERE user_id = ?', [userId]);
  }

  /** 获取会话所属用户 ID */
  getSessionOwner(sessionId: string): number | null {
    const row = queryOne<{ user_id: number }>('SELECT user_id FROM chat_sessions WHERE id = ?', [sessionId]);
    return row?.user_id ?? null;
  }
}
