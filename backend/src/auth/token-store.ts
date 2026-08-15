import crypto from 'node:crypto';
import { queryOne, execute } from '../db/database.js';

/** 生成一个随机 token */
export function generateToken(): string {
  return crypto.randomUUID();
}

/** 为用户创建 token 并存入数据库，默认 7 天后过期 */
export function createToken(userId: number, expiresDays = 7): string {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
  execute('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
  return token;
}

/** 根据 token 获取用户 ID，过期则删除并返回 null */
export function validateToken(token: string): number | null {
  const row = queryOne<{ user_id: number; expires_at: string }>(
    'SELECT user_id, expires_at FROM auth_tokens WHERE token = ?',
    [token],
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteToken(token);
    return null;
  }
  return row.user_id;
}

/** 删除 token（登出） */
export function deleteToken(token: string): void {
  execute('DELETE FROM auth_tokens WHERE token = ?', [token]);
}

/** 删除用户的所有 token（强制登出所有设备） */
export function deleteUserTokens(userId: number): void {
  execute('DELETE FROM auth_tokens WHERE user_id = ?', [userId]);
}
