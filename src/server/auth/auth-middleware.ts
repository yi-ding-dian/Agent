import type { Request, Response, NextFunction } from 'express';
import { validateToken } from './token-store.js';
import { UserRepository } from '../db/user-repository.js';

const userRepo = new UserRepository();

/** 声明扩展的 Request 类型 */
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; role: string };
    }
  }
}

/**
 * 认证中间件。对 /api/auth/* 路径放行，其余 /api/* 路径必须携带有效 token。
 */
export function createAuthMiddleware() {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // 登录/登出接口不需要认证
    if (req.path.startsWith('/auth/')) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      res.status(401).json({ error: '请先登录' });
      return;
    }

    const userId = validateToken(token);
    if (!userId) {
      res.status(401).json({ error: '登录已过期，请重新登录' });
      return;
    }

    const user = userRepo.findById(userId);
    req.user = { id: userId, role: user?.role ?? 'user' };
    next();
  };
}
