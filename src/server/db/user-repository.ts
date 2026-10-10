import bcrypt from 'bcryptjs';
import { queryOne, queryAll, execute } from './database.js';

export interface UserRecord {
  id: number;
  username: string;
  account: string;
  password: string;
  role: string;
  last_login_at: string | null;
  last_logout_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserCreateInput {
  username: string;
  account: string;
  password: string;
}

export interface UserUpdateInput {
  username?: string;
  account?: string;
  password?: string;
}

export class UserRepository {
  /** 根据账号查找用户 */
  findByAccount(account: string): UserRecord | undefined {
    return queryOne<UserRecord>('SELECT * FROM users WHERE account = ?', [account]);
  }

  /** 根据 ID 查找用户 */
  findById(id: number): UserRecord | undefined {
    return queryOne<UserRecord>('SELECT * FROM users WHERE id = ?', [id]);
  }

  /** 获取所有用户 */
  listAll(): UserRecord[] {
    return queryAll<UserRecord>('SELECT * FROM users ORDER BY created_at DESC');
  }

  /** 创建用户 */
  create(input: UserCreateInput): UserRecord {
    const hashed = bcrypt.hashSync(input.password, 10);
    const result = execute(
      'INSERT INTO users (username, account, password) VALUES (?, ?, ?)',
      [input.username, input.account, hashed],
    );
    return this.findById(result.lastInsertRowid)!;
  }

  /** 更新用户 */
  update(id: number, input: UserUpdateInput): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.username !== undefined) {
      fields.push('username = ?');
      values.push(input.username);
    }
    if (input.account !== undefined) {
      fields.push('account = ?');
      values.push(input.account);
    }
    if (input.password !== undefined) {
      fields.push('password = ?');
      values.push(bcrypt.hashSync(input.password, 10));
    }

    if (fields.length === 0) return false;

    fields.push("updated_at = datetime('now', 'localtime')");
    values.push(id);

    const result = execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    return result.changes > 0;
  }

  /** 删除用户 */
  delete(id: number): boolean {
    const result = execute('DELETE FROM users WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /** 更新登录时间 */
  updateLoginTime(id: number): void {
    execute("UPDATE users SET last_login_at = datetime('now', 'localtime') WHERE id = ?", [id]);
  }

  /** 更新退出时间 */
  updateLogoutTime(id: number): void {
    execute("UPDATE users SET last_logout_at = datetime('now', 'localtime') WHERE id = ?", [id]);
  }

  /** 创建默认管理员（如不存在）；已有管理员若密码未哈希则自动迁移 */
  ensureAdmin(defaultAccount: string, defaultPassword: string): void {
    const existing = this.findByAccount(defaultAccount);
    if (!existing) {
      this.create({ username: '管理员', account: defaultAccount, password: defaultPassword });
      execute("UPDATE users SET role = 'admin' WHERE account = ?", [defaultAccount]);
      console.log('[DB] 默认管理员账号已创建:', defaultAccount);
      return;
    }
    // 迁移旧数据：角色修正 + 明文密码哈希
    if (existing.role !== 'admin') {
      execute("UPDATE users SET role = 'admin' WHERE account = ?", [defaultAccount]);
    }
    if (!existing.password.startsWith('$2')) {
      execute("UPDATE users SET password = ? WHERE account = ?", [bcrypt.hashSync(defaultPassword, 10), defaultAccount]);
      console.log('[DB] 管理员密码已从明文迁移为 bcrypt 哈希');
    }
  }
}
