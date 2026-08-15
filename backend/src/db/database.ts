import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue } from 'sql.js';
import path from 'node:path';
import fs from 'node:fs';

let SQL: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;
let dbPath = '';

/** 确保数据目录存在 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 旧命名迁移：应用已从 piagent 更名为 myagent。
 * 启动时扫描 data 目录，把含 "piagent" 旧命名的数据文件 rename 为 "myagent" 新命名
 * （如 piagent.db → myagent.db）。仅当新文件不存在且旧文件存在时执行，保证不丢用户数据。
 */
function migrateLegacyFiles(dataDir: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.includes('piagent')) continue;
    const newName = name.replace(/piagent/g, 'myagent');
    const src = path.join(dataDir, name);
    const dst = path.join(dataDir, newName);
    if (fs.existsSync(dst)) continue; // 新文件已存在，跳过（保留旧文件不动）
    try {
      fs.renameSync(src, dst);
      console.log(`[DB] 已迁移旧数据文件: ${name} -> ${newName}`);
    } catch (err) {
      console.warn(`[DB] 迁移旧数据文件失败 ${name}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** 初始化数据库（异步，需在启动时调用一次） */
export async function initDatabase(dataDir: string): Promise<void> {
  ensureDir(dataDir);
  migrateLegacyFiles(dataDir); // 旧 piagent 命名数据文件 → myagent（含 piagent.db → myagent.db）
  dbPath = path.join(dataDir, 'myagent.db');

  SQL = await initSqlJs();

  // 尝试从文件加载
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
    console.log('[DB] 已加载数据库:', dbPath);
  } else {
    db = new SQL.Database();
    console.log('[DB] 已创建新数据库');
  }

  // 建表
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      account TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      last_login_at TEXT,
      last_logout_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      messages TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      last_active_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 迁移已有数据库：添加新列（sql.js 对重复 ALTER TABLE 会抛异常，忽略）
  try { db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch {}
  try { db.run("ALTER TABLE auth_tokens ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''"); } catch {}

  saveDb();
}

/** 获取数据库实例（同步，需在 initDatabase 后调用） */
export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return db;
}

/** 持久化数据库到文件 */
export function saveDb(): void {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

/** 关闭数据库 */
export function closeDb(): void {
  saveDb();
  if (db) {
    db.close();
    db = null;
  }
}

/** 执行查询并返回结果数组，每行为对象 */
export function queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  try {
    stmt.bind(params as SqlValue[]);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as T);
    }
    return results;
  } finally {
    stmt.free();
  }
}

/** 执行查询并返回第一行，没有则返回 undefined */
export function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  const results = queryAll<T>(sql, params);
  return results[0];
}

/** 执行写操作（INSERT/UPDATE/DELETE），返回影响行数 */
export function execute(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
  const database = getDb();
  database.run(sql, params as SqlValue[]);
  // sql.js 的 getRowsModified 在 run 后可用
  const changes = database.getRowsModified();
  // 通过查询获取 last_insert_rowid
  const lastId = queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
  saveDb(); // 写操作后自动持久化
  return { changes, lastInsertRowid: lastId?.id ?? 0 };
}
