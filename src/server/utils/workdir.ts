import fs from 'node:fs';
import path from 'node:path';

/**
 * 校验并归一化工作目录输入。
 *
 * 归一化很重要：`/a/b` 与 `/a/b/` 必须折叠成同一个值，否则会出现
 * 「明明切了目录却没变化」（值不同但实际同目录）和前端 localStorage 里的重复项。
 *
 * 不做 sandbox 白名单 —— 与既有的 `GET /api/list-directory` 放开策略一致：
 * 单用户 / 内网个人系统，服务端本就以进程用户权限读写任意目录。
 */
export function normalizeWorkDir(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '工作目录不能为空' };
  }
  const abs = path.resolve(raw.trim());
  try {
    if (!fs.statSync(abs).isDirectory()) {
      return { ok: false, error: `不是目录：${abs}` };
    }
  } catch (err: any) {
    const reason =
      err?.code === 'ENOENT'
        ? '目录不存在'
        : err?.code === 'EACCES' || err?.code === 'EPERM'
          ? '没有权限访问'
          : '无法访问';
    return { ok: false, error: `${reason}：${abs}` };
  }
  return { ok: true, value: abs };
}
