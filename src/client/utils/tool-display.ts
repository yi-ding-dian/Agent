/**
 * 工具调用的展示辅助（主 Agent 的 ToolCallGroup 与子 Agent 的 AgentDetailModal 共用）
 *
 * 此前两侧各自维护一份 TOOL_LABELS 与参数格式化逻辑（formatArgs / formatPayload /
 * summarizeArgsInline），每次调整都要改两处，漏一处就造成主/子行为不一致
 * —— 例如「去掉字数截断」那次需要同时改 3 个函数。集中到此，单一来源。
 */

/** 工具名 → 中文标签；未收录的工具由调用方回落显示原始 toolName */
export const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  execute_command: '执行命令',
  search_web: '搜索网络',
  run_python: '运行Python',
  subagent: '子代理',
};

/**
 * 行内参数摘要：按工具名取关键字段，未收录工具走整段 JSON。
 * 不做字数截断 —— 能显示多长就多长，装不下时由容器 ellipsis，全文经 title 悬停提示。
 */
export function formatToolArgs(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, any>;
  switch (toolName) {
    case 'read_file':
    case 'write_file':
      return a.path || a.filePath || '';
    case 'execute_command':
      return a.command || '';
    case 'search_web':
      return a.query || '';
    case 'run_python':
      return a.code || '';
    default:
      return formatToolPayload(args);
  }
}

/** 参数/结果文本：字符串原样，对象 JSON 化。不截断（展开区也用它渲染完整内容） */
export function formatToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  return JSON.stringify(payload) ?? '';
}

/** 工具卡片时间戳格式：HH:MM:SS.mmm（主/子 Agent 一致） */
export function formatToolTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
