import type { Request, Response, NextFunction } from 'express';

/**
 * 统一错误处理中间件。
 * 错误对象可携带自定义 status 字段（如 NoDefaultModelError.status = 400），
 * 无 status 的按 500 处理。始终返回中文可读的 { error } JSON。
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const errWithStatus = err as unknown as { status?: number };
  const status = typeof errWithStatus.status === 'number' ? errWithStatus.status : 500;
  console.error(`[ErrorHandler] ${status}`, err.message);
  res.status(status).json({ error: err.message ?? 'Internal server error' });
}
