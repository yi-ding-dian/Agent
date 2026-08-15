import { registerCalculator } from "./calculator.js";
import { registerTimeTool } from "./time.js";
import { registerEcho } from "./echo.js";
import { registerWebSearch } from "./webSearch.js";
import { registerKbQuery } from "./kbQuery.js";

/**
 * 在 MCP 服务上注册所有工具
 * 新增工具时在此文件添加一行即可
 */
export function registerAllTools(server) {
  registerCalculator(server);
  registerTimeTool(server);
  registerEcho(server);
  registerWebSearch(server);
  registerKbQuery(server);
}
