import { Router } from 'express';
import type { Request, Response } from 'express';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { resolveSafePath } from '../utils/sanitize.js';

export const utilsRouter = Router();

// GET /api/list-directory?path=/some/dir
// 路径限制在工作目录（config.workDir）内，防止认证后读取任意路径
utilsRouter.get('/list-directory', (req: Request, res: Response): void => {
  const rawPath = (req.query.path as string) || '.';

  try {
    const dirPath = resolveSafePath(rawPath, config.workDir);
    const entries = readdirSync(dirPath);
    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      try {
        const fullPath = join(dirPath, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          dirs.push(entry);
        } else {
          files.push(entry);
        }
      } catch {
        // skip entries we can't stat
      }
    }

    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));

    res.json({
      path: dirPath,
      parent: dirPath !== '/' ? join(dirPath, '..') : null,
      directories: dirs,
      files,
    });
  } catch (err: any) {
    res.status(400).json({ error: `无法读取目录: ${err.message}` });
  }
});
