import { queryOne, queryAll, execute } from '../db/database.js';

export interface SessionRecord {
  id: string;
  user_id: number;
  name: string;
  mode: string;
  messages: string;
  /** 会话级工作目录；NULL = 老会话，读取时回退全局默认（config.workDir） */
  work_dir: string | null;
  created_at: string;
  last_active_at: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  mode: string;
  /** 会话级工作目录；null = 老会话，前端回退显示全局默认值 */
  workDir: string | null;
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
    /** 会话级工作目录；显式传 null 表示「沿用全局默认」 */
    workDir: string | null;
  }): void {
    execute(
      // work_dir 必须同时出现在 INSERT 与 ON CONFLICT：后者原先只更新
      // messages/last_active_at/name，漏了它则「改了目录也存不进去」
      `INSERT INTO chat_sessions (id, user_id, name, mode, messages, work_dir, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
       ON CONFLICT(id) DO UPDATE SET
         messages = excluded.messages,
         work_dir = excluded.work_dir,
         last_active_at = datetime('now', 'localtime'),
         name = excluded.name`,
      [session.id, session.userId, session.name, session.mode, JSON.stringify(session.messages), session.workDir],
    );
  }

  /** 获取用户的会话列表 */
  listByUser(userId: number): SessionSummary[] {
    const rows = queryAll<SessionRecord>(
      'SELECT id, name, mode, work_dir, created_at, last_active_at FROM chat_sessions WHERE user_id = ? ORDER BY last_active_at DESC',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mode: r.mode,
      workDir: r.work_dir ?? null,
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

  /**
   * 仅更新工作目录。
   *
   * 单独开一个方法而不是复用 saveSession：后者要求带上完整 messages，
   * 而切目录时只想改这一个字段（且会话可能只存在于 DB 中，内存里没有 service）。
   * 传 null = 清除显式目录，回到「跟随全局默认」。
   */
  updateWorkDir(sessionId: string, workDir: string | null): void {
    execute(
      "UPDATE chat_sessions SET work_dir = ?, last_active_at = datetime('now', 'localtime') WHERE id = ?",
      [workDir, sessionId],
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
