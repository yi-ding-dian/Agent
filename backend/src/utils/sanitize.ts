import path from 'node:path';

/**
 * 解析用户提供的路径并防止路径穿越攻击。
 * 如果解析后的路径在 workDir 之外则抛错。
 */
export function resolveSafePath(userPath: string, workDir: string): string {
  const resolved = path.resolve(workDir, userPath);
  const relative = path.relative(workDir, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径访问被拒绝: "${userPath}" 在允许的工作目录之外`);
  }

  return resolved;
}
