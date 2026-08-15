import type { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const method = req.method;
  const url = req.originalUrl ?? req.url;

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${method}] ${url} - ${res.statusCode} (${duration}ms)`);
  });

  next();
}
