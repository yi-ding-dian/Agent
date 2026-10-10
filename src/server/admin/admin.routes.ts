import { Router } from 'express';
import type { Request, Response } from 'express';
import { UserRepository, type UserRecord } from '../db/user-repository.js';
import { SessionStore } from '../db/session-store.js';

const userRepo = new UserRepository();
const sessionStore = new SessionStore();

/** 返回去掉密码字段的用户对象 */
function withoutPassword(user: UserRecord) {
  const { password: _pw, ...safe } = user;
  return safe;
}

/** 管理员检查中间件 */
function requireAdmin(req: Request, res: Response, next: Function): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

export function createAdminRouter(): Router {
  const router = Router();

  // 所有 admin 路由都需要管理员权限
  router.use('/admin', requireAdmin);

  // GET /api/admin/users — 获取所有用户
  router.get('/admin/users', (_req, res) => {
    const users = userRepo.listAll();
    res.json({ users: users.map(withoutPassword) });
  });

  // GET /api/admin/users/:id — 获取单个用户
  router.get('/admin/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const user = userRepo.findById(id);
    if (!user) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json({ user: withoutPassword(user) });
  });

  // POST /api/admin/users — 创建用户
  router.post('/admin/users', (req, res) => {
    const { username, account, password } = req.body || {};

    if (!username || !account || !password) {
      res.status(400).json({ error: '用户名、账号、密码为必填项' });
      return;
    }

    const existing = userRepo.findByAccount(account);
    if (existing) {
      res.status(409).json({ error: '该账号已存在' });
      return;
    }

    const user = userRepo.create({ username, account, password });
    res.status(201).json({ user: withoutPassword(user) });
  });

  // PUT /api/admin/users/:id — 更新用户
  router.put('/admin/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }

    const { username, account, password } = req.body || {};

    if (account) {
      const existing = userRepo.findByAccount(account);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: '该账号已被其他用户使用' });
        return;
      }
    }

    const updated = userRepo.update(id, { username, account, password });
    if (!updated) {
      res.status(404).json({ error: '用户不存在或没有变更' });
      return;
    }

    const user = userRepo.findById(id)!;
    res.json({ user: withoutPassword(user) });
  });

  // DELETE /api/admin/users/:id — 删除用户
  router.delete('/admin/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }

    sessionStore.deleteByUser(id);

    const deleted = userRepo.delete(id);
    if (!deleted) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    res.json({ success: true });
  });

  return router;
}
