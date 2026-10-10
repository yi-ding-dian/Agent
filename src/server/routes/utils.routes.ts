import { Router } from 'express';
import type { Request, Response } from 'express';
import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

export const utilsRouter = Router();

// GET /api/list-directory?path=/some/dir
// 自由浏览任意目录（用户可在设置中自由选择工作目录）。
// 说明：仅做可读性校验（目录不存在/无权限返回中文错误），不再限制在 workDir 内——
// 单用户/内网个人系统场景下管理员可浏览任意可读路径属预期；如需收紧可后续加白名单配置。
utilsRouter.get('/list-directory', (req: Request, res: Response): void => {
  const rawPath = (req.query.path as string) || '/';
  let dirPath: string;
  try {
    dirPath = resolve(rawPath);
  } catch {
    res.status(400).json({ error: '无效的目录路径' });
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err: any) {
    const reason =
      err?.code === 'ENOENT'
        ? '目录不存在'
        : err?.code === 'EACCES' || err?.code === 'EPERM'
          ? '没有权限访问'
          : err?.message || '未知错误';
    res.status(400).json({ error: `无法读取目录：${reason}` });
    return;
  }

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
});
