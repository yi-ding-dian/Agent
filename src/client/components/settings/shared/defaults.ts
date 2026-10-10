/**
 * 设置面板的模块级常量
 *
 * 这些常量原先定义在 SettingsModal.tsx 顶部，与组件逻辑混在一个文件里。
 * 抽出后：工具权限面板（panels/PermissionsPanel）用 TOOL_LABELS；
 * SettingsModal 壳用 DEFAULT_PERMISSIONS 初始化 form。
 */
import type { ToolPermissionValue } from '../../../types/api';

/** 工具权限配置：工具名 → 中文名（未知工具名兜底显示原名） */
export const TOOL_LABELS: Record<string, string> = {
  execute_command: '执行命令',
  run_python: '运行 Python',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  search_web: '网络搜索',
  grep_search: '文本搜索',
  list_files: '列出文件',
  run_skill: '运行技能',
  remember: '记住信息',
  subagent: '子代理',
};

/** 各工具的出厂默认权限（form 初始值；服务端另有 data/tool-permissions.json 为权威） */
export const DEFAULT_PERMISSIONS: Record<string, ToolPermissionValue> = {
  execute_command: 'ask',
  run_python: 'ask',
  read_file: 'allow',
  write_file: 'allow',
  edit_file: 'allow',
  search_web: 'allow',
  grep_search: 'allow',
  list_files: 'allow',
  run_skill: 'allow',
  remember: 'allow',
  subagent: 'allow',
};
