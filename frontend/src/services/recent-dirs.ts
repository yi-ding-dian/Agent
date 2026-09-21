/**
 * 最近使用的工作目录（localStorage）。
 *
 * 只做「最近用过」的记录，供目录选择器置顶显示 —— 注意它不是「新会话默认目录」的来源：
 * 新会话未选目录时仍沿用全局 config.work_dir（见 chat-store 的会话级语义）。
 */
const KEY = 'myagent_recent_work_dirs';
const MAX = 10;

/** 最近使用的工作目录（最近优先、去重） */
export function getRecentWorkDirs(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 置顶一条目录（去重 + 截断）。仅在切换成功后调用。 */
export function pushRecentWorkDir(dir: string): void {
  if (!dir) return;
  try {
    const next = [dir, ...getRecentWorkDirs().filter((d) => d !== dir)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore：隐私模式 / 配额超限，不影响主流程 */
  }
}
