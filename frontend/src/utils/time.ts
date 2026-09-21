/**
 * 会话列表用的相对时间文案。
 *
 * 口径（与产品约定一致）：
 *    < 1 分钟        → 刚刚
 *    < 60 分钟       → 12 分钟前
 *    当天            → 今天 15:42
 *    昨天            → 昨天 09:20
 *    2–6 天          → 3 天前
 *    ≥ 7 天，今年内  → 09-14
 *    ≥ 7 天，跨年    → 2025-12-30
 *
 * 两个刻意的取舍：
 * 1. 「分钟」优先于「今天/昨天」—— 刚过午夜时，23:50 在 00:30 看应显示「40 分钟前」，
 *    而不是「昨天 23:50」。
 * 2. 天数是按**自然日**（各自 00:00 相减）算，而不是毫秒差除以 24h ——
 *    否则 23:50 与次日 00:30 只差 40 分钟却会被算成「跨了一天」。
 *    注意此处只用于「≥1 小时」的分支，分钟分支已在前一步返回。
 */
export function formatRelativeTime(input: string | number | Date): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 时间戳落在未来（本机时钟回拨等）时 dayDiff 可能为负，归到「今天」兜底
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (dayDiff <= 0) return `今天 ${hhmm}`;
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  if (dayDiff <= 6) return `${dayDiff} 天前`;

  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return date.getFullYear() === now.getFullYear() ? mmdd : `${date.getFullYear()}-${mmdd}`;
}
