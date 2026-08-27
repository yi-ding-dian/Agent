import { registerWebSearch } from "./webSearch.js";
import { registerKbQuery } from "./kbQuery.js";
import { registerFileQuery } from "./fileQuery.js";

/**
 * 在 MCP 服务上注册所有工具
 * 新增工具时在此文件添加一行即可
 */
export function registerAllTools(server) {
  registerWebSearch(server);
  registerKbQuery(server);
  registerFileQuery(server);
}
