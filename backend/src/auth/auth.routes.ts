import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { UserRepository } from '../db/user-repository.js';
import { createToken, deleteToken, validateToken } from './token-store.js';

// POST /api/auth/login — 用户登录
const userRepo = new UserRepository();

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/auth/login', (req, res) => {
    const { account, password } = req.body || {};

    if (!account || !password) {
      res.status(400).json({ error: '请输入账号和密码' });
      return;
    }

    const user = userRepo.findByAccount(account);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      res.status(401).json({ error: '账号或密码错误' });
      return;
    }

    const token = createToken(user.id);
    userRepo.updateLoginTime(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        account: user.account,
        role: user.role,
        last_login_at: user.last_login_at,
        last_logout_at: user.last_logout_at,
      },
    });
  });

  // POST /api/auth/logout — 用户登出
  router.post('/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      const userId = validateToken(token);
      if (userId) {
        userRepo.updateLogoutTime(userId);
      }
      deleteToken(token);
    }

    res.json({ success: true });
  });

  // GET /api/auth/me — 获取当前用户信息
  router.get('/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    const userId = validateToken(token);
    if (!userId) {
      res.status(401).json({ error: '登录已过期，请重新登录' });
      return;
    }

    const user = userRepo.findById(userId);
    if (!user) {
      res.status(401).json({ error: '用户不存在' });
      return;
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        account: user.account,
        role: user.role,
        last_login_at: user.last_login_at,
        last_logout_at: user.last_logout_at,
      },
    });
  });

  return router;
}
